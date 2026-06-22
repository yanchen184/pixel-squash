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
  SERVICE_BOX_SIZE,
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
  FLOOR_FRICTION,
  HITSTOP_PERFECT,
  HITSTOP_GOOD,
  HITSTOP_WEAK,
  HITSTOP_FRONT_WALL,
  MOMENTUM_MAX,
  PLAYER_SPEED,
  PLAYER_MARGIN,
  PLAYER_BODY_RADIUS,
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
const PRACTICE_TOSS_Z = 120; // height the practice toss lifts the ball to (inside SWING_REACH_Z)
// Real-toss serve tuning (strategy, not reaction):
const PRACTICE_TOSS_VZ = 6;     // upward velocity given to the tossed ball
const PRACTICE_SLOWMO = 0.18;   // gravity multiplier while airborne — very slow rise/fall
const PRACTICE_HIT_RANGE = 150; // horizontal distance (px) that counts as "near body" for a hit
const PRACTICE_MISS_HITSTOP = 18; // freeze frames after a missed (dropped) serve
// Stretch the practice-serve flight time so the launched ball travels at the same speed
// as a match serve (the practice serve starts deeper in the court, so the raw tof made it
// fly ~1.6–2.7× too fast). 1.65 lines the effective px/frame up with the match serve.
const PRACTICE_SERVE_SLOWDOWN = 1.65;
// Slow-motion factor for the M-key preview. Instead of replaying a pre-sampled path (which
// looked uneven — fast where path points were sparse, never decelerating), the preview now
// runs the REAL ball physics (stepBall → applyWalls → applyFloorBounce) one sub-step per
// tick, with displacement and gravity scaled by this factor. The ball therefore moves by its
// own velocity and slows naturally (air drag + floor friction), matching the calm pace of the
// toss (PRACTICE_SLOWMO = 0.18). 0.18 keeps the two in sync.
const PRACTICE_PREVIEW_SLOWMO = 0.18;
// Practice serves shed more horizontal speed on each floor bounce than a match rally, so the
// "last bounce" doesn't skid most of the way to the back wall (which read as "way too far" in
// the slow-motion preview). Match physics keep the livelier FLOOR_FRICTION (0.6); this lower
// value is applied ONLY to the practice serve flight (preview ball + its guide path), leaving
// match rallies untouched. 0.35 lands the 2nd bounce in the mid-front court for all strokes.
const PRACTICE_FLOOR_FRICTION = 0.35;

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

  // ---- Practice rally freeze (TEST AID) ----
  // M (nextStop edge) toggles a freeze on the LIVE ball so the tester can read the predicted
  // landing marker and walk to it before swinging. Default OFF — outside practice this whole
  // block is skipped and the player's free rally is untouched.
  if (state.gameMode === 'practice') {
    const toggled = inA.nextStop ? !state.rallyFrozen : state.rallyFrozen;
    if (toggled) {
      // Frozen: ball is held still (no flight, no walls, no death). Players may move freely and
      // swing. predictLanding keeps the marker fresh against the held ball. A connecting swing
      // relaunches the ball and lifts the freeze so normal physics resume next tick.
      let fp1 = movePlayer(state.p1, inA, 0, state.shuttle, state);
      let fp2 = movePlayer(state.p2, inB, 1, state.shuttle, state);
      let fshuttle = state.shuttle;
      let fhitstop = 0;
      const fr1 = resolveSwing(fp1, inA, fshuttle, 0, fp2, state.rallyHitCount);
      fp1 = fr1.player; fshuttle = fr1.shuttle; fhitstop = Math.max(fhitstop, fr1.hitstop);
      const fr2 = resolveSwing(fp2, inB, fshuttle, 1, fp1, state.rallyHitCount);
      fp2 = fr2.player; fshuttle = fr2.shuttle; fhitstop = Math.max(fhitstop, fr2.hitstop);
      const hitThisTick = fr1.player.justHit || fr2.player.justHit;
      fshuttle = predictLanding(fshuttle);
      return {
        ...state,
        frame,
        p1: fp1,
        p2: fp2,
        shuttle: fshuttle,
        hitstop: fhitstop,
        rallyHitCount: hitThisTick ? state.rallyHitCount + 1 : state.rallyHitCount,
        rallyFrozen: !hitThisTick, // a connecting swing lifts the freeze
      };
    }
  }

  // ---- Rally tick ----
  let p1 = movePlayer(state.p1, inA, 0, state.shuttle, state);
  let p2 = movePlayer(state.p2, inB, 1, state.shuttle, state);
  // Bodies can't overlap. Both AIs chase the same ball + recover to the same T, so
  // without this they fuse into one blob. Push them symmetrically apart along the
  // axis between their centres until they're a body-width clear.
  [p1, p2] = separatePlayers(p1, p2);

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
  // Practice rally uses the gentler PRACTICE_FLOOR_FRICTION so the live ball sheds the SAME
  // horizontal skid on its first bounce as the dashed preview path and the slow-mo preview
  // ball (both of which already pass PRACTICE_FLOOR_FRICTION). Without this the live serve ran
  // the match-default FLOOR_FRICTION (0.6) while the dashed guide ran 0.35, so the predicted
  // line and the real flight diverged after the first floor bounce ("球一開始的軌跡跟實際軌跡不同").
  const rallyFloorFriction = state.gameMode === 'practice' ? PRACTICE_FLOOR_FRICTION : FLOOR_FRICTION;
  shuttle = applyFloorBounce(shuttle, state.shuttle, rallyFloorFriction);
  shuttle = predictLanding(shuttle);

  // Practice free-rally mode: the front-wall hit is NOT a freeze point any more — the ball
  // rebounds and stays live so the player can chase it and keep the rally going (Bob: 自由對打).
  // The extra hit-stop above already gives the impact its weight.

  // Scoring: a dead-ball reason was set this tick (tin/out/double-bounce/not-front-wall).
  if (shuttle.inPlay && shuttle.deadReason !== null) {
    // Practice mode: reset rally without scoring instead of ending the point. Carry the
    // fault reason across the same-tick reset so the renderer can still play the tin/out
    // call (practice skips the 'point' phase the match renderer reads deadReason from).
    if (state.gameMode === 'practice') {
      return {
        ...resetForServe({ ...state, frame, p1, p2, shuttle, hitstop: 0, rallyHitCount }, state.server),
        frame,
        lastFaultReason: shuttle.deadReason,
      };
    }
    return scorePoint({ ...state, frame, p1, p2, shuttle, hitstop: 0, rallyHitCount });
  }

  return { ...state, frame, p1, p2, shuttle, hitstop, rallyHitCount, rallyFrozen: false };
}

