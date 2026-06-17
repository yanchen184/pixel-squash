import {
  type GameState,
  type PlayerState,
  type ShuttleState,
  type Side,
  type Vec2,
  type Facing4,
  type SwingQuality,
  type DeadReason,
  type Wall,
  COURT,
  TIN_HEIGHT,
  FRONT_OUT_HEIGHT,
  WALL_HEIGHT,
  SERVE_LINE_Y,
  POINTS_TO_WIN,
  WIN_BY,
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
  WALL_BOUNCE,
  FRONT_WALL_BOUNCE,
  FLOOR_BOUNCE,
  HITSTOP_PERFECT,
  HITSTOP_GOOD,
  HITSTOP_WEAK,
  HITSTOP_FRONT_WALL,
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
  aimWallTarget,
  distToFrontWall,
  type WallTarget,
  type StrokeId,
  type StrokeProfile,
} from '@/data/strokes';

/**
 * Pure, deterministic step for the SQUASH game. Given a state + both players' inputs,
 * returns the NEXT state. No mutation, no Math.random, no Date — replays identically
 * (Phase-2 netcode foundation).
 *
 * The ball has a floor position (x,y) and a height z. y is the distance from the FRONT
 * WALL (y=0). Gravity pulls z down; a hit launches it in an arc toward a point on the
 * front wall. The ball bounces off all four walls (and the floor). A rally ends when
 * the ball dies: hits the tin, flies out, bounces on the floor twice, or never reaches
 * the front wall valid zone.
 */

export const GRAVITY = 0.42; // height px / tick^2 (keep in sync with AIInput)
const SWING_COST = 8;
const STAMINA_REGEN = 0.5;
const EPS = 1; // small inset used to push the ball off a wall it just hit

export function step(state: GameState, inA: InputFrame, inB: InputFrame): GameState {
  if (state.winner !== null) return state;

  const frame = state.frame + 1;

  // PracticeRenderer shows the front wall — camera faces forward so the court depth is
  // flipped visually: screen-up = toward back wall (pos.y increases), screen-down = toward
  // front wall (pos.y decreases). Flip W/S for the human player so W moves toward back wall.
  if (state.gameMode === 'practice') {
    inA = { ...inA, moveY: (inA.moveY === 0 ? 0 : inA.moveY < 0 ? 1 : -1) as -1 | 0 | 1 };
  }

  // ---- Hit-stop: the whole sim is frozen while > 0 (weight on impact). ----
  if (state.hitstop > 0) {
    return { ...state, frame, hitstop: state.hitstop - 1 };
  }

  if (state.phase === 'serve' || state.phase === 'point') {
    const timer = state.phaseTimer - 1;
    if (timer > 0) {
      // During the countdown, let players reposition within their service box.
      if (state.phase === 'serve') {
        const p1s = movePlayer(state.p1, inA, 0, state.shuttle, state);
        const p2s = movePlayer(state.p2, inB, 1, state.shuttle, state);
        return { ...state, frame, phaseTimer: timer, p1: p1s, p2: p2s };
      }
      return { ...state, frame, phaseTimer: timer };
    }
    if (state.phase === 'point') return { ...resetForServe(state, state.server), frame };
    // Human server must choose a service box before the serve launches.
    if (state.awaitingServeChoice) {
      // Practice mode: skip box-choice overlay — auto-assign box and go straight to toss.
      if (state.gameMode === 'practice') {
        return { ...state, frame, awaitingServeChoice: false, serveSubPhase: 'toss' };
      }
      if (inA.serveLeft)  return { ...state, frame, serveBox: 0, awaitingServeChoice: false, phaseTimer: 40 };
      if (inA.serveRight) return { ...state, frame, serveBox: 1, awaitingServeChoice: false, phaseTimer: 40 };
      return { ...state, frame }; // keep waiting
    }
    // Practice mode: 3-step manual serve flow (toss → swing).
    if (state.gameMode === 'practice' && state.server === 0) {
      return stepPracticeServe({ ...state, frame }, inA);
    }
    return launchServe({ ...state, frame });
  }

  // ---- Rally tick ----
  let p1 = movePlayer(state.p1, inA, 0, state.shuttle, state);
  let p2 = movePlayer(state.p2, inB, 1, state.shuttle, state);

  let shuttle = stepBall(state.shuttle);

  let hitstop = 0;
  const r1 = resolveSwing(p1, inA, shuttle, 0, p2, state.rallyHitCount);
  p1 = r1.player;
  shuttle = r1.shuttle;
  hitstop = Math.max(hitstop, r1.hitstop);
  const r2 = resolveSwing(p2, inB, shuttle, 1, p1, state.rallyHitCount);
  p2 = r2.player;
  shuttle = r2.shuttle;
  hitstop = Math.max(hitstop, r2.hitstop);

  // Track rally hit count: increment whenever a new hit happened this tick.
  const hitThisTick = (r1.player.justHit || r2.player.justHit);
  const rallyHitCount = hitThisTick ? state.rallyHitCount + 1 : state.rallyHitCount;

  // Wall bounces (and tin/out fault detection) come AFTER swings, so a fresh hit this
  // tick gets a clean trajectory before we test it against the walls.
  const prevLastWall = state.shuttle.lastWall;
  shuttle = applyWalls(shuttle, state.shuttle);
  // Front-wall impact this tick → freeze for a few frames so it feels weighty.
  const frontWallHit = prevLastWall !== 'front' && shuttle.lastWall === 'front';
  if (frontWallHit) hitstop = Math.max(hitstop, HITSTOP_FRONT_WALL);
  shuttle = applyFloorBounce(shuttle, state.shuttle);
  shuttle = predictLanding(shuttle);

  // Practice mode: first front-wall hit → freeze ball on the wall so player can read
  // the rebound trajectory, then allow next serve.
  if (state.gameMode === 'practice' && frontWallHit) {
    // Compute where the rebound would land before freezing velocity
    const reboundLanding = predictLanding({ ...shuttle });
    const frozenShuttle = { ...reboundLanding, vel: { x: 0, y: 0 }, vz: 0, inPlay: false };
    return { ...state, frame, p1, p2, shuttle: frozenShuttle, hitstop: 0, rallyHitCount,
      serveSubPhase: 'toss' as const, phase: 'serve' as const, phaseTimer: 0 };
  }

  // Scoring: a dead-ball reason was set this tick (tin/out/double-bounce/not-front-wall).
  if (shuttle.inPlay && shuttle.deadReason !== null) {
    // Practice mode: reset rally without scoring instead of ending the point.
    if (state.gameMode === 'practice') {
      return { ...resetForServe({ ...state, frame, p1, p2, shuttle, hitstop: 0, rallyHitCount }, state.server), frame };
    }
    return scorePoint({ ...state, frame, p1, p2, shuttle, hitstop: 0, rallyHitCount });
  }

  return { ...state, frame, p1, p2, shuttle, hitstop, rallyHitCount };
}

