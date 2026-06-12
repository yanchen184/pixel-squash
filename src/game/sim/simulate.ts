import {
  type GameState,
  type PlayerState,
  type ShuttleState,
  type Side,
  type Vec2,
  type Facing4,
  type SwingQuality,
  COURT,
  NET_Y,
  NET_HEIGHT,
  POINTS_TO_WIN,
  STAMINA_MAX,
  SWING_COOLDOWN_FRAMES,
  SWING_REACH,
  SWING_REACH_Z,
  SWING_MAGNET_RANGE,
  SWING_MAGNET_PULL,
  TIMING_PERFECT,
  TIMING_GOOD,
  TIMING_WINDOW,
  STRIKE_Z,
  SHUTTLE_DRAG,
  SHUTTLE_PACE,
  APEX_CEIL,
  HITSTOP_PERFECT,
  HITSTOP_GOOD,
  HITSTOP_WEAK,
  MOMENTUM_MAX,
  PLAYER_SPEED,
  PLAYER_MARGIN,
  DIVE_FRAMES,
  DIVE_SPEED,
  DIVE_REACH_BONUS,
  DIVE_RECOVERY_FRAMES,
  DIVE_STAMINA_COST,
  DIVE_MIN_STAMINA,
  racketCenter,
  resetForServe,
} from '@/data/gameState';
import type { InputFrame } from '@/game/input/InputSource';
import {
  STROKES,
  aimTargetForStroke,
  distToNet,
  type StrokeId,
  type StrokeProfile,
} from '@/data/strokes';

/**
 * Pure, deterministic step for the TOP-DOWN game. Given a state + both players'
 * inputs, returns the NEXT state. No mutation, no Math.random, no Date — replays
 * identically (Phase-2 netcode foundation).
 *
 * The shuttle has a floor position (x,y) and a height z. Gravity pulls z down; a
 * hit launches it in an arc toward the opponent's half that clears NET_HEIGHT at
 * the net. A point ends when the shuttle's height reaches the floor (z<=0).
 */

export const GRAVITY = 0.45; // height px / tick^2 (keep in sync with AIInput)
const SWING_COST = 8;
const STAMINA_REGEN = 0.5;

export function step(state: GameState, inA: InputFrame, inB: InputFrame): GameState {
  if (state.winner !== null) return state;

  const frame = state.frame + 1;

  // ---- Hit-stop: the whole sim is frozen while > 0 (weight on impact). ----
  // We still advance the frame counter (so the renderer ticks + FX play), but no
  // movement or physics — the smash "lands" for a few frames before resuming.
  if (state.hitstop > 0) {
    return { ...state, frame, hitstop: state.hitstop - 1 };
  }

  if (state.phase === 'serve' || state.phase === 'point') {
    const timer = state.phaseTimer - 1;
    if (timer > 0) return { ...state, frame, phaseTimer: timer };
    if (state.phase === 'point') return { ...resetForServe(state, state.server), frame };
    return launchServe({ ...state, frame });
  }

  // ---- Rally tick ----
  let p1 = movePlayer(state.p1, inA, 0, state.shuttle);
  let p2 = movePlayer(state.p2, inB, 1, state.shuttle);

  let shuttle = stepShuttle(state.shuttle);

  let hitstop = 0;
  const r1 = resolveSwing(p1, inA, shuttle, 0, p2);
  p1 = r1.player;
  shuttle = r1.shuttle;
  hitstop = Math.max(hitstop, r1.hitstop);
  const r2 = resolveSwing(p2, inB, shuttle, 1, p1);
  p2 = r2.player;
  shuttle = r2.shuttle;
  hitstop = Math.max(hitstop, r2.hitstop);

  shuttle = applyNet(shuttle, state.shuttle);
  shuttle = predictLanding(shuttle);

  // Scoring: shuttle hit the floor.
  if (shuttle.inPlay && shuttle.z <= 0) {
    return scorePoint({ ...state, frame, p1, p2, shuttle: { ...shuttle, z: 0 }, hitstop: 0 });
  }

  return { ...state, frame, p1, p2, shuttle, hitstop };
}

