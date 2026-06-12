import { NET_HEIGHT, COURT, NET_Y, type Side, type Vec2 } from './gameState';

/**
 * Stroke system — single source of truth for the five playable badminton shots.
 *
 * Each stroke is a distinct *feel*: a clear floats safe and deep, a smash is a
 * fast flat kill, a drop dies just over the net, a drive is a quick body-line
 * push, and the serve opens the rally. The sim reads a stroke's profile to shape
 * the shuttle arc + landing + fault risk; the renderer reads `frames` to pick the
 * matching swing animation; input maps key combos to a StrokeId.
 *
 * Determinism: every number here is fixed data. No Math.random — fault checks are
 * threshold tests on the shuttle's own state (height, distance), so replays match.
 */

export type StrokeId = 'clear' | 'smash' | 'drop' | 'drive' | 'serve';

/** A landing-target resolver: where in the opponent half this stroke aims. */
export type AimKind = 'deep' | 'frontcourt' | 'net' | 'bodyline';

export interface StrokeProfile {
  readonly id: StrokeId;
  /** Display name (zh-TW) for UI / feedback. */
  readonly label: string;
  /** Arc apex height in z. Higher = floatier & slower to land; lower = flat & fast. */
  readonly apex: number;
  /** Time-of-flight clamp [min,max] ticks. Smaller = faster shuttle. */
  readonly tof: readonly [number, number];
  /**
   * Per-stroke pace multiplier on flight time — OVERRIDES the global SHUTTLE_PACE so
   * each shot has its own signature speed (a smash rockets, a drop floats). <1 = faster
   * than the global readable pace, >1 = slower/floatier. solveArc reads this.
   */
  readonly pace: number;
  /** Where the shuttle is aimed in the opponent's half. */
  readonly aim: AimKind;
  /**
   * Fault gate. The stroke only succeeds if the contact condition holds; otherwise
   * it whiffs into the net (commitment penalty). null = always safe.
   *   - smash needs the shuttle HIGH enough to hit down on it.
   *   - drop needs the player CLOSE enough to the net to feather it.
   */
  readonly fault: StrokeFault | null;
  /** Swing animation frame count (drives the sprite-sheet slicer + player). */
  readonly frames: number;
}

export type StrokeFault =
  | { kind: 'min-contact-z'; z: number } // shuttle height must be >= z to succeed
  | { kind: 'max-net-dist'; dist: number }; // player floor-distance to net must be <= dist

/**
 * The five profiles. Tuned against the existing arc math (GRAVITY=0.45,
 * NET_HEIGHT=70). `clear` deliberately mirrors the old single-arc behaviour so the
 * default stroke keeps the proven safe rally feel and existing tests pass.
 */
export const STROKES: Record<StrokeId, StrokeProfile> = {
  clear: {
    id: 'clear',
    label: '高遠球',
    // Floats HIGH and slow, deep to the baseline — the safe reset. Highest apex of all
    // four so its silhouette is unmistakably a tall lob next to the flat smash/drive.
    apex: NET_HEIGHT + 70, // 140 — tallest, floatiest arc
    tof: [24, 44],
    pace: 1.0, // global readable pace — the calm baseline the others deviate from
    aim: 'deep',
    fault: null,
    frames: 4,
  },
  smash: {
    id: 'smash',
    label: '殺球',
    // The KILL: lowest, flattest arc + fastest pace. It barely clears the tape then
    // drives DOWN at the opponent's body. Distinct from everything else by being both
    // the flattest (apex 75) AND the fastest (pace 0.6) — you SEE and FEEL the speed.
    apex: NET_HEIGHT + 5, // 75 — almost flat, skims the tape
    tof: [16, 24], // short flight…
    pace: 0.6, // …and accelerated well past global pace → a true rocket
    aim: 'bodyline', // handcuffs the receiver at their body
    // Can only smash a ball that's still high; a low ball forces a clear instead.
    fault: { kind: 'min-contact-z', z: 70 },
    frames: 5,
  },
  drop: {
    id: 'drop',
    label: '切球',
    // The FEATHER: floats just over the tape then dies in the forecourt. Slowest pace of
    // all so it hangs and drops short — the opposite tempo to a smash, forcing the
    // receiver to sprint forward. Apex high-ish but pace makes it crawl.
    apex: NET_HEIGHT + 45, // 115 — lobs up then tumbles down at the net
    tof: [40, 56], // long, lazy descent (clamped so the arc doesn't balloon)
    pace: 1.15, // slowest of the four → floaty soft touch, but not a moon-shot
    aim: 'net',
    // Needs to be played from near the net; from deep court it tumbles into the tape.
    fault: { kind: 'max-net-dist', dist: 200 },
    frames: 5,
  },
  drive: {
    id: 'drive',
    label: '平抽',
    // The FLAT DRIVE: low and quick like a smash, but aimed FLAT to the deep corners
    // (not down at the body) — a fast attacking rally ball. Faster than a clear, flatter
    // arc, but cornered instead of body-line, so it reads different from the smash.
    apex: NET_HEIGHT + 18, // 88 — low, flat
    tof: [18, 28],
    pace: 0.78, // quick, just shy of smash speed
    aim: 'deep', // flat to the back corners, not the body
    fault: null,
    frames: 4,
  },
  serve: {
    id: 'serve',
    label: '發球',
    // Just clears the net then descends into the receiver's strike zone — a fair,
    // returnable push, NOT a floaty deep ball that sails over the receiver's head.
    apex: NET_HEIGHT + 25, // 95
    tof: [24, 40],
    pace: 1.0,
    aim: 'deep',
    fault: null,
    frames: 6,
  },
};