function movePlayer(pl: PlayerState, input: InputFrame, side: Side, shuttle: ShuttleState, state?: GameState): PlayerState {
  const facing: Facing4 = 'up'; // both players face the front wall
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
    const ny = clampY(pl.pos.y + pl.diveDir.y * DIVE_SPEED);
    const remaining = pl.diveFrames - 1;
    return {
      ...baseFields,
      pos: { x: Math.round(nx), y: Math.round(ny) },
      vel: { x: pl.diveDir.x * DIVE_SPEED, y: pl.diveDir.y * DIVE_SPEED },
      stamina: pl.stamina,
      diveFrames: remaining,
      diveRecovery: remaining <= 0 ? DIVE_RECOVERY_FRAMES : 0,
    };
  }

  // --- Fresh dive trigger: lunge toward the move dir (or the ball if idle). ---
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

  // Magnetic assist (squash): both players share the court, so we only nudge the player
  // whose TURN it is to return — the one who did NOT hit the ball last and who is nearer
  // to the predicted landing than the other side would be. Avoids both players magnet-
  // locking onto the same ball and clogging the court.
  const mineToReturn = shuttle.lastHitBy !== null && shuttle.lastHitBy !== side;
  if (mineToReturn && shuttle.inPlay && shuttle.z <= SWING_REACH_Z) {
    const target = shuttle.landing ?? shuttle.pos;
    const gx = target.x - x;
    const gy = target.y - y;
    if (Math.hypot(gx, gy) <= SWING_MAGNET_RANGE) {
      x += gx * SWING_MAGNET_PULL;
      y += gy * SWING_MAGNET_PULL;
    }
  }

  x = clampX(x);
  y = clampY(y);

  // During the serve phase, constrain player movement to their service box so
  // the server is in the correct box and the receiver stays in the opposite box.
  if (state && state.phase === 'serve' && state.phaseTimer > 0) {
    const midX = COURT.width / 2;
    const isServer = side === state.server;
    const box = isServer ? state.serveBox : (state.serveBox === 0 ? 1 : 0);
    // Server stays in their service box (behind SERVE_LINE_Y, left or right of centre).
    // Receiver stays in opposite box.
    if (isServer) {
      // Server must be behind the short service line
      y = Math.max(y, SERVE_LINE_Y + PLAYER_MARGIN);
      // Server constrained to their box (left=x<midX, right=x>midX)
      if (box === 0) x = Math.min(x, midX - PLAYER_MARGIN);
      else x = Math.max(x, midX + PLAYER_MARGIN);
    } else {
      // Receiver stays in the opposite back box
      y = Math.max(y, SERVE_LINE_Y + PLAYER_MARGIN);
      if (box === 0) x = Math.min(x, midX - PLAYER_MARGIN);
      else x = Math.max(x, midX + PLAYER_MARGIN);
    }
    x = clampX(x);
    y = clampY(y);
  }

  return {
    ...baseFields,
    pos: { x: Math.round(x), y: Math.round(y) },
    vel: { x: input.moveX * speed, y: input.moveY * speed },
    stamina: Math.min(STAMINA_MAX, pl.stamina + STAMINA_REGEN),
  };
}

/** Pick the dive slide direction: the held move dir if any, else toward the ball. */
function diveDirection(input: InputFrame, pl: PlayerState, shuttle: ShuttleState): Vec2 {
  if (input.moveX !== 0 || input.moveY !== 0) {
    return normalize(input.moveX, input.moveY);
  }
  return normalize(shuttle.pos.x - pl.pos.x, shuttle.pos.y - pl.pos.y);
}

function normalize(x: number, y: number): Vec2 {
  const m = Math.sqrt(x * x + y * y);
  if (m < 1e-3) return { x: 0, y: 0 };
  return { x: x / m, y: y / m };
}

/** Constrain X to the playable court width (whole court — both players share it). */
function clampX(x: number): number {
  return clamp(x, PLAYER_MARGIN, COURT.width - PLAYER_MARGIN);
}

/** Constrain Y to the whole court depth — squash players roam the entire floor. */
function clampY(y: number): number {
  return clamp(y, PLAYER_MARGIN, COURT.depth - PLAYER_MARGIN);
}

