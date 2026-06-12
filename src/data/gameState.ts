import type { StrokeId } from './strokes';

/**
 * GameState — what is happening in a match right now. In Phase 2 the server owns
 * this. Kept deterministic for that future: integer-ish coordinates, advanced only
 * by a fixed 60Hz tick, no engine physics. Treat as immutable — produce new states,
 * never mutate.
 *
 * TOP-DOWN logic court (3/4 view). Coordinate space:
 *   x ∈ [0, COURT.width]  left→right (across the net)
 *   y ∈ [0, COURT.depth]  far→near   (far baseline 0 → near baseline depth)
 *   z (shuttle only)      height off the floor (up is +)
 * The net runs across the court at y = COURT.depth / 2. Player 1 (side 0, near)
 * owns y > net; Player 2 (side 1, far) owns y < net. Rendering projects (x,y,z)
 * to the trapezoid screen quad (see game/court/projection.ts).
 */

export type Vec2 = { x: number; y: number };

export type Side = 0 | 1; // 0 = near (player), 1 = far (AI)

/** 4-way facing for top-down sprites. */
export type Facing4 = 'down' | 'up' | 'left' | 'right';

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
   * along `diveDir` and their swing reach is extended (so a ball just out of normal
   * range can be saved). When the dive ends they crash to the floor and are pinned
   * for `diveRecovery` frames — cannot move or swing while scrambling back up. This
   * is the high-risk / high-reward "魚躍救球": save the ball, but if the rally
   * continues you may be caught flat on the ground.
   */
  diveFrames: number; // frames of active lunge remaining (0 = not diving)
  diveDir: Vec2; // unit-ish direction of the current dive slide
  diveRecovery: number; // post-dive floor pin; >0 = grounded, locked out
  /**
   * Quality of the most recent connect (perfect/good/early/late/miss). The renderer
   * reads this to tier the impact FX (a perfect smash flashes brighter + shakes the
   * camera). null until the player's first swing. Set on every committed swing.
   */
  lastQuality: SwingQuality | null;
};

/** Quality of a swing's timing — drives feel (FX tier, power, accuracy). */
export type SwingQuality = 'perfect' | 'good' | 'early' | 'late' | 'miss';

export type ShuttleState = {
  pos: Vec2; // floor position (x,y) on the court plane
  z: number; // height off the floor
  vel: Vec2; // floor-plane velocity
  vz: number; // vertical velocity (height)
  /** Which side last hit it; used for fault scoring. */
  lastHitBy: Side | null;
  /** True while in flight; false when dead (point ended, awaiting serve). */
  inPlay: boolean;
  /**
   * Predicted floor landing point of the current flight, recomputed each tick the
   * shuttle is in play. The renderer draws a shrinking ground marker here so the
   * player knows where to run + when to swing. null when not in play.
   */
  landing: Vec2 | null;
  /** Ticks until the shuttle reaches the landing point (drives the marker shrink). */
  landingEta: number;
};

export type RallyPhase = 'serve' | 'rally' | 'point';

export type GameState = {
  frame: number;
  p1: PlayerState;
  p2: PlayerState;
  shuttle: ShuttleState;
  scores: [number, number];
  phase: RallyPhase;
  /** Side that must serve next. */
  server: Side;
  /** Frames to wait on serve/point before next action. */
  phaseTimer: number;
  winner: Side | null;
  /**
   * Hit-stop / freeze frames. While > 0 the whole sim is frozen (no movement, no
   * physics) — the renderer keeps drawing + plays FX, so a hard smash "lands with
   * weight". Counts down one per tick. The single biggest cheap win for game feel.
   */
  hitstop: number;
  /**
   * Rally momentum for AI rubber-banding. Positive = the human is on a run (AI
   * tightens up); negative = the human is losing (AI eases off so the score stays
   * close). Clamped to [-MOMENTUM_MAX, MOMENTUM_MAX]; nudged on each scored point.
   */
  momentum: number;
};

// ---- Logic-space constants (deterministic) ----
/** Top-down court: width across, depth far→near. */
export const COURT = { width: 850, depth: 500 } as const;
export const NET_Y = COURT.depth / 2; // 300 — net runs across here
export const NET_HEIGHT = 70; // shuttle must clear this height at the net
export const FLOOR_Z = 0;

export const STAMINA_MAX = 100;
export const POINTS_TO_WIN = 11;

export const PLAYER_SPEED = 9.5; // logic px per tick (both axes)
export const SWING_COOLDOWN_FRAMES = 14;
export const SWING_REACH = 95; // floor distance to shuttle that counts as a hit
export const SWING_REACH_Z = 150; // max shuttle height still reachable
/**
 * The racket isn't at the body — it's held out toward the net. The hit volume is a
 * circle centred on the RACKET HEAD, not the player's feet: it sits this far in front
 * (toward the net, along the depth axis) of the player. So a ball in front is caught
 * at arm's length and a ball behind your back is harder — the collision follows the
 * racket you can see, instead of a symmetric bubble around the body. Renderer draws
 * the reach ring at this same offset so what you see is what you can hit.
 */
export const RACKET_REACH_OFFSET = 48; // px the racket head leads the body toward the net

/**
 * Centre of the swing hit-volume: the racket head, offset from the player toward the
 * net along the depth axis. Near side (0) owns y > NET_Y so its net is at smaller y;
 * far side (1) the opposite. Shared by the sim (hit test) and the renderer (reach ring)
 * so they never drift apart.
 */
