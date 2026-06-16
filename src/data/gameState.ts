import type { StrokeId } from './strokes';

/**
 * GameState — what is happening in a squash match right now. In Phase 2 the server
 * owns this. Kept deterministic for that future: integer-ish coordinates, advanced
 * only by a fixed 60Hz tick, no engine physics. Treat as immutable — produce new
 * states, never mutate.
 *
 * SQUASH: a closed four-wall room. Both players share the WHOLE floor and face the
 * FRONT WALL. Coordinate space:
 *   x ∈ [0, COURT.width]  left wall → right wall
 *   y ∈ [0, COURT.depth]  FRONT wall (0) → BACK wall (depth)   ← front wall is y=0
 *   z (ball only)         height off the floor (up is +); also the height the ball
 *                         strikes the front wall at (front wall is the plane y=0)
 * There is NO net and NO two-halves split. A shot is "good" only if it strikes the
 * front wall between the tin (z=TIN_HEIGHT) and the out line (z=FRONT_OUT_HEIGHT).
 * Rendering projects (x,y,z) to a room-perspective quad facing the front wall (see
 * game/court/projection.ts).
 *
 * NOTE: the ball field is still named `shuttle` (inherited from the badminton fork)
 * to keep the sim/renderer/AI seams stable. Read it as "the ball".
 */

export type Vec2 = { x: number; y: number };

export type Side = 0 | 1; // 0 = player, 1 = AI. In squash both share the court;
// side only tracks ownership (who hit last) and serve rights.

/** 4-way facing for the chibi sprite. In squash both players default to 'up' (front wall). */
export type Facing4 = 'down' | 'up' | 'left' | 'right';

/** Which wall the ball most recently bounced off (renderer / AI hints). */
export type Wall = 'front' | 'back' | 'left' | 'right';

export type PlayerState = {
  pos: Vec2; // logic court coords (x,y)
  vel: Vec2;
  /** Frames remaining in a swing animation/cooldown; 0 = ready. */
  swingCooldown: number;
  stamina: number; // 0..STAMINA_MAX
  facing: Facing4;
  /**
   * The stroke this player most recently committed (set on every swing, hit or
   * whiff). The renderer reads it during the swing cooldown to pick the matching
   * swing animation + floating stroke label. null = idle / never swung.
   */
  lastStroke: StrokeId | null;
  /** True only on the exact tick a swing actually connected (drives FX trigger). */
  justHit: boolean;
  /**
   * Diving save state. While `diveFrames > 0` the player is mid-lunge: they slide
   * along `diveDir` and their swing reach is extended. When the dive ends they crash
   * to the floor and are pinned for `diveRecovery` frames — cannot move or swing.
   * High-risk / high-reward "魚躍救球".
   */
  diveFrames: number;
  diveDir: Vec2;
  diveRecovery: number;
  /** Quality of the most recent connect (perfect/good/early/late/miss). FX tier. */
  lastQuality: SwingQuality | null;
};

/** Quality of a swing's timing — drives feel (FX tier, power, accuracy). */
export type SwingQuality = 'perfect' | 'good' | 'early' | 'late' | 'miss';

/** Why the rally ended — decides who loses the point (see scorePoint). */
export type DeadReason =
  | 'tin' // striker hit below the tin → striker loses
  | 'out' // ball went above the front out line / over a side wall top → striker loses
  | 'double-bounce' // ball bounced on the floor twice → the side that should have returned loses
  | 'not-front-wall'; // ball reached the floor twice without ever hitting the front wall valid zone → striker loses

export type ShuttleState = {
  pos: Vec2; // floor position (x,y); y is distance from the front wall
  z: number; // height off the floor (also the strike height at the front wall plane y=0)
  vel: Vec2; // floor-plane velocity
  vz: number; // vertical velocity (height)
  /** Which side last hit it; used for fault scoring & serve rights. */
  lastHitBy: Side | null;
  /** True while in flight; false when dead (point ended, awaiting serve). */
  inPlay: boolean;
  /**
   * Floor bounces accrued SINCE the ball last hit the front wall valid zone. Squash:
   * the ball may bounce on the floor at most ONCE before a player must return it; the
   * second floor bounce ends the rally. Reset to 0 whenever the ball strikes the
   * front wall valid zone (a fresh, legal shot has landed).
   */
  bouncesSinceWall: number;
  /**
   * Has the ball hit the front wall valid zone since it was last struck by a racket?
   * A return is only legal if it eventually reaches the front wall; if the ball dies
   * on the floor with this still false, the striker hit a fault (not-front-wall / tin).
   */
  hitFrontWall: boolean;
  /** The wall the ball most recently bounced off (renderer/AI). */
  lastWall: Wall | null;
  /** Reason the rally ended this tick, set by physics; consumed by scorePoint. */
  deadReason: DeadReason | null;
  /**
   * Predicted FIRST floor landing point of the current flight (after wall bounces),
   * recomputed each tick. Renderer draws a shrinking ground marker; AI runs to it.
   */
  landing: Vec2 | null;
  /** Ticks until the ball reaches the predicted landing (drives marker shrink). */
  landingEta: number;
};

