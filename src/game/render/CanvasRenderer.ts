import {
  COURT,
  NET_Y,
  NET_HEIGHT,
  SWING_REACH,
  SWING_REACH_Z,
  SWING_COOLDOWN_FRAMES,
  racketCenter,
  type GameState,
  type PlayerState,
  type SwingQuality,
  type Side,
  type Vec2,
} from '@/data/gameState';
import { makeProjector, DEFAULT_PROJECTION, type Projector } from '@/game/court/projection';
import { SimRunner } from '@/game/sim/SimRunner';
import { LocalInput } from '@/game/input/LocalInput';
import { AIInput, type Difficulty } from '@/game/input/AIInput';
import { eventBus } from '@/game/eventBus';
import { STROKES } from '@/data/strokes';

/**
 * GREYBOX renderer — pure Canvas 2D, zero art assets. Everything is a primitive
 * (lines, circles, ellipses) so the game is fully playable while the *feel* (timing,
 * trajectory, hit-stop, placement) is tuned before any skin exists. This is
 * the Steam blockout step: prove the mechanics read clearly as geometry first.
 *
 * It OWNS the runtime loop: it drives the deterministic SimRunner at 60Hz via the
 * frame clock and draws the latest state. All gameplay math stays in the pure sim;
 * this layer only projects logic (x,y,z) → the trapezoid screen and paints shapes.
 * It talks to React purely through the existing eventBus (HUD seam), so swapping the
 * renderer never touches the UI. Reuses makeProjector (same trapezoid as the art
 * pipeline) so a future skin lines up pixel-for-pixel.
 */

export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 720;

// Greybox palette — flat, high-contrast, readable. No textures, no gradients beyond
// a couple of soft fills, so shape + motion carry all the information.
const COL = {
  bg: '#10131f',
  floor: '#1c3a2e', // deep court green
  floorAlt: '#1f4233', // alternating service box tint
  line: '#cdd6e6', // court line paint
  net: '#e8edf7',
  netPost: '#9aa6c4',
  p1: '#4a9ad0', // human (near, right)
  p2: '#d04a6a', // AI (far, left)
  p1Dark: '#2c6b9c',
  p2Dark: '#9c2c46',
  shadow: 'rgba(0,0,0,0.32)',
  shuttle: '#fdfdff',
  shuttleEdge: '#33384a',
  reach: 'rgba(120,200,255,0.18)',
  reachRing: 'rgba(150,210,255,0.5)',
  landing: 'rgba(255,210,90,0.9)',
} as const;

/** Per-quality flash colour for the impact pop (tiers the connect feedback). */
const QUALITY_FLASH: Record<SwingQuality, string> = {
  perfect: '#fff6c8',
  good: '#bdf5c8',
  early: '#9ab8d8',
  late: '#9ab8d8',
  miss: '#88909c',
};

/** A short-lived impact burst spawned on a connect; drawn + faded over its life. */
type Burst = {
  pos: Vec2; // logic floor pos
  z: number; // logic height of contact
  quality: SwingQuality;
  age: number; // ticks since spawn
  life: number; // total ticks
};

export type RendererConfig = { difficulty: Difficulty };