export function racketCenter(pos: Vec2, side: Side, offset = RACKET_REACH_OFFSET): Vec2 {
  const toward = side === 0 ? -1 : 1; // sign that moves y toward the net
  return { x: pos.x, y: pos.y + toward * offset };
}
/**
 * Magnetic assist: within this slop the player auto-aligns a fraction toward the
 * shuttle's floor point each tick, so "run to the area" is enough — you don't need
 * pixel-perfect positioning, but you DO have to be near (reach shrank to 95 to keep
 * walking meaningful). Tuned so good positioning still beats sloppy positioning.
 */
export const SWING_MAGNET_RANGE = 150; // px slop where auto-align kicks in
export const SWING_MAGNET_PULL = 0.18; // fraction of the gap closed per tick

// ---- Timing window (the core of "feel"; research #1) ----
// When a swing fires, we measure how far (in ticks) the shuttle is from the ideal
// contact moment — the tick it would be at the comfortable strike height inside
// reach. |dt| buckets into quality. Smaller = stricter = sweeter reward.
export const TIMING_PERFECT = 3; // |dt| <= 3 ticks → perfect (sweet spot)
export const TIMING_GOOD = 7; // |dt| <= 7 → good
export const TIMING_WINDOW = 12; // |dt| <= 12 → early/late (still connects, weak)
export const STRIKE_Z = 55; // the comfortable contact height we time against

// ---- Shuttle flight (research #2: a readable badminton arc) ----
// Horizontal air-drag per tick: the shuttle leaves fast then bleeds speed so it
// decelerates into a steep drop — the signature badminton feel a constant-speed
// arc completely lacks. Applied to vx/vy every tick the shuttle is airborne.
export const SHUTTLE_DRAG = 0.988;

/**
 * Global pace dial. solveArc divides horizontal launch speed by an effective flight
 * time; multiplying that time by this slows EVERY shot uniformly without touching
 * each stroke's relative feel (a smash is still faster than a clear, just calmer).
 * 1.0 = original snappy pace. >1 = slower, more readable. Tuned up from the first
 * playtest: the original pace was unplayably fast for a human (research/real-feel).
 */
export const SHUTTLE_PACE = 1.9;

/**
 * Hard ceiling on a shot's arc apex (z). A long paced flight can otherwise make the
 * solved up-velocity balloon, sending a floaty clear/drop off the top of the screen.
 * solveArc caps vz to this peak (and shortens the flight to match) so every shot stays
 * on-screen and readable, without moving where it lands. ~2.7× the net height reads as
 * a satisfyingly high lob while still framing in view.
 */
export const APEX_CEIL = 190;

// ---- Hit-stop tiers (research #2) ----
export const HITSTOP_PERFECT = 6; // freeze frames on a perfect connect
export const HITSTOP_GOOD = 3;
export const HITSTOP_WEAK = 1; // early/late

// ---- AI rubber-band ----
export const MOMENTUM_MAX = 4; // clamp on the rally-momentum counter

// ---- Diving save (魚躍救球) ----
export const DIVE_FRAMES = 10; // active lunge length: how long the slide lasts
export const DIVE_SPEED = 17; // slide speed during the lunge (≈ 1.8× run speed)
export const DIVE_REACH_BONUS = 90; // extra hit reach while diving (SWING_REACH + this)
export const DIVE_RECOVERY_FRAMES = 30; // floor pin after the lunge (locked out)
export const DIVE_STAMINA_COST = 25; // heavy: a dive bites deep into stamina
export const DIVE_MIN_STAMINA = 10; // below this you're too gassed to dive

/** How far a player may roam from the net / baseline within their own half. */
export const PLAYER_MARGIN = 40;

export function createInitialState(): GameState {
  return resetForServe(
    {
      frame: 0,
      p1: makePlayer(0),
      p2: makePlayer(1),
      shuttle: { pos: { x: COURT.width / 2, y: NET_Y }, z: 0, vel: { x: 0, y: 0 }, vz: 0, lastHitBy: null, inPlay: false, landing: null, landingEta: 0 },
      scores: [0, 0],
      phase: 'serve',
      server: 0,
      phaseTimer: 0,
      winner: null,
      hitstop: 0,
      momentum: 0,
    },
    0,
  );
}

function makePlayer(side: Side): PlayerState {
  // Near player (0) sits in the lower half (large y); far player (1) upper half.
  const y = side === 0 ? COURT.depth * 0.78 : COURT.depth * 0.22;
  return {
    pos: { x: Math.round(COURT.width / 2), y: Math.round(y) },
    vel: { x: 0, y: 0 },
    swingCooldown: 0,
    stamina: STAMINA_MAX,
    // L↔R layout: near side 0 is drawn on the RIGHT facing LEFT; far side 1 on the
    // LEFT facing RIGHT. Both face the vertical net in the screen centre.
    facing: side === 0 ? 'left' : 'right',
    lastStroke: null,
    justHit: false,
    diveFrames: 0,
    diveDir: { x: 0, y: 0 },
    diveRecovery: 0,
    lastQuality: null,
  };
}

/** Park the shuttle above the serving player and pause briefly. */
export function resetForServe(state: GameState, server: Side): GameState {
  const serverPlayer = server === 0 ? state.p1 : state.p2;
  return {
    ...state,
    phase: 'serve',
    server,
    phaseTimer: 45,
    p1: { ...state.p1, pos: { ...makePlayer(0).pos }, facing: 'left', diveFrames: 0, diveDir: { x: 0, y: 0 }, diveRecovery: 0 },
    p2: { ...state.p2, pos: { ...makePlayer(1).pos }, facing: 'right', diveFrames: 0, diveDir: { x: 0, y: 0 }, diveRecovery: 0 },
    hitstop: 0,
    shuttle: {
      pos: { x: serverPlayer.pos.x, y: serverPlayer.pos.y },
      z: 90,
      vel: { x: 0, y: 0 },
      vz: 0,
      lastHitBy: null,
      inPlay: false,
      landing: null,
      landingEta: 0,
    },
  };
}