function stepBall(s: ShuttleState): ShuttleState {
  if (!s.inPlay) return s;
  const vz = s.vz - GRAVITY;
  // A squash ball is rubber: horizontal speed barely bleeds (SHUTTLE_DRAG ≈ 0.998).
  // Energy is lost to wall bounces and gravity, not air drag — the ball pings around.
  return {
    ...s,
    pos: { x: s.pos.x + s.vel.x, y: s.pos.y + s.vel.y },
    vel: { x: s.vel.x * SHUTTLE_DRAG, y: s.vel.y * SHUTTLE_DRAG },
    z: s.z + vz,
    vz,
    deadReason: null, // cleared each physics tick; set again only if a fault occurs now
  };
}

/**
 * Bounce the ball off the four walls. The FRONT wall (y=0) is special: a strike there
 * is the legal target — but only if it lands between the tin and the out line. Below
 * the tin or above the out line is a fault (deadReason set, ball not reflected). Side
 * and back walls reflect with WALL_BOUNCE restitution and don't affect legality.
 */
function applyWalls(s: ShuttleState, prev: ShuttleState): ShuttleState {
  if (!s.inPlay) return s;
  let { x, y } = s.pos;
  let vx = s.vel.x;
  let vy = s.vel.y;
  let hitFrontWall = s.hitFrontWall;
  let bouncesSinceWall = s.bouncesSinceWall;
  let lastWall: Wall | null = s.lastWall;
  let deadReason: DeadReason | null = s.deadReason;

  // --- FRONT wall: ball crossed the plane y=0 moving toward it (y decreasing). ---
  if (prev.pos.y > 0 && y <= 0) {
    // Strike height: interpolate z at the moment y crossed 0 (linear between prev/cur).
    const span = prev.pos.y - y;
    const t = span > 1e-6 ? prev.pos.y / span : 0; // fraction of the step to reach y=0
    const hitZ = prev.z + (s.z - prev.z) * t;
    if (hitZ < TIN_HEIGHT) {
      deadReason = 'tin'; // struck the board — striker loses
      y = EPS;
      vy = Math.abs(vy) * FRONT_WALL_BOUNCE; // let it dribble back so it's visible
      lastWall = 'front';
    } else if (hitZ > FRONT_OUT_HEIGHT) {
      deadReason = 'out'; // above the out line — striker loses
      y = EPS;
      vy = Math.abs(vy) * FRONT_WALL_BOUNCE;
      lastWall = 'front';
    } else {
      // Legal front-wall hit: reflect, mark the shot as good, reset floor-bounce count.
      vy = Math.abs(vy) * FRONT_WALL_BOUNCE;
      y = EPS;
      hitFrontWall = true;
      bouncesSinceWall = 0;
      lastWall = 'front';
    }
  }

  // --- BACK wall: y >= depth. ---
  if (y >= COURT.depth) {
    vy = -Math.abs(vy) * WALL_BOUNCE;
    y = COURT.depth - EPS;
    lastWall = 'back';
  }

  // --- LEFT / RIGHT walls. ---
  if (x <= 0) {
    vx = Math.abs(vx) * WALL_BOUNCE;
    x = EPS;
    lastWall = 'left';
  } else if (x >= COURT.width) {
    vx = -Math.abs(vx) * WALL_BOUNCE;
    x = COURT.width - EPS;
    lastWall = 'right';
  }

  return { ...s, pos: { x, y }, vel: { x: vx, y: vy }, hitFrontWall, bouncesSinceWall, lastWall, deadReason };
}

/**
 * Bounce the ball off the floor (z crossing 0). Squash allows at most one floor bounce
 * before a player must return it; the SECOND bounce ends the rally. If the ball reaches
 * a floor bounce without ever hitting the front wall valid zone, the striker faulted.
 */
function applyFloorBounce(s: ShuttleState, _prev: ShuttleState): ShuttleState {
  if (!s.inPlay) return s;
  if (s.z > 0 || s.vz > 0) return s; // not landing this tick
  const bouncesSinceWall = s.bouncesSinceWall + 1;

  // Never reached the front wall valid zone before landing → striker faulted.
  if (!s.hitFrontWall) {
    return { ...s, z: 0, vz: 0, bouncesSinceWall, deadReason: s.deadReason ?? 'not-front-wall' };
  }

  if (bouncesSinceWall >= 2) {
    // Second floor bounce → the side that should have returned it loses (double bounce).
    return { ...s, z: 0, vz: 0, bouncesSinceWall, deadReason: s.deadReason ?? 'double-bounce' };
  }

  // First bounce after a good front-wall hit: pop back up so the opponent can return.
  return { ...s, z: EPS, vz: Math.abs(s.vz) * FLOOR_BOUNCE, bouncesSinceWall };
}

/**
 * Forward-integrate a copy of the ball — including wall and floor bounces — to find its
 * FIRST floor landing point (and ticks to it). Pure look-ahead; never mutates the live
 * ball. The renderer draws a shrinking marker here and the AI runs to it.
 */