export class CanvasRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly proj: Projector;
  private readonly runner: SimRunner;
  private readonly local: LocalInput;
  private readonly ai: AIInput;

  private raf = 0;
  private lastTime = 0;
  private running = false;

  // Feel FX state (render-only — never feeds back into the deterministic sim).
  private bursts: Burst[] = [];
  private shake = 0; // screen-shake magnitude, decays each frame
  private prevJustHit = { p1: false, p2: false };

  // HUD-diff caches so we only emit events on change.
  private lastScores: [number, number] = [0, 0];
  private lastWinner: number | null = null;

  constructor(canvas: HTMLCanvasElement, cfg: RendererConfig) {
    canvas.width = GAME_WIDTH;
    canvas.height = GAME_HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.proj = makeProjector(DEFAULT_PROJECTION);

    this.local = new LocalInput(0);
    this.ai = new AIInput(cfg.difficulty, 1, 0x1234abcd);
    this.runner = new SimRunner(this.local, this.ai);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    eventBus.emit('sim:reset', undefined);
    const loop = (now: number) => {
      if (!this.running) return;
      const dt = Math.min(100, now - this.lastTime); // clamp tab-switch spikes
      this.lastTime = now;
      this.runner.update(dt);
      const s = this.runner.current;
      this.advanceFx(s);
      this.draw(s);
      this.syncHud(s);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.local.dispose();
  }

  restart(): void {
    this.runner.reset();
    this.bursts = [];
    this.shake = 0;
    this.lastScores = [0, 0];
    this.lastWinner = null;
    eventBus.emit('sim:reset', undefined);
  }

  setDifficulty(d: Difficulty): void {
    this.ai.setDifficulty(d);
  }

  /** Test/debug seam: the live sim state. */
  debugState(): GameState {
    return this.runner.current;
  }

  // ---- FX bookkeeping (spawn bursts on the connect edge; decay shake) ----
  private advanceFx(s: GameState): void {
    this.spawnBurstIfHit('p1', s.p1, s);
    this.spawnBurstIfHit('p2', s.p2, s);
    // Age + cull bursts.
    this.bursts = this.bursts
      .map((b) => ({ ...b, age: b.age + 1 }))
      .filter((b) => b.age < b.life);
    this.shake *= 0.82;
    if (this.shake < 0.3) this.shake = 0;
  }

  private spawnBurstIfHit(who: 'p1' | 'p2', pl: PlayerState, s: GameState): void {
    const wasHit = this.prevJustHit[who];
    if (pl.justHit && !wasHit) {
      const quality = pl.lastQuality ?? 'good';
      this.bursts.push({ pos: { ...s.shuttle.pos }, z: s.shuttle.z, quality, age: 0, life: 16 });
      // A clean connect shakes the camera; the tier scales the kick.
      const kick = quality === 'perfect' ? 9 : quality === 'good' ? 5 : 2;
      this.shake = Math.max(this.shake, kick);
    }
    this.prevJustHit[who] = pl.justHit;
  }

  // ---- Drawing ----
  private draw(s: GameState): void {
    const ctx = this.ctx;
    ctx.save();
    // Screen-shake: a small deterministic-feeling jitter from the shake magnitude.
    if (this.shake > 0) {
      const a = s.frame * 1.3;
      ctx.translate(Math.cos(a) * this.shake, Math.sin(a * 1.7) * this.shake);
    }

    ctx.fillStyle = COL.bg;
    ctx.fillRect(-40, -40, GAME_WIDTH + 80, GAME_HEIGHT + 80);

    this.drawCourt();
    this.drawNetBack();

    // Landing marker under everything in-court so players + shuttle sit on top.
    if (s.shuttle.inPlay && s.shuttle.landing) {
      this.drawLandingMarker(s.shuttle.landing, s.shuttle.landingEta);
    }

    // Shadows first (on the floor), then bodies, painted far→near so the near player
    // overlaps correctly. Far side (p2) has smaller logic x → drawn first.
    this.drawPlayerShadow(s.p1);
    this.drawPlayerShadow(s.p2);
    this.drawShuttleShadow(s.shuttle);

    this.drawPlayer(s.p2, COL.p2, COL.p2Dark);
    this.drawPlayer(s.p1, COL.p1, COL.p1Dark);

    this.drawNetFront();
    this.drawShuttle(s.shuttle, s.phase);
    this.drawBursts();

    // Hit-stop tint: a faint white flash over the whole court while frozen, so the
    // freeze reads as deliberate weight, not a stutter.
    if (s.hitstop > 0) {
      ctx.fillStyle = `rgba(255,255,255,${0.06 * s.hitstop})`;
      ctx.fillRect(-40, -40, GAME_WIDTH + 80, GAME_HEIGHT + 80);
    }

    ctx.restore();
  }

  /** Project a logic corner and return screen point. */
  private pt(x: number, y: number, h = 0): Vec2 {
    return this.proj.toScreen({ x, y }, h);
  }

  private drawCourt(): void {
    const ctx = this.ctx;
    const { width, depth } = COURT;
    // Court quad corners (logic): (0,0)(0,depth)(width,depth)(width,0).
    const tl = this.pt(0, 0);
    const tr = this.pt(0, depth);
    const br = this.pt(width, depth);
    const bl = this.pt(width, 0);

    // Floor fill.
    ctx.beginPath();
    ctx.moveTo(tl.x, tl.y);
    ctx.lineTo(tr.x, tr.y);
    ctx.lineTo(br.x, br.y);
    ctx.lineTo(bl.x, bl.y);
    ctx.closePath();
    ctx.fillStyle = COL.floor;
    ctx.fill();

    // Service-box tint band (the mid-depth third) for a little depth read.
    const sNearY = COURT.width * 0.33;
    const sFarY = COURT.width * 0.66;
    this.fillBand(sNearY, sFarY, COL.floorAlt);

    // Court lines: outer boundary, the two long sidelines, baselines, and the
    // mid service line. Drawn as projected polylines so they keep the perspective.
    ctx.strokeStyle = COL.line;
    ctx.lineWidth = 3;
    this.strokePoly([tl, tr, br, bl, tl]);

    // Centre line down the court depth (logic y = depth/2 would be the net; the
    // service centre line runs along x at court-centre width on each half).
    this.strokeLogicLine({ x: 0, y: COURT.depth * 0.5 }, { x: COURT.width, y: COURT.depth * 0.5 });
    // Short service lines either side of the net.
    this.strokeLogicLine({ x: 0, y: NET_Y - 90 }, { x: COURT.width, y: NET_Y - 90 });
    this.strokeLogicLine({ x: 0, y: NET_Y + 90 }, { x: COURT.width, y: NET_Y + 90 });
  }

  /** Fill a depth band between two logic-x lines across the full court width. */
  private fillBand(x0: number, x1: number, color: string): void {
    const ctx = this.ctx;
    const a = this.pt(x0, 0);
    const b = this.pt(x0, COURT.depth);
    const c = this.pt(x1, COURT.depth);
    const d = this.pt(x1, 0);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  /** The net's back face (behind players): the tape line + mesh hint. */
  private drawNetBack(): void {
    const ctx = this.ctx;
    // Net runs across logic y = NET_Y, spanning logic x 0..width, at height NET_HEIGHT.
    const topFar = this.pt(0, NET_Y, NET_HEIGHT);
    const topNear = this.pt(COURT.width, NET_Y, NET_HEIGHT);
    const botFar = this.pt(0, NET_Y, 0);
    const botNear = this.pt(COURT.width, NET_Y, 0);

    // Mesh (faint vertical strands).
    ctx.strokeStyle = 'rgba(220,228,245,0.18)';
    ctx.lineWidth = 1;
    const strands = 18;
    for (let i = 0; i <= strands; i++) {
      const t = i / strands;
      const xLogic = t * COURT.width;
      const top = this.pt(xLogic, NET_Y, NET_HEIGHT);
      const bot = this.pt(xLogic, NET_Y, 0);
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(bot.x, bot.y);
      ctx.stroke();
    }
    // Net side posts.
    ctx.strokeStyle = COL.netPost;
    ctx.lineWidth = 5;
    this.strokePoly([botFar, topFar]);
    this.strokePoly([botNear, topNear]);
  }

  /** The net tape line in front of players (the white top cord). */
  private drawNetFront(): void {
    const ctx = this.ctx;
    const topFar = this.pt(0, NET_Y, NET_HEIGHT);
    const topNear = this.pt(COURT.width, NET_Y, NET_HEIGHT);
    ctx.strokeStyle = COL.net;
    ctx.lineWidth = 4;
    this.strokePoly([topFar, topNear]);
  }

  private drawLandingMarker(landing: Vec2, eta: number): void {
    const ctx = this.ctx;
    const p = this.pt(landing.x, landing.y, 0);
    const scale = this.proj.depthScale(landing.x);
    // The ring shrinks as the shuttle nears the floor — a countdown to "swing now".
    const close = Math.max(0, Math.min(1, eta / 90));
    const r = (10 + close * 26) * scale;
    ctx.strokeStyle = COL.landing;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, r, r * 0.42, 0, 0, Math.PI * 2);
    ctx.stroke();
    // Inner dot marks the exact spot.
    ctx.fillStyle = COL.landing;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, 3.5 * scale, 1.6 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawPlayerShadow(pl: PlayerState): void {
    const ctx = this.ctx;
    const p = this.pt(pl.pos.x, pl.pos.y, 0);
    const scale = this.proj.depthScale(pl.pos.x);
    const diving = pl.diveFrames > 0;
    ctx.fillStyle = COL.shadow;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, (diving ? 30 : 24) * scale, 9 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawPlayer(pl: PlayerState, color: string, dark: string): void {
    const ctx = this.ctx;
    const scale = this.proj.depthScale(pl.pos.x);
    const foot = this.pt(pl.pos.x, pl.pos.y, 0);

    // The body is a capsule standing on the floor point; height ~ PLAYER size.
    const bodyH = 64 * scale;
    const bodyW = 30 * scale;
    const diving = pl.diveFrames > 0;
    const grounded = pl.diveRecovery > 0;

    // Reach circle: the floor footprint where a swing connects (SWING_REACH radius),
    // drawn as a projected ellipse so the player can see exactly how far they cover.
    this.drawReach(pl, scale);

    ctx.save();
    ctx.translate(foot.x, foot.y);
    // A dive/recovery flattens the capsule along the slide.
    if (diving || grounded) {
      const lean = grounded ? 1.0 : 0.7;
      ctx.rotate((pl.diveDir.y || 0) * 0.4 + (pl.pos.x > COURT.width / 2 ? lean : -lean) * 0.0);
    }

    // Capsule body.
    const cx = 0;
    const top = -bodyH;
    ctx.fillStyle = color;
    roundCapsule(ctx, cx, top, bodyW, bodyH, bodyW * 0.5);
    ctx.fill();
    // Darker base ring for grounding.
    ctx.strokeStyle = dark;
    ctx.lineWidth = 2.5 * scale;
    ctx.stroke();

    // Head: a smaller circle on top so facing/height reads.
    ctx.fillStyle = lighten(color);
    ctx.beginPath();
    ctx.arc(cx, top, bodyW * 0.55, 0, Math.PI * 2);
    ctx.fill();

    // Racket: a stick + oval head held in the racket hand. It WHIPS through an arc
    // while a swing resolves (swingCooldown counts 14→0), then rests at a ready angle.
    // This is the missing swing feedback — you SEE the racket meet the shuttle.
    if (!diving && !grounded) {
      this.drawRacket(ctx, cx, top, bodyW, scale, pl);
    }

    ctx.restore();
  }

  /**
   * Draw the player's racket: a handle from the hand to an oval string-bed. The swing
   * arc is driven by swingCooldown (SWING_COOLDOWN_FRAMES→0): 1 = just hit (racket
   * forward, low), 0 = fully recovered (racket up, ready). Facing flips it L/R so the
   * near player (faces left) and far player (faces right) both swing toward the net.
   */
  private drawRacket(
    ctx: CanvasRenderingContext2D,
    cx: number,
    top: number,
    bodyW: number,
    scale: number,
    pl: PlayerState,
  ): void {
    const faceSign = pl.facing === 'left' ? -1 : 1; // which way the racket points
    // Swing progress: 1 right after contact → 0 at rest. While >0 the racket whips
    // down-and-forward; at rest it sits raised at a ready angle.
    const swing = pl.swingCooldown / SWING_COOLDOWN_FRAMES;
    // Angle measured from straight-up (−90°). Rest = raised (~ −55°); a fresh swing
    // throws the head forward & down to about +35°, then eases back as swing→0.
    const restAngle = -0.95; // radians from vertical, raised & ready
    const swingAngle = 0.6; // forward/down at peak swing
    const angle = restAngle + (swingAngle - restAngle) * swing;
    const handX = cx + faceSign * bodyW * 0.45;
    const handY = top + bodyW * 0.7; // hand a bit below the head
    const len = bodyW * 1.7;
    const dx = Math.sin(angle) * faceSign;
    const dy = -Math.cos(angle);
    const tipX = handX + dx * len;
    const tipY = handY + dy * len;

    // Handle.
    ctx.strokeStyle = '#caa46a';
    ctx.lineWidth = 3 * scale;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(handX, handY);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    // String-bed: an oval at the tip, oriented along the handle.
    const headR = bodyW * 0.5;
    ctx.save();
    ctx.translate(tipX, tipY);
    ctx.rotate(angle * faceSign);
    ctx.strokeStyle = '#e8e8e8';
    ctx.lineWidth = 2.2 * scale;
    ctx.beginPath();
    ctx.ellipse(0, -headR * 0.5, headR * 0.62, headR, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawReach(pl: PlayerState, scale: number): void {
    const ctx = this.ctx;
    const diving = pl.diveFrames > 0;
    const reach = diving ? SWING_REACH + 90 : SWING_REACH;
    // The hit volume is centred on the RACKET HEAD (held out toward the net), so the
    // ring is too — what you see is what you can hit. A dive lunges from the body, so
    // its extended ring stays body-centred. Side derived from facing (left = near/0).
    const side: Side = pl.facing === 'left' ? 0 : 1;
    const c = diving ? pl.pos : racketCenter(pl.pos, side);
    // Sample the reach circle in logic space and project each sample → a smooth ring.
    const pts: Vec2[] = [];
    const N = 28;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      pts.push(this.pt(c.x + Math.cos(a) * reach, c.y + Math.sin(a) * reach, 0));
    }
    ctx.fillStyle = COL.reach;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const q of pts) ctx.lineTo(q.x, q.y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = COL.reachRing;
    ctx.lineWidth = 1.5 * scale;
    ctx.stroke();
    void SWING_REACH_Z;
  }

  private drawShuttleShadow(sh: GameState['shuttle']): void {
    if (!sh.inPlay) return;
    const ctx = this.ctx;
    const p = this.pt(sh.pos.x, sh.pos.y, 0);
    const scale = this.proj.depthScale(sh.pos.x);
    const lift = Math.min(1, sh.z / 220);
    ctx.fillStyle = `rgba(0,0,0,${0.3 * (1 - lift * 0.7)})`;
    ctx.beginPath();
    const r = (7 - lift * 3) * scale;
    ctx.ellipse(p.x, p.y, r, r * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawShuttle(sh: GameState['shuttle'], phase: GameState['phase']): void {
    const visible = sh.inPlay || phase === 'serve';
    if (!visible) return;
    const ctx = this.ctx;
    const body = this.pt(sh.pos.x, sh.pos.y, sh.z);
    const scale = this.proj.depthScale(sh.pos.x);
    // Ball size grows a touch with height (closer to the "camera") so altitude reads.
    const r = (5 + Math.min(1, sh.z / 200) * 2.5) * scale;
    ctx.fillStyle = COL.shuttle;
    ctx.strokeStyle = COL.shuttleEdge;
    ctx.lineWidth = 1.8 * scale;
    ctx.beginPath();
    ctx.arc(body.x, body.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Feather skirt: a short fan trailing opposite the velocity, so direction reads.
    const sp = Math.hypot(sh.vel.x, sh.vel.y);
    if (sp > 0.4) {
      const ang = Math.atan2(sh.vel.y, sh.vel.x) + Math.PI;
      ctx.strokeStyle = 'rgba(230,235,250,0.8)';
      ctx.lineWidth = 1.2 * scale;
      for (const off of [-0.4, 0, 0.4]) {
        ctx.beginPath();
        ctx.moveTo(body.x, body.y);
        ctx.lineTo(body.x + Math.cos(ang + off) * r * 2.4, body.y + Math.sin(ang + off) * r * 2.4);
        ctx.stroke();
      }
    }
  }

  private drawBursts(): void {
    const ctx = this.ctx;
    for (const b of this.bursts) {
      const t = b.age / b.life;
      const p = this.pt(b.pos.x, b.pos.y, b.z);
      const scale = this.proj.depthScale(b.pos.x);
      const r = (8 + t * 30) * scale;
      ctx.strokeStyle = withAlpha(QUALITY_FLASH[b.quality], 1 - t);
      ctx.lineWidth = (b.quality === 'perfect' ? 4 : 2.5) * (1 - t) * scale;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
      // Perfect adds a bright cross spark.
      if (b.quality === 'perfect') {
        const s = r * 1.2;
        ctx.beginPath();
        ctx.moveTo(p.x - s, p.y);
        ctx.lineTo(p.x + s, p.y);
        ctx.moveTo(p.x, p.y - s);
        ctx.lineTo(p.x, p.y + s);
        ctx.stroke();
      }
    }
  }

  private strokePoly(pts: Vec2[]): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }

  private strokeLogicLine(a: Vec2, b: Vec2): void {
    const pa = this.pt(a.x, a.y, 0);
    const pb = this.pt(b.x, b.y, 0);
    this.strokePoly([pa, pb]);
  }

  // ---- HUD bridge (same events MatchScene emitted) ----
  private syncHud(s: GameState): void {
    if (s.scores[0] !== this.lastScores[0] || s.scores[1] !== this.lastScores[1]) {
      this.lastScores = [...s.scores];
      eventBus.emit('score:changed', { scores: [...s.scores] });
    }
    eventBus.emit('stamina:changed', { p1: s.p1.stamina, p2: s.p2.stamina });
    if (s.winner !== null && s.winner !== this.lastWinner) {
      this.lastWinner = s.winner;
      eventBus.emit('match:over', { winner: s.winner as 0 | 1, scores: [...s.scores] });
    }
  }
}

// ---- small drawing helpers (module-local, pure) ----

/** A rounded vertical capsule whose bottom centre sits at (cx, top+h). */
function roundCapsule(
  ctx: CanvasRenderingContext2D,
  cx: number,
  top: number,
  w: number,
  h: number,
  r: number,
): void {
  const left = cx - w / 2;
  const right = cx + w / 2;
  const bottom = top + h;
  ctx.beginPath();
  ctx.moveTo(left, top + r);
  ctx.arc(cx, top + r, w / 2, Math.PI, 0); // top cap
  ctx.lineTo(right, bottom - r);
  ctx.arc(cx, bottom - r, w / 2, 0, Math.PI); // bottom cap
  ctx.lineTo(left, top + r);
  ctx.closePath();
  void r;
}

/** Lighten a hex colour toward white for the head highlight. */
function lighten(hex: string): string {
  const { r, g, b } = hexRgb(hex);
  const mix = (c: number) => Math.round(c + (255 - c) * 0.35);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

/** Apply an alpha to a hex colour → rgba string. */
function withAlpha(hex: string, a: number): string {
  const { r, g, b } = hexRgb(hex);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
}

function hexRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// Referenced so the stroke table stays in the bundle for future per-stroke FX tints.
void STROKES;
