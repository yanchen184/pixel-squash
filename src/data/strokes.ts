import {
  COURT,
  WALL_HEIGHT,
  TIN_HEIGHT,
  FRONT_OUT_HEIGHT,
  type Vec2,
} from './gameState';

/**
 * Stroke system — single source of truth for the six playable squash shots.
 *
 * Squash is a FRONT-WALL game: every legal shot must strike the front wall (plane
 * y=0) between the tin (z=48) and the out line (z=456). A stroke is a distinct
 * *feel* shaped by WHERE on the front wall it aims and HOW fast the ball flies:
 *
 *   - drive : the bread-and-butter rail — strikes mid-low, comes back deep & straight.
 *   - boast : an angled shot off a SIDE wall first, then to the front — defensive escape.
 *   - lob   : floats HIGH on the front wall, loops to the back corners — the reset.
 *   - drop  : feathers JUST above the tin, dies in the front corner — the touch shot.
 *   - kill  : a flat hard low rail near the tin — the put-away (needs a high contact).
 *   - serve : opens the rally, strikes mid-high, rebounds diagonally to the receiver.
 *
 * The sim reads a stroke's profile to shape the ball's launch toward a WallTarget +
 * flight time + fault risk; the renderer reads `frames` for the swing animation;
 * input maps key combos to a StrokeId.
 *
 * Determinism: every number is fixed data. No Math.random — fault checks are
 * threshold tests on the ball's own state (height, distance, side proximity), so
 * replays match byte-for-byte (Phase-2 netcode foundation).
 */

export type StrokeId = 'drive' | 'boast' | 'lob' | 'drop' | 'kill' | 'serve';

/**
 * A point the ball is aimed at to start its rebound.
 *  - wall 'front': aim a point on the front wall plane (y=0) at horizontal x, height z.
 *  - wall 'side' : aim a point on a SIDE wall (x = 0 or COURT.width) at depth sideY,
 *    height z — used by the boast, which bounces off the side wall toward the front.
 */
export type WallTarget = {
  readonly x: number;
  readonly z: number;
  readonly wall: 'front' | 'side';
  readonly sideY?: number;
};

/** Where on the front wall (height band) this stroke naturally aims. */
export type AimKind = 'low' | 'mid' | 'high' | 'tin' | 'angle';

export interface StrokeProfile {
  readonly id: StrokeId;
  /** Display name (zh-TW) for UI / feedback. */
  readonly label: string;
  /**
   * Natural front-wall strike HEIGHT in z. Higher on the wall = the rebound loops
   * deeper & floatier; lower (near the tin) = a flat fast rail that dies short.
   * For the boast this is the side-wall contact height.
   */
  readonly wallZ: number;
  /** Time-of-flight clamp [min,max] ticks to reach the wall. Smaller = faster ball. */
  readonly tof: readonly [number, number];
  /**
   * Per-stroke pace multiplier on flight time — OVERRIDES the global SHUTTLE_PACE so
   * each shot has its own signature speed (a kill rockets, a lob floats). <1 = faster
   * than the global readable pace, >1 = slower/floatier. solveArcToWall reads this.
   */
  readonly pace: number;
  /** Which front-wall height band this stroke aims at. */
  readonly aim: AimKind;
  /**
   * Fault gate. The stroke only succeeds if the contact condition holds; otherwise it
   * misfires (dribbles, won't reach the front wall = striker loses). null = always safe.
   *   - kill  needs the ball HIGH enough to hit down hard on it (min-contact-z).
   *   - drop  needs the player CLOSE to the front wall to feather it (max-front-dist).
   *   - boast needs the ball OFF to one side, near a side wall, to angle it (need-angle).
   */
  readonly fault: StrokeFault | null;
  /** Swing animation frame count (drives the sprite-sheet slicer + player). */
  readonly frames: number;
}