function movePlayer(pl: PlayerState, input: InputFrame, side: Side, shuttle: ShuttleState): PlayerState {
  const facing: Facing4 = side === 0 ? 'left' : 'right';
  const swingCooldown = Math.max(0, pl.swingCooldown - 1);
  const baseFields = { ...pl, swingCooldown, facing, justHit: false };

  // --- Grounded after a dive: pinned, no move/swing, stamina recovers slowly. ---
  if (pl.diveRecovery > 0) {
    return {
      ...baseFields,
      vel: { x: 0, y: 0 },
      stamina: Math.min(STAMINA_MAX, pl.stamina + STAMINA_REGEN),
      diveFrames: 0,
      diveRecovery: pl.diveRecovery - 1,
    };
  }

  // --- Mid-lunge: slide along the dive direction, ignore move input. ---
  if (pl.diveFrames > 0) {
    const nx = clampX(pl.pos.x + pl.diveDir.x * DIVE_SPEED);
    const ny = clampY(pl.pos.y + pl.diveDir.y * DIVE_SPEED, side);
    const remaining = pl.diveFrames - 1;
    return {
      ...baseFields,
      pos: { x: Math.round(nx), y: Math.round(ny) },
      vel: { x: pl.diveDir.x * DIVE_SPEED, y: pl.diveDir.y * DIVE_SPEED },
      stamina: pl.stamina,
      diveFrames: remaining,
      // When the lunge ends, crash to the floor and pin the player.
      diveRecovery: remaining <= 0 ? DIVE_RECOVERY_FRAMES : 0,
    };
  }

  // --- Fresh dive trigger: lunge toward the move dir (or the shuttle if idle). ---
  if (input.dive && pl.stamina >= DIVE_MIN_STAMINA) {
    const dir = diveDirection(input, pl, shuttle);
    return {
      ...baseFields,
      vel: { x: dir.x * DIVE_SPEED, y: dir.y * DIVE_SPEED },
      stamina: Math.max(0, pl.stamina - DIVE_STAMINA_COST),
      diveFrames: DIVE_FRAMES,
      diveDir: dir,
      diveRecovery: 0,
    };
  }

  // --- Normal grounded movement. ---
  const speedFactor = pl.stamina > 0 ? 1 : 0.5;
  const speed = PLAYER_SPEED * speedFactor;
  let x = pl.pos.x + input.moveX * speed;
  let y = pl.pos.y + input.moveY * speed;

  // Magnetic assist: if the shuttle is on my half, incoming, low enough to hit, and
  // I'm already near its floor point, nudge me a fraction toward it. This is the
  // "run to the area is enough" forgiveness — it never teleports (small pull), so
  // good positioning still beats sloppy positioning, but you don't whiff by 5px.
  const onMyHalf = side === 0 ? shuttle.pos.y > NET_Y : shuttle.pos.y < NET_Y;
  if (onMyHalf && shuttle.inPlay && shuttle.z <= SWING_REACH_Z) {
    const gx = shuttle.pos.x - x;
    const gy = shuttle.pos.y - y;
    if (Math.hypot(gx, gy) <= SWING_MAGNET_RANGE) {
      x += gx * SWING_MAGNET_PULL;
      y += gy * SWING_MAGNET_PULL;
    }
  }

  x = clampX(x);
  y = clampY(y, side);

  return {
    ...baseFields,
    pos: { x: Math.round(x), y: Math.round(y) },
    vel: { x: input.moveX * speed, y: input.moveY * speed },
    stamina: Math.min(STAMINA_MAX, pl.stamina + STAMINA_REGEN),
  };
}

/** Pick the dive slide direction: the held move dir if any, else toward the shuttle. */
function diveDirection(input: InputFrame, pl: PlayerState, shuttle: ShuttleState): Vec2 {
  if (input.moveX !== 0 || input.moveY !== 0) {
    return normalize(input.moveX, input.moveY);
  }
  // Idle dive: lunge toward where the shuttle is (a reflex save).
  return normalize(shuttle.pos.x - pl.pos.x, shuttle.pos.y - pl.pos.y);
}