/**
 * Resolve player-vs-player overlap. If the two centres are within 2×PLAYER_BODY_RADIUS,
 * push each out by half the penetration along the separating axis, then clamp back inside
 * the legal floor. Pure: returns new player objects (or the originals when already clear).
 * Degenerate case (exactly coincident) nudges them apart along x so the result is stable.
 */
function separatePlayers(a: PlayerState, b: PlayerState): [PlayerState, PlayerState] {
  const minDist = PLAYER_BODY_RADIUS * 2;
  let dx = b.pos.x - a.pos.x;
  let dy = b.pos.y - a.pos.y;
  let d = Math.sqrt(dx * dx + dy * dy);
  if (d >= minDist) return [a, b];
  if (d < 1e-3) { dx = 1; dy = 0; d = 1; } // coincident → split along x deterministically
  const push = (minDist - d) / 2;
  const ux = dx / d, uy = dy / d;
  const na = { ...a, pos: { x: clampX(a.pos.x - ux * push), y: clampY(a.pos.y - uy * push) } };
  const nb = { ...b, pos: { x: clampX(b.pos.x + ux * push), y: clampY(b.pos.y + uy * push) } };
  return [na, nb];
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
  // This also covers the whole practice manual-serve flow (toss/airborne/swing/
  // preview), so the server can only reposition inside their box while serving.
  // The serve-box clamp applies up to (and including) the actual serve strike. In practice
  // mode the human server is FREE the moment the ball leaves the racket — once the flow reaches
  // 'airborne'/'preview' (ball struck), they can roam the whole court to chase the rebound.
  const practiceServerFreed =
    state != null &&
    state.gameMode === 'practice' &&
    side === state.server &&
    (state.serveSubPhase === 'airborne' || state.serveSubPhase === 'preview');
  const inServeFlow =
    state != null &&
    state.phase === 'serve' &&
    (state.phaseTimer > 0 || state.serveSubPhase != null) &&
    !practiceServerFreed;
  if (state && inServeFlow) {
    const isServer = side === state.server;
    // Service boxes are 1.6m squares tucked into the back CORNERS against the side walls (WSF):
    //   left box  = [0, SERVICE_BOX_SIZE]   right box = [width - SERVICE_BOX_SIZE, width]
    // Practice mode lets the server pick their box by standing in either corner (no menu), so
    // the server may stand in EITHER corner box. The receiver (and match-mode server) is pinned
    // to the box dictated by serveBox.
    const freeChoice = state.gameMode === 'practice' && isServer;
    const box = isServer ? state.serveBox : (state.serveBox === 0 ? 1 : 0);
    // Behind the short service line for everyone in the serve flow.
    y = Math.max(y, SERVE_LINE_Y + PLAYER_MARGIN);
    if (freeChoice) {
      // Practice server picks their box by WALKING to a corner — keep them behind the short
      // line but free to cross the whole width, so they can reach either side wall. The legal
      // foot-in-box position is enforced by snapping x into the chosen corner box at toss time
      // (see stepPracticeServe), not by a sticky mid-court wall here.
      x = clampX(x);
    } else if (box === 0) {
      // Left corner box: [0, SERVICE_BOX_SIZE]
      x = clamp(x, PLAYER_MARGIN, SERVICE_BOX_SIZE - PLAYER_MARGIN);
    } else {
      // Right corner box: [width - SERVICE_BOX_SIZE, width]
      x = clamp(x, COURT.width - SERVICE_BOX_SIZE + PLAYER_MARGIN, COURT.width - PLAYER_MARGIN);
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

  // House rule: after the ball's ONE legal floor bounce, touching ANYTHING (a wall here,
  // a second floor bounce in applyFloorBounce, or a player in the swing check) ends the
  // rally — the side that should have returned it loses. So if the ball has already bounced
  // once since its last good front-wall hit, any wall contact this tick is fatal. We still
  // reflect it (so it dribbles visibly) but stamp the dead reason. Captured BEFORE the
  // front-wall block below, which would otherwise reset bouncesSinceWall to 0.
  const alreadyBounced = s.hitFrontWall && s.bouncesSinceWall >= 1;

  // True if the ball contacts any wall this tick (used by the post-bounce house rule below).
  let touchedWall = false;

  // --- FRONT wall: ball crossed the plane y=0 moving toward it (y decreasing). ---
  if (prev.pos.y > 0 && y <= 0) {
    touchedWall = true;
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
    touchedWall = true;
    vy = -Math.abs(vy) * WALL_BOUNCE;
    y = COURT.depth - EPS;
    lastWall = 'back';
  }

  // --- LEFT / RIGHT walls. ---
  if (x <= 0) {
    touchedWall = true;
    vx = Math.abs(vx) * WALL_BOUNCE;
    x = EPS;
    lastWall = 'left';
  } else if (x >= COURT.width) {
    touchedWall = true;
    vx = -Math.abs(vx) * WALL_BOUNCE;
    x = COURT.width - EPS;
    lastWall = 'right';
  }

  // House rule: a wall touched AFTER the ball already took its one legal floor bounce ends
  // the rally. Applies to any wall (including the front wall — a post-bounce front-wall
  // contact is no longer a fresh shot). We keep the reflection above so the dead ball
  // dribbles visibly, but stamp the dead reason if not already dead.
  if (alreadyBounced && touchedWall) {
    deadReason = deadReason ?? 'dead-after-bounce';
  }

  return { ...s, pos: { x, y }, vel: { x: vx, y: vy }, hitFrontWall, bouncesSinceWall, lastWall, deadReason };
}

/**
 * Bounce the ball off the floor (z crossing 0). Squash allows at most one floor bounce
 * before a player must return it; the SECOND bounce ends the rally. If the ball reaches
 * a floor bounce without ever hitting the front wall valid zone, the striker faulted.
 */
function applyFloorBounce(
  s: ShuttleState,
  _prev: ShuttleState,
  floorFriction: number = FLOOR_FRICTION,
): ShuttleState {
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
  // Horizontal speed sheds FLOOR_FRICTION too, so the ball doesn't skid across the
  // whole court on the rebound (which made lobs land absurdly far on the 2nd bounce).
  return {
    ...s,
    z: EPS,
    vz: Math.abs(s.vz) * FLOOR_BOUNCE,
    vel: { x: s.vel.x * floorFriction, y: s.vel.y * floorFriction },
    bouncesSinceWall,
  };
}

/**
 * 唯一的球體前進一步。所有路徑（live rally / M-preview / 落點預測 / 虛線取樣）都呼叫它，
 * 不准有第二份積分。dt<1 = 慢動作子步（位移與重力增量按 dt 縮放，阻力用 SHUTTLE_DRAG^dt
 * 確保 1/dt 個子步乘回來剛好等於每 tick 的 SHUTTLE_DRAG）。牆/地板反彈重用既有
 * applyWalls / applyFloorBounce，所以收斂後虛線與 live 在數學上不可能分岔。
 */
export interface StepOpts {
  dt: number;            // 子步比例：live=1，slowmo preview=PRACTICE_PREVIEW_SLOWMO
  floorFriction: number; // live=FLOOR_FRICTION，practice=PRACTICE_FLOOR_FRICTION
}

export function stepShuttle(s: ShuttleState, opts: StepOpts): ShuttleState {
  if (!s.inPlay) return s;
  const { dt, floorFriction } = opts;
  const vz = s.vz - GRAVITY * dt;
  const subDrag = dt === 1 ? SHUTTLE_DRAG : Math.pow(SHUTTLE_DRAG, dt);
  const moved: ShuttleState = {
    ...s,
    pos: { x: s.pos.x + s.vel.x * dt, y: s.pos.y + s.vel.y * dt },
    vel: { x: s.vel.x * subDrag, y: s.vel.y * subDrag },
    z: s.z + vz * dt,
    vz,
    deadReason: null,
  };
  const walled = applyWalls(moved, s);
  return applyFloorBounce(walled, s, floorFriction);
}

/**
 * Slow-motion physics sub-step for the M-key serve preview. Advances the ball by ONE real
 * physics tick but with displacement and the gravity increment scaled by `slowmo` (< 1), so
 * the ball drifts at a readable pace. Velocity itself is kept at its true magnitude — only
 * how far the ball travels per tick is slowed — so wall/floor restitution (FRONT_WALL_BOUNCE,
 * FLOOR_BOUNCE, FLOOR_FRICTION) behave exactly as in a live rally. This is what makes the
 * preview decelerate naturally (drag + floor friction) instead of replaying a pre-sampled
 * path at an uneven, never-slowing pace.
 */
function previewPhysicsStep(s: ShuttleState, slowmo: number): ShuttleState {
  if (!s.inPlay) return s;
  // Delegates to the single source of truth so the preview, the dashed guide and the live
  // rally share one integrator (drag is raised to the slowmo power inside stepShuttle).
  return stepShuttle(s, { dt: slowmo, floorFriction: PRACTICE_FLOOR_FRICTION });
}

/**
 * Forward-integrate a copy of the ball — including wall and floor bounces — to find its
 * FIRST floor landing point (and ticks to it). Pure look-ahead; never mutates the live
 * ball. The renderer draws a shrinking marker here and the AI runs to it.
 */
export function predictLanding(s: ShuttleState): ShuttleState {
  if (!s.inPlay) return { ...s, landing: null, landingEta: 0 };
  // Forward-integrate through the SAME stepShuttle the live rally uses, so the landing
  // marker / AI run-to point can't disagree with where the ball really lands. Uses match
  // FLOOR_FRICTION (preserves prior behaviour; AI run-to is a match-mode concern).
  let cur = { ...s };
  const opts: StepOpts = { dt: 1, floorFriction: FLOOR_FRICTION };
  const MAX = 300; // 5s cap
  for (let t = 1; t <= MAX; t++) {
    const prevBounces = cur.bouncesSinceWall;
    cur = stepShuttle(cur, opts);
    // First floor bounce after a legal shot (or any death) is the spot the marker/AI targets.
    if (cur.bouncesSinceWall > prevBounces || cur.deadReason != null) {
      return { ...s, landing: { x: cur.pos.x, y: cur.pos.y }, landingEta: t };
    }
  }
  return { ...s, landing: { x: cur.pos.x, y: cur.pos.y }, landingEta: MAX };
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

export type PathPoint = { x: number; y: number; z: number; wall?: 'front' | 'back' | 'left' | 'right' | 'floor' | 'out' | 'tin' };

/**
 * Simulate ball trajectory from a starting state, sampling points every N ticks.
 * Returns path points (3D game-space) and marks wall/floor contacts.
 *
 * Runs through the SECOND floor landing — that's the double-bounce that ends the
 * rally — so the preview shows both floor contacts (two floor rings) the way the real
 * point plays out. Caps at 400 ticks as a safety bound.
 */
export function sampleServePath(
  startPos: { x: number; y: number },
  startZ: number,
  vel: { x: number; y: number },
  vz: number,
  sampleEvery = 3,
  floorFriction: number = FLOOR_FRICTION,
): PathPoint[] {
  const points: PathPoint[] = [{ x: startPos.x, y: startPos.y, z: startZ }];
  // Integrate through the SAME stepShuttle the live rally uses, so the dashed guide and
  // the real ball cannot diverge. Wall/floor events are read off the returned state to
  // place the labelled PathPoints the renderer draws; tin/out get their dedicated visuals.
  let s: ShuttleState = {
    pos: { x: startPos.x, y: startPos.y }, z: startZ,
    vel: { x: vel.x, y: vel.y }, vz,
    inPlay: true, lastHitBy: 0, bouncesSinceWall: 0,
    hitFrontWall: false, lastWall: null, deadReason: null,
    landing: null, landingEta: 0,
  };
  const opts: StepOpts = { dt: 1, floorFriction };
  const MAX = 400;
  for (let t = 1; t <= MAX; t++) {
    const prevWall = s.lastWall;
    const prevBounces = s.bouncesSinceWall;
    s = stepShuttle(s, opts);

    // OUT: ball cleared the out line. stepShuttle already reflected it (and stamped
    // deadReason='out'); for the guide we instead let it sail forward + arc down so the
    // player sees the shot leave the court, then end. Mirrors the old preview visual.
    if (s.deadReason === 'out') {
      points.push({ x: s.pos.x, y: 0, z: s.z, wall: 'out' });
      let { x: ox, y: oy } = s.pos; let oz = s.z; let ovz = s.vz;
      const ovx = s.vel.x; const ovy = Math.abs(s.vel.y);
      for (let k = 1; k <= 8; k++) {
        ovz -= GRAVITY;
        ox += ovx; oy -= ovy; oz += ovz; // keep flying forward (out) + arc down
        points.push({ x: ox, y: oy, z: Math.max(oz, 0) });
      }
      break;
    }
    if (s.deadReason === 'tin') {
      points.push({ x: s.pos.x, y: 0, z: s.z, wall: 'tin' });
      break;
    }

    // Wall event: lastWall changed → drop a labelled point at the contact.
    if (s.lastWall !== prevWall && s.lastWall != null) {
      points.push({ x: s.pos.x, y: s.pos.y, z: s.z, wall: s.lastWall });
    }
    // Floor event: a bounce accrued → drop a floor point; 2nd bounce or any death ends it.
    if (s.bouncesSinceWall > prevBounces) {
      points.push({ x: s.pos.x, y: s.pos.y, z: 0, wall: 'floor' });
      if (s.bouncesSinceWall >= 2 || s.deadReason != null) break;
    }
    if (s.deadReason != null) break;

    if (t % sampleEvery === 0) points.push({ x: s.pos.x, y: s.pos.y, z: s.z });
  }
  return points;
}

/**
 * Z height the previewed/launched ball starts from when struck (must match launchPracticeServe's z0).
 */
const PREVIEW_START_Z = 80;

/**
 * Practice free-rally serve: the player's serve swing launches the ball LIVE into a normal
 * rally with real physics (instead of the old frozen M-by-M preview). The ball flies to the
 * front wall, rebounds, and the player chases it to keep the rally going — this is what makes
 * "swing ten times in a row" possible. The computed preview path is kept in `previewPath` so
 * the renderer can draw a PERSISTENT trail of where the serve went (Bob: 軌跡一直留著).
 */
function launchPracticeRally(state: GameState, stroke: StrokeId, path: PathPoint[]): GameState {
  const pos: Vec2 = { x: state.p1.pos.x, y: state.p1.pos.y };
  const vel = practiceServeVelocity(state, stroke, pos, PREVIEW_START_Z);
  const p1 = { ...state.p1, lastStroke: stroke, justHit: true, swingCooldown: SWING_COOLDOWN_FRAMES };
  return {
    ...state,
    phase: 'rally',
    serveSubPhase: null,
    previewPath: path,      // kept for the persistent trail overlay
    previewStroke: stroke,
    previewStep: -1,
    previewPathIdx: -1,
    rallyFrozen: false,     // start the rally live; M toggles the freeze test aid
    lastFaultReason: null,  // a fresh rally clears the previous fault marker
    rallyHitCount: 1,       // the serve counts as the first hit of the rally
    p1,
    shuttle: {
      ...state.shuttle,
      pos,
      z: PREVIEW_START_Z,
      vel: { x: vel.x, y: vel.y },
      vz: vel.vz,
      inPlay: true,
      lastHitBy: state.server,
      bouncesSinceWall: 0,
      hitFrontWall: false,
      lastWall: null,
      deadReason: null,
    },
  };
}

/**
 * Practice-mode 3-step serve:
 *   'choice'  — pick L/R box (reuses awaitingServeChoice, handled above; lands here with null after countdown)
 *   'toss'    — press any swing key → ball pops up (small toss arc)
 *   'swing'   — ball in the air; press swing key → hit with that stroke type
 */
function stepPracticeServe(state: GameState, inA: InputFrame): GameState {
  const sub = state.serveSubPhase;

  // ── toss: press M to toss the ball up; it then drifts in slow-motion ──
  if (sub === 'toss') {
    if (inA.nextStop) {
      // Real toss: give the ball an upward velocity so it genuinely rises and
      // falls (in slow-motion, see 'airborne'). This is a strategy game, not a
      // reaction game — the slow fall gives the player time to read the
      // opponent's position and choose a stroke before swinging.
      // The player picks their box by walking to a corner — lock serveBox in at toss time from
      // which half they're in, then snap their foot (and the ball) into that 160px corner box
      // so the serve starts from a legal position.
      const serveBox: 0 | 1 = state.p1.pos.x < COURT.width / 2 ? 0 : 1;
      const boxX = serveBox === 0
        ? clamp(state.p1.pos.x, PLAYER_MARGIN, SERVICE_BOX_SIZE - PLAYER_MARGIN)
        : clamp(state.p1.pos.x, COURT.width - SERVICE_BOX_SIZE + PLAYER_MARGIN, COURT.width - PLAYER_MARGIN);
      const p1 = { ...state.p1, pos: { x: Math.round(boxX), y: state.p1.pos.y } };
      const tossed = {
        ...state.shuttle,
        pos: { x: p1.pos.x, y: p1.pos.y },
        z: PRACTICE_TOSS_Z,
        vel: { x: 0, y: 0 },
        vz: PRACTICE_TOSS_VZ,
        inPlay: true,
        lastHitBy: null as null,
        bouncesSinceWall: 0,
        hitFrontWall: false,
        deadReason: null as null,
      };
      return { ...state, p1, shuttle: tossed, serveBox, serveSubPhase: 'airborne' };
    }
    const p1s = movePlayer(state.p1, inA, 0, state.shuttle, state);
    return { ...state, p1: p1s };
  }

  // ── airborne: tossed ball drifts up/down in slow-motion; swing near it to hit ──
  if (sub === 'airborne') {
    const sh = state.shuttle;
    // Slow-motion gravity so the player has time to decide where to place the
    // ball and which stroke to use. The ball never stops — it keeps drifting.
    const nvz = sh.vz - GRAVITY * PRACTICE_SLOWMO;
    const nz = sh.z + nvz;

    // Hit detection (simplified per design): a swing key counts as a hit when
    // the ball is horizontally near the player's body — height is forgiving so
    // the player isn't fighting a reaction-timing window.
    if (inA.swing) {
      const dx = sh.pos.x - state.p1.pos.x;
      const dy = sh.pos.y - state.p1.pos.y;
      const nearBody = Math.hypot(dx, dy) <= PRACTICE_HIT_RANGE;
      if (nearBody) {
        // Free-rally design: the serve swing launches the ball LIVE with real
        // physics into a normal rally (not the old frozen M-by-M preview), so the
        // player can chase the rebound and keep swinging. The path is kept only as
        // a persistent on-screen trail.
        const path = computePreviewPath(state.p1.pos, inA.stroke, state);
        return launchPracticeRally(state, inA.stroke, path);
      }
      // WHIFF: swung but the ball was out of reach. The swing still commits — set
      // the cooldown + a 'miss' quality (and crucially NOT justHit) so the renderer
      // can play the dedicated whiff animation. The ball keeps drifting; if it lands
      // they lose the point.
      if (state.p1.swingCooldown <= 0) {
        const whiffed: PlayerState = {
          ...state.p1,
          swingCooldown: SWING_COOLDOWN_FRAMES,
          facing: 'up',
          lastStroke: inA.stroke,
          lastQuality: 'miss',
          justHit: false,
        };
        const drifting = { ...sh, z: nz, vz: nvz };
        const p1s = movePlayer(whiffed, inA, 0, drifting, state);
        return { ...state, shuttle: drifting, p1: p1s };
      }
    }

    // Ball landed without a successful hit → missed serve → lose the point.
    if (nz <= 0 && nvz < 0) {
      return loseServeAttempt(state);
    }

    const drifting = { ...sh, z: nz, vz: nvz };
    const p1s = movePlayer(state.p1, inA, 0, drifting, state);
    return { ...state, shuttle: drifting, p1: p1s };
  }

  // ── swing: ball is up; press a stroke key (J/K/L/U/Space) to hit & show path ──
  if (sub === 'swing') {
    if (inA.swing) {
      const path = computePreviewPath(state.p1.pos, inA.stroke, state);
      return launchPracticeRally(state, inA.stroke, path);
    }
    const p1s = movePlayer(state.p1, inA, 0, state.shuttle, state);
    return { ...state, p1: p1s };
  }

  // ── preview: ball armed with its real serve velocity; M releases it to fly (real physics,
  //    slow-motion) until it hits a wall or the floor, where it freezes for the next M. ──
  if (sub === 'preview') {
    // previewPathIdx >= 0 → ball is flying (release one segment); -1 → frozen, waiting for M.
    if (state.previewPathIdx >= 0) {
      const before = state.shuttle;
      const after = previewPhysicsStep(before, PRACTICE_PREVIEW_SLOWMO);
      const p1s = movePlayer(state.p1, inA, 0, after, state);

      // The shot is dead (out / tin / 2nd-bounce / post-bounce wall) → hand to rally so the
      // normal scoring path resolves it, exactly as a launched serve would end.
      if (after.deadReason != null || after.bouncesSinceWall >= 2) {
        return {
          ...state,
          shuttle: after,
          p1: p1s,
          serveSubPhase: null,
          previewPath: null,
          previewStroke: null,
          previewStep: -1,
          previewPathIdx: -1,
          phase: 'rally' as const,
        };
      }

      // Reached a wall or its first floor bounce → freeze here and wait for the next M press.
      const hitWall = after.lastWall !== before.lastWall && after.lastWall != null;
      const bounced = after.bouncesSinceWall > before.bouncesSinceWall;
      if (hitWall || bounced) {
        return {
          ...state,
          shuttle: { ...after, vel: after.vel, vz: after.vz },
          p1: p1s,
          previewPathIdx: -1, // freeze; velocity is retained so the next M resumes the flight
        };
      }

      // Still mid-flight → keep gliding.
      return { ...state, shuttle: after, p1: p1s, previewPathIdx: 0 };
    }

    // Frozen. M releases the ball to continue its flight from the current (real) velocity.
    if (inA.nextStop) {
      const p1s = movePlayer(state.p1, inA, 0, state.shuttle, state);
      return { ...state, p1: p1s, previewPathIdx: 0 };
    }

    // Swing keys work normally — player can hit the frozen ball during preview
    let p1 = movePlayer(state.p1, inA, 0, state.shuttle, state);
    if (inA.swing && state.shuttle.inPlay) {
      const r1 = resolveSwing(p1, inA, state.shuttle, 0, state.p2, state.rallyHitCount);
      if (r1.player.justHit) {
        return {
          ...state, p1: r1.player, shuttle: r1.shuttle,
          serveSubPhase: null, previewPath: null, previewStroke: null,
          previewStep: -1, previewPathIdx: -1,
          phase: 'rally' as const,
        };
      }
      p1 = r1.player;
    }
    return { ...state, p1 };
  }

  return launchServe(state);
}

/**
 * Practice serve missed (ball landed without a successful swing). No scoring in
 * practice — we just reset back to 'toss' so the player can serve again, with a
 * brief hit-stop as feedback that they let the ball drop.
 */
function loseServeAttempt(state: GameState): GameState {
  const reset = {
    ...state.shuttle,
    pos: { x: state.p1.pos.x, y: state.p1.pos.y },
    z: 0,
    vel: { x: 0, y: 0 },
    vz: 0,
    inPlay: false,
    bouncesSinceWall: 0,
    hitFrontWall: false,
    deadReason: 'floor' as DeadReason,
  };
  return {
    ...state,
    shuttle: reset,
    serveSubPhase: 'toss',
    hitstop: Math.max(state.hitstop, PRACTICE_MISS_HITSTOP),
    previewPath: null,
    previewStroke: null,
    previewStep: -1,
    previewPathIdx: -1,
  };
}

/**
 * Compute the dashed serve-preview trajectory. Uses the SAME launch velocity as the ball
 * (practiceServeVelocity) so the dashed line and the ball trace the exact same arc — the ball
 * now flies real physics, so the guide must be the real physics path, not a separately-tuned
 * curve (which is why the ball used to drift off the dashes).
 */
function computePreviewPath(
  playerPos: { x: number; y: number },
  strokeId: StrokeId,
  state: GameState,
): PathPoint[] {
  const vel = practiceServeVelocity(state, strokeId, playerPos, PREVIEW_START_Z);
  // Use the practice-only floor friction so the dashed guide line's bounce distance matches
  // the preview ball (which also runs PRACTICE_FLOOR_FRICTION via previewPhysicsStep).
  return sampleServePath(
    playerPos, PREVIEW_START_Z, { x: vel.x, y: vel.y }, vel.vz, 4, PRACTICE_FLOOR_FRICTION,
  );
}

/**
 * Compute the launch velocity for a practice serve from `pos`/`z0` for the given stroke.
 * Shared by launchPracticeServe (live launch) and the M-key preview (slow-mo flight) so the
 * previewed flight and the real serve use the SAME initial velocity — the preview is a true
 * slow-motion of what will happen, not a separately-tuned animation.
 */
function practiceServeVelocity(
  state: GameState,
  strokeId: StrokeId,
  pos: Vec2,
  z0: number,
): { x: number; y: number; vz: number } {
  // tof1 = frames to reach front wall; wallZ = height at front wall (game-space px)
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

  // The practice serve launches from the player's position (deep in the court, y≈549+),
  // a longer run to the front wall than the match serve (which starts at y≈357). With the
  // raw tof1 above the resulting ball speed was ~1.6–2.7× the match serve — too fast to read.
  // Scale tof1 up so the effective speed matches the match serve (tof≈30 from y≈357 →
  // ~11.9 px/frame). This stretches flight time uniformly, preserving each stroke's relative
  // pace and landing design while bringing the overall speed down to rally norm.
  tof1 *= PRACTICE_SERVE_SLOWDOWN;

  const tx = COURT.width * aimX;
  return {
    x: (tx - pos.x) / tof1,            // toward aim point
    y: (0 - pos.y) / tof1,             // negative (toward front wall)
    vz: (wallZ - z0 + 0.5 * GRAVITY * tof1 * tof1) / tof1,
  };
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
  if (reason === 'double-bounce' || reason === 'dead-after-bounce') {
    // The striker hit a good ball that died after its one legal bounce (a second bounce, or
    // a wall/player touch post-bounce) → the side that should have returned it loses, so the
    // striker wins.
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