function predictLanding(s: ShuttleState): ShuttleState {
  if (!s.inPlay) return { ...s, landing: null, landingEta: 0 };
  let x = s.pos.x;
  let y = s.pos.y;
  let z = s.z;
  let vx = s.vel.x;
  let vy = s.vel.y;
  let vz = s.vz;
  let prevY = y;
  let prevZ = z;
  let hitFront = s.hitFrontWall;
  let t = 0;
  const MAX = 300; // 5s cap
  while (t < MAX) {
    vz -= GRAVITY;
    x += vx;
    y += vy;
    z += vz;
    vx *= SHUTTLE_DRAG;
    vy *= SHUTTLE_DRAG;
    // Front wall
    if (prevY > 0 && y <= 0) {
      const span = prevY - y;
      const tt = span > 1e-6 ? prevY / span : 0;
      const hitZ = prevZ + (z - prevZ) * tt;
      if (hitZ >= TIN_HEIGHT && hitZ <= FRONT_OUT_HEIGHT) hitFront = true;
      vy = Math.abs(vy) * FRONT_WALL_BOUNCE;
      y = EPS;
    }
    if (y >= COURT.depth) {
      vy = -Math.abs(vy) * WALL_BOUNCE;
      y = COURT.depth - EPS;
    }
    if (x <= 0) {
      vx = Math.abs(vx) * WALL_BOUNCE;
      x = EPS;
    } else if (x >= COURT.width) {
      vx = -Math.abs(vx) * WALL_BOUNCE;
      x = COURT.width - EPS;
    }
    // Floor landing
    if (z <= 0 && vz <= 0) {
      if (hitFront) break; // first landing after a legal shot — this is the spot
      // a fault landing; still report the spot
      break;
    }
    prevY = y;
    prevZ = z;
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
  _opponent: PlayerState,
  rallyHitCount = 0,
): SwingResult {
  const swinging = input.swing;
  const strokeId = input.stroke;
  if (pl.diveRecovery > 0) return { player: pl, shuttle, hitstop: 0 };

  const diving = pl.diveFrames > 0;
  if (!diving && (!swinging || pl.swingCooldown > 0)) {
    return { player: pl, shuttle, hitstop: 0 };
  }

  // Human: auto-downgrade an illegal stroke to a safe drive rather than whiffing.
  const requestedStroke: StrokeId = input.timingAim
    ? downgradeIfFaulted(strokeId, pl, shuttle)
    : strokeId;
  if (!shuttle.inPlay) return { player: pl, shuttle, hitstop: 0 };

  const hitFrom = diving ? pl.pos : racketCenter(pl.pos, side);
  const dx = shuttle.pos.x - hitFrom.x;
  const dy = shuttle.pos.y - hitFrom.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const reach = diving ? SWING_REACH + DIVE_REACH_BONUS : SWING_REACH;
  const reachZ = diving ? SWING_REACH_Z + DIVE_REACH_BONUS : SWING_REACH_Z;
  const reachable = dist <= reach && shuttle.z <= reachZ;

  // A dive return is always a scrappy flat "drive" save.
  const effectiveStroke: StrokeId = diving ? 'drive' : requestedStroke;

  if (!reachable) {
    if (diving) return { player: pl, shuttle, hitstop: 0 };
    const committed: PlayerState = {
      ...pl,
      swingCooldown: SWING_COOLDOWN_FRAMES,
      stamina: Math.max(0, pl.stamina - SWING_COST),
      facing: 'up',
      lastStroke: strokeId,
      lastQuality: 'miss',
    };
    return { player: committed, shuttle, hitstop: 0 };
  }

  const dt = diving ? 0 : timingDelta(shuttle);
  const quality: SwingQuality = diving ? 'good' : qualityFromDelta(dt, shuttle.vz);
  const accuracy = ACCURACY[quality];
  const power = POWER[quality];

  const committed: PlayerState = {
    ...pl,
    swingCooldown: SWING_COOLDOWN_FRAMES,
    stamina: diving ? pl.stamina : Math.max(0, pl.stamina - SWING_COST),
    facing: 'up',
    lastStroke: effectiveStroke,
    lastQuality: quality,
    diveFrames: diving ? 0 : pl.diveFrames,
    diveRecovery: diving ? DIVE_RECOVERY_FRAMES : pl.diveRecovery,
  };

  const stroke = STROKES[effectiveStroke] ?? STROKES.drive;
  if (!diving && faultMisfire(stroke, pl, shuttle)) {
    // Misfire: ball dribbles, won't reach the front wall → striker loses.
    return {
      player: { ...committed, justHit: true, lastQuality: 'miss' },
      shuttle: { ...shuttle, vel: { x: 0, y: 0 }, vz: -2, lastHitBy: side, hitFrontWall: false, bouncesSinceWall: 0 },
      hitstop: 0,
    };
  }

  // LEFT/RIGHT on the FRONT WALL: human derives it from swing timing (early → left wall,
  // late → right wall); AI supplies an explicit aimX. The stroke sets the strike height.
  const aimX = input.timingAim ? aimXFromTiming(dt) : input.aimX;
  const wallTarget: WallTarget = aimWallTarget(stroke, pl.pos, aimX, input.aimY, accuracy);

  // TIMING fault (squash): an EARLY over-hit raises the front-wall strike point (over the
  // out line = OUT); a LATE under-hit lowers it (below the tin = dead). The human supplies
  // the mistime through swing timing (dt); the AI injects a synthetic faultBias. A clean
  // shot leaves the strike point untouched.
  const faultDt = input.timingAim ? dt : (input.faultBias ?? 0);
  const adjustedTarget = applyTimingFault(wallTarget, faultDt);

  // Dynamic pace: after 8 hits the ball accelerates slightly each hit (tension).
  const rallySpeedMod = rallyHitCount > 8 ? 1 - Math.min(0.18, (rallyHitCount - 8) * 0.03) : 1;
  const launch = solveArcToWall(shuttle.pos, shuttle.z, adjustedTarget, stroke, power, rallySpeedMod);
  const hitstop = diving ? HITSTOP_WEAK : HITSTOP[quality];

  return {
    player: { ...committed, justHit: true },
    shuttle: {
      ...shuttle,
      vel: { x: launch.vx, y: launch.vy },
      vz: launch.vz,
      lastHitBy: side,
      // A fresh swing resets the legality trackers — this shot must reach the front wall.
      hitFrontWall: false,
      bouncesSinceWall: 0,
      deadReason: null,
    },
    hitstop,
  };
}

/**
 * Signed ticks from the ideal contact moment. POSITIVE = ball above the sweet spot →
 * EARLY; NEGATIVE = already dropped past it → LATE. Drives the quality bucket and the
 * human's left/right front-wall placement.
 */
function timingDelta(shuttle: ShuttleState): number {
  if (shuttle.vz <= 0) {
    const dz = shuttle.z - STRIKE_Z;
    const a = 0.5 * GRAVITY;
    const b = -shuttle.vz;
    const c = -dz;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const t = (-b + Math.sqrt(disc)) / (2 * a);
      return t;
    }
    return dz / 4;
  }
  return shuttle.vz / GRAVITY + Math.abs(shuttle.z - STRIKE_Z) / 12;
}