function normalize(x: number, y: number): Vec2 {
  const m = Math.sqrt(x * x + y * y);
  if (m < 1e-3) return { x: 0, y: 0 };
  return { x: x / m, y: y / m };
}

/** Constrain X to the playable court width. */
function clampX(x: number): number {
  return clamp(x, PLAYER_MARGIN, COURT.width - PLAYER_MARGIN);
}

/** Constrain Y to the player's own half (a dive may reach the net but not cross it). */
function clampY(y: number, side: Side): number {
  return side === 0
    ? clamp(y, NET_Y + PLAYER_MARGIN, COURT.depth - PLAYER_MARGIN)
    : clamp(y, PLAYER_MARGIN, NET_Y - PLAYER_MARGIN);
}

function stepShuttle(s: ShuttleState): ShuttleState {
  if (!s.inPlay) return s;
  const vz = s.vz - GRAVITY;
  // Horizontal air-drag: the shuttle bleeds floor-speed every tick, so it leaves the
  // racket fast and decelerates into a steep drop — the badminton signature. Gravity
  // is undamped, so the vertical drop stays crisp while the horizontal run softens.
  return {
    ...s,
    pos: { x: s.pos.x + s.vel.x, y: s.pos.y + s.vel.y },
    vel: { x: s.vel.x * SHUTTLE_DRAG, y: s.vel.y * SHUTTLE_DRAG },
    z: s.z + vz,
    vz,
  };
}

/**
 * Forward-integrate a copy of the shuttle to the floor to find where (and when in
 * ticks) it will land. Pure look-ahead — it never mutates the live shuttle, only
 * fills `landing`/`landingEta` so the renderer can draw a shrinking ground marker.
 * Mirrors stepShuttle exactly (same drag + gravity) so the marker is truthful.
 */
function predictLanding(s: ShuttleState): ShuttleState {
  if (!s.inPlay) return { ...s, landing: null, landingEta: 0 };
  let x = s.pos.x;
  let y = s.pos.y;
  let z = s.z;
  let vx = s.vel.x;
  let vy = s.vel.y;
  let vz = s.vz;
  let t = 0;
  const MAX = 240; // 4s cap — a sane bound, no flight lasts this long
  while (z > 0 && t < MAX) {
    vz -= GRAVITY;
    x += vx;
    y += vy;
    z += vz;
    vx *= SHUTTLE_DRAG;
    vy *= SHUTTLE_DRAG;
    t++;
  }
  return { ...s, landing: { x, y }, landingEta: t };
}

type SwingResult = { player: PlayerState; shuttle: ShuttleState; hitstop: number };

