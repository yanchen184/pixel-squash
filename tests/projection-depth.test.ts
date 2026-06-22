import { describe, it, expect } from 'vitest';
import { makeProjector, DEFAULT_PROJECTION } from '@/game/court/projection';
import { COURT } from '@/data/gameState';

/**
 * Phase 3 — 深度非線性投影 (perspective depth, design §3.5).
 *
 * The camera sits behind the players: the back of the court (logic y=COURT.depth) is
 * NEAR the camera (bottom of screen), the front wall (logic y=0) is FAR (top). Real
 * perspective is non-linear (~1/z): a ball travelling at CONSTANT world depth-velocity
 * covers MORE screen distance when it's near the camera and LESS as it recedes into the
 * distance. The old mapping used a LINEAR d = p.y/COURT.depth, so equal world steps gave
 * equal screen steps — the depth motion read as "floaty / fake" (no perspective accel).
 *
 * AC: walk the ball from the back (near) toward the front wall (far) in equal world-y
 * steps; the per-step screen-y displacement must MONOTONICALLY DECREASE (near fast → far
 * slow). The trapezoid endpoints stay pinned (front wall → farY, back → nearY) so the
 * art calibration is untouched — only the interior curve bends.
 */

describe('perspective depth projection (Phase 3)', () => {
  const proj = makeProjector(DEFAULT_PROJECTION);

  it('keeps the trapezoid endpoints pinned to the calibrated art anchors', () => {
    const front = proj.toScreen({ x: COURT.width / 2, y: 0 });
    const back = proj.toScreen({ x: COURT.width / 2, y: COURT.depth });
    expect(front.y).toBeCloseTo(DEFAULT_PROJECTION.farY, 5);
    expect(back.y).toBeCloseTo(DEFAULT_PROJECTION.nearY, 5);
  });

  it('a ball at constant depth-velocity shows DECREASING screen-y steps as it recedes (near→far)', () => {
    const STEPS = 10;
    const cx = COURT.width / 2;
    // Sample equal world-y steps from the back (near camera) toward the front wall (far).
    const ys: number[] = [];
    for (let i = 0; i <= STEPS; i++) {
      const worldY = COURT.depth * (1 - i / STEPS); // depth → 0
      ys.push(proj.toScreen({ x: cx, y: worldY }).y);
    }
    // Per-step screen-y displacement (absolute) as the ball recedes.
    const deltas: number[] = [];
    for (let i = 1; i < ys.length; i++) deltas.push(Math.abs(ys[i] - ys[i - 1]));

    // Strictly decreasing: each receding step covers LESS screen than the previous.
    for (let i = 1; i < deltas.length; i++) {
      expect(deltas[i]).toBeLessThan(deltas[i - 1]);
    }
    // And the effect must be meaningful, not a rounding wobble: the nearest step should
    // cover clearly more screen than the farthest.
    expect(deltas[0]).toBeGreaterThan(deltas[deltas.length - 1] * 1.3);
  });

  it('depth mapping stays monotonic (deeper into the room never moves UP-screen)', () => {
    const cx = COURT.width / 2;
    let prev = -Infinity;
    for (let i = 0; i <= 20; i++) {
      const y = proj.toScreen({ x: cx, y: COURT.depth * (i / 20) }).y;
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });
});