function qualityFromDelta(dt: number, vz: number): SwingQuality {
  const a = Math.abs(dt);
  if (a <= TIMING_PERFECT) return 'perfect';
  if (a <= TIMING_GOOD) return 'good';
  return dt > 0 || vz > 0 ? 'early' : 'late';
}

/** Map a signed timing delta to a continuous left/right aim ∈ [−1,+1]. Early → left. */
function aimXFromTiming(dt: number): number {
  return clamp(-dt / TIMING_WINDOW, -1, 1);
}

const OUT_OVERSHOOT = 300; // px the worst over-hit raises the front-wall strike point
const TIN_UNDERSHOOT = 30; // px BELOW the tin the worst under-hit drops the strike point

/** Severity 0→1 of a mistime, measured past the "good" window up to the window edge. */
function mistimeSeverity(dt: number): number {
  const a = Math.abs(dt);
  if (a <= TIMING_GOOD) return 0;
  const span = Math.max(1, TIMING_WINDOW - TIMING_GOOD);
  return clamp((a - TIMING_GOOD) / span, 0, 1);
}

/**
 * Shift the front-wall strike point for a mistimed swing. EARLY (over-hit, dt>0) raises
 * the strike z toward / past the out line (OUT); LATE (under-hit, dt<0) lowers it toward
 * / below the tin (dead). Ramps in only past the "good" window so a clean shot stays in.
 */
function applyTimingFault(target: WallTarget, dt: number): WallTarget {
  const sev = mistimeSeverity(dt);
  if (sev === 0) return target;
  if (dt > 0) {
    // over-hit: raise the strike point above the out line at full severity
    const high = FRONT_OUT_HEIGHT + OUT_OVERSHOOT;
    return { ...target, z: lerp(target.z, high, sev), wall: target.wall };
  }
  // under-hit: drop the strike point toward / below the tin at full severity, so a
  // severe late swing genuinely hits the board (z < TIN_HEIGHT) rather than merely
  // dipping low-but-legal.
  const low = TIN_HEIGHT - TIN_UNDERSHOOT;
  return { ...target, z: lerp(target.z, low, sev), wall: target.wall };
}

function downgradeIfFaulted(strokeId: StrokeId, pl: PlayerState, shuttle: ShuttleState): StrokeId {
  const stroke = STROKES[strokeId] ?? STROKES.drive;
  return faultMisfire(stroke, pl, shuttle) ? 'drive' : strokeId;
}

const ACCURACY: Record<SwingQuality, number> = {
  perfect: 1.0,
  good: 0.8,
  early: 0.45,
  late: 0.45,
  miss: 0.2,
};

const POWER: Record<SwingQuality, number> = {
  perfect: 1.15,
  good: 1.0,
  early: 0.78,
  late: 0.78,
  miss: 0.6,
};

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
  if (f.kind === 'min-contact-z') return shuttle.z < f.z; // ball too low to kill
  if (f.kind === 'max-front-dist') return distToFrontWall(pl.pos) > f.dist; // too far from front wall to feather a drop
  if (f.kind === 'need-angle') {
    // boast needs the ball off to one side (near a side wall) to angle off it
    const nearSide = Math.min(shuttle.pos.x, COURT.width - shuttle.pos.x);
    return nearSide > f.maxX;
  }
  return false;
}

/**
 * Solve a launch from (pos,z0) to a point on the FRONT WALL (plane y=0) at height
 * `target.z` and horizontal `target.x`. We pick a flight time from the stroke's band
 * (scaled by global pace, the stroke's own pace, and swing power), derive the
 * horizontal velocities to reach the wall point in that time, then solve the vertical
 * velocity that puts the ball at height target.z when it reaches the wall.
 *
 * boast (target.wall === 'side'): aim at a SIDE wall point instead; the physics then
 * carries the ball off the side wall toward the front wall on its own.
 */
function solveArcToWall(
  pos: Vec2,
  z0: number,
  target: WallTarget,
  stroke: StrokeProfile,
  power = 1,
  rallySpeedMod = 1,
): { vx: number; vy: number; vz: number } {
  // Target point in 3D the ball should pass through.
  let tx = target.x;
  let ty = 0; // front wall plane
  if (target.wall === 'side') {
    // Side-wall boast: target a point on the near side wall, partway to the front.
    tx = target.x; // already a side-wall x (0 or width) from aimWallTarget
    ty = target.sideY ?? COURT.depth * 0.4;
  }
  const dx = tx - pos.x;
  const dy = ty - pos.y;

  // Flight time to the wall point: stroke band, scaled by global pace / stroke pace,
  // shortened by power (a perfect-timed shot flies flatter and faster).
  const tofRaw = clamp((stroke.tof[0] + stroke.tof[1]) / 2, stroke.tof[0], stroke.tof[1]);
  let tof = (tofRaw * SHUTTLE_PACE * stroke.pace * rallySpeedMod) / power;

  const vx = dx / tof;
  const vy = dy / tof;

  // Vertical: solve z(tof) = target.z, i.e. z0 + vz·tof − 0.5·g·tof² = target.z.
  let vz = (target.z - z0 + 0.5 * GRAVITY * tof * tof) / tof;

  // Cap the arc apex so a high lob never flies off-screen — but ONLY for a LEGAL target
  // (inside the tin/out band). An intentional fault (target z above the out line) must be
  // allowed to actually sail out; capping it would silently turn every over-hit back into
  // a legal shot, which kills the timing-fault risk entirely.
  const legalTarget = target.z >= TIN_HEIGHT && target.z <= FRONT_OUT_HEIGHT;
  const apexPeak = z0 + (vz > 0 ? (vz * vz) / (2 * GRAVITY) : 0);
  if (legalTarget && vz > 0 && apexPeak > APEX_CEIL) {
    vz = Math.sqrt(2 * GRAVITY * Math.max(0, APEX_CEIL - z0));
    // keep tof consistent-ish; vx/vy already aim at the wall, the lower vz just means a
    // flatter approach — acceptable for a capped lob.
  }
  return { vx, vy, vz };
}