function resolveSwing(
  pl: PlayerState,
  input: InputFrame,
  shuttle: ShuttleState,
  side: Side,
  opponent: PlayerState,
): SwingResult {
  const swinging = input.swing;
  const strokeId = input.stroke;
  // Grounded after a dive: can't swing at all (scrambling up).
  if (pl.diveRecovery > 0) return { player: pl, shuttle, hitstop: 0 };

  const diving = pl.diveFrames > 0;
  // A dive auto-swings every lunge frame so it connects the instant the shuttle
  // enters the (extended) reach — the lunge IS the save attempt. Outside a dive,
  // the explicit swing edge + cooldown gate apply as normal.
  if (!diving && (!swinging || pl.swingCooldown > 0)) {
    return { player: pl, shuttle, hitstop: 0 };
  }

  // Stroke is now ALWAYS explicit — the human taps a key (J/K/L/Space), the AI names
  // it. For the human (timingAim) we AUTO-DOWNGRADE an impossible stroke to a safe
  // clear instead of letting it whiff: tap smash on a low ball, or drop from deep
  // court, and you simply get a clear rather than being punished for a key you can't
  // legally play. The AI keeps the raw stroke (its pickStroke already gates legality),
  // so a named-but-illegal AI stroke still carries its misfire risk.
  const requestedStroke: StrokeId = input.timingAim
    ? downgradeIfFaulted(strokeId, pl, shuttle)
    : strokeId;
  if (!shuttle.inPlay) return { player: pl, shuttle, hitstop: 0 };

  // Hit volume is centred on the RACKET HEAD (held out toward the net), not the body —
  // a ball in front is caught at arm's length, one behind your back is out of reach. A
  // dive is a flat lunge of the whole body, so it reaches from the body centre instead.
  const hitFrom = diving ? pl.pos : racketCenter(pl.pos, side);
  const dx = shuttle.pos.x - hitFrom.x;
  const dy = shuttle.pos.y - hitFrom.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  // Diving extends both the floor reach and the height ceiling — that's the point.
  const reach = diving ? SWING_REACH + DIVE_REACH_BONUS : SWING_REACH;
  const reachZ = diving ? SWING_REACH_Z + DIVE_REACH_BONUS : SWING_REACH_Z;
  const reachable = dist <= reach && shuttle.z <= reachZ;

  // A dive return is always a scrappy flat "drive" save, regardless of the held
  // stroke — you're lunging, not setting up a smash.
  const effectiveStroke: StrokeId = diving ? 'drive' : requestedStroke;

  if (!reachable) {
    // Mid-dive and the ball isn't in extended reach yet: keep lunging, no whiff.
    if (diving) return { player: pl, shuttle, hitstop: 0 };
    // A normal swing that misses still costs cooldown + stamina (commitment).
    const committed: PlayerState = {
      ...pl,
      swingCooldown: SWING_COOLDOWN_FRAMES,
      stamina: Math.max(0, pl.stamina - SWING_COST),
      facing: side === 0 ? 'left' : 'right',
      lastStroke: strokeId,
      lastQuality: 'miss',
    };
    return { player: committed, shuttle, hitstop: 0 };
  }

  // ---- Timing: how close is the shuttle to the ideal contact moment? ----
  // The signed delta (early = +, late = −) drives BOTH a quality bucket (power +
  // accuracy) AND, for the human, the left/right placement. A dive auto-connects
  // (no timing — it's a desperate save, always "good", dead-center).
  const dt = diving ? 0 : timingDelta(shuttle);
  const quality: SwingQuality = diving ? 'good' : qualityFromDelta(dt, shuttle.vz);
  const accuracy = ACCURACY[quality];
  const power = POWER[quality];

  const committed: PlayerState = {
    ...pl,
    swingCooldown: SWING_COOLDOWN_FRAMES,
    stamina: diving ? pl.stamina : Math.max(0, pl.stamina - SWING_COST),
    facing: side === 0 ? 'left' : 'right',
    lastStroke: effectiveStroke,
    lastQuality: quality,
    // Connecting on a dive ends the lunge immediately and starts the floor pin.
    diveFrames: diving ? 0 : pl.diveFrames,
    diveRecovery: diving ? DIVE_RECOVERY_FRAMES : pl.diveRecovery,
  };

  // Pick the stroke. A dive save bypasses fault gates (you just get it back); a
  // normal stroke can misfire if its fault condition isn't met (e.g. smashing a low
  // ball) — the risk that makes stroke *selection* matter, not just spamming swing.
  const stroke = STROKES[effectiveStroke] ?? STROKES.clear;
  if (!diving && faultMisfire(stroke, pl, shuttle)) {
    // Misfire: shuttle dribbles down on the hitter's own side -> they lose the rally.
    return {
      player: { ...committed, justHit: true, lastQuality: 'miss' },
      shuttle: { ...shuttle, vel: { x: 0, y: 0 }, vz: -2, lastHitBy: side },
      hitstop: 0,
    };
  }

  // LEFT/RIGHT placement: for the human (autoStroke), derive it from SWING TIMING —
  // an early swing (dt > 0) sends the ball LEFT, a late swing (dt < 0) sends it RIGHT,
  // dead-on goes center. We map the signed dt across the timing window to a continuous
  // aimX ∈ [−1,+1]. The AI keeps its explicit aimX (0 → auto-place away from human).
  // From the HITTER's own viewpoint "left" is screen-left; aimTargetForStroke takes
  // aimX as court-space left(−)/right(+), and for side 0 (near, facing up the court)
  // screen-left maps to court-left, so the sign passes through directly.
  const aimX = input.timingAim ? aimXFromTiming(dt) : input.aimX;
  const target = aimTargetForStroke(stroke.aim, side, opponent, aimX, input.aimY, accuracy);
  // DEPTH ERROR from mistimed contact (human only): an EARLY swing (dt>0) over-hits and
  // sails the shuttle LONG — past the baseline = OUT; a LATE swing (dt<0) under-hits and
  // drops it SHORT — into the net = 掛網. Perfect/good timing stays in; only a real
  // mistime risks a fault, so the timing window now governs in/out, not just placement.
  // The mistime that governs faults: the human supplies it through swing TIMING (dt); the
  // AI has no timing, so it injects a synthetic `faultBias` instead. Either way it flows
  // through the SAME depth-error (long → 出界) + net-dip (short → 掛網) below, so both sides
  // fault by one rule. A clean shot (human good-timing, AI faultBias 0) leaves this at 0.
  const faultDt = input.timingAim ? dt : (input.faultBias ?? 0);
  const aimed = faultDt !== 0 ? applyDepthError(target, faultDt, side) : target;
  const launch = solveArc(shuttle.pos, shuttle.z, aimed, stroke, power);
  // LATE (under-timed) swing: kill some up-velocity so the arc no longer clears the tape —
  // the shuttle dies in the net (掛網). solveArc always clears to its target, so this dip is
  // the ONLY way a too-late swing faults short. Applies to a human LATE mistime and to an AI
  // negative faultBias alike; a clean shot (faultDt ≥ 0) is untouched.
  if (faultDt < 0) {
    const dip = NET_DIP_MAX * mistimeSeverity(faultDt);
    if (dip > 0) launch.vz *= 1 - dip;
  }
  const hitstop = diving ? HITSTOP_WEAK : HITSTOP[quality];

  return {
    player: { ...committed, justHit: true },
    shuttle: { ...shuttle, vel: { x: launch.vx, y: launch.vy }, vz: launch.vz, lastHitBy: side },
    hitstop,
  };
}