/** Default stroke when no modifier key is held — the safe floaty clear. */
export const DEFAULT_STROKE: StrokeId = 'clear';

/**
 * Resolve a floor landing target for a stroke in the opponent's open court.
 * `side` is the HITTER's side.
 *
 * Placement is now PLAYER-DRIVEN (research #6): `aimX`/`aimY` are the held direction
 * at swing time (aimX: -1 left … +1 right across court; aimY: -1 toward net … +1
 * deep). `accuracy` (0..1, from swing timing) blends the player's chosen spot toward
 * the safe center as it drops — a mistimed swing can't be placed precisely. With no
 * aim held we fall back to the stroke's natural zone aimed away from the opponent,
 * so a new player who never touches the aim keys still gets sensible shots.
 */
export function aimTargetForStroke(
  aim: AimKind,
  side: Side,
  opponent: { pos: Vec2 },
  aimX = 0,
  aimY = 0,
  accuracy = 1,
): Vec2 {
  // The corners of the opponent's open court. Pushed RIGHT to the lines so a fully
  // committed aim actually thumps the baseline / sideline — that's the "I hit the
  // corner" payoff a timid 0.12/0.78 box never gave. The depth axis runs from just
  // past the net (`front`) to the deep baseline (`deep`).
  const deep = side === 0 ? COURT.depth * 0.04 : COURT.depth * 0.96; // hard on the baseline
  const front = side === 0 ? NET_Y - 70 : NET_Y + 70; // just over the net
  const mid = (deep + front) / 2;
  const xEdgeL = COURT.width * 0.08; // hard on the left sideline
  const xEdgeR = COURT.width * 0.92; // hard on the right sideline
  const centerX = COURT.width * 0.5;

  // The stroke's natural depth zone (used when the player gives no vertical aim).
  const naturalY =
    aim === 'net' ? (side === 0 ? NET_Y - 30 : NET_Y + 30)
    : aim === 'frontcourt' ? front
    : aim === 'deep' || aim === 'bodyline' ? deep
    : mid;

  // Depth: aimY is CONTINUOUS in [-1,+1] (−1 = net, +1 = baseline). Interpolate from
  // the stroke's natural zone toward whichever extreme the player is pushing, so a
  // full pull lands ON the baseline and a partial pull lands partway — no 3-step snap.
  const targetYExtreme = aimY < 0 ? front : deep;
  let targetY = lerp(naturalY, targetYExtreme, Math.min(1, Math.abs(aimY)));

  // Horizontal: aimX is CONTINUOUS in [-1,+1] from swing timing (−1 left … +1 right).
  // Interpolate from center out to the sideline so a hard mistime thumps the edge and
  // a slight one drifts gently — the placement is as fine as your timing. With no aim
  // held (and a non-bodyline stroke) fall back to hitting away from the opponent.
  const xAway = opponent.pos.x < COURT.width / 2 ? xEdgeR : xEdgeL;
  let targetX: number;
  if (aimX === 0) {
    targetX = aim === 'bodyline' ? opponent.pos.x : xAway;
  } else {
    const edge = aimX < 0 ? xEdgeL : xEdgeR;
    targetX = lerp(centerX, edge, Math.min(1, Math.abs(aimX)));
  }

  // Accuracy blend: a mistimed swing drifts toward the safe center of the open court;
  // a perfect swing (accuracy 1) lands exactly on the corner you aimed.
  const centerY = (front + deep) / 2;
  targetX = lerp(centerX, targetX, accuracy);
  targetY = lerp(centerY, targetY, accuracy);

  return { x: targetX, y: targetY };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Distance from a player to the net plane (used by drop's fault gate). */
export function distToNet(pos: Vec2): number {
  return Math.abs(pos.y - NET_Y);
}