export type RallyPhase = 'serve' | 'rally' | 'point';

export type GameState = {
  frame: number;
  p1: PlayerState;
  p2: PlayerState;
  shuttle: ShuttleState; // "the ball" — name kept from the badminton fork
  scores: [number, number];
  phase: RallyPhase;
  /** Side that must serve next. */
  server: Side;
  /** Which service box the server stands in: 0 = left, 1 = right. Alternates each point won. */
  serveBox: 0 | 1;
  /**
   * True when the human player (side 0) is the server and hasn't yet chosen a service box.
   * The sim waits for left/right input before launching. False for AI serves (box chosen automatically).
   */
  awaitingServeChoice: boolean;
  /** Frames to wait on serve/point before next action. */
  phaseTimer: number;
  winner: Side | null;
  /** Hit-stop / freeze frames. While > 0 the whole sim is frozen. */
  hitstop: number;
  /** Rally momentum for AI rubber-banding. Clamped to [-MOMENTUM_MAX, MOMENTUM_MAX]. */
  momentum: number;
  /** Number of successful hits in the current rally (resets to 0 on each point). */
  rallyHitCount: number;
};

// ---- Logic-space constants (deterministic) ----
/**
 * Closed squash court (singles): ~6.4 m wide × ~9.75 m deep, 1px ≈ 1cm. The front
 * wall is the plane y = 0; the back wall is y = COURT.depth.
 */
export const COURT = { width: 640, depth: 980 } as const;

/** Max useful wall height (front wall valid zone tops out below this). */
export const WALL_HEIGHT = 480;
/** The tin (board) at the bottom of the front wall — a shot must strike ABOVE this z. */
export const TIN_HEIGHT = 80;
/** The out line at the top of the front wall — a shot striking above this is OUT. */
export const FRONT_OUT_HEIGHT = 456;
/** Short service line: a serve's first floor bounce must land BEHIND this (y > line). */
export const SERVE_LINE_Y = 549;
export const FLOOR_Z = 0;

export const STAMINA_MAX = 100;
/** PAR-11: first to 11, must win by WIN_BY. */
export const POINTS_TO_WIN = 11;
export const WIN_BY = 2;

export const PLAYER_SPEED = 9.5; // logic px per tick (both axes)
export const SWING_COOLDOWN_FRAMES = 14;
export const SWING_REACH = 100; // floor distance to ball that counts as a hit (larger court)
export const SWING_REACH_Z = 160; // max ball height still reachable
/**
 * The racket is held out in front of the body toward the FRONT WALL. The hit volume
 * is a circle centred on the RACKET HEAD, this far in front (smaller y) of the player.
 * In squash both players face the front wall, so the offset is always toward y=0.
 * The sim (hit test) and the renderer (reach ring) share this so they never drift.
 */
export const RACKET_REACH_OFFSET = 48;

/**
 * Centre of the swing hit-volume: the racket head, offset from the player toward the
 * FRONT WALL (smaller y). Both players hit toward the front wall, so toward = -1 for
 * everyone (unlike badminton, where the two face each other).
 */
export function racketCenter(pos: Vec2, _side: Side, offset = RACKET_REACH_OFFSET): Vec2 {
  return { x: pos.x, y: pos.y - offset };
}

/** Magnetic assist: within this slop the player auto-aligns a fraction toward the ball. */
export const SWING_MAGNET_RANGE = 160;
export const SWING_MAGNET_PULL = 0.18;

// ---- Timing window (the core of "feel") ----
export const TIMING_PERFECT = 3; // |dt| <= 3 ticks → perfect (sweet spot)
export const TIMING_GOOD = 7; // |dt| <= 7 → good
export const TIMING_WINDOW = 12; // |dt| <= 12 → early/late (still connects, weak)
export const STRIKE_Z = 55; // the comfortable contact height we time against

// ---- Ball flight (squash: a rubber bouncing ball) ----
/**
 * Horizontal air-drag per tick. A squash ball is rubber: it barely loses horizontal
 * speed in flight (0.998, vs badminton's 0.988). Energy is bled by WALL BOUNCES and
 * gravity doing work, not air drag — that's what makes the ball ping around the box.
 */