export type StrokeFault =
  | { kind: 'min-contact-z'; z: number } // ball height must be >= z to succeed (kill)
  | { kind: 'max-front-dist'; dist: number } // player distance to front wall must be <= dist (drop)
  | { kind: 'need-angle'; maxX: number }; // ball must be within maxX of a side wall (boast)

/**
 * The six profiles. Tuned against the squash arc math (GRAVITY=0.42, tin z=48, out
 * line z=456, wall height z=480). `drive` is the safe default rail — it strikes the
 * front wall mid-low and returns deep & straight, the proven baseline the others
 * deviate from. See PLAN.md §5 for the full stroke table.
 */
export const STROKES: Record<StrokeId, StrokeProfile> = {
  drive: {
    id: 'drive',
    label: '直線球',
    // The RAIL: strikes the front wall a touch below mid, rebounds deep and straight
    // down the side. The bread-and-butter shot — the calm baseline tempo everything
    // else reads against.
    wallZ: 144,
    tof: [16, 26],
    pace: 1.0, // global readable pace
    aim: 'mid',
    fault: null,
    frames: 4,
  },
  boast: {
    id: 'boast',
    label: '反角球',
    // The ESCAPE: hits a SIDE wall first, then angles onto the front wall and dies in
    // the opposite front corner. Slightly slower (the longer path), and only playable
    // when the ball is trapped near a side wall — the defensive scramble out of a corner.
    wallZ: 130,
    tof: [22, 34],
    pace: 1.1,
    aim: 'angle',
    // Needs the ball off to one side (within maxX of a side wall) to bank off it.
    fault: { kind: 'need-angle', maxX: 220 },
    frames: 5,
  },
  lob: {
    id: 'lob',
    label: '高吊球',
    // The RESET: floats HIGH on the front wall (just under the out line) and loops in a
    // slow, tall arc to the back corners — buys time, the opposite tempo to a kill.
    // Highest strike point of all six, comfortably below the out line so it stays in.
    wallZ: 374,
    tof: [30, 46],
    pace: 1.25, // slowest, floatiest
    aim: 'high',
    fault: null,
    frames: 4,
  },
  drop: {
    id: 'drop',
    label: '小球',
    // The TOUCH: feathers JUST above the tin so it barely clears, then dies in the front
    // corner. Forces the receiver to sprint forward. Played from near the front wall.
    wallZ: 72, // a hair above the tin (48)
    tof: [20, 30],
    pace: 1.15, // soft, hangs and dies short
    aim: 'low',
    // Must be played from close to the front wall; from deep court it tumbles into the tin.
    fault: { kind: 'max-front-dist', dist: 380 },
    frames: 5,
  },
  kill: {
    id: 'kill',
    label: '殺球',
    // The PUT-AWAY: a flat hard rail just above the tin, fastest of all. Barely clears
    // the tin then skids low and dead — the winner. Can only be played on a HIGH ball
    // (you must be above it to hit down), so a low ball forces a safe drive instead.
    wallZ: 60, // hugs the tin (48) — highest risk, biggest reward
    tof: [12, 20], // shortest flight…
    pace: 0.6, // …and accelerated past global pace → a true rocket
    aim: 'tin',
    fault: { kind: 'min-contact-z', z: 70 },
    frames: 5,
  },
  serve: {
    id: 'serve',
    label: '發球',
    // Opens the rally: strikes the front wall mid-high, rebounds in a fair arc that
    // descends into the receiver's diagonal back quarter — returnable, not an ace bomb.
    wallZ: 264,
    tof: [26, 40],
    pace: 1.0,
    aim: 'mid',
    fault: null,
    frames: 6,
  },
};

/** Default stroke when no modifier key is held — the safe straight drive. */
export const DEFAULT_STROKE: StrokeId = 'drive';