export type PathPoint = { x: number; y: number; z: number; wall?: 'front' | 'back' | 'left' | 'right' | 'floor' };

/**
 * Simulate ball trajectory from a starting state, sampling points every N ticks.
 * Returns path points (3D game-space) and marks wall/floor contacts.
 * Stops after floor landing (first bounce after front wall hit) or 400 ticks.
 */
export function sampleServePath(
  startPos: { x: number; y: number },
  startZ: number,
  vel: { x: number; y: number },
  vz: number,
  sampleEvery = 3,
): PathPoint[] {
  const points: PathPoint[] = [{ x: startPos.x, y: startPos.y, z: startZ }];
  let x = startPos.x, y = startPos.y, z = startZ;
  let vx = vel.x, vy = vel.y, curVz = vz;
  let prevY = y, prevZ = z;
  const MAX = 400;
  for (let t = 1; t <= MAX; t++) {
    curVz -= GRAVITY;
    x += vx;
    y += vy;
    z += curVz;
    vx *= SHUTTLE_DRAG;
    vy *= SHUTTLE_DRAG;

    // Front wall
    if (prevY > 0 && y <= 0) {
      const span = prevY - y;
      const frac = span > 1e-6 ? prevY / span : 0;
      const hitZ = prevZ + (z - prevZ) * frac;
      points.push({ x, y: 0, z: hitZ, wall: 'front' });
      vy = Math.abs(vy) * FRONT_WALL_BOUNCE;
      y = EPS;
    }
    // Back wall
    if (y >= COURT.depth) {
      points.push({ x, y: COURT.depth, z, wall: 'back' });
      vy = -Math.abs(vy) * WALL_BOUNCE;
      y = COURT.depth - EPS;
    }
    // Side walls
    if (x <= 0) {
      points.push({ x: 0, y, z, wall: 'left' });
      vx = Math.abs(vx) * WALL_BOUNCE;
      x = EPS;
    } else if (x >= COURT.width) {
      points.push({ x: COURT.width, y, z, wall: 'right' });
      vx = -Math.abs(vx) * WALL_BOUNCE;
      x = COURT.width - EPS;
    }
    // Floor
    if (z <= 0 && curVz <= 0) {
      points.push({ x, y, z: 0, wall: 'floor' });
      break;
    }
    if (t % sampleEvery === 0) points.push({ x, y, z });
    prevY = y;
    prevZ = z;
  }
  return points;
}

/**
 * Practice-mode 3-step serve:
 *   'choice'  — pick L/R box (reuses awaitingServeChoice, handled above; lands here with null after countdown)
 *   'toss'    — press any swing key → ball pops up (small toss arc)
 *   'swing'   — ball in the air; press swing key → hit with that stroke type
 */
function stepPracticeServe(state: GameState, inA: InputFrame): GameState {
  const sub = state.serveSubPhase;

  // ── toss: waiting for player to choose stroke type ──
  if (sub === 'toss') {
    if (inA.swing) {
      // Any swing key → show full preview path; ball stays at player pos
      const path = computePreviewPath(state.p1.pos, inA.stroke, state);
      return {
        ...state,
        serveSubPhase: 'preview',
        previewPath: path,
        previewStroke: inA.stroke,
        previewStep: -1,
      };
    }
    const p1s = movePlayer(state.p1, inA, 0, state.shuttle, state);
    return { ...state, p1: p1s };
  }

  // ── preview: path visible; M advances ball stop-by-stop; swing keys work normally ──
  if (sub === 'preview') {
    const path = state.previewPath ?? [];
    const stops = path.filter(p => p.wall != null);

    // M key → advance ball to next wall-contact stop (or launch if exhausted)
    if (inA.nextStop) {
      const nextStep = state.previewStep + 1;

      if (nextStep < stops.length) {
        const stop = stops[nextStep];
        // Wall contact y: front=0, back=COURT.depth, side walls keep current flight y
        const wallY =
          stop.wall === 'front' ? 0 :
          stop.wall === 'back'  ? COURT.depth :
          stop.wall === 'floor' ? (stop.y ?? state.shuttle.pos.y) :
          stop.y ?? state.shuttle.pos.y;
        const stoppedShuttle = {
          ...state.shuttle,
          pos: { x: stop.x, y: wallY },
          z: stop.wall === 'floor' ? 0 : stop.z,
          vel: { x: 0, y: 0 }, vz: 0,
          inPlay: false,
          lastHitBy: null as null,
        };
        const p1s = movePlayer(state.p1, inA, 0, stoppedShuttle, state);
        return { ...state, previewStep: nextStep, shuttle: stoppedShuttle, p1: p1s };
      }

      // All stops visited → enter rally with the ball launched
      const stroke = state.previewStroke ?? 'drive';
      const fakeShuttle = {
        pos: { x: state.p1.pos.x, y: state.p1.pos.y },
        z: 80,
        vel: { x: 0, y: 0 }, vz: 0,
        lastHitBy: null as null, inPlay: true,
        bouncesSinceWall: 0, hitFrontWall: false,
        lastWall: null as null, deadReason: null as null,
        landing: null as null, landingEta: 0,
      };
      return launchPracticeServe(
        { ...state, previewPath: null, previewStroke: null, previewStep: -1 },
        stroke,
        fakeShuttle,
      );
    }

    // Swing keys work normally — player can hit the ball during preview
    let p1 = movePlayer(state.p1, inA, 0, state.shuttle, state);
    if (inA.swing && state.shuttle.inPlay) {
      const r1 = resolveSwing(p1, inA, state.shuttle, 0, state.p2, state.rallyHitCount);
      if (r1.player.justHit) {
        // Player hit the ball → exit preview and go to rally
        return {
          ...state, p1: r1.player, shuttle: r1.shuttle,
          serveSubPhase: null, previewPath: null, previewStroke: null, previewStep: -1,
          phase: 'rally' as const,
        };
      }
      p1 = r1.player;
    }
    return { ...state, p1 };
  }

  // ── swing: legacy — kept for compatibility, now unused in practice flow ──
  if (sub === 'swing') {
    let shuttle = stepBall(state.shuttle);
    if (shuttle.z <= 30) {
      const p1s = movePlayer(state.p1, inA, 0, shuttle, state);
      return { ...state, serveSubPhase: 'toss',
        shuttle: { ...shuttle, inPlay: false, z: 60, vel: { x: 0, y: 0 }, vz: 0 }, p1: p1s };
    }
    if (inA.swing) return launchPracticeServe(state, inA.stroke, shuttle);
    const p1s = movePlayer(state.p1, inA, 0, shuttle, state);
    return { ...state, shuttle, p1: p1s };
  }

  return launchServe(state);
}

