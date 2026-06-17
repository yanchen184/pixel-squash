import {
  COURT,
  WALL_HEIGHT,
  TIN_HEIGHT,
  FRONT_OUT_HEIGHT,
  SERVE_LINE_Y,
  SWING_REACH,
  SWING_REACH_Z,
  SWING_COOLDOWN_FRAMES,
  STRIKE_Z,
  TIMING_WINDOW,
  racketCenter,
  T_SPOT,
  type GameState,
  type PlayerState,
  type ShuttleState,
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
import {
  loadAssets,
  getImage,
  wallImpactCrop,
  PLAYER_LUNGE_CROPS,
  PLAYER_LATERAL_CROPS,
  PLAYER_BACKVIEW_CROPS,
  OPPONENT_CROPS,
  type Crop,
} from '@/assets/assetLoader';
import { SoundEngine } from '@/game/audio/SoundEngine';

/**
 * Polished prototype renderer — pure Canvas 2D, zero art assets. Everything is a
 * primitive drawn with gradients/glows to approximate the reference image.
 *
 * Visual target: graphite/teal enclosed squash room; tall side walls reaching near
 * full-height; bright glow court lines; amber ball with multi-sample ghost trajectory;
 * wall-hit pings; forward lunge smear; foot-skid dust; vignette + screen shake.
 */

export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 720;

// Polished palette.
const COL = {
  bg: '#08090f',
  // Wall planes — graphite-teal dark
  wall: '#1a2635',
  wallLight: '#243044',
  wallEdge: '#1c2b42',
  frontWall: '#1e2d44',
  frontWallTop: '#151f30',
  // Floor — dark teal wood
  floor: '#1a2e28',
  floorFar: '#1a3030',
  floorAlt: '#1f3530',     // service box tint
  // Court line glow
  line: '#c8e0d0',
  lineGlow: 'rgba(120,220,160,0.35)',
  // Tin = red band
  tin: '#c44040',
  tinGlow: 'rgba(200,60,60,0.6)',
  // Out line = amber
  outLine: '#e8a040',
  outLineGlow: 'rgba(240,160,40,0.5)',
  // Service line on front wall = red (lower red stripe in ref)
  serviceLine: '#c03838',
  serviceLineGlow: 'rgba(200,50,50,0.5)',
  // Players
  p1: '#3ab0e8',
  p2: '#e84a60',
  p1Dark: '#1a7aaa',
  p2Dark: '#aa1a30',
  shadow: 'rgba(0,0,0,0.5)',
  // Ball — amber glow
  shuttle: '#f59a20',
  shuttleCore: '#fff0a0',
  shuttleEdge: '#c05010',
  // Trail / ghost
  trailA: 'rgba(255,170,40,0.7)',
  trailB: 'rgba(255,100,0,0.0)',
  reach: 'rgba(80,180,255,0.08)',
  reachRing: 'rgba(100,200,255,0.3)',
  landing: 'rgba(255,200,80,0.95)',
  // Dust
  dust: 'rgba(200,180,140,',
  // Vignette
  vignette: 'rgba(0,0,0,0.72)',
} as const;

// Front-wall service line height. Squash: clearly ABOVE the tin, reading as a
// distinct mid-wall band. Using ~40% of wall height puts it visually high on the
// wall relative to the tin which sits at ~10%.
const FRONT_SERVICE_LINE_Z = WALL_HEIGHT * 0.40;

/** Per-quality flash colour for the impact pop. */
const QUALITY_FLASH: Record<SwingQuality, string> = {
  perfect: '#fff6c8',
  good: '#80ffb0',
  early: '#80b0d8',
  late: '#80b0d8',
  miss: '#686e78',
};

/** A short-lived impact burst spawned on a connect. */
type Burst = {
  pos: Vec2;
  z: number;
  quality: SwingQuality;
  age: number;
  life: number;
};

/** A wall-impact ping on the front wall plane. */
type WallPing = {
  x: number;
  z: number;
  age: number;
  life: number;
};

/** A dust puff near a player's foot. */
type DustPuff = {
  pos: Vec2;
  age: number;
  life: number;
  r: number;
};

/** A ball ghost for the trajectory trail. */
type BallGhost = {
  pos: Vec2;
  z: number;
  age: number;
  life: number;
  speed: number; // ball speed at capture time — drives trail style
};

/** A floating quality label (PERFECT! / GOOD!) above the hit point. */
type QualityLabel = {
  pos: Vec2;
  z: number;
  quality: SwingQuality;
  age: number;
  life: number;
};

/** A referee announcement text. */
type RefAnnounce = {
  text: string;
  color: string;
  age: number;
  life: number;
};

/** A wall impact FX (colored per zone). */
type WallImpactFX = {
  x: number;
  z: number;
  age: number;
  life: number;
  kind: 'tin' | 'valid' | 'out';
};

import type { GameMode } from '@/data/gameState';

export type RendererConfig = { difficulty: Difficulty; gameMode?: GameMode };

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
  private wallPings: WallPing[] = [];
  private dustPuffs: DustPuff[] = [];
  private ballGhosts: BallGhost[] = [];
  private qualityLabels: QualityLabel[] = [];
  private refAnnouncements: RefAnnounce[] = [];
  private wallImpactFX: WallImpactFX[] = [];
  private shake = 0;
  private prevJustHit = { p1: false, p2: false };
  private prevHitFrontWall = false;
  private ghostTimer = 0;
  private prevP1Vel: Vec2 = { x: 0, y: 0 };
  private prevP2Vel: Vec2 = { x: 0, y: 0 };
  private prevRallyHitCount = 0;

  // HUD-diff caches.
  private lastScores: [number, number] = [0, 0];
  private lastWinner: number | null = null;

  // Sound trigger state.
  private prevBouncesSinceWall = 0;
  private prevLastWall: string | null = null;
  private prevPhase: string = 'serve';

  // Fault flash — lights up tin (bottom) or out-line (top) for a few frames.
  private faultFlash: { kind: 'tin' | 'out'; age: number; life: number } | null = null;

  // Audience cheer overlay — triggered on score / long rally / dive save.
  private cheerTimer = 0; // frames remaining; drives audience flash brightness
  private prevRallyHitCountCheer = 0; // last rallyHitCount threshold we cheered at

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
    if (cfg.gameMode) {
      this.runner.setGameMode(cfg.gameMode);
      this.ai.setPracticeMode(cfg.gameMode === 'practice');
    }

    // Kick off asset loading — non-blocking; game runs with procedural fallback
    // until images arrive.
    loadAssets();

    // Unlock Web Audio on first user gesture (browser autoplay policy).
    const unlock = () => { SoundEngine.get().unlock(); };
    window.addEventListener('keydown', unlock, { once: true });
    window.addEventListener('pointerdown', unlock, { once: true });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    eventBus.emit('sim:reset', undefined);
    const loop = (now: number) => {
      if (!this.running) return;
      const dt = Math.min(100, now - this.lastTime);
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
    this.wallPings = [];
    this.dustPuffs = [];
    this.ballGhosts = [];
    this.qualityLabels = [];
    this.refAnnouncements = [];
    this.wallImpactFX = [];
    this.shake = 0;
    this.prevJustHit = { p1: false, p2: false };
    this.prevHitFrontWall = false;
    this.ghostTimer = 0;
    this.lastScores = [0, 0];
    this.lastWinner = null;
    this.prevBouncesSinceWall = 0;
    this.prevLastWall = null;
    this.prevPhase = 'serve';
    this.faultFlash = null;
    this.prevRallyHitCount = 0;
    this.cheerTimer = 0;
    this.cheerText = null;
    this.prevRallyHitCountCheer = 0;
    eventBus.emit('sim:reset', undefined);
  }

  setDifficulty(d: Difficulty): void {
    this.ai.setDifficulty(d);
  }

  debugState(): GameState {
    return this.runner.current;
  }

  // ---- FX bookkeeping ----
  private advanceFx(s: GameState): void {
    this.spawnBurstIfHit('p1', s.p1, s);
    this.spawnBurstIfHit('p2', s.p2, s);

    const hitWall = s.shuttle.inPlay && s.shuttle.hitFrontWall;
    if (hitWall && !this.prevHitFrontWall) {
      this.wallPings.push({
        x: s.shuttle.pos.x,
        z: Math.max(TIN_HEIGHT, Math.min(FRONT_OUT_HEIGHT, s.shuttle.z)),
        age: 0,
        life: 14,
      });
      // Colored wall impact FX based on strike zone
      const hitZ = s.shuttle.z;
      const impactKind: WallImpactFX['kind'] = hitZ < TIN_HEIGHT ? 'tin' : hitZ > FRONT_OUT_HEIGHT ? 'out' : 'valid';
      this.wallImpactFX.push({ x: s.shuttle.pos.x, z: s.shuttle.z, age: 0, life: 22, kind: impactKind });
      this.shake = Math.max(this.shake, 6);
      // Front wall ping sound
      const spd = Math.hypot(s.shuttle.vel.x, s.shuttle.vel.y);
      SoundEngine.get().frontWallHit(Math.min(1, spd / 18));
    }
    this.prevHitFrontWall = hitWall;

    // Side / back wall bounce sound
    if (s.shuttle.lastWall !== this.prevLastWall && s.shuttle.lastWall !== null && s.shuttle.lastWall !== 'front') {
      SoundEngine.get().sideWallHit();
    }
    this.prevLastWall = s.shuttle.lastWall;

    // Floor bounce sound
    if (s.shuttle.bouncesSinceWall !== this.prevBouncesSinceWall && s.shuttle.bouncesSinceWall > 0) {
      SoundEngine.get().floorBounce(s.shuttle.bouncesSinceWall);
    }
    this.prevBouncesSinceWall = s.shuttle.bouncesSinceWall;

    // Point ended — play tin / out / point scored sound + trigger fault flash + referee text
    if (s.phase === 'point' && this.prevPhase === 'rally') {
      const reason = s.shuttle.deadReason;
      if (reason === 'tin') {
        SoundEngine.get().tinHit();
        this.faultFlash = { kind: 'tin', age: 0, life: 24 };
        this.refAnnouncements.push({ text: '下網！', color: '#ff4040', age: 0, life: 120 });
      } else if (reason === 'out') {
        SoundEngine.get().outCall();
        this.faultFlash = { kind: 'out', age: 0, life: 24 };
        this.refAnnouncements.push({ text: '出界！', color: '#e8a040', age: 0, life: 120 });
      } else if (reason === 'double-bounce') {
        this.refAnnouncements.push({ text: '二次落地！', color: '#40c8a0', age: 0, life: 120 });
      }
    }
    if (s.scores[0] !== this.lastScores[0] || s.scores[1] !== this.lastScores[1]) {
      const scorer = s.scores[0] > this.lastScores[0] ? 0 : 1;
      SoundEngine.get().pointScored(scorer as 0 | 1);
      const name = scorer === 0 ? '你得分！' : 'CPU 得分';
      const col = scorer === 0 ? '#5ec8f0' : '#f07080';
      this.refAnnouncements.push({ text: name, color: col, age: 0, life: 90 });
    }
    if (s.winner !== null && s.winner !== this.lastWinner) {
      SoundEngine.get().matchWon(s.winner as 0 | 1);
    }
    this.prevPhase = s.phase;

    // --- Audience cheer triggers ---
    // 1) Point scored
    if (s.scores[0] !== this.lastScores[0] || s.scores[1] !== this.lastScores[1]) {
      this.triggerCheer(120, '全場歡呼！', '#f0d060');
    }
    // 2) Every 10 successful hits in a rally
    const cheerThreshold = Math.floor(s.rallyHitCount / 10) * 10;
    if (s.rallyHitCount > 0 && cheerThreshold > this.prevRallyHitCountCheer && s.rallyHitCount >= 10) {
      this.prevRallyHitCountCheer = cheerThreshold;
      this.triggerCheer(90, '精彩對拍！', '#80e8c0');
    }
    if (s.phase === 'serve') this.prevRallyHitCountCheer = 0;
    // 3) Dive save (魚躍救球): justHit while diveFrames > 0 or diveRecovery > 0
    const p1DiveSave = s.p1.justHit && (s.p1.diveFrames > 0);
    const p2DiveSave = s.p2.justHit && (s.p2.diveFrames > 0);
    if (p1DiveSave || p2DiveSave) {
      this.triggerCheer(80, '魚躍救球！', '#60c8ff');
    }

    // Ball ghost trail — sample every 2 ticks when moving fast.
    if (s.shuttle.inPlay) {
      this.ghostTimer++;
      if (this.ghostTimer >= 2) {
        this.ghostTimer = 0;
        const sp = Math.hypot(s.shuttle.vel.x, s.shuttle.vel.y);
        if (sp > 1.0) {
          this.ballGhosts.push({ pos: { ...s.shuttle.pos }, z: s.shuttle.z, age: 0, life: 10, speed: sp });
        }
      }
    }

    // Track rally hit count for quality label spawning
    if (s.rallyHitCount !== this.prevRallyHitCount) {
      this.prevRallyHitCount = s.rallyHitCount;
    }

    // Foot-skid dust: spawn when a player changes direction sharply (diving or skidding).
    this.spawnDust(s.p1, this.prevP1Vel);
    this.spawnDust(s.p2, this.prevP2Vel);
    this.prevP1Vel = { ...s.p1.vel };
    this.prevP2Vel = { ...s.p2.vel };

    this.bursts = this.bursts.map((b) => ({ ...b, age: b.age + 1 })).filter((b) => b.age < b.life);
    if (this.faultFlash) {
      this.faultFlash.age++;
      if (this.faultFlash.age >= this.faultFlash.life) this.faultFlash = null;
    }
    this.wallPings = this.wallPings.map((w) => ({ ...w, age: w.age + 1 })).filter((w) => w.age < w.life);
    this.dustPuffs = this.dustPuffs.map((d) => ({ ...d, age: d.age + 1 })).filter((d) => d.age < d.life);
    this.ballGhosts = this.ballGhosts.map((g) => ({ ...g, age: g.age + 1 })).filter((g) => g.age < g.life);
    this.qualityLabels = this.qualityLabels.map((q) => ({ ...q, age: q.age + 1 })).filter((q) => q.age < q.life);
    this.refAnnouncements = this.refAnnouncements.map((r) => ({ ...r, age: r.age + 1 })).filter((r) => r.age < r.life);
    this.wallImpactFX = this.wallImpactFX.map((w) => ({ ...w, age: w.age + 1 })).filter((w) => w.age < w.life);

    this.shake *= 0.80;
    if (this.shake < 0.3) this.shake = 0;

    if (this.cheerTimer > 0) this.cheerTimer--;
    if (this.cheerText) {
      this.cheerText.age++;
      if (this.cheerText.age >= this.cheerText.life) this.cheerText = null;
    }
  }

  private cheerText: { text: string; color: string; age: number; life: number } | null = null;

  private triggerCheer(frames: number, text: string, color: string): void {
    this.cheerTimer = Math.max(this.cheerTimer, frames);
    // Only show cheerText if one isn't already running (avoid overwriting score text)
    if (!this.cheerText || this.cheerText.age > this.cheerText.life * 0.5) {
      this.cheerText = { text, color, age: 0, life: frames };
    }
  }

  private drawCheerFlash(): void {
    if (this.cheerTimer <= 0) return;
    const ctx = this.ctx;
    // Audience area: top strip of the canvas
    const alpha = Math.min(1, this.cheerTimer / 30) * 0.35;
    const grad = ctx.createLinearGradient(0, 0, 0, GAME_HEIGHT * 0.45);
    grad.addColorStop(0, `rgba(255,240,140,${alpha})`);
    grad.addColorStop(0.5, `rgba(255,200,80,${alpha * 0.5})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT * 0.45);
    ctx.restore();

    // Cheer label — drawn at the top of the court (audience area), separate from refAnnouncements
    if (this.cheerText) {
      const { text, color, age, life } = this.cheerText;
      const t = age / life;
      const textAlpha = t < 0.15 ? t / 0.15 : t > 0.65 ? 1 - (t - 0.65) / 0.35 : 1;
      ctx.save();
      ctx.globalAlpha = textAlpha * 0.9;
      ctx.font = 'bold 24px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = color;
      ctx.shadowBlur = 16;
      ctx.fillStyle = color;
      ctx.fillText(text, GAME_WIDTH / 2, GAME_HEIGHT * 0.14);
      ctx.restore();
    }
  }

  private spawnBurstIfHit(who: 'p1' | 'p2', pl: PlayerState, s: GameState): void {
    const wasHit = this.prevJustHit[who];
    if (pl.justHit && !wasHit) {
      const quality = pl.lastQuality ?? 'good';
      this.bursts.push({ pos: { ...s.shuttle.pos }, z: s.shuttle.z, quality, age: 0, life: 18 });
      // Quality floating label (only for good+ hits to avoid spam)
      if (quality === 'perfect' || quality === 'good') {
        this.qualityLabels.push({ pos: { ...s.shuttle.pos }, z: s.shuttle.z + 30, quality, age: 0, life: 40 });
      }
      const kick = quality === 'perfect' ? 10 : quality === 'good' ? 6 : 2;
      this.shake = Math.max(this.shake, kick);
      SoundEngine.get().racketHit(quality);
    }
    this.prevJustHit[who] = pl.justHit;
  }

  private spawnDust(pl: PlayerState, prevVel: Vec2): void {
    const diving = pl.diveFrames > 0;
    const dx = pl.vel.x - prevVel.x;
    const dy = pl.vel.y - prevVel.y;
    const accel = Math.hypot(dx, dy);
    if (diving || accel > 3.5) {
      this.dustPuffs.push({
        pos: { x: pl.pos.x + (Math.random() - 0.5) * 16, y: pl.pos.y + (Math.random() - 0.5) * 10 },
        age: 0,
        life: 14 + Math.floor(Math.random() * 8),
        r: 8 + Math.random() * 12,
      });
    }
  }

  // ---- Drawing ----
  private draw(s: GameState): void {
    const ctx = this.ctx;
    ctx.save();
    if (this.shake > 0) {
      const a = s.frame * 1.3;
      ctx.translate(Math.cos(a) * this.shake, Math.sin(a * 1.7) * this.shake);
    }

    ctx.fillStyle = COL.bg;
    ctx.fillRect(-40, -40, GAME_WIDTH + 80, GAME_HEIGHT + 80);

    // Back-to-front: bg art → walls → floor → front wall → court overlay → fx →
    //   actors → ball → FOREGROUND glass gallery (occludes actors) → vignette.
    this.drawCourtBaseArt();
    this.drawCheerFlash();
    this.drawAudienceArt();
    this.drawWalls();
    this.drawFloor();
    this.drawFrontWall();
    this.drawCourtLinesOverlay();
    this.drawWallPings();
    if (this.faultFlash) this.drawFaultFlash(this.faultFlash);

    // Practice mode: always show landing marker so player can read trajectories.
    if (s.shuttle.inPlay && s.shuttle.landing) {
      this.drawLandingMarker(s.shuttle.landing, s.shuttle.landingEta, s.gameMode === 'practice');
    }

    // T-spot recovery hint — show when in rally and player hasn't just hit
    if (s.phase === 'rally' && s.shuttle.lastHitBy === 0) {
      this.drawTSpotHint();
    }

    // Aim indicator: show the player their timing-based front-wall target when the
    // shuttle is near their strike zone and it's their turn to return.
    if (s.phase === 'rally' && s.shuttle.inPlay && s.shuttle.lastHitBy !== 0) {
      this.drawAimIndicator(s.shuttle);
    }

    this.drawDustPuffs();

    const order: PlayerState[] = s.p1.pos.y <= s.p2.pos.y ? [s.p1, s.p2] : [s.p2, s.p1];
    const colorOf = (pl: PlayerState) =>
      pl === s.p1 ? ([COL.p1, COL.p1Dark] as const) : ([COL.p2, COL.p2Dark] as const);

    this.drawPlayerShadow(s.p1);
    this.drawPlayerShadow(s.p2);
    this.drawShuttleShadow(s.shuttle);

    for (const pl of order) {
      const [c, d] = colorOf(pl);
      this.drawPlayer(pl, c, d);
    }

    this.drawBallGhosts();
    this.drawShuttle(s.shuttle, s.phase);
    this.drawBursts();
    this.drawWallImpactFX();
    this.drawQualityLabels();

    // Foreground glass layer — drawn last so it sits IN FRONT of the actors,
    // sandwiching them between the solid back walls and the glass gallery.
    this.drawBackGlassFront();

    // Serve guide line: during serve phase, draw a dashed line from server to target front wall zone.
    if (s.phase === 'serve' && s.phaseTimer > 0 && !s.awaitingServeChoice) {
      const server = s.server === 0 ? s.p1 : s.p2;
      this.drawServeGuideLine(server.pos, s.serveBox);
    }

    // Service box choice prompt (human server only).
    if (s.awaitingServeChoice && s.server === 0) {
      this.drawServeChoiceOverlay(null);
    } else if (!s.awaitingServeChoice && s.phase === 'serve' && s.server === 0 && s.phaseTimer > 0) {
      // Box chosen, counting down to serve — show confirmation
      this.drawServeChoiceOverlay(s.serveBox);
    }

    if (s.hitstop > 0) {
      ctx.fillStyle = `rgba(255,255,255,${0.07 * s.hitstop})`;
      ctx.fillRect(-40, -40, GAME_WIDTH + 80, GAME_HEIGHT + 80);
    }

    // Referee announcements overlay (on top of everything except vignette)
    this.drawRefAnnouncements();

    this.drawVignette();
    ctx.restore();
  }

  private pt(x: number, y: number, h = 0): Vec2 {
    return this.proj.toScreen({ x, y }, h);
  }

  /**
   * Walls drawn as gradient quads. Side walls are tall — they run from the floor
   * (z=0) all the way to WALL_HEIGHT, which gives the enclosed room feel. The back
   * wall is a short glass-gallery band.
   */
  private drawWalls(): void {
    const ctx = this.ctx;
    const { width, depth } = COURT;
    const h = WALL_HEIGHT;

    if (!this.hasCourtArt()) {
      // Procedural fills only when no art is loaded
      const lbb = this.pt(0, depth, 0);
      const lfb = this.pt(0, 0, 0);
      const lft = this.pt(0, 0, h);
      const lbt = this.pt(0, depth, h);
      const leftGrad = ctx.createLinearGradient(lfb.x, lfb.y, lbb.x, lbb.y);
      leftGrad.addColorStop(0, 'rgba(28,43,62,0.38)');
      leftGrad.addColorStop(1, 'rgba(14,24,32,0.28)');
      this.fillQuadGrad(lbb, lbt, lft, lfb, leftGrad);
      ctx.strokeStyle = COL.wallEdge;
      ctx.lineWidth = 2;
      this.strokePoly([lbt, lft]);

      const rbb = this.pt(width, depth, 0);
      const rfb = this.pt(width, 0, 0);
      const rft = this.pt(width, 0, h);
      const rbt = this.pt(width, depth, h);
      const rightGrad = ctx.createLinearGradient(rfb.x, rfb.y, rbb.x, rbb.y);
      rightGrad.addColorStop(0, 'rgba(28,43,62,0.38)');
      rightGrad.addColorStop(1, 'rgba(14,24,32,0.28)');
      this.fillQuadGrad(rbb, rfb, rft, rbt, rightGrad);
      ctx.strokeStyle = COL.wallEdge;
      ctx.lineWidth = 2;
      this.strokePoly([rbt, rft]);

      const lft2 = this.pt(0, 0, h);
      const lbt2 = this.pt(0, depth, h);
      const rbt2 = this.pt(width, depth, h);
      const rft2 = this.pt(width, 0, h);
      this.fillQuad(lft2, lbt2, rbt2, rft2, 'rgba(12,21,32,0.45)');
    }

    // Side-wall out lines always drawn (they define the playable boundary).
    this.setGlowLine(
      withAlpha(COL.outLine, 0.98),
      withAlpha(COL.outLineGlow, 0.75),
      5, 16,
    );
    this.strokeSideWallLine('left', FRONT_OUT_HEIGHT);
    this.strokeSideWallLine('right', FRONT_OUT_HEIGHT);
    this.clearGlow();
  }

  /**
   * Back glass-gallery wall — the FOREGROUND layer. Drawn AFTER the players so a
   * competitor standing deep in the court (near y=depth) is correctly occluded by
   * the semi-transparent glass: he reads as "behind the glass, in front of nothing".
   * This is what gives the 2.5D depth sandwich — solid walls behind, glass in front.
   */
  private drawBackGlassFront(): void {
    const ctx = this.ctx;
    const glassImg = getImage('court_glass');
    if (glassImg && !this.hasCourtArt()) {
      // Only draw glass overlay when no art is loaded — art already has the back wall
      ctx.drawImage(glassImg, 0, 0, GAME_WIDTH, GAME_HEIGHT);
    } else if (!glassImg) {
      // Procedural fallback until the PNG loads.
      const { width, depth } = COURT;
      const h = WALL_HEIGHT;
      const bbl = this.pt(0, depth, 0);
      const bfl = this.pt(0, depth, h);
      const bfr = this.pt(width, depth, h);
      const bbr = this.pt(width, depth, 0);
      const bgGrad = ctx.createLinearGradient(0, bfl.y, 0, bbl.y);
      bgGrad.addColorStop(0, 'rgba(20,38,50,0.45)');
      bgGrad.addColorStop(0.5, 'rgba(15,28,38,0.30)');
      bgGrad.addColorStop(1, 'rgba(8,14,20,0.18)');
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(bbl.x, bbl.y);
      ctx.lineTo(bfl.x, bfl.y);
      ctx.lineTo(bfr.x, bfr.y);
      ctx.lineTo(bbr.x, bbr.y);
      ctx.closePath();
      ctx.fillStyle = bgGrad;
      ctx.fill();
      const audGrad = ctx.createLinearGradient(0, bfl.y, 0, bbl.y);
      audGrad.addColorStop(0, 'rgba(30,55,65,0.45)');
      audGrad.addColorStop(1, 'rgba(10,18,22,0.0)');
      ctx.beginPath();
      ctx.moveTo(bbl.x, bbl.y);
      ctx.lineTo(bfl.x, bfl.y);
      ctx.lineTo(bfr.x, bfr.y);
      ctx.lineTo(bbr.x, bbr.y);
      ctx.closePath();
      ctx.fillStyle = audGrad;
      ctx.fill();
      ctx.restore();
    }

    // Back-wall out line — amber boundary at FRONT_OUT_HEIGHT (sits on the glass).
    this.setGlowLine(
      withAlpha(COL.outLine, 0.92),
      withAlpha(COL.outLineGlow, 0.6),
      4, 12,
    );
    this.strokeBackWallLine(FRONT_OUT_HEIGHT);
    this.clearGlow();
  }

  /** Court floor as a perspective quad with gradient depth and marked service boxes. */
  private drawFloor(): void {
    const ctx = this.ctx;
    const { width, depth } = COURT;
    const tl = this.pt(0, 0);
    const tr = this.pt(width, 0);
    const br = this.pt(width, depth);
    const bl = this.pt(0, depth);

    if (!this.hasCourtArt()) {
      // Base floor gradient — only when no art loaded
      const floorGrad = ctx.createLinearGradient(tl.x, tl.y, bl.x, bl.y);
      floorGrad.addColorStop(0, 'rgba(22,40,36,0.52)');
      floorGrad.addColorStop(0.4, 'rgba(30,52,48,0.38)');
      floorGrad.addColorStop(1, 'rgba(21,36,32,0.28)');
      ctx.beginPath();
      ctx.moveTo(tl.x, tl.y);
      ctx.lineTo(tr.x, tr.y);
      ctx.lineTo(br.x, br.y);
      ctx.lineTo(bl.x, bl.y);
      ctx.closePath();
      ctx.fillStyle = floorGrad;
      ctx.fill();

      const midX = COURT.width / 2;
      this.fillFloorBand(SERVE_LINE_Y, depth, 'rgba(30,60,50,0.20)');
      this.fillFloorQuad(
        { x: 0, y: SERVE_LINE_Y }, { x: midX, y: SERVE_LINE_Y },
        { x: midX, y: depth }, { x: 0, y: depth },
        'rgba(60,160,100,0.08)',
      );
      this.fillFloorQuad(
        { x: midX, y: SERVE_LINE_Y }, { x: COURT.width, y: SERVE_LINE_Y },
        { x: COURT.width, y: depth }, { x: midX, y: depth },
        'rgba(80,130,160,0.08)',
      );
    }

    // Glow effect under the short service line — always shown
    const slA = this.pt(0, SERVE_LINE_Y);
    const slB = this.pt(width, SERVE_LINE_Y);
    ctx.save();
    ctx.shadowColor = 'rgba(80,220,160,0.6)';
    ctx.shadowBlur = 14;
    ctx.strokeStyle = 'rgba(100,255,180,0.5)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(slA.x, slA.y);
    ctx.lineTo(slB.x, slB.y);
    ctx.stroke();
    ctx.restore();

    // Court boundary lines — always drawn (gameplay reference)
    this.setGlowLine(COL.line, COL.lineGlow, 3, 8);
    this.strokePoly([tl, tr, br, bl, tl]);
    this.clearGlow();
    // Service box lines
    this.setGlowLine('rgba(140,240,180,0.95)', 'rgba(80,220,140,0.55)', 3, 10);
    this.strokeLogicLine({ x: 0, y: SERVE_LINE_Y }, { x: COURT.width, y: SERVE_LINE_Y });
    this.strokeLogicLine({ x: COURT.width / 2, y: SERVE_LINE_Y }, { x: COURT.width / 2, y: depth });
    this.clearGlow();
  }

  private fillFloorQuad(a: Vec2, b: Vec2, c: Vec2, d: Vec2, color: string): void {
    this.fillQuad(this.pt(a.x, a.y), this.pt(b.x, b.y), this.pt(c.x, c.y), this.pt(d.x, d.y), color);
  }

  private fillFloorBand(y0: number, y1: number, color: string): void {
    this.fillQuad(this.pt(0, y0), this.pt(COURT.width, y0), this.pt(COURT.width, y1), this.pt(0, y1), color);
  }

  /**
   * Front wall — drawn as a gradient panel. Lines from bottom to top:
   *   1. Tin (z = TIN_HEIGHT) — red board
   *   2. Service line (z = FRONT_SERVICE_LINE_Z ~40%) — red stripe, clearly above tin
   *   3. Out line (z = FRONT_OUT_HEIGHT ~95%) — amber top boundary
   */
  private drawFrontWall(): void {
    const ctx = this.ctx;
    const { width } = COURT;
    const h = WALL_HEIGHT;

    if (!this.hasCourtArt()) {
      // Wall gradient fill — only when no art loaded
      const wGrad = ctx.createLinearGradient(
        this.pt(width / 2, 0, h).x, this.pt(width / 2, 0, h).y,
        this.pt(width / 2, 0, 0).x, this.pt(width / 2, 0, 0).y,
      );
      wGrad.addColorStop(0, 'rgba(19,30,46,0.55)');
      wGrad.addColorStop(0.5, 'rgba(30,47,70,0.45)');
      wGrad.addColorStop(1, 'rgba(21,30,44,0.55)');
      const wTL = this.pt(0, 0, 0);
      const wTR = this.pt(width, 0, 0);
      const wBR = this.pt(width, 0, h);
      const wBL = this.pt(0, 0, h);
      ctx.beginPath();
      ctx.moveTo(wTL.x, wTL.y);
      ctx.lineTo(wTR.x, wTR.y);
      ctx.lineTo(wBR.x, wBR.y);
      ctx.lineTo(wBL.x, wBL.y);
      ctx.closePath();
      ctx.fillStyle = wGrad;
      ctx.fill();

      this.fillQuad(
        this.pt(0, 0, 0), this.pt(width, 0, 0),
        this.pt(width, 0, TIN_HEIGHT), this.pt(0, 0, TIN_HEIGHT),
        'rgba(160,40,40,0.35)',
      );
    }

    if (!this.hasCourtArt()) {
      // Tin and service lines — skip when art already shows them
      this.setGlowLine(COL.tin, COL.tinGlow, 5, 12);
      this.strokeWallLine(TIN_HEIGHT);
      this.clearGlow();

      this.setGlowLine(COL.serviceLine, COL.serviceLineGlow, 4, 10);
      this.strokeWallLine(FRONT_SERVICE_LINE_Z);
      this.clearGlow();
    }

    // Out line (top boundary) — always drawn as gameplay reference
    this.setGlowLine(COL.outLine, COL.outLineGlow, 6, 18);
    this.strokeWallLine(FRONT_OUT_HEIGHT);
    this.clearGlow();

    if (!this.hasCourtArt()) {
      this.fillQuad(
        this.pt(0, 0, FRONT_OUT_HEIGHT), this.pt(COURT.width, 0, FRONT_OUT_HEIGHT),
        this.pt(COURT.width, 0, WALL_HEIGHT), this.pt(0, 0, WALL_HEIGHT),
        'rgba(200,120,0,0.12)',
      );
    }
  }

  /** Stroke a horizontal line across the front wall at logic height z. */
  private strokeWallLine(z: number): void {
    const a = this.pt(0, 0, z);
    const b = this.pt(COURT.width, 0, z);
    this.strokePoly([a, b]);
  }

  /** Stroke a boundary line running front-to-back along one side wall at height z. */
  private strokeSideWallLine(side: 'left' | 'right', z: number): void {
    const x = side === 'left' ? 0 : COURT.width;
    const a = this.pt(x, 0, z);
    const b = this.pt(x, COURT.depth, z);
    this.strokePoly([a, b]);
  }

  /** Stroke a horizontal boundary line across the back wall at height z. */
  private strokeBackWallLine(z: number): void {
    const a = this.pt(0, COURT.depth, z);
    const b = this.pt(COURT.width, COURT.depth, z);
    this.strokePoly([a, b]);
  }

  /** Set a glow stroke: shadow blur behind the main line. */
  private setGlowLine(color: string, glow: string, lineW: number, blur: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowColor = glow;
    ctx.shadowBlur = blur;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineW;
  }

  private clearGlow(): void {
    this.ctx.restore();
  }

  /**
   * Draw the v4 material-only court background (no pre-baked lines) as the art
   * base. Falls back to v3 then v2 if not yet loaded. Procedural line passes
   * handle all geometry so we never get double-lines or stray image artefacts.
   */
  private drawCourtBaseArt(): void {
    const img = getImage('court_bg_no_glass') ?? getImage('court_material_base') ?? getImage('court_base_v3') ?? getImage('court_base');
    if (!img) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 1.0;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(img, 0, 0, GAME_WIDTH, GAME_HEIGHT);
    ctx.restore();
    // Cover the scoreboard baked into the art image — real scores come from the DOM HUD.
    if (getImage('court_bg_no_glass')) {
      ctx.save();
      ctx.fillStyle = 'rgba(6,8,15,0.97)';
      ctx.fillRect(360, 52, 560, 140);
      ctx.restore();
    }
  }

  /** Returns true when the generated court background art is loaded (skip procedural fills). */
  private hasCourtArt(): boolean {
    return getImage('court_bg_no_glass') !== null;
  }

  private drawAudienceArt(): void {
    // court_bg_no_glass already contains audience — skip separate overlay when it's loaded
    if (this.hasCourtArt()) return;
    const img = getImage('audience_side');
    if (!img) return;
    const ctx = this.ctx;
    const x = GAME_WIDTH * 0.12;
    const y = GAME_HEIGHT * 0.05;
    const w = GAME_WIDTH * 0.76;
    const h = GAME_HEIGHT * 0.22;
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.drawImage(img, x, y, w, h);
    ctx.restore();
  }

  /**
   * Court lines overlay disabled: v4 base has no pre-baked lines so we rely
   * entirely on procedural geometry (drawFrontWall / drawWalls / drawFloor).
   * Keeping the method avoids a diff on the call-site; it simply returns early.
   */
  private drawCourtLinesOverlay(): void {
    // Intentionally empty — image overlay caused stray fragments + double lines.
  }

  /** Subtle T-spot pulse — nudges the player to return to centre after hitting. */
  /**
   * Aim indicator: shows the player the front-wall horizontal target zone based on
   * current swing timing. Timing early → ball goes left; late → ball goes right;
   * perfect → centre. A sliding marker on the front wall top edge shows the zone.
   * Only visible when the shuttle is approaching the player's strike height.
   */
  private drawAimIndicator(shuttle: ShuttleState): void {
    const ctx = this.ctx;
    // Only show when ball is near the player and descending toward strike zone.
    const dz = shuttle.z - STRIKE_Z;
    if (Math.abs(dz) > SWING_REACH_Z) return; // too far above
    if (shuttle.z < 0) return;

    // Compute timing delta: positive = ball still above STRIKE_Z (early), negative = below (late).
    // Same logic as sim's timingDelta but simplified.
    const dt = shuttle.vz <= 0
      ? Math.sign(dz) * Math.min(TIMING_WINDOW, Math.abs(dz) / 6)
      : TIMING_WINDOW * 0.5; // rising ball = always "early" zone

    // Map timing to aimX: early (dt>0) → left (aimX<0), late (dt<0) → right (aimX>0).
    const aimX = Math.max(-1, Math.min(1, -dt / TIMING_WINDOW));
    const centerX = COURT.width * 0.5;
    const xEdgeL = COURT.width * 0.12;
    const xEdgeR = COURT.width * 0.88;
    const edge = aimX < 0 ? xEdgeL : xEdgeR;
    const targetWallX = aimX === 0 ? centerX : centerX + (edge - centerX) * Math.abs(aimX);

    // Urgency: brighter and larger when ball is very close to strike zone.
    const proximity = 1 - Math.min(1, Math.abs(dz) / SWING_REACH_Z);
    if (proximity < 0.25) return; // too far, don't clutter

    // Draw a glowing dot on the front wall at the predicted hit point.
    // The front wall is at y=0; we draw it at height ~mid (tin_height to out_height midpoint).
    const wallZ = TIN_HEIGHT + (FRONT_OUT_HEIGHT - TIN_HEIGHT) * 0.5;
    const p = this.pt(targetWallX, 0, wallZ);

    const alpha = proximity * 0.75;
    const isLeft  = aimX < -0.15;
    const isRight = aimX > 0.15;
    const dirColor = isLeft ? 'rgba(100,220,140,' : isRight ? 'rgba(255,170,60,' : 'rgba(120,200,255,';

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = dirColor + '0.9)';
    ctx.shadowBlur = 12;
    ctx.strokeStyle = dirColor + '0.9)';
    ctx.lineWidth = 3;
    // Horizontal line segment centred on the aim point
    const hw = 28 * proximity;
    ctx.beginPath();
    ctx.moveTo(p.x - hw, p.y);
    ctx.lineTo(p.x + hw, p.y);
    ctx.stroke();
    // Centre dot
    ctx.fillStyle = dirColor + '1)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6 * proximity, 0, Math.PI * 2);
    ctx.fill();
    // Label: ← centre →
    if (proximity > 0.5) {
      ctx.globalAlpha = alpha * 0.9;
      ctx.font = `bold ${Math.round(13 * proximity)}px sans-serif`;
      ctx.fillStyle = dirColor + '1)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const label = isLeft ? '← 左' : isRight ? '右 →' : '中央';
      ctx.fillText(label, p.x, p.y - 10);
    }
    ctx.restore();
  }

  private drawTSpotHint(): void {
    const ctx = this.ctx;
    const p = this.pt(T_SPOT.x, T_SPOT.y, 0);
    const scale = this.proj.depthScale(T_SPOT.y);
    const pulse = 0.5 + Math.sin(Date.now() * 0.004) * 0.25;
    ctx.save();
    ctx.globalAlpha = pulse * 0.35;
    ctx.shadowColor = 'rgba(80,220,160,0.9)';
    ctx.shadowBlur = 12 * scale;
    ctx.strokeStyle = 'rgba(80,220,160,0.9)';
    ctx.lineWidth = 2 * scale;
    const r = 18 * scale;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, r, r * 0.42, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Dashed guide line from the server's position toward the front-wall target zone,
   * shown during the serve countdown. Gives the server a visual cue of where their
   * serve will land.
   */
  private drawServeGuideLine(serverPos: Vec2, serveBox: 0 | 1): void {
    const ctx = this.ctx;
    // Target front-wall x: opposite to the serve box so it rebounds diagonally.
    const targetX = serveBox === 1 ? COURT.width * 0.35 : COURT.width * 0.65;
    const targetZ = WALL_HEIGHT * 0.55; // mid-high strike zone

    const from = this.pt(serverPos.x, serverPos.y, 60);
    const to   = this.pt(targetX, 0, targetZ);

    const pulse = 0.55 + Math.sin(Date.now() * 0.012) * 0.30;

    ctx.save();
    ctx.globalAlpha = pulse * 0.65;
    ctx.shadowColor = 'rgba(80,200,255,0.8)';
    ctx.shadowBlur = 10;
    ctx.strokeStyle = 'rgba(80,200,255,0.9)';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([14, 9]);
    ctx.lineDashOffset = (Date.now() * 0.05) % 23;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Small dot at the target wall point
    ctx.globalAlpha = pulse;
    ctx.fillStyle = 'rgba(100,220,255,0.9)';
    ctx.beginPath();
    ctx.arc(to.x, to.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Flash the tin (bottom) or out line (top) of the front wall red for a short burst. */
  private drawFaultFlash(flash: { kind: 'tin' | 'out'; age: number; life: number }): void {
    const ctx = this.ctx;
    const { width } = COURT;
    const t = flash.age / flash.life;
    const alpha = (1 - t) * (0.6 + Math.sin(t * Math.PI * 4) * 0.25); // pulsing fade

    // The band spans from the fault line ±some pixels in z
    const bandZ = flash.kind === 'tin' ? TIN_HEIGHT : FRONT_OUT_HEIGHT;
    const bandH = 30;
    const zLo = flash.kind === 'tin' ? 0 : bandZ - bandH;
    const zHi = flash.kind === 'tin' ? bandZ + bandH : WALL_HEIGHT;

    const tl = this.pt(0, 0, zHi);
    const tr = this.pt(width, 0, zHi);
    const br = this.pt(width, 0, zLo);
    const bl = this.pt(0, 0, zLo);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(255,40,40,1)';
    ctx.beginPath();
    ctx.moveTo(tl.x, tl.y);
    ctx.lineTo(tr.x, tr.y);
    ctx.lineTo(br.x, br.y);
    ctx.lineTo(bl.x, bl.y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /** Wall-impact pings — uses wall_impact_sheet if loaded, otherwise procedural rings. */
  private drawWallPings(): void {
    const ctx = this.ctx;
    const impactImg = getImage('wall_impact_sheet');
    for (const w of this.wallPings) {
      const t = w.age / w.life;
      const p = this.pt(w.x, 0, w.z);
      const depSc = this.proj.depthScale(0);

      if (impactImg) {
        // Image-assisted: strong initial flash, fast fade.
        const frameIdx = Math.min(9, Math.floor(t * 10));
        const crop = wallImpactCrop(frameIdx);
        const size = (80 + t * 30) * depSc;
        const alpha = Math.pow(1 - t, 1.5);
        ctx.save();
        // White flash at t=0 fading to normal.
        if (t < 0.2) {
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = (0.2 - t) * 5 * 0.55;
          ctx.drawImage(impactImg, crop.sx, crop.sy, crop.sw, crop.sh, p.x - size / 2, p.y - size / 2, size, size);
        }
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = alpha * 0.95;
        ctx.shadowColor = '#ffe080';
        ctx.shadowBlur = 20 * (1 - t);
        ctx.drawImage(impactImg, crop.sx, crop.sy, crop.sw, crop.sh, p.x - size / 2, p.y - size / 2, size, size);
        ctx.restore();
      } else {
        // Procedural fallback — sharp initial pop, fast clean fade.
        const r = (12 + t * 40) * depSc;
        ctx.save();
        ctx.shadowColor = '#ffe080';
        ctx.shadowBlur = (24 - t * 20) * (1 - t);
        ctx.strokeStyle = withAlpha('#ffe9a8', Math.pow(1 - t, 1.4) * 0.98);
        ctx.lineWidth = (5.5 - t * 3) * (1 - t);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = withAlpha('#ffffff', Math.pow(1 - t, 2.2) * 0.7);
        ctx.lineWidth = 2.5 * (1 - t);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 0.52, 0, Math.PI * 2);
        ctx.stroke();
        if (t < 0.28) {
          // Bright flash core — white fill shrinks quickly.
          const flashAlpha = (0.28 - t) / 0.28;
          ctx.fillStyle = withAlpha('#ffffff', flashAlpha * 0.85);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 7 * depSc * (1 - t * 3), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }
  }

  private drawLandingMarker(landing: Vec2, eta: number, practice = false): void {
    const ctx = this.ctx;
    const p = this.pt(landing.x, landing.y, 0);
    const scale = this.proj.depthScale(landing.y);

    // close: 0 = ball just landed, 1 = ball far away (large ring)
    const close = Math.max(0, Math.min(1, eta / 80));
    const urgency = 1 - close; // 0 = far, 1 = about to land

    // Practice: always full-brightness cyan target — training aid always visible.
    // Match: green (far) → amber → red (imminent) with decreasing ring.
    let colFill: string;
    let colGlow: string;
    let outerR: number;
    if (practice) {
      colFill = `rgba(80,220,255,${0.75 + urgency * 0.2})`;
      colGlow = `rgba(40,180,255,${0.4 + urgency * 0.3})`;
      outerR = (10 + close * 36) * scale;
    } else {
      const r = urgency;
      const g = Math.max(0, 1 - urgency * 1.4);
      void g;
      colFill  = `rgba(${Math.round(80 + r * 175)},${Math.round(200 - urgency * 150)},${Math.round(80 - urgency * 60)},${0.85 + urgency * 0.1})`;
      colGlow  = `rgba(${Math.round(80 + r * 175)},${Math.round(200 - urgency * 150)},60,${0.3 + urgency * 0.3})`;
      outerR = (6 + close * 28) * scale;
    }
    const pulse  = urgency > 0.6 ? Math.sin(Date.now() * 0.025) * 1.5 * urgency * scale : 0;

    ctx.save();
    ctx.shadowColor = colGlow;
    ctx.shadowBlur = (practice ? 16 : 10) + urgency * 14;
    ctx.strokeStyle = colFill;
    ctx.lineWidth = (practice ? 3 : 2 + urgency * 2) * scale;
    // Outer shrinking ring
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, outerR + pulse, (outerR + pulse) * 0.38, 0, 0, Math.PI * 2);
    ctx.stroke();
    // Practice: extra inner cross-hair for precise target
    if (practice) {
      const ch = 10 * scale;
      ctx.lineWidth = 1.5 * scale;
      ctx.beginPath();
      ctx.moveTo(p.x - ch, p.y); ctx.lineTo(p.x + ch, p.y);
      ctx.moveTo(p.x, p.y - ch * 0.38); ctx.lineTo(p.x, p.y + ch * 0.38);
      ctx.stroke();
    }
    // Solid centre dot — grows as ball approaches
    ctx.fillStyle = colFill;
    ctx.beginPath();
    const dotR = (practice ? 5 : 3 + urgency * 4) * scale;
    ctx.ellipse(p.x, p.y, dotR, dotR * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Foot-skid dust puffs. */
  private drawDustPuffs(): void {
    const ctx = this.ctx;
    for (const d of this.dustPuffs) {
      const t = d.age / d.life;
      const p = this.pt(d.pos.x, d.pos.y, 0);
      const scale = this.proj.depthScale(d.pos.y);
      const alpha = (1 - t) * 0.35;
      ctx.fillStyle = COL.dust + alpha + ')';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y - d.r * t * scale, d.r * (0.5 + t) * scale, d.r * 0.4 * (1 - t * 0.5) * scale, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawPlayerShadow(pl: PlayerState): void {
    const ctx = this.ctx;
    const p = this.pt(pl.pos.x, pl.pos.y, 0);
    const scale = this.proj.depthScale(pl.pos.y);
    const diving = pl.diveFrames > 0;
    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, (diving ? 36 : 28) * scale);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, (diving ? 38 : 30) * scale, 11 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawPlayer(pl: PlayerState, color: string, dark: string): void {
    const ctx = this.ctx;
    const scale = this.proj.depthScale(pl.pos.y);
    const foot = this.pt(pl.pos.x, pl.pos.y, 0);
    const isP1 = color === COL.p1;
    const diving = pl.diveFrames > 0;
    const grounded = pl.diveRecovery > 0;

    this.drawReach(pl, scale);

    // Try sprite rendering first; fall back to procedural capsule on failure.
    if (this.drawPlayerSprite(pl, foot, scale, isP1)) return;

    // ---- Procedural fallback ----
    const bodyH = 64 * scale;
    const bodyW = 30 * scale;

    ctx.save();
    ctx.translate(foot.x, foot.y);

    let leanAngle = 0;
    if (diving || grounded) {
      const lean = grounded ? 1.0 : 0.7;
      leanAngle = (pl.diveDir.x || 0) * 0.45 * lean;
      ctx.rotate(leanAngle);

      if (diving && pl.diveFrames > 2) {
        for (let i = 1; i <= 3; i++) {
          const ghostAlpha = 0.12 - i * 0.03;
          const offX = -(pl.diveDir.x || 0) * i * 8 * scale;
          const offY = -(pl.diveDir.y || 0) * i * 6 * scale;
          ctx.save();
          ctx.globalAlpha = ghostAlpha;
          ctx.translate(offX, offY);
          roundCapsule(ctx, 0, -bodyH, bodyW, bodyH, bodyW * 0.5);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.restore();
        }
      }
    }

    const cx = 0;
    const top = -bodyH;

    const bodyGrad = ctx.createLinearGradient(-bodyW / 2, top, bodyW / 2, top + bodyH);
    const { r: cr, g: cg, b: cb } = hexRgb(color);
    bodyGrad.addColorStop(0, `rgb(${Math.min(255, cr + 40)},${Math.min(255, cg + 40)},${Math.min(255, cb + 40)})`);
    bodyGrad.addColorStop(1, `rgb(${Math.max(0, cr - 20)},${Math.max(0, cg - 20)},${Math.max(0, cb - 20)})`);

    roundCapsule(ctx, cx, top, bodyW, bodyH, bodyW * 0.5);
    ctx.fillStyle = bodyGrad;
    ctx.fill();
    ctx.strokeStyle = dark;
    ctx.lineWidth = 2.5 * scale;
    ctx.stroke();

    ctx.fillStyle = lighten(color);
    ctx.beginPath();
    ctx.arc(cx, top, bodyW * 0.55, 0, Math.PI * 2);
    ctx.fill();

    if (!diving && !grounded) {
      this.drawRacket(ctx, cx, top, bodyW, scale, pl);
    }

    ctx.restore();
  }

  /**
   * Draw a player using sprite sheet crops. Returns true if a sprite was drawn,
   * false if the required image is not loaded (caller falls back to procedural).
   *
   * Sizing: sprite cells are 418×314 px. We target ~100-130 px tall at midcourt
   * and scale linearly by depth. The cell aspect ratio is kept; bottom-center
   * of the cell is anchored at the floor projection point.
   */
  private drawPlayerSprite(
    pl: PlayerState,
    foot: Vec2,
    scale: number,
    isP1: boolean,
  ): boolean {
    const diving = pl.diveFrames > 0;
    const swinging = pl.swingCooldown > 0;

    let img: HTMLImageElement | null;
    let crop: Crop;

    if (isP1) {
      // Prefer back-view sheet for p1 (player faces front wall, back to camera).
      const backviewImg = getImage('player_backview');
      if (backviewImg) {
        img = backviewImg;
        if (diving) {
          crop = PLAYER_BACKVIEW_CROPS.dive;
        } else if (swinging) {
          crop = PLAYER_BACKVIEW_CROPS.swing;
        } else {
          const speed = Math.hypot(pl.vel.x, pl.vel.y);
          crop = speed > 1.0 ? PLAYER_BACKVIEW_CROPS.run : PLAYER_BACKVIEW_CROPS.ready;
        }
      } else {
        // Fallback to old sheets if backview not loaded yet
        const speedY = pl.vel.y;
        const useLunge = diving || speedY < -1.5;
        if (useLunge) {
          img = getImage('player_lunge');
          if (!img) return false;
          crop = diving ? PLAYER_LUNGE_CROPS.dive : PLAYER_LUNGE_CROPS.lunge;
        } else {
          img = getImage('player_lateral');
          if (!img) return false;
          crop = swinging ? PLAYER_LATERAL_CROPS.swing : PLAYER_LATERAL_CROPS.ready;
        }
      }
    } else {
      img = getImage('opponent_core');
      if (!img) return false;
      if (diving) {
        crop = OPPONENT_CROPS.dive;
      } else if (swinging) {
        crop = OPPONENT_CROPS.swing;
      } else {
        const speed = Math.hypot(pl.vel.x, pl.vel.y);
        crop = speed > 1.0 ? OPPONENT_CROPS.run : OPPONENT_CROPS.ready;
      }
    }

    // Target sprite height: ~148 px at midcourt depth (scale=1), scaled by depth.
    // +25% over phase-4 baseline for stronger presence; far player still smaller via scale.
    const spriteH = 148 * scale;
    // Maintain cell aspect ratio (418 / 314 ≈ 1.33)
    const spriteW = spriteH * (crop.sw / crop.sh);

    const ctx = this.ctx;
    ctx.save();

    // Lean sprite when diving
    if ((pl.diveFrames > 0 || pl.diveRecovery > 0)) {
      const lean = pl.diveRecovery > 0 ? 1.0 : 0.7;
      ctx.translate(foot.x, foot.y);
      ctx.rotate((pl.diveDir.x || 0) * 0.35 * lean);
      ctx.translate(-foot.x, -foot.y);
    }

    // Motion smear ghosts behind sprite during dive
    if (pl.diveFrames > 2) {
      for (let i = 1; i <= 2; i++) {
        const offX = -(pl.diveDir.x || 0) * i * 9 * scale;
        const offY = -(pl.diveDir.y || 0) * i * 6 * scale;
        ctx.save();
        ctx.globalAlpha = 0.09 - i * 0.03;
        ctx.drawImage(
          img,
          crop.sx, crop.sy, crop.sw, crop.sh,
          foot.x - spriteW / 2 + offX,
          foot.y - spriteH + offY,
          spriteW, spriteH,
        );
        ctx.restore();
      }
    }

    // Main sprite: bottom-center anchored at foot position (drawn in flipped Y space,
    // so foot.y - spriteH in flipped coords = head above foot visually).
    ctx.drawImage(
      img,
      crop.sx, crop.sy, crop.sw, crop.sh,
      foot.x - spriteW / 2,
      foot.y - spriteH,
      spriteW, spriteH,
    );

    ctx.restore();
    return true;
  }

  private drawRacket(
    ctx: CanvasRenderingContext2D,
    cx: number,
    top: number,
    bodyW: number,
    scale: number,
    pl: PlayerState,
  ): void {
    const faceSign = 1;
    const swing = pl.swingCooldown / SWING_COOLDOWN_FRAMES;
    const restAngle = -0.95;
    const swingAngle = 0.6;
    const angle = restAngle + (swingAngle - restAngle) * swing;
    const handX = cx + faceSign * bodyW * 0.45;
    const handY = top + bodyW * 0.7;
    const len = bodyW * 1.7;
    const dx = Math.sin(angle) * faceSign;
    const dy = -Math.cos(angle);
    const tipX = handX + dx * len;
    const tipY = handY + dy * len;

    ctx.strokeStyle = '#c8a060';
    ctx.lineWidth = 3 * scale;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(handX, handY);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    const headR = bodyW * 0.5;
    ctx.save();
    ctx.translate(tipX, tipY);
    ctx.rotate(angle * faceSign);
    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 2.2 * scale;
    ctx.beginPath();
    ctx.ellipse(0, -headR * 0.5, headR * 0.62, headR, 0, 0, Math.PI * 2);
    ctx.stroke();
    // Racket strings cross.
    ctx.strokeStyle = 'rgba(220,220,220,0.3)';
    ctx.lineWidth = 0.8 * scale;
    ctx.beginPath();
    ctx.moveTo(-headR * 0.55, -headR * 0.5);
    ctx.lineTo(headR * 0.55, -headR * 0.5);
    ctx.moveTo(0, -headR * 1.4);
    ctx.lineTo(0, headR * 0.4);
    ctx.stroke();
    ctx.restore();
  }

  private drawReach(pl: PlayerState, scale: number): void {
    const ctx = this.ctx;
    const diving = pl.diveFrames > 0;
    const reach = diving ? SWING_REACH + 90 : SWING_REACH;
    const side: Side = pl.facing === 'left' ? 0 : 1;
    const c = diving ? pl.pos : racketCenter(pl.pos, side);
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
    const shadow = this.pt(sh.pos.x, sh.pos.y, 0);  // ground projection
    const ball   = this.pt(sh.pos.x, sh.pos.y, sh.z); // ball actual screen pos
    const scale  = this.proj.depthScale(sh.pos.y);
    const lift   = Math.min(1, sh.z / 300); // 0 = on floor, 1 = very high

    // Dashed vertical line from shadow to ball — clear height indicator
    if (sh.z > 8) {
      ctx.save();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = `rgba(255,200,80,${0.28 * (1 - lift * 0.5)})`;
      ctx.lineWidth = 1 * scale;
      ctx.beginPath();
      ctx.moveTo(shadow.x, shadow.y);
      ctx.lineTo(ball.x, ball.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Ground shadow ellipse: darker/larger when near floor
    const r = (6 + (1 - lift) * 8) * scale;
    const alpha = 0.55 * (1 - lift * 0.65);
    const grad = ctx.createRadialGradient(shadow.x, shadow.y, 0, shadow.x, shadow.y, r * 2.5);
    grad.addColorStop(0, `rgba(0,0,0,${alpha})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(shadow.x, shadow.y, r, r * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Ball ghost trail — style varies by speed: kill=streak, lob=wide circle, drive=medium. */
  private drawBallGhosts(): void {
    const ctx = this.ctx;
    for (const g of this.ballGhosts) {
      const t = g.age / g.life;
      const p = this.pt(g.pos.x, g.pos.y, g.z);
      const scale = this.proj.depthScale(g.pos.y);
      const sp = g.speed;

      // Speed classification: kill >18, drive 8–18, lob <8
      const isKill = sp > 18;
      const isLob = sp < 8;

      const r = (isKill ? 4 : isLob ? 9 : 6) * scale * (1 - t * 0.45);
      const alpha = Math.pow(1 - t, isKill ? 1.6 : 1.1) * (isKill ? 0.9 : 0.65);

      ctx.save();
      ctx.globalAlpha = alpha;

      if (isKill) {
        // Fast kill: flat elongated streak, hot orange/white
        ctx.shadowColor = '#ffffff';
        ctx.shadowBlur = 6 * (1 - t);
        ctx.fillStyle = t < 0.3 ? '#ffffff' : '#ffaa30';
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, r * 1.8, r * 0.55, 0, 0, Math.PI * 2);
        ctx.fill();
      } else if (isLob) {
        // Slow lob: full circle, cooler cyan-amber
        ctx.shadowColor = '#60d8ff';
        ctx.shadowBlur = 10 * (1 - t);
        ctx.strokeStyle = withAlpha('#80e8ff', (1 - t) * 0.8);
        ctx.lineWidth = 1.5 * scale;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = withAlpha(COL.shuttle, alpha * 0.4);
        ctx.fill();
      } else {
        // Drive: medium amber glow
        ctx.shadowColor = t < 0.5 ? '#ffa030' : '#ff6018';
        ctx.shadowBlur = 12 * (1 - t);
        ctx.fillStyle = t < 0.4 ? COL.shuttle : COL.shuttleEdge;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  private drawShuttle(sh: GameState['shuttle'], phase: GameState['phase']): void {
    const visible = sh.inPlay || phase === 'serve';
    if (!visible) return;
    const ctx = this.ctx;
    const body = this.pt(sh.pos.x, sh.pos.y, sh.z);
    const scale = this.proj.depthScale(sh.pos.y);
    const r = (7 + Math.min(1, sh.z / 200) * 2.5) * scale;

    // Speed trail — style depends on shot type: kill=white streak, lob=wide arc, drive=amber
    const sp = Math.hypot(sh.vel.x, sh.vel.y);
    const isKill = sp > 18;
    const isLob = sp < 8;
    if (sp > 0.6) {
      const ang = Math.atan2(sh.vel.y, sh.vel.x) + Math.PI;
      const trailLen = Math.min(sp * (isKill ? 1.8 : 1.3), isKill ? 90 : 60) * scale;
      const speedT = Math.min(1, sp / 22);
      const grd = ctx.createLinearGradient(
        body.x, body.y,
        body.x + Math.cos(ang) * trailLen,
        body.y + Math.sin(ang) * trailLen,
      );
      if (isKill) {
        grd.addColorStop(0, `rgba(255,255,220,${0.95})`);
        grd.addColorStop(0.25, `rgba(255,180,40,${0.8})`);
        grd.addColorStop(1, 'rgba(255,80,0,0)');
      } else if (isLob) {
        grd.addColorStop(0, `rgba(200,240,255,${0.6})`);
        grd.addColorStop(0.5, `rgba(100,200,240,${0.3})`);
        grd.addColorStop(1, 'rgba(80,160,200,0)');
      } else {
        grd.addColorStop(0, `rgba(255,200,60,${0.75 + speedT * 0.20})`);
        grd.addColorStop(0.4, `rgba(255,120,20,${0.45 + speedT * 0.20})`);
        grd.addColorStop(1, 'rgba(255,80,0,0)');
      }
      ctx.save();
      ctx.shadowColor = isKill ? '#ffffff' : isLob ? '#80d0ff' : '#ff5010';
      ctx.shadowBlur = (isKill ? 18 : 10 + speedT * 14) * Math.min(1, sp / 16);
      ctx.strokeStyle = grd;
      ctx.lineWidth = r * (isKill ? 1.4 : 2.2 + speedT * 1.2);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(body.x, body.y);
      ctx.lineTo(body.x + Math.cos(ang) * trailLen, body.y + Math.sin(ang) * trailLen);
      ctx.stroke();
      ctx.restore();
    }

    // Outer glow halo.
    ctx.save();
    ctx.shadowColor = '#ff8020';
    ctx.shadowBlur = 16 * scale;
    // Ball fill — radial gradient: bright core to amber.
    const ballGrad = ctx.createRadialGradient(
      body.x - r * 0.25, body.y - r * 0.25, r * 0.1,
      body.x, body.y, r,
    );
    ballGrad.addColorStop(0, COL.shuttleCore);
    ballGrad.addColorStop(0.5, COL.shuttle);
    ballGrad.addColorStop(1, COL.shuttleEdge);
    ctx.fillStyle = ballGrad;
    ctx.beginPath();
    ctx.arc(body.x, body.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Thin edge stroke for definition.
    ctx.strokeStyle = 'rgba(80,30,0,0.6)';
    ctx.lineWidth = 1.2 * scale;
    ctx.beginPath();
    ctx.arc(body.x, body.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  /** Colored wall impact FX — tin=red, valid=white/orange, out=purple. (task #26) */
  private drawWallImpactFX(): void {
    const ctx = this.ctx;
    for (const w of this.wallImpactFX) {
      const t = w.age / w.life;
      const p = this.pt(w.x, 0, Math.max(0, Math.min(WALL_HEIGHT, w.z)));
      const depSc = this.proj.depthScale(0);
      const colorMap = { tin: '#ff3030', valid: '#ffe88a', out: '#c060ff' };
      const glowMap  = { tin: '#ff0000', valid: '#ffaa00', out: '#8040ff' };
      const color = colorMap[w.kind];
      const glow  = glowMap[w.kind];
      const r = (30 + t * 50) * depSc;
      ctx.save();
      ctx.globalAlpha = Math.pow(1 - t, 1.3) * 0.9;
      ctx.shadowColor = glow;
      ctx.shadowBlur = 22 * (1 - t);
      ctx.strokeStyle = color;
      ctx.lineWidth = (6 - t * 4) * depSc;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
      if (t < 0.35) {
        ctx.globalAlpha = (0.35 - t) / 0.35 * 0.7;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  /** Floating PERFECT!/GOOD! quality labels above hit point. (task #27) */
  private drawQualityLabels(): void {
    const ctx = this.ctx;
    for (const q of this.qualityLabels) {
      const t = q.age / q.life;
      const rise = t * 28; // float upward
      const p = this.pt(q.pos.x, q.pos.y, q.z + rise);
      const alpha = t < 0.5 ? 1 : 1 - (t - 0.5) / 0.5;
      const text = q.quality === 'perfect' ? 'PERFECT!' : 'GOOD!';
      const color = q.quality === 'perfect' ? '#ffd060' : '#80ffb0';
      const size = q.quality === 'perfect' ? 20 : 16;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = `bold ${size}px "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.fillStyle = color;
      ctx.fillText(text, p.x, p.y);
      ctx.restore();
    }
  }

  /** Referee text announcements at screen centre. (task #22) */
  private drawRefAnnouncements(): void {
    if (this.refAnnouncements.length === 0) return;
    const ctx = this.ctx;
    // Show only the most recent one
    const ann = this.refAnnouncements[this.refAnnouncements.length - 1];
    const t = ann.age / ann.life;
    const alpha = t < 0.15 ? t / 0.15 : t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
    const scale = t < 0.15 ? 0.6 + (t / 0.15) * 0.4 : 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(GAME_WIDTH / 2, GAME_HEIGHT * 0.42);
    ctx.scale(scale, scale);
    ctx.font = `bold 36px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = ann.color;
    ctx.shadowBlur = 24;
    ctx.fillStyle = ann.color;
    ctx.fillText(ann.text, 0, 0);
    ctx.restore();
  }

  private drawBursts(): void {
    const ctx = this.ctx;
    for (const b of this.bursts) {
      const t = b.age / b.life;
      const p = this.pt(b.pos.x, b.pos.y, b.z);
      const scale = this.proj.depthScale(b.pos.y);
      const r = (8 + t * 36) * scale;
      ctx.save();
      ctx.shadowColor = QUALITY_FLASH[b.quality];
      ctx.shadowBlur = 12 * (1 - t);
      ctx.strokeStyle = withAlpha(QUALITY_FLASH[b.quality], 1 - t);
      ctx.lineWidth = (b.quality === 'perfect' ? 4.5 : 2.8) * (1 - t) * scale;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
      if (b.quality === 'perfect') {
        const sp = r * 1.3;
        ctx.lineWidth = 2 * (1 - t) * scale;
        ctx.beginPath();
        ctx.moveTo(p.x - sp, p.y);
        ctx.lineTo(p.x + sp, p.y);
        ctx.moveTo(p.x, p.y - sp);
        ctx.lineTo(p.x, p.y + sp);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /** Radial vignette to darken the screen edges, giving focus to centre court. */
  /** serveBox null = waiting for choice; 0/1 = box confirmed, showing ready countdown. */
  /** Serve choice overlay — task #15: more prominent, pulsing border. */
  private drawServeChoiceOverlay(serveBox: 0 | 1 | null): void {
    const ctx = this.ctx;
    const cx = GAME_WIDTH / 2;
    const cy = GAME_HEIGHT * 0.78;
    ctx.save();
    const isReady = serveBox !== null;

    if (!isReady) {
      // Pulsing glow background
      const pulse = 0.5 + Math.sin(Date.now() * 0.006) * 0.3;

      // Left box button
      const lbx = cx - 120; const bw = 110; const bh = 58;
      const lby = cy - bh / 2;
      ctx.shadowColor = 'rgba(56,200,160,0.8)';
      ctx.shadowBlur = 12 * pulse;
      ctx.fillStyle = 'rgba(8,24,20,0.92)';
      ctx.beginPath();
      ctx.roundRect(lbx, lby, bw, bh, 8);
      ctx.fill();
      ctx.strokeStyle = `rgba(56,200,160,${0.5 + pulse * 0.4})`;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#a0f8d8';
      ctx.font = `bold 13px "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('← 左框發球', lbx + bw / 2, cy - 10);
      ctx.fillStyle = 'rgba(160,240,200,0.55)';
      ctx.font = `11px "Segoe UI", system-ui, sans-serif`;
      ctx.fillText('[A / ←]', lbx + bw / 2, cy + 12);

      // Right box button
      const rbx = cx + 10;
      ctx.shadowColor = 'rgba(56,200,160,0.8)';
      ctx.shadowBlur = 12 * pulse;
      ctx.fillStyle = 'rgba(8,20,28,0.92)';
      ctx.beginPath();
      ctx.roundRect(rbx, lby, bw, bh, 8);
      ctx.fill();
      ctx.strokeStyle = `rgba(56,200,160,${0.5 + pulse * 0.4})`;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#a0f8d8';
      ctx.font = `bold 13px "Segoe UI", system-ui, sans-serif`;
      ctx.fillText('右框發球 →', rbx + bw / 2, cy - 10);
      ctx.fillStyle = 'rgba(160,240,200,0.55)';
      ctx.font = `11px "Segoe UI", system-ui, sans-serif`;
      ctx.fillText('[D / →]', rbx + bw / 2, cy + 12);

      // Label above
      ctx.fillStyle = 'rgba(180,220,210,0.75)';
      ctx.font = `12px "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('選擇發球格', cx, cy - bh / 2 - 10);
    } else {
      // Ready countdown
      const pw = 280; const ph = 52;
      ctx.fillStyle = 'rgba(8,26,14,0.92)';
      ctx.shadowColor = 'rgba(80,220,120,0.6)';
      ctx.shadowBlur = 16;
      ctx.beginPath();
      ctx.roundRect(cx - pw / 2, cy - ph / 2, pw, ph, 10);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(80,220,120,0.8)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#a0f0c0';
      ctx.font = `bold 18px "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const boxLabel = serveBox === 0 ? '左框' : '右框';
      ctx.fillText(`✓ ${boxLabel}  準備發球…`, cx, cy);
    }
    ctx.restore();
  }

  private drawVignette(): void {
    const ctx = this.ctx;
    const cx = GAME_WIDTH / 2;
    const cy = GAME_HEIGHT / 2;
    const grad = ctx.createRadialGradient(cx, cy, GAME_HEIGHT * 0.25, cx, cy, GAME_HEIGHT * 0.85);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, COL.vignette);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
  }

  private fillQuad(a: Vec2, b: Vec2, c: Vec2, d: Vec2, color: string): void {
    if (color === 'transparent') return;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  private fillQuadGrad(a: Vec2, b: Vec2, c: Vec2, d: Vec2, grad: CanvasGradient): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
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

  // ---- HUD bridge ----
  private lastAwaitingServe = false;

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
    // Notify touch controls when the human must choose a service box.
    const awaiting = s.awaitingServeChoice && s.server === 0;
    if (awaiting !== this.lastAwaitingServe) {
      this.lastAwaitingServe = awaiting;
      eventBus.emit('serve:awaiting', { waiting: awaiting });
    }
  }

}

// ---- small drawing helpers (module-local, pure) ----

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
  ctx.arc(cx, top + r, w / 2, Math.PI, 0);
  ctx.lineTo(right, bottom - r);
  ctx.arc(cx, bottom - r, w / 2, 0, Math.PI);
  ctx.lineTo(left, top + r);
  ctx.closePath();
  void r;
}

function lighten(hex: string): string {
  const { r, g, b } = hexRgb(hex);
  const mix = (c: number) => Math.round(c + (255 - c) * 0.35);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

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