/**
 * Signed ticks from the ideal contact moment (the tick the shuttle crosses STRIKE_Z
 * on its way down). POSITIVE = the ball is still ABOVE/ahead of the sweet spot, i.e.
 * you swung EARLY; NEGATIVE = you swung LATE (it already dropped past the spot). This
 * one number drives both the quality bucket and the human's left/right placement.
 */
function timingDelta(shuttle: ShuttleState): number {
  if (shuttle.vz <= 0) {
    // Falling (or flat): ticks until z hits STRIKE_Z under gravity from here. A ball
    // still above the spot → positive dt (early); already below → negative (late).
    const dz = shuttle.z - STRIKE_Z;
    // z(t) = z0 + vz t - 0.5 g t^2 = STRIKE_Z → 0.5 g t^2 - vz t - dz = 0, solve for t.
    const a = 0.5 * GRAVITY;
    const b = -shuttle.vz;
    const c = -dz;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const t = (-b + Math.sqrt(disc)) / (2 * a);
      // t>0 means the spot is in the future (ball above it) → early (+); the spot
      // already passed (ball below) yields t<0 from the root → late (−). Mirror sign.
      return t;
    }
    return dz / 4; // above spot → +, below → − (coarse proxy when no real root)
  }
  // Rising: you swung early; gap measured as ticks to apex + a bit. Always early (+).
  return shuttle.vz / GRAVITY + Math.abs(shuttle.z - STRIKE_Z) / 12;
}

/** Bucket a signed timing delta into a quality (power + accuracy tier). */
function qualityFromDelta(dt: number, vz: number): SwingQuality {
  const a = Math.abs(dt);
  if (a <= TIMING_PERFECT) return 'perfect';
  if (a <= TIMING_GOOD) return 'good';
  // Outside good (in or past the window): a weak off-timed contact. Early if the ball
  // was still high/ahead (dt>0 or rising), else late.
  return dt > 0 || vz > 0 ? 'early' : 'late';
}

/**
 * Map a signed timing delta to a continuous left/right aim ∈ [−1,+1]. EARLY (dt>0) →
 * LEFT (negative aimX); LATE (dt<0) → RIGHT (positive aimX); dead-on → center. We
 * scale by TIMING_WINDOW so a normal mistime spans most of the court and clamp the
 * extremes — the placement is gentle near perfect timing and decisive at the edges.
 */
