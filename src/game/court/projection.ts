import { COURT, type Vec2 } from '@/data/gameState';

/**
 * Screen-trapezoid anchors for the SQUASH room. The camera sits behind the players
 * looking at the FRONT wall, so the room recedes into the screen: the front wall
 * (logic y=0) is FAR/narrow at the top, the back of the court (logic y=COURT.depth)
 * is NEAR/wide at the bottom. Depth runs along the logic Y axis; logic X maps left↔
 * right. The sim works in a clean rectangular logic court (COURT.width × COURT.depth)
 * — UNCHANGED. This layer maps logic → screen.
 */
export type CourtProjection = {
  /** screen y of the far/top edge (logic y=0, the front wall) */
  farY: number;
  /** screen y of the near/bottom edge (logic y=COURT.depth, the back) */
  nearY: number;
  /** half screen-x spread at the top (narrow, at the front wall) */
  farHalf: number;
  /** half screen-x spread at the bottom (wide, at the back) */
  nearHalf: number;
  /** horizontal screen centre (room centreline) */
  centerX: number;
};

/**
 * FRONT-WALL room projection: the front wall stands across the TOP of the screen
 * (narrow, far), the floor recedes DOWN toward the camera (wide, near). Both players
 * share the floor and face up-screen toward the front wall.
 *
 * Logic axes (sim, unchanged):
 *   x ∈ [0, COURT.width]  left → right (maps to screen left↔right)
 *   y ∈ [0, COURT.depth]  front wall (y=0) → back of court (y=depth) = the DEPTH axis
 *
 * Screen mapping:
 *   logic y (front→back depth) → screen Y (top→bottom), the room widening as y grows
 *                                (top narrow at the front wall, bottom wide at the back).
 *   logic x (left→right)       → screen X (left↔right), scaled by the depth half-width.
 */

/** Anchors describing the screen trapezoid (top narrow at the front wall, bottom wide). */
export const DEFAULT_PROJECTION: CourtProjection = {
  farY: 305,  // TOP screen y (front wall floor edge) — art brightness jump at row 434 → canvas_y=305
  nearY: 439, // BOTTOM screen y (back wall) — calibrated from service line at canvas_y=380
  farHalf: 340,  // half-WIDTH at the front wall (narrow — perspective)
  nearHalf: 638, // half-WIDTH at the back wall (wide — near the camera)
  centerX: 645,  // horizontal screen centre
};

export type Projector = {
  /** logic (x,y[,height]) → screen px in the court's LOGIC canvas (1280×720). */
  toScreen(p: Vec2, height?: number): Vec2;
  /** depth scale at a given logic y (front/top is smaller, back/bottom bigger). */
  depthScale(y: number): number;
};

/**
 * Height (logic px up off the floor) → screen-y lift, perspective-scaled.
 * At the front wall (far, d=0) objects appear smaller so height lifts less.
 * At the back (near, d=1) the player is large and height lifts more.
 * Scale factor: farScale at d=0, nearScale at d=1, lerped in between.
 */
const HEIGHT_SCALE_FAR = 0.533;  // (farY - out_line_canvas_y) / FRONT_OUT_HEIGHT = (305-62)/456
const HEIGHT_SCALE_NEAR = 0.80;  // px-lift per logic height unit at the back

export function makeProjector(proj: CourtProjection = DEFAULT_PROJECTION): Projector {
  const topY = proj.farY; // front wall floor edge (logic y=0)
  const botY = proj.nearY; // back of court (logic y=depth)
  const { farHalf, nearHalf, centerX } = proj;

  function toScreen(p: Vec2, height = 0): Vec2 {
    const d = clamp01(p.y / COURT.depth); // 0 front(far) … 1 back(near) — DEPTH along logic y
    const cx = clamp01(p.x / COURT.width); // 0 left … 1 right — ACROSS the room
    const half = farHalf + (nearHalf - farHalf) * d; // wider toward the back/bottom
    const y = topY + (botY - topY) * d;
    const heightScale = HEIGHT_SCALE_FAR + (HEIGHT_SCALE_NEAR - HEIGHT_SCALE_FAR) * d;
    return {
      x: centerX + (cx - 0.5) * 2 * half,
      y: y - height * heightScale,
    };
  }

  function depthScale(y: number): number {
    const d = clamp01(y / COURT.depth);
    const t = farHalf / nearHalf; // smaller at the top (front wall, far)
    return t + (1 - t) * d;
  }

  return { toScreen, depthScale };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