/**
 * Resolve a front-wall (or side-wall, for a boast) aim point for a stroke.
 *
 * Placement is PLAYER-DRIVEN: `aimX`/`aimY` are the held direction at swing time
 * (aimX: -1 left … +1 right across the front wall; aimY: -1 low/tin … +1 high/out)
 * and `accuracy` (0..1, from swing timing) blends the chosen point toward the safe
 * centre as it degrades — a mistimed swing can't be placed precisely. With no aim
 * held we fall back to the stroke's natural band, so a player who never touches the
 * aim keys still gets sensible shots.
 *
 * The HEIGHT band is bounded to stay between the tin and the out line; the timing
 * fault in the sim (applyTimingFault) is what pushes a mishit ABOVE the out line
 * (OUT) or BELOW the tin (dead) — aimWallTarget itself always returns a legal point.
 */
export function aimWallTarget(
  stroke: StrokeProfile,
  pos: Vec2,
  aimX = 0,
  aimY = 0,
  accuracy = 1,
): WallTarget {
  // The boast banks off a side wall first: pick the side wall the ball is nearest,
  // aim a point on it partway to the front, at the stroke's contact height.
  if (stroke.aim === 'angle') {
    const nearLeft = pos.x < COURT.width / 2;
    const sideX = nearLeft ? 0 : COURT.width;
    // Bank point sits in the front third of the court depth so the rebound carries
    // forward to the opposite front corner.
    const sideY = clamp(COURT.depth * 0.32, 60, COURT.depth - 60);
    const z = clampWallZ(stroke.wallZ);
    return { x: sideX, z, wall: 'side', sideY };
  }

  // Horizontal placement across the front wall: aimX continuous in [-1,+1]. Interpolate
  // from centre out toward whichever sideline the player pushes; a hard mistime thumps
  // the corner, a slight one drifts gently. No aim → centre-biased natural rail.
  const centerX = COURT.width * 0.5;
  const xEdgeL = COURT.width * 0.12;
  const xEdgeR = COURT.width * 0.88;
  let targetX: number;
  if (aimX === 0) {
    targetX = centerX;
  } else {
    const edge = aimX < 0 ? xEdgeL : xEdgeR;
    targetX = lerp(centerX, edge, Math.min(1, Math.abs(aimX)));
  }

  // Vertical placement on the front wall: start at the stroke's natural band, then let
  // aimY nudge it within the LEGAL window (tin..out). aimY −1 pulls toward the tin
  // (low/attacking), +1 pushes toward the out line (high/defensive). Stays in-bounds —
  // going OUT/below-tin is the job of the timing fault, not deliberate aim.
  const naturalZ = clampWallZ(stroke.wallZ);
  let targetZ: number;
  if (aimY === 0) {
    targetZ = naturalZ;
  } else {
    const zExtreme = aimY < 0 ? TIN_HEIGHT + 24 : FRONT_OUT_HEIGHT - 24;
    targetZ = lerp(naturalZ, zExtreme, Math.min(1, Math.abs(aimY)));
  }

  // Accuracy blend: a mistimed swing drifts toward the safe centre of the front wall
  // (centre-x, mid height); a perfect swing lands exactly on the point you aimed.
  const safeZ = (TIN_HEIGHT + FRONT_OUT_HEIGHT) / 2;
  targetX = lerp(centerX, targetX, accuracy);
  targetZ = lerp(safeZ, targetZ, accuracy);

  return { x: targetX, z: clampWallZ(targetZ), wall: 'front' };
}

/** Clamp a front-wall strike height into the legal tin..out window (with a margin). */
function clampWallZ(z: number): number {
  return clamp(z, TIN_HEIGHT + 8, FRONT_OUT_HEIGHT - 8);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Distance from a player to the front wall plane (y=0). Used by the drop's fault gate
 * (you can only feather a drop from near the front) and by AI shot selection.
 */
export function distToFrontWall(pos: Vec2): number {
  return Math.abs(pos.y);
}

// WALL_HEIGHT is part of the squash court contract; re-reference it so the import is
// always meaningful even though strokes clamp to the out line rather than the ceiling.
export const MAX_WALL_Z = WALL_HEIGHT;