/** Compute serve preview path from player's current position for the given stroke. */
function computePreviewPath(
  playerPos: { x: number; y: number },
  strokeId: StrokeId,
  state: GameState,
): PathPoint[] {
  const z0 = 80;
  const receiverSide = state.serveBox === 0 ? 0.7 : 0.3;
  const straightSide = state.serveBox === 0 ? 0.3 : 0.7;
  // boast: aim past the near side wall so ball bounces off it first → front wall
  // serveBox 0 (left): player near left side → aim RIGHT wall (tx > COURT.width) → front
  // serveBox 1 (right): player near right side → aim LEFT wall (tx < 0) → front
  const boastSide = state.serveBox === 0 ? 1.35 : -0.35; // tx overflows to side wall

  let wallZ: number, tof1: number, aimX: number;
  switch (strokeId) {
    case 'kill':  wallZ = WALL_HEIGHT * 0.42; tof1 = 18; aimX = receiverSide; break;
    case 'lob':   wallZ = WALL_HEIGHT * 0.85; tof1 = 28; aimX = 0.5;          break; // straight, high → back wall
    case 'drop':  wallZ = WALL_HEIGHT * 0.48; tof1 = 26; aimX = straightSide; break;
    case 'boast': wallZ = WALL_HEIGHT * 0.52; tof1 = 22; aimX = boastSide;    break; // side wall first
    default:      wallZ = WALL_HEIGHT * 0.58; tof1 = 28; aimX = receiverSide;
  }
  const tx = COURT.width * aimX;
  const vx = (tx - playerPos.x) / tof1;
  const vy = (0 - playerPos.y) / tof1;
  const vz = (wallZ - z0 + 0.5 * GRAVITY * tof1 * tof1) / tof1;
  return sampleServePath(playerPos, z0, { x: vx, y: vy }, vz, 4);
}

/**
 * Launch a practice serve with stroke-type variations:
 *   kill  → low fast serve that hugs the front wall (opponent scrambles)
 *   lob   → high floaty serve to back corner
 *   drive → standard mid-height serve (default)
 *   drop  → angled softer serve toward front corner
 *   boast → same as drive for serves (boast is a rally shot)
 */
function launchPracticeServe(state: GameState, strokeId: StrokeId, tossedBall: ShuttleState): GameState {
  const pos: Vec2 = { x: tossedBall.pos.x, y: tossedBall.pos.y };
  const z0 = tossedBall.z > 40 ? tossedBall.z : 80; // ensure reasonable toss height

  // Each stroke targets a specific front-wall height and rebound landing zone.
  // tof1 = frames to reach front wall; wallZ = height at front wall (game-space px)
  // landingY = where the ball should land after rebounding (y=0 is front wall, depth=far)
  // aimX = left/right fraction of court width for the wall strike
  const receiverSide = state.serveBox === 0 ? 0.7 : 0.3;
  const straightSide = state.serveBox === 0 ? 0.3 : 0.7;
  const boastSide    = state.serveBox === 0 ? 1.35 : -0.35; // overshoot → side wall first

  let wallZ: number;
  let tof1: number;
  let aimX: number;

  switch (strokeId) {
    case 'kill':  wallZ = WALL_HEIGHT * 0.42; tof1 = 18; aimX = receiverSide; break;
    case 'lob':   wallZ = WALL_HEIGHT * 0.85; tof1 = 28; aimX = 0.5;          break;
    case 'drop':  wallZ = WALL_HEIGHT * 0.48; tof1 = 26; aimX = straightSide; break;
    case 'boast': wallZ = WALL_HEIGHT * 0.52; tof1 = 22; aimX = boastSide;    break;
    default:      wallZ = WALL_HEIGHT * 0.58; tof1 = 28; aimX = receiverSide;
  }

  const tx = COURT.width * aimX;

  // Velocity to reach front wall (y=0) in tof1 frames
  const vx = (tx - pos.x) / tof1;
  const vy = (0 - pos.y) / tof1;   // negative (toward front wall)
  const vz = (wallZ - z0 + 0.5 * GRAVITY * tof1 * tof1) / tof1;

  // After front-wall bounce: vy flips to positive (toward back), attenuated by FRONT_WALL_BOUNCE
  // We want ball to land at landingY. Time to reach floor after bounce:
  //   landingY = vy_after * tof2  →  tof2 = landingY / vy_after
  // We don't re-set vy — physics will handle the bounce. The tof1 already gives correct vy.
  // Trust FRONT_WALL_BOUNCE (0.95) to carry the ball naturally. The landingY above is design
  // intent; the actual landing is physics. The key is choosing tof1 that puts enough vy.
  // vy at wall = vy = -pos.y/tof1; after bounce = pos.y/tof1 * 0.95; land at ≈ pos.y * 0.95
  // So to reach landingY > pos.y we need smaller tof1 (faster = more energy).
  // The values above are tuned for these landing zones.

  const shuttle: ShuttleState = predictLanding({
    pos,
    z: z0,
    vel: { x: vx, y: vy },
    vz,
    lastHitBy: state.server,
    inPlay: true,
    bouncesSinceWall: 0,
    hitFrontWall: false,
    lastWall: null,
    deadReason: null,
    landing: null,
    landingEta: 0,
  });

  return { ...state, phase: 'rally', serveSubPhase: null, tossZ: 0, shuttle };
}