function aimXFromTiming(dt: number): number {
  // dt>0 (early) should give aimX<0 (left): negate. Scale so |dt|=TIMING_WINDOW maps
  // to a full-court ±1.
  return clamp(-dt / TIMING_WINDOW, -1, 1);
}

// A fully-mistimed swing's depth error. LONG pushes the landing well PAST the opponent
// baseline (out): a perfect clear lands ~140px inside the court, so 220 sails it clean
// over the line at full severity, and clips it near the line partway. NET_DIP is the
// fraction the up-velocity is killed on a bad LATE swing — under-hit, the arc no longer
// clears the tape and the shuttle dies in the net (掛網). Both ramp in only past "good".
// A fully over-hit (early) swing lands THIS far past the opponent baseline (out of
// court, y<0 for side 0). Absolute target so the fault doesn't depend on where the
// accuracy-collapsed aim started — a hard mistime always sails out.
// Air-drag (SHUTTLE_DRAG) bleeds horizontal speed, so the shuttle lands well SHORT of
// its solveArc target (a clear aimed at the y≈24 baseline actually lands ~y140). To make
// a worst over-hit truly clear the line we must AIM far past it; this deep phantom target,
// after drag, lands just outside the court. Tuned by smoke until d≥window mistimes go out.
const OUT_OVERSHOOT = 360; // px the worst over-hit AIMS past the baseline (pre-drag)
const NET_DIP_MAX = 0.55; // max fraction of launch vz killed by a severe under-timed (late) swing

/** Severity 0→1 of a mistime, measured past the "good" window up to the window edge. */
function mistimeSeverity(dt: number): number {
  const a = Math.abs(dt);
  if (a <= TIMING_GOOD) return 0;
  const span = Math.max(1, TIMING_WINDOW - TIMING_GOOD);
  return clamp((a - TIMING_GOOD) / span, 0, 1);
}

/**
 * Shift a landing target's DEPTH for an EARLY (over-hit) swing so it sails LONG — past
 * the opponent's baseline = OUT. A LATE swing isn't pushed here (moving the target can't
 * make the arc fall short — solveArc always clears the net to its target); the late fault
 * is the net-dip below. Ramps in only past the "good" window so a clean shot stays in.
 *
 * `side` is the HITTER's side: side 0 hits toward the far half (small y, baseline at
 * y≈0), so "long" means SMALLER y; side 1 is mirrored.
 */
function applyDepthError(target: Vec2, dt: number, side: Side): Vec2 {
  if (dt <= 0) return target; // only an EARLY (over-hit) swing sails long
  const sev = mistimeSeverity(dt);
  if (sev === 0) return target;
  // Lerp the landing depth from where it was aimed toward a point just OUTSIDE the far
  // baseline, by severity — at full mistime it sails clear of the line (out), partway it
  // clips near it (still in, but deep). Absolute outside-point so the result doesn't
  // depend on the accuracy-collapsed start; x (left/right) is left alone.
  const outsideBaseline = side === 0 ? -OUT_OVERSHOOT : COURT.depth + OUT_OVERSHOOT;
  return { x: target.x, y: lerp(target.y, outsideBaseline, sev) };
}

/**
 * The human taps a stroke key directly, but some strokes are illegal in the current
 * context (a smash needs a high ball, a drop needs to be near the net). Rather than
 * punish the player with a whiff for tapping a key they can't legally play, we DOWNGRADE
 * an impossible stroke to a safe clear. A legal stroke passes through unchanged. (The AI
 * skips this — its named-but-illegal strokes still carry the misfire risk.)
 */
function downgradeIfFaulted(strokeId: StrokeId, pl: PlayerState, shuttle: ShuttleState): StrokeId {
  const stroke = STROKES[strokeId] ?? STROKES.clear;
  return faultMisfire(stroke, pl, shuttle) ? 'clear' : strokeId;
}

/** Per-quality placement accuracy (0..1): how precisely the aim lands. */
const ACCURACY: Record<SwingQuality, number> = {
  perfect: 1.0,
  good: 0.8,
  early: 0.45,
  late: 0.45,
  miss: 0.2,
};

