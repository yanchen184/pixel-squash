import { COURT, type Vec2 } from '@/data/gameState';

/**
 * Screen-trapezoid anchors. Inlined here (was a zod-validated type in the old
 * art pipeline) so the greybox renderer carries no art-manifest dependency.
 */
export type CourtProjection = {
  /** screen y of the far/top baseline (x=0) */
  farY: number;
  /** screen y of the near/bottom baseline (x=width) */
  nearY: number;
  /** half screen-x spread at the top (narrow) */
  farHalf: number;
  /** half screen-x spread at the bottom (wide) */
  nearHalf: number;
  /** horizontal screen centre (the vertical net) */
  centerX: number;
};

/**
 * LEFT↔RIGHT trapezoid projection (matches reference/target.jpg): the net stands
 * VERTICAL in the horizontal screen centre, the two halves sit left & right, and
 * the perspective depth runs UP→DOWN (back court narrow at the top, front court
 * wide at the bottom). The sim works in a clean rectangular logic court
 * (COURT.width × COURT.depth) — UNCHANGED. This layer maps logic → screen.
 * MUST mirror scripts/gen_court.py's project().
 *
 * Logic axes (sim, unchanged):
 *   x ∈ [0, COURT.width]  baseline → baseline (this is the DEPTH axis on screen)
 *   y ∈ [0, COURT.depth]  across the net (side 1 half y<NET … side 0 half y>NET)
 *
 * Screen mapping:
 *   logic y (across net) → screen X (left↔right): net (y=NET_Y) = screen centre,
 *                          side 1 (y<NET) on the LEFT, side 0 (y>NET) on the RIGHT.
 *   logic x (baseline→baseline) → screen Y (top→bottom), with the court's
 *                          left-right WIDTH widening as x grows (top narrow,
 *                          bottom wide) → the up-down trapezoid of the target.
 */

/** Anchors describing the screen trapezoid (top narrow, bottom wide). */
export const DEFAULT_PROJECTION: CourtProjection = {
  farY: 250, // TOP screen y (far baseline, x=0)
  nearY: 660, // BOTTOM screen y (near baseline, x=width)
  farHalf: 230, // half-WIDTH (screen x spread) at the top (narrow)
  nearHalf: 430, // half-WIDTH at the bottom (wide)
  centerX: 640, // horizontal screen centre (the vertical net sits here)
};

export type Projector = {
  /** logic (x,y[,height]) → screen px in the court's LOGIC canvas (1280×720). */
  toScreen(p: Vec2, height?: number): Vec2;
  /** depth scale at a given logic x (front/bottom is bigger), for sprite sizing. */
  depthScale(x: number): number;
};

/** Height (logic px up off the floor) → screen-y lift. A flat factor reads fine. */
const HEIGHT_LIFT = 0.9;

export function makeProjector(proj: CourtProjection = DEFAULT_PROJECTION): Projector {
  // Field names kept for schema compat; reinterpreted for this layout:
  //   topY    = proj.farY   (screen y of the far/top baseline, x=0)
  //   botY    = proj.nearY  (screen y of the near/bottom baseline, x=width)
  //   farHalf = half screen-x spread at the top (narrow)
  //   nearHalf= half screen-x spread at the bottom (wide)
  //   centerX = horizontal screen centre (vertical net)
  const topY = proj.farY;
  const botY = proj.nearY;
  const { farHalf, nearHalf, centerX } = proj;

  function toScreen(p: Vec2, height = 0): Vec2 {
    const cx = clamp01(p.x / COURT.width); // 0 top(far) … 1 bottom(near) — DEPTH
    const cy = clamp01(p.y / COURT.depth); // 0 left(side1) … 1 right(side0) — ACROSS NET
    const half = farHalf + (nearHalf - farHalf) * cx; // wider toward the bottom
    const y = topY + (botY - topY) * cx;
    return {
      x: centerX + (cy - 0.5) * 2 * half,
      y: y - height * HEIGHT_LIFT,
    };
  }

  function depthScale(x: number): number {
    const cx = clamp01(x / COURT.width);
    const t = farHalf / nearHalf; // smaller at the top (far)
    return t + (1 - t) * cx;
  }

  return { toScreen, depthScale };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