function launchServe(state: GameState): GameState {
  // Use a fixed serve origin inside the service box, close to the T.
  // Squash serves are made from close to the T — the front half of the service box.
  const midX = COURT.width / 2;
  const serveOriginX = state.serveBox === 0 ? midX * 0.55 : midX * 1.45;
  const pos: Vec2 = { x: serveOriginX, y: SERVE_LINE_Y * 0.65 }; // ~357px: front of service box
  // A serve strikes the front wall mid-high; the rebound must land in the diagonally
  // opposite back quarter (the receiver's box). Aim at a front-wall point biased toward
  // the receiver's side so the bounce carries diagonally back.
  const target = serveTarget(state.server, state.serveBox);
  // Compute velocities directly so the ball reaches the front wall at a legal height.
  // solveArcToWall with APEX_CEIL can produce a vz that makes z < TIN_HEIGHT at impact.
  // Instead, solve using only the floor-to-wall geometry:
  //   - horizontal: vx/vy solve for front wall at target.x, y=0 in tof frames
  //   - vertical: solve z(tof) = target.z with uncapped vz (serve high arc is allowed)
  const tof = 30; // fixed fast tof: fast serve that clears tin and carries ball to back of court
  const vx = (target.x - pos.x) / tof;
  const vy = (0 - pos.y) / tof; // y=0 is the front wall
  const vz = (target.z - 110 + 0.5 * GRAVITY * tof * tof) / tof;
  const launch = { vx, vy, vz };
  const shuttle: ShuttleState = predictLanding({
    pos,
    z: 110,
    vel: { x: launch.vx, y: launch.vy },
    vz: launch.vz,
    lastHitBy: state.server,
    inPlay: true,
    bouncesSinceWall: 0,
    hitFrontWall: false,
    lastWall: null,
    deadReason: null,
    landing: null,
    landingEta: 0,
  });
  return { ...state, phase: 'rally', shuttle };
}

/**
 * Serve front-wall target: strike the front wall mid-high, biased toward the side
 * OPPOSITE the server's box, so the rebound carries diagonally to the receiver's back
 * quarter — a fair, returnable serve (the squash diagonal serve rule).
 */
function serveTarget(_server: Side, serveBox: 0 | 1): WallTarget {
  // serveBox 1 (right) → aim front wall left of centre so it rebounds to the left back
  // quarter; serveBox 0 (left) → aim right. Keep it comfortably inside the court.
  const x = serveBox === 1 ? COURT.width * 0.35 : COURT.width * 0.65;
  return { x, z: WALL_HEIGHT * 0.55, wall: 'front' };
}

/**
 * Decide who loses the rally from the dead-ball reason set by physics.
 * - tin / out / not-front-wall: the STRIKER faulted → striker loses.
 * - double-bounce: the side that SHOULD have returned (the striker's opponent) loses.
 * PAR scoring (rally point): the winner of the rally scores AND serves next.
 */
function scorePoint(state: GameState): GameState {
  const hitter = state.shuttle.lastHitBy;
  const reason = state.shuttle.deadReason;

  let winnerSide: Side;
  if (reason === 'double-bounce') {
    // The striker hit a good ball the opponent failed to return → striker wins.
    winnerSide = hitter !== null ? hitter : state.server;
  } else {
    // tin / out / not-front-wall → striker faulted → opponent wins.
    winnerSide = hitter !== null ? ((hitter === 0 ? 1 : 0) as Side) : state.server;
  }

  const scores: [number, number] = [...state.scores];
  scores[winnerSide] += 1;

  // PAR-11, win by WIN_BY (deuce at 10-10 plays to a 2-point lead).
  const lead = scores[winnerSide] - scores[winnerSide === 0 ? 1 : 0];
  const winner: Side | null = scores[winnerSide] >= POINTS_TO_WIN && lead >= WIN_BY ? winnerSide : null;

  // Server alternates the service box on a point won by the current server; PAR gives
  // the rally winner the serve. Simplest consistent rule: winner serves, box flips.
  const serveBox: 0 | 1 = state.serveBox === 0 ? 1 : 0;

  const delta = winnerSide === 0 ? 1 : -1;
  const momentum = clamp(state.momentum + delta, -MOMENTUM_MAX, MOMENTUM_MAX);

  return {
    ...state,
    scores,
    phase: 'point',
    phaseTimer: 60,
    server: winnerSide,
    serveBox,
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