/** Per-quality power multiplier on launch speed (a perfect shot flies fastest). */
const POWER: Record<SwingQuality, number> = {
  perfect: 1.15,
  good: 1.0,
  early: 0.78,
  late: 0.78,
  miss: 0.6,
};

/** Per-quality hit-stop freeze frames (weight on a clean connect). */
const HITSTOP: Record<SwingQuality, number> = {
  perfect: HITSTOP_PERFECT,
  good: HITSTOP_GOOD,
  early: HITSTOP_WEAK,
  late: HITSTOP_WEAK,
  miss: 0,
};

/** True if the stroke's contact condition fails -> the shot misfires. */
function faultMisfire(stroke: StrokeProfile, pl: PlayerState, shuttle: ShuttleState): boolean {
  const f = stroke.fault;
  if (!f) return false;
  if (f.kind === 'min-contact-z') return shuttle.z < f.z; // ball too low to attack
  if (f.kind === 'max-net-dist') return distToNet(pl.pos) > f.dist; // too far from net to feather
  return false;
}

/**
 * Solve a launch from (pos,z0) to floor `target` using a stroke's apex + tof clamp.
 * We FIX the apex height per stroke (a clear floats high, a smash stays flat),
 * derive the up velocity and time-of-flight from that apex, then split the
 * horizontal displacement across the flight clamped to the stroke's speed band.
 *
 * `power` (from swing timing, default 1) scales the HORIZONTAL launch speed: a
 * perfect-timed shot flies flatter and faster toward the target, a mistimed one
 * is sluggish. We leave the vertical solve untouched so the arc still clears the
 * net — power changes pace, not whether the shuttle makes it over.
 */
function solveArc(
  pos: Vec2,
  z0: number,
  target: Vec2,
  stroke: StrokeProfile,
  power = 1,
): { vx: number; vy: number; vz: number } {
  const dx = target.x - pos.x;
  const dy = target.y - pos.y;

  // We solve the whole arc against ONE flight time `tof`, so the horizontal landing
  // and the vertical drop-to-floor stay consistent (change tof and BOTH adapt — no
  // landing-short bug). The global SHUTTLE_PACE sets a base calm/readable speed; each
  // stroke's own `pace` then OVERRIDES it (smash <1 rockets, drop >1 floats) so the
  // four shots have distinct signature speeds. `power` (swing timing) shortens the
  // flight further — a perfect-timed shot flies flatter and faster.
  const apex = Math.max(stroke.apex, z0 + 12);
  const baseVz = Math.sqrt(2 * GRAVITY * (apex - z0));
  const tRise = baseVz / GRAVITY;
  const tFall = Math.sqrt((2 * apex) / GRAVITY);
  const tofRaw = clamp(tRise + tFall, stroke.tof[0], stroke.tof[1]);
  let tof = (tofRaw * SHUTTLE_PACE * stroke.pace) / power;

  // Given the (paced) flight time, derive the up-velocity that returns the shuttle to
  // the floor exactly when it reaches `target` horizontally: solve z(tof)=0 for vz,
  // i.e. 0 = z0 + vz·tof − 0.5·g·tof² → vz = (0.5·g·tof² − z0) / tof. This keeps the
  // arc self-consistent (it always lands on the floor at the target).
  let vz = (0.5 * GRAVITY * tof * tof - z0) / tof;

  // CAP the arc height. A long paced flight makes vz (and so apex = z0 + vz²/2g) balloon
  // — a floaty clear/drop could otherwise rocket off the top of the screen. If the peak
  // exceeds APEX_CEIL, clamp vz to that ceiling and SHORTEN tof to the flight that still
  // lands on the floor at the target with this gentler vz (solve 0 = z0 + vz·t − ½g·t²).
  // Keeps every shot on-screen and readable without distorting where it lands.
  const apexPeak = z0 + (vz * vz) / (2 * GRAVITY);
  if (vz > 0 && apexPeak > APEX_CEIL) {
    vz = Math.sqrt(2 * GRAVITY * (APEX_CEIL - z0));
    tof = (vz + Math.sqrt(vz * vz + 2 * GRAVITY * z0)) / GRAVITY; // larger root of the fall
  }
  return { vx: dx / tof, vy: dy / tof, vz };
}

