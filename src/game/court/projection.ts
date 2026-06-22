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
    // Perspective-correct depth remap (design §3.5). The camera is behind the players, so
    // the back of the court (linear d=1) is NEAR and the front wall (d=0) is FAR. Real
    // perspective is non-linear (~1/z): equal world depth-steps cover MORE screen near the
    // camera and LESS as they recede. We bend the interior of d while pinning both endpoints
    // (d=0→0, d=1→1) so the calibrated trapezoid anchors (farY/nearY, farHalf/nearHalf) are
    // untouched — only the depth MOTION changes (near fast → far slow), killing the floaty
    // look where a ball flying into the room moved at a constant on-screen pace.
    const d = perspectiveDepth(clamp01(p.y / COURT.depth));
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
    // Same perspective remap as toScreen so a sprite's SIZE tracks the same non-linear
    // depth its POSITION does (otherwise a ball's x-spread and its scale disagree at a
    // given y). Endpoints pinned, so front-wall and back-wall scales are unchanged.
    const d = perspectiveDepth(clamp01(y / COURT.depth));
    const t = farHalf / nearHalf; // smaller at the top (front wall, far)
    return t + (1 - t) * d;
  }

  return { toScreen, depthScale };
}

/**
 * Bend a linear depth d ∈ [0,1] into a perspective-correct one, pinning both endpoints
 * (0→0, 1→1). With CAM_PULL > 1 the curve rises slowly near the front wall (far) and
 * steeply toward the back (near the camera), so equal world depth-steps produce shrinking
 * on-screen steps as the object recedes — the ~1/z feel of real perspective.
 */
const CAM_PULL = 2.2;
function perspectiveDepth(d: number): number {
  return d / (d + (1 - d) * CAM_PULL);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
