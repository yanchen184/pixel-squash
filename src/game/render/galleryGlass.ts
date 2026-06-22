/**
 * Procedural back glass-gallery wall.
 *
 * In the "screen-as-front-wall" perspective the top of the frame is the SOLID front wall the
 * ball strikes. The glass is the OTHER wall — the camera-side gallery the audience watches
 * through ("壁球的玻璃在另外那邊"). So the glass lives in the LOWER band of the frame, behind
 * the players, and must be drawn AFTER them so a deep competitor reads as standing behind it.
 *
 * Painted in code rather than blitted from a sheet: the generated glass PNG baked a fake
 * transparency checkerboard into its opaque pixels, which reads as an unloaded placeholder.
 * A translucent pane + diagonal sheen + brushed-metal mullions reads as real glass, keeps the
 * court art visible through it, and stays fully in our control. Shared by the practice and
 * match renderers so the two cannot drift apart again.
 */
const GLASS_TOP_RATIO = 0.645; // pane top edge (just below the court floor line)

export function drawGalleryGlass(
  ctx: CanvasRenderingContext2D,
  width = 1280,
  height = 720,
): void {
  const top = height * GLASS_TOP_RATIO;
  const bot = height;
  const h = bot - top;

  ctx.save();

  // 1. Translucent glass pane — cool, slightly denser toward the bottom (more light caught
  //    near the floor). Low alpha so the court + players read clearly THROUGH the glass.
  const pane = ctx.createLinearGradient(0, top, 0, bot);
  pane.addColorStop(0, 'rgba(150,180,205,0.16)');
  pane.addColorStop(0.5, 'rgba(120,155,185,0.22)');
  pane.addColorStop(1, 'rgba(95,130,165,0.30)');
  ctx.fillStyle = pane;
  ctx.fillRect(0, top, width, h);

  // 2. Diagonal reflection sheen — the tell-tale that there's a pane there at all.
  const sheen = ctx.createLinearGradient(0, top, width, bot);
  sheen.addColorStop(0.00, 'rgba(225,238,250,0)');
  sheen.addColorStop(0.30, 'rgba(225,238,250,0)');
  sheen.addColorStop(0.42, 'rgba(235,245,252,0.22)');
  sheen.addColorStop(0.50, 'rgba(235,245,252,0.10)');
  sheen.addColorStop(0.58, 'rgba(235,245,252,0)');
  sheen.addColorStop(1.00, 'rgba(225,238,250,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, top, width, h);

  // 3. Top rail — a brushed-metal beam capping the glass.
  const railH = Math.max(5, height * 0.012);
  const rail = ctx.createLinearGradient(0, top - railH, 0, top + railH);
  rail.addColorStop(0, 'rgba(180,190,200,0.95)');
  rail.addColorStop(0.5, 'rgba(120,130,142,0.95)');
  rail.addColorStop(1, 'rgba(150,162,175,0.9)');
  ctx.fillStyle = rail;
  ctx.fillRect(0, top - railH, width, railH * 2);

  // 4. Vertical mullions — six glass panels => five interior posts plus the two side posts.
  //    The centre post is the glass-door split, drawn brighter.
  const posts = [0, 1 / 6, 2 / 6, 0.5, 4 / 6, 5 / 6, 1];
  for (const f of posts) {
    const x = width * f;
    const isCentre = Math.abs(f - 0.5) < 0.001;
    const w = isCentre ? 7 : 6;
    const g = ctx.createLinearGradient(x - w, 0, x + w, 0);
    g.addColorStop(0, 'rgba(95,103,114,0.95)');
    g.addColorStop(0.5, isCentre ? 'rgba(205,215,226,0.98)' : 'rgba(176,186,198,0.96)');
    g.addColorStop(1, 'rgba(95,103,114,0.95)');
    ctx.fillStyle = g;
    ctx.fillRect(x - w / 2, top - railH, w, h + railH);
    // Bolt highlights down each post.
    ctx.fillStyle = 'rgba(225,232,240,0.7)';
    for (let i = 1; i <= 3; i++) {
      const by = top + (h * i) / 4;
      ctx.fillRect(x - 1, by - 1, 2, 2);
    }
  }

  // 5. Centre door handle — a small vertical bar just left of the door split.
  const handleX = width * 0.5 - 18;
  const handleY = top + h * 0.42;
  ctx.fillStyle = 'rgba(210,218,228,0.9)';
  ctx.fillRect(handleX, handleY, 4, h * 0.14);

  ctx.restore();
}