export const SHUTTLE_DRAG = 0.998; // (name kept from fork) ball horizontal drag

/** Global pace dial — multiplies effective flight time. Higher = slower ball. */
export const SHUTTLE_PACE = 1.8;

/** Hard ceiling on a shot's arc apex (z), ~ wall height, so a lob never flies off-screen. */
export const APEX_CEIL = 460;

// ---- Wall bounce restitution ----
export const WALL_BOUNCE = 0.92; // side/back wall: velocity retained on bounce
export const FRONT_WALL_BOUNCE = 0.95; // front wall — retain more energy so ball carries deep
export const FLOOR_BOUNCE = 0.58; // floor bounce: enough to carry to back court, not endless

// ---- Hit-stop tiers ----
export const HITSTOP_PERFECT = 6;
export const HITSTOP_GOOD = 3;
export const HITSTOP_WEAK = 1;

// ---- AI rubber-band ----
export const MOMENTUM_MAX = 4;

// ---- Diving save (魚躍救球) ----
export const DIVE_FRAMES = 10;
export const DIVE_SPEED = 17;
export const DIVE_REACH_BONUS = 90;
export const DIVE_RECOVERY_FRAMES = 30;
export const DIVE_STAMINA_COST = 25;
export const DIVE_MIN_STAMINA = 10;

/** How far a player may roam from the walls. */
export const PLAYER_MARGIN = 30;

/** The "T" — the central spot players return to between shots. */
export const T_SPOT: Vec2 = { x: COURT.width / 2, y: COURT.depth * 0.5 };

export function createInitialState(): GameState {
  const base = resetForServe(
    {
      frame: 0,
      p1: makePlayer(0),
      p2: makePlayer(1),
      shuttle: {
        pos: { x: COURT.width / 2, y: COURT.depth * 0.7 },
        z: 0,
        vel: { x: 0, y: 0 },
        vz: 0,
        lastHitBy: null,
        inPlay: false,
        bouncesSinceWall: 0,
        hitFrontWall: false,
        lastWall: null,
        deadReason: null,
        landing: null,
        landingEta: 0,
      },
      scores: [0, 0],
      phase: 'serve',
      server: 0,
      serveBox: 1,
      awaitingServeChoice: false,
      phaseTimer: 0,
      winner: null,
      hitstop: 0,
      momentum: 0,
      rallyHitCount: 0,
    },
    0,
  );
  // First serve: human picks the service box. Override after resetForServe.
  return { ...base, awaitingServeChoice: true, phaseTimer: 0 };
}

function makePlayer(side: Side): PlayerState {
  // Both players share the court and start in the back, split left/right.
  const x = side === 0 ? COURT.width * 0.35 : COURT.width * 0.65;
  const y = COURT.depth * 0.7;
  return {
    pos: { x: Math.round(x), y: Math.round(y) },
    vel: { x: 0, y: 0 },
    swingCooldown: 0,
    stamina: STAMINA_MAX,
    facing: 'up', // both face the front wall
    lastStroke: null,
    justHit: false,
    diveFrames: 0,
    diveDir: { x: 0, y: 0 },
    diveRecovery: 0,
    lastQuality: null,
  };
}

/** Park the ball at the serving player and pause briefly. */
export function resetForServe(state: GameState, server: Side): GameState {
  const serverPlayer = server === 0 ? state.p1 : state.p2;
  return {
    ...state,
    phase: 'serve',
    server,
    // Only the very first serve of the match asks the human to choose a box;
    // subsequent serves auto-alternate (PAR rule). resetForServe never re-triggers the choice.
    awaitingServeChoice: false,
    phaseTimer: 45,
    p1: { ...state.p1, pos: { ...makePlayer(0).pos }, facing: 'up', diveFrames: 0, diveDir: { x: 0, y: 0 }, diveRecovery: 0 },
    p2: { ...state.p2, pos: { ...makePlayer(1).pos }, facing: 'up', diveFrames: 0, diveDir: { x: 0, y: 0 }, diveRecovery: 0 },
    hitstop: 0,
    rallyHitCount: 0,
    shuttle: {
      pos: { x: serverPlayer.pos.x, y: serverPlayer.pos.y },
      z: 110,
      vel: { x: 0, y: 0 },
      vz: 0,
      lastHitBy: null,
      inPlay: false,
      bouncesSinceWall: 0,
      hitFrontWall: false,
      lastWall: null,
      deadReason: null,
      landing: null,
      landingEta: 0,
    },
  };
}
