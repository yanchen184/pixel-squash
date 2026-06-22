/**
 * Procedural glass-pane overlay — translucent pane + diagonal sheen + brushed-metal mullions.
 *
 * In the "camera pinned to the front wall, looking back at the player" view the glass is the
 * BACK wall of the court, which the renderer's depth projection converges to the FAR vanishing
 * rectangle (top-centre of the frame, behind the court). So this overlay is drawn over THAT
 * far rectangle — the audience reads as sitting behind the glass, deep in the room.
 *
 * Painted in code rather than blitted from a sheet: the generated glass PNG baked a fake
 * transparency checkerboard into its opaque pixels, which reads as an unloaded placeholder.
 * A translucent pane + diagonal sheen + brushed-metal mullions reads as real glass, keeps the
 * court art visible through it, and stays fully in our control.
 *
 * @param x,y,w,h  the screen rectangle the glass pane spans (the FAR back-wall rect).
 */
export function drawGalleryGlass(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const left = x;
  const width = w;
  const top = y;
  const bot = y + h;

  ctx.save();

  // 1. Translucent glass pane — cool, slightly denser toward the bottom (more light caught
  //    near the floor). Low alpha so the court + players read clearly THROUGH the glass.
  const pane = ctx.createLinearGradient(0, top, 0, bot);
  pane.addColorStop(0, 'rgba(150,180,205,0.16)');
  pane.addColorStop(0.5, 'rgba(120,155,185,0.22)');
  pane.addColorStop(1, 'rgba(95,130,165,0.30)');
  ctx.fillStyle = pane;
  ctx.fillRect(left, top, width, h);

  // 2. Diagonal reflection sheen — the tell-tale that there's a pane there at all.
  const sheen = ctx.createLinearGradient(left, top, left + width, bot);
  sheen.addColorStop(0.00, 'rgba(225,238,250,0)');
  sheen.addColorStop(0.30, 'rgba(225,238,250,0)');
  sheen.addColorStop(0.42, 'rgba(235,245,252,0.22)');
  sheen.addColorStop(0.50, 'rgba(235,245,252,0.10)');
  sheen.addColorStop(0.58, 'rgba(235,245,252,0)');
  sheen.addColorStop(1.00, 'rgba(225,238,250,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(left, top, width, h);

  // 3. Top rail — a brushed-metal beam capping the glass.
  const railH = Math.max(3, h * 0.04);
  const rail = ctx.createLinearGradient(0, top - railH, 0, top + railH);
  rail.addColorStop(0, 'rgba(180,190,200,0.95)');
  rail.addColorStop(0.5, 'rgba(120,130,142,0.95)');
  rail.addColorStop(1, 'rgba(150,162,175,0.9)');
  ctx.fillStyle = rail;
  ctx.fillRect(left, top - railH, width, railH * 2);

  // 4. Vertical mullions — six glass panels => five interior posts plus the two side posts.
  //    The centre post is the glass-door split, drawn brighter.
  const posts = [0, 1 / 6, 2 / 6, 0.5, 4 / 6, 5 / 6, 1];
  for (const f of posts) {
    const px = left + width * f;
    const isCentre = Math.abs(f - 0.5) < 0.001;
    const pw = isCentre ? 5 : 4;
    const g = ctx.createLinearGradient(px - pw, 0, px + pw, 0);
    g.addColorStop(0, 'rgba(95,103,114,0.95)');
    g.addColorStop(0.5, isCentre ? 'rgba(205,215,226,0.98)' : 'rgba(176,186,198,0.96)');
    g.addColorStop(1, 'rgba(95,103,114,0.95)');
    ctx.fillStyle = g;
    ctx.fillRect(px - pw / 2, top - railH, pw, h + railH);
    // Bolt highlights down each post.
    ctx.fillStyle = 'rgba(225,232,240,0.7)';
    for (let i = 1; i <= 3; i++) {
      const by = top + (h * i) / 4;
      ctx.fillRect(px - 1, by - 1, 2, 2);
    }
  }

  // 5. Centre door handle — a small vertical bar just left of the door split.
  const handleX = left + width * 0.5 - 10;
  const handleY = top + h * 0.42;
  ctx.fillStyle = 'rgba(210,218,228,0.9)';
  ctx.fillRect(handleX, handleY, 3, h * 0.14);

  ctx.restore();
}