/** Block the shuttle if it crosses the net plane below net height. */
function applyNet(s: ShuttleState, prev: ShuttleState): ShuttleState {
  if (!s.inPlay) return s;
  const crossed = (prev.pos.y - NET_Y) * (s.pos.y - NET_Y) < 0; // changed sides this tick
  if (crossed && s.z < NET_HEIGHT) {
    // Hit the tape: drop it on the hitter's side, kill cross-court momentum.
    return {
      ...s,
      pos: { x: s.pos.x, y: prev.pos.y < NET_Y ? NET_Y - 6 : NET_Y + 6 },
      vel: { x: 0, y: 0 },
      vz: -Math.abs(s.vz) * 0.3,
    };
  }
  return s;
}

function launchServe(state: GameState): GameState {
  const serverPlayer = state.server === 0 ? state.p1 : state.p2;
  const pos: Vec2 = { x: serverPlayer.pos.x, y: serverPlayer.pos.y };
  // A serve is always a clean deep push to the MIDDLE of the receiver's half —
  // never a drop shot. Aiming deep guarantees it clears the net and gives the
  // receiver a fair, reachable ball (drop shots only happen mid-rally).
  const target = serveTarget(state.server);
  const launch = solveArc(pos, 90, target, STROKES.serve);
  const shuttle: ShuttleState = predictLanding({
    pos,
    z: 90,
    vel: { x: launch.vx, y: launch.vy },
    vz: launch.vz,
    lastHitBy: state.server,
    inPlay: true,
    landing: null,
    landingEta: 0,
  });
  return { ...state, phase: 'rally', shuttle };
}

/**
 * Serve landing spot: a fair MID-court push to the receiver's half. Aiming for the
 * middle (not the deep baseline) keeps the serve comfortably returnable — it descends
 * into the receiver's strike zone where they wait, instead of a floaty deep ball that
 * sails over their head and lands behind them. The deep serve was making every return
 * a miss (the rally-collapse bug).
 */
function serveTarget(server: Side): Vec2 {
  const y = server === 0 ? COURT.depth * 0.4 : COURT.depth * 0.6;
  return { x: COURT.width * 0.5, y };
}

function scorePoint(state: GameState): GameState {
  const { x, y } = state.shuttle.pos;
  // OUT OF BOUNDS: the shuttle landed outside the singles court (past a sideline or
  // beyond a baseline). A fault belongs to whoever HIT it last — they sailed it long
  // or wide, so they lose the rally regardless of which half it crossed into.
  const hitter = state.shuttle.lastHitBy;
  const outOfBounds = x < 0 || x > COURT.width || y < 0 || y > COURT.depth;
  let scoringSide: Side;
  if (outOfBounds && hitter !== null) {
    scoringSide = hitter === 0 ? 1 : 0; // the hitter loses
  } else {
    // In bounds: the side whose half the shuttle landed in LOSES the rally.
    const landedSide: Side = y > NET_Y ? 0 : 1; // near half = side 0
    scoringSide = landedSide === 0 ? 1 : 0;
  }

  const scores: [number, number] = [...state.scores];
  scores[scoringSide] += 1;

  const winner: Side | null = scores[scoringSide] >= POINTS_TO_WIN ? scoringSide : null;

  // Rally momentum for AI rubber-banding: the human is side 0. A human point pushes
  // momentum positive (AI will tighten up); an AI point pushes it negative (AI eases
  // off so the score stays close). Clamped so a long run can't run away. The AI reads
  // this in AIInput to scale its reaction; the sim only maintains the counter.
  const delta = scoringSide === 0 ? 1 : -1;
  const momentum = clamp(state.momentum + delta, -MOMENTUM_MAX, MOMENTUM_MAX);

  return {
    ...state,
    scores,
    phase: 'point',
    phaseTimer: 60,
    server: scoringSide,
    winner,
    momentum,
    shuttle: { ...state.shuttle, inPlay: false },
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
