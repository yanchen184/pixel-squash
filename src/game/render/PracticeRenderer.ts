/**
 * PracticeRenderer — front-wall camera view.
 *
 * Camera is pinned to the front wall, looking back toward the player.
 * The front wall IS the screen. Ball flying toward the front wall appears to
 * grow larger (approaching camera); ball rebounding back toward the player
 * shrinks (moving away from camera).
 *
 * Coordinate remapping from game-space:
 *   game x ∈ [0, COURT.width]   → screen x (mirrored: left wall on left)
 *   game y ∈ [0, COURT.depth]   → depth (y=0 = front wall = near camera, y=depth = far)
 *   game z ∈ [0, WALL_HEIGHT]   → screen y (z=0 = floor, z=high = top)
 *
 * Screen layout:
 *   ┌──────────────────────────────┐  ← top (ceiling / out line)
 *   │   left wall  │  right wall   │
 *   │              │               │
 *   │         front wall lines     │
 *   │              │               │
 *   │   player (bottom centre)     │
 *   └──────────────────────────────┘  ← glass back wall + audience
 */

import {
  COURT,
  TIN_HEIGHT,
  FRONT_OUT_HEIGHT,
  SERVE_LINE_Y,
  SERVICE_BOX_SIZE,
  SERVICE_BOX_BACK_Y,
  WALL_HEIGHT,
  SWING_COOLDOWN_FRAMES,
  type GameState,
  type PlayerState,
  type DeadReason,
  type GameMode,
} from '@/data/gameState';
import { SimRunner } from '@/game/sim/SimRunner';
import { type PathPoint } from '@/game/sim/simulate';
import { LocalInput } from '@/game/input/LocalInput';
import { AIInput, type Difficulty } from '@/game/input/AIInput';
import { eventBus } from '@/game/eventBus';
import { SoundEngine } from '@/game/audio/SoundEngine';
import { loadAssets, getImage, PLAYER_BACKVIEW_CROPS, PLAYER_ACTIONS_V2_CROPS, OPPONENT_CROPS } from '@/assets/assetLoader';

export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 720;

// ── Perspective constants ──────────────────────────────────────────────────
// The "vanishing point" is at the centre of the screen — that's where the
// back wall converges. Everything scales linearly between near (front wall,
// which fills the whole screen) and far (back wall, which converges to a
// small rectangle at the VP).

const VP_X = GAME_WIDTH / 2;
// Camera is at ~60% wall height (2.7m). As fraction of screen that's 40% from top.
const VP_Y = GAME_HEIGHT * 0.38;

// Squash court: width 6.4m, depth 9.75m.
// Back wall is 9.75/6.4 = 1.52× deeper than wide.
// With a natural FOV the back wall subtends ~37% of the front-wall width.
const FAR_SCALE = 0.37;

// Back-wall rect corners (where side/ceiling walls converge)
const FAR_W = GAME_WIDTH * FAR_SCALE;
const FAR_H = GAME_HEIGHT * FAR_SCALE;
const FAR_LEFT   = VP_X - FAR_W / 2;
const FAR_RIGHT  = VP_X + FAR_W / 2;
const FAR_TOP    = VP_Y - FAR_H / 2;
const FAR_BOTTOM = VP_Y + FAR_H / 2;

// Front wall = full canvas edges
const NEAR_LEFT   = 0;
const NEAR_RIGHT  = GAME_WIDTH;
const NEAR_TOP    = 0;
const NEAR_BOTTOM = GAME_HEIGHT;

// ── Map game coords → screen ───────────────────────────────────────────────
// depth t ∈ [0,1]: 0 = front wall (near), 1 = back wall (far)
function depthT(gameY: number): number {
  return Math.max(0, Math.min(1, gameY / COURT.depth));
}

// Lerp between near edge and far edge at depth t
function screenX(gameX: number, t: number): number {
  const nearX = (gameX / COURT.width) * GAME_WIDTH;
  const farX  = FAR_LEFT + (gameX / COURT.width) * FAR_W;
  return nearX + (farX - nearX) * t;
}

function screenY(gameZ: number, t: number): number {
  // z=WALL_HEIGHT → WALL_TOP_Y (near) or FAR_TOP (far)
  // z=0           → GAME_HEIGHT  (near) or FAR_BOTTOM (far)
  const norm = gameZ / WALL_HEIGHT; // 0=floor, 1=out line
  const nearY = GAME_HEIGHT - norm * (GAME_HEIGHT - WALL_TOP_Y);
  const farY  = FAR_BOTTOM - norm * (FAR_BOTTOM - FAR_TOP);
  return nearY + (farY - nearY) * t;
}

// Ball apparent radius: big near front wall, small near back
const BALL_NEAR_R = 22;
const BALL_FAR_R  = 4;

function ballRadius(t: number): number {
  return BALL_NEAR_R + (BALL_FAR_R - BALL_NEAR_R) * t;
}

// ── Front-wall line positions (in screen space, at t=0) ───────────────────
// The front wall occupies [WALL_TOP_Y, GAME_HEIGHT] on screen.
// WALL_TOP_Y > 0 leaves room between the canvas top and the OUT line,
// giving the "this wall has a ceiling above the out line" feel.
const WALL_TOP_Y = 72; // px from top: gap between canvas edge and OUT line

function wallLineY(gameZ: number): number {
  // z=WALL_HEIGHT → WALL_TOP_Y (out line), z=0 → GAME_HEIGHT (floor)
  const norm = gameZ / WALL_HEIGHT; // 0=floor, 1=out line
  return GAME_HEIGHT - norm * (GAME_HEIGHT - WALL_TOP_Y);
}

const LINE_TIN      = wallLineY(TIN_HEIGHT);       // WSF 0.48m
const LINE_OUT      = wallLineY(FRONT_OUT_HEIGHT); // = WALL_TOP_Y (72px from top)
const LINE_SERVICE  = wallLineY(192);              // WSF 1.83m / 4.57m × 480px = 192px
const LINE_MID_X    = GAME_WIDTH / 2;

// Side-wall & back-wall out line heights (WSF):
//   Front wall: 4.57m → z=480px (FRONT_OUT_HEIGHT)
//   Back wall:  2.13m → z = 2.13/4.57 * 480 = 224px
// The side-wall out line slopes linearly from front to back.
const BACK_OUT_Z = Math.round(2.13 / 4.57 * WALL_HEIGHT); // ≈ 224px game-space
// Screen Y of the back-wall out line at the FAR plane
function sideOutScreenY(t: number): number {
  // Interpolate z from FRONT_OUT_HEIGHT (at t=0) down to BACK_OUT_Z (at t=1)
  const z = FRONT_OUT_HEIGHT + (BACK_OUT_Z - FRONT_OUT_HEIGHT) * t;
  return screenY(z, t);
}

// Palette
const COL = {
  bg:          '#08090f',
  sideWall:    '#1a2030',
  sideWallLit: '#243044',
  floor:       '#141c28',
  floorLit:    '#1a2535',
  glass:       'rgba(140,200,255,0.12)',
  glassBorder: 'rgba(160,220,255,0.35)',
  tin:         '#e03030',
  outLine:     '#e07020',
  serviceLine: '#30b060',
  midLine:     'rgba(255,255,255,0.25)',
  ball:        '#ffb830',
  ballGlow:    '#ff7800',
  player:      '#4080ff',
  neon1:       '#ff2080',
  neon2:       '#00c8ff',
};

export type FrontWallConfig = { gameMode: GameMode; difficulty: Difficulty };

/**
 * The front-wall (screen-wall) renderer — the selling-point view where both players
 * stand on the same side facing the front wall, like real squash. Drives BOTH practice
 * and match: practice rallies freely with no scoring; match emits score/winner events to
 * the DOM HUD and respects the sim's real point phase. Mode + AI difficulty are injected,
 * not hard-coded.
 */
export class FrontWallRenderer {
  private ctx: CanvasRenderingContext2D;
  private runner: SimRunner;
  private localInput: LocalInput;
  private gameMode: GameMode;
  private rafId = 0;
  private lastTs = 0;
  private assetsReady = false;

  // HUD bridge (match mode): mirror CanvasRenderer so the DOM scoreboard/winner modal
  // reacts. Practice never scores, so these stay inert there.
  private lastScores: [number, number] = [0, 0];
  private lastWinner: 0 | 1 | null = null;
  private lastAwaitingServe = false;

  // FX
  private wallImpacts: Array<{ x: number; y: number; r: number; age: number; color: string }> = [];
  private shake = 0;
  private ballTrail: Array<{ sx: number; sy: number; r: number; age: number }> = [];
  // Persistent rally trail (Bob: 「軌跡一直留著」): unlike ballTrail (which fades in 12
  // frames), this accumulates the WHOLE rally's flight path and only clears when a new
  // rally starts, so the player can read where every shot went.
  private persistentTrail: Array<{ sx: number; sy: number }> = [];
  private prevRallyPhase: string = 'serve';
  // Wall-impact tracking so we can fire shake + flash whenever the ball hits ANY
  // wall (previously practice mode only reacted to scoring, so wall hits felt dead).
  private prevLastWall: string | null = null;
  private prevHitFrontWall = false;
  // Sound-trigger edge tracking (practice mode was silent — only CanvasRenderer wired
  // SoundEngine. These mirror that wiring so wall hits / racket hits / faults make noise).
  private prevBouncesSinceWall = 0;
  private prevJustHit: { p1: boolean; p2: boolean } = { p1: false, p2: false };
  private prevFaultReason: DeadReason | null = null;
  // Audience cheer (mirrors CanvasRenderer): a top-of-screen flash + label fired on
  // every 10th rally hit and on a dive save, so the crowd reacts to good play.
  private cheerTimer = 0;
  private cheerText: { text: string; color: string; age: number; life: number } | null = null;
  private prevRallyHitCountCheer = 0;

  constructor(canvas: HTMLCanvasElement, config: FrontWallConfig = { gameMode: 'practice', difficulty: 'easy' }) {
    this.ctx = canvas.getContext('2d')!;
    this.gameMode = config.gameMode;
    this.localInput = new LocalInput();
    const ai = new AIInput(config.difficulty, 1, 0xaabbccdd);
    this.runner = new SimRunner(this.localInput, ai);
    this.runner.setGameMode(config.gameMode);
    this.runner.reset();
    loadAssets().then(() => { this.assetsReady = true; }).catch(() => {});
    this.bindEvents();
    // Web Audio needs a user gesture to unlock; arm it on the first key/pointer.
    const unlock = () => { SoundEngine.get().unlock(); };
    window.addEventListener('keydown', unlock, { once: true });
    window.addEventListener('pointerdown', unlock, { once: true });
  }

  start(): void {
    this.lastTs = performance.now();
    this.rafId = requestAnimationFrame(this.loop);
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
    this.localInput.dispose();
    eventBus.clear();
  }

  restart(): void {
    this.runner.reset();
    this.wallImpacts = [];
    this.ballTrail = [];
    this.persistentTrail = [];
    this.shake = 0;
    this.cheerTimer = 0;
    this.cheerText = null;
    this.prevRallyHitCountCheer = 0;
    if (this.gameMode === 'match') {
      this.lastScores = [0, 0];
      this.lastWinner = null;
      this.lastAwaitingServe = false;
      eventBus.emit('sim:reset', undefined);
    }
  }

  /**
   * Match HUD bridge: emit score/stamina/winner/serve-choice events the DOM HUD listens
   * to (mirrors CanvasRenderer.syncHud). Scores are NOT drawn on the canvas — the React
   * Hud overlay owns the scoreboard and winner modal. Practice never calls this.
   */
  private syncHud(s: GameState): void {
    if (s.scores[0] !== this.lastScores[0] || s.scores[1] !== this.lastScores[1]) {
      this.lastScores = [s.scores[0], s.scores[1]];
      eventBus.emit('score:changed', { scores: [s.scores[0], s.scores[1]] });
    }
    eventBus.emit('stamina:changed', { p1: s.p1.stamina, p2: s.p2.stamina });
    if (s.winner !== null && s.winner !== this.lastWinner) {
      this.lastWinner = s.winner;
      SoundEngine.get().matchWon(s.winner as 0 | 1);
      eventBus.emit('match:over', { winner: s.winner as 0 | 1, scores: [s.scores[0], s.scores[1]] });
    }
    const awaiting = s.awaitingServeChoice && s.server === 0;
    if (awaiting !== this.lastAwaitingServe) {
      this.lastAwaitingServe = awaiting;
      eventBus.emit('serve:awaiting', { waiting: awaiting });
    }
  }

  /**
   * DEV/E2E seam (mirrors the old CanvasRenderer.debug). Bundles the sim's debug
   * API with the AIInput class so a headless/E2E driver can swap player A for an
   * AI and drive a full self-playing match (incl. forcing the serve-box choice the
   * AI never emits). Works for BOTH practice and match.
   */
  debug() {
    return { ...this.runner.debugApi(), AIInput };
  }

  private bindEvents(): void {
    // Use rally:point as the closest proxy for a significant game event
    eventBus.on('rally:point', () => {
      const s = this.runner.current.shuttle;
      const t = depthT(s.pos.y);
      const sx = screenX(s.pos.x, t);
      const sy = screenY(s.z, t);
      this.wallImpacts.push({ x: sx, y: sy, r: 0, age: 0, color: '#ff6040' });
      this.shake = 6;
    });
  }

  private readonly loop = (ts: number): void => {
    const delta = Math.min(ts - this.lastTs, 50);
    this.lastTs = ts;
    this.runner.update(delta);
    this.draw();
    this.rafId = requestAnimationFrame(this.loop);
  };

  /**
   * Fire screen-shake + a colored flash whenever the ball strikes a wall. Front
   * wall hits punch harder than side/back. Called once per frame before drawing.
   */
  private detectWallImpacts(s: GameState): void {
    const sh = s.shuttle;
    if (!sh.inPlay) {
      this.prevLastWall = sh.lastWall ?? null;
      this.prevHitFrontWall = sh.hitFrontWall;
      return;
    }
    const t = depthT(sh.pos.y);
    const px = screenX(sh.pos.x, t);
    const py = screenY(sh.z, t);

    // Front wall (strongest feedback): tin/out/valid coloring by strike height.
    const frontHit = sh.hitFrontWall && !this.prevHitFrontWall;
    if (frontHit) {
      const color = sh.z < TIN_HEIGHT ? '#ff3030' : sh.z > FRONT_OUT_HEIGHT ? '#ffcc30' : '#40ddff';
      this.wallImpacts.push({ x: px, y: py, r: 0, age: 0, color });
      this.shake = Math.max(this.shake, 9);
      const spd = Math.hypot(sh.vel.x, sh.vel.y);
      SoundEngine.get().frontWallHit(Math.min(1, spd / 18));
    }

    // Side / back wall: lighter shake + neutral flash.
    const wallChanged = sh.lastWall !== this.prevLastWall && sh.lastWall != null && sh.lastWall !== 'front';
    if (wallChanged) {
      this.wallImpacts.push({ x: px, y: py, r: 0, age: 0, color: '#7090c0' });
      this.shake = Math.max(this.shake, 5);
      SoundEngine.get().sideWallHit();
    }

    // Floor bounce.
    if (sh.bouncesSinceWall !== this.prevBouncesSinceWall && sh.bouncesSinceWall > 0) {
      SoundEngine.get().floorBounce(sh.bouncesSinceWall);
    }

    this.prevLastWall = sh.lastWall ?? null;
    this.prevHitFrontWall = sh.hitFrontWall;
    this.prevBouncesSinceWall = sh.bouncesSinceWall;
  }

  /**
   * Racket-hit and fault sounds (the rest of the front-wall feedback set). Kept
   * separate from detectWallImpacts because these fire on player/phase edges, not
   * on the shuttle's wall state, and need to run even when the ball isn't inPlay.
   */
  private detectSounds(s: GameState): void {
    // Racket hit — fires on each player's justHit rising edge, scaled by quality.
    const checkHit = (who: 'p1' | 'p2', pl: PlayerState): void => {
      if (pl.justHit && !this.prevJustHit[who]) {
        SoundEngine.get().racketHit(pl.lastQuality ?? 'good');
      }
      this.prevJustHit[who] = pl.justHit;
    };
    checkHit('p1', s.p1);
    checkHit('p2', s.p2);

    // Fault calls. In practice a fault resets straight back to serve the SAME tick (no
    // 'point' phase — see simulate.ts:219), so we can't read deadReason off the post-reset
    // shuttle. The sim carries the reason forward on state.lastFaultReason instead; play the
    // call once, on its rising edge.
    const fault = s.lastFaultReason;
    if (fault != null && fault !== this.prevFaultReason) {
      if (fault === 'tin') SoundEngine.get().tinHit();
      else if (fault === 'out') SoundEngine.get().outCall();
    }
    this.prevFaultReason = fault;
  }

  /**
   * Audience-cheer triggers (practice has no scoring, so only the skill cues fire):
   * every 10th hit of a sustained rally, and a dive save. Mirrors CanvasRenderer so
   * the crowd reacts to good play in practice too.
   */
  private detectCheer(s: GameState): void {
    const threshold = Math.floor(s.rallyHitCount / 10) * 10;
    if (s.rallyHitCount >= 10 && threshold > this.prevRallyHitCountCheer) {
      this.prevRallyHitCountCheer = threshold;
      this.triggerCheer(90, '精彩對拍！', '#80e8c0');
    }
    if (s.phase === 'serve') this.prevRallyHitCountCheer = 0;

    const diveSave = (s.p1.justHit && s.p1.diveFrames > 0) || (s.p2.justHit && s.p2.diveFrames > 0);
    if (diveSave) this.triggerCheer(80, '魚躍救球！', '#60c8ff');

    if (this.cheerTimer > 0) this.cheerTimer--;
    if (this.cheerText) {
      this.cheerText.age++;
      if (this.cheerText.age >= this.cheerText.life) this.cheerText = null;
    }
  }

  private triggerCheer(frames: number, text: string, color: string): void {
    this.cheerTimer = Math.max(this.cheerTimer, frames);
    if (!this.cheerText || this.cheerText.age > this.cheerText.life * 0.5) {
      this.cheerText = { text, color, age: 0, life: frames };
    }
  }

  /** Top-of-screen audience flash + cheer label (drawn over the crowd area). */
  private drawCheerFlash(): void {
    if (this.cheerTimer <= 0) return;
    const ctx = this.ctx;
    const alpha = Math.min(1, this.cheerTimer / 30) * 0.35;
    const grad = ctx.createLinearGradient(0, 0, 0, GAME_HEIGHT * 0.45);
    grad.addColorStop(0, `rgba(255,240,140,${alpha})`);
    grad.addColorStop(0.5, `rgba(255,200,80,${alpha * 0.5})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT * 0.45);
    ctx.restore();

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

  /**
   * Accumulate the live ball's screen position into the persistent rally trail
   * (Bob: 「軌跡一直留著」). The trail is wiped the moment a NEW rally launches
   * (serve → rally transition) so each rally starts on a clean court; during the
   * rally every flight position is kept so the player can read the whole exchange.
   */
  private updatePersistentTrail(s: GameState): void {
    const phase = s.phase;
    // A fresh rally just launched → clear last rally's trail.
    if (phase === 'rally' && this.prevRallyPhase !== 'rally') {
      this.persistentTrail = [];
    }
    this.prevRallyPhase = phase;

    if (phase !== 'rally' || !s.shuttle.inPlay) return;
    const t = depthT(s.shuttle.pos.y);
    const sx = screenX(s.shuttle.pos.x, t);
    const sy = screenY(s.shuttle.z, t);
    // Sample every frame; cap the buffer so a marathon rally can't grow unbounded.
    this.persistentTrail.push({ sx, sy });
    if (this.persistentTrail.length > 600) this.persistentTrail.shift();
  }

  /** Draw the persistent rally trail as a faint connected ribbon under the live ball. */
  private drawPersistentTrail(): void {
    if (this.persistentTrail.length < 2) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,170,60,0.22)';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(this.persistentTrail[0].sx, this.persistentTrail[0].sy);
    for (let i = 1; i < this.persistentTrail.length; i++) {
      ctx.lineTo(this.persistentTrail[i].sx, this.persistentTrail[i].sy);
    }
    ctx.stroke();
    ctx.restore();
  }

  // ── Main draw ─────────────────────────────────────────────────────────────
  private draw(): void {
    const ctx = this.ctx;
    const s = this.runner.current;

    this.detectWallImpacts(s);
    this.detectSounds(s);
    this.detectCheer(s);
    this.updatePersistentTrail(s);
    if (this.gameMode === 'match') this.syncHud(s);

    // Screen shake
    const sx = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 2 : 0;
    const sy = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 2 : 0;
    if (this.shake > 0) this.shake *= 0.75;
    ctx.save();
    ctx.translate(sx, sy);

    this.drawBg();
    this.drawSideWalls();
    this.drawFloor(s);
    this.drawGlassBackWall(s);
    // Both players face the front wall (same side). In match draw the opponent too,
    // z-sorted so the one farther from camera (larger y) is drawn first / behind.
    if (this.gameMode === 'match') {
      const ordered = s.p1.pos.y >= s.p2.pos.y ? [s.p2, s.p1] : [s.p1, s.p2];
      this.drawPlayer(ordered[0]);
      this.drawPlayer(ordered[1]);
    } else {
      this.drawPlayer(s.p1);
    }
    this.drawFrontWallLines();
    this.drawPreviewPath(s);
    this.drawPersistentTrail();
    this.drawBallTrail();
    this.drawBall(s);
    this.drawPreviewBall(s);
    this.drawFrozenBall(s);
    this.drawRallyFreeze(s);
    this.drawWallImpacts();
    this.drawCheerFlash();
    this.drawHud(s);

    ctx.restore();

    // advance FX
    this.wallImpacts = this.wallImpacts
      .map(w => ({ ...w, r: w.r + 3, age: w.age + 1 }))
      .filter(w => w.age < 18);
    this.ballTrail = this.ballTrail
      .map(b => ({ ...b, age: b.age + 1 }))
      .filter(b => b.age < 12);
  }

  // ── Background ────────────────────────────────────────────────────────────
  private drawBg(): void {
    const ctx = this.ctx;
    // Deep dark gradient top-to-bottom
    const grad = ctx.createLinearGradient(0, 0, 0, GAME_HEIGHT);
    grad.addColorStop(0, '#060810');
    grad.addColorStop(1, '#0d1520');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
  }

  // ── Court surfaces + 12-edge wireframe ───────────────────────────────────
  //
  // The court is a box. 8 corners map directly:
  //   Front-top-left    (0,0)     → NEAR (0, 0)
  //   Front-top-right   (W,0)     → NEAR (GW, 0)
  //   Front-bot-left    (0,tin)   → NEAR (0, GH)   [floor at z=0]
  //   Front-bot-right   (W,tin)   → NEAR (GW, GH)
  //   Back-top-left     (0,depth) → FAR  (FAR_LEFT, FAR_TOP)
  //   Back-top-right    (W,depth) → FAR  (FAR_RIGHT, FAR_TOP)
  //   Back-bot-left     (0,depth) → FAR  (FAR_LEFT, FAR_BOTTOM)
  //   Back-bot-right    (W,depth) → FAR  (FAR_RIGHT, FAR_BOTTOM)

  private drawSideWalls(): void {
    const ctx = this.ctx;

    // ── Fill surfaces first ──
    // Left wall trapezoid
    ctx.beginPath();
    ctx.moveTo(NEAR_LEFT, NEAR_TOP);
    ctx.lineTo(FAR_LEFT, FAR_TOP);
    ctx.lineTo(FAR_LEFT, FAR_BOTTOM);
    ctx.lineTo(NEAR_LEFT, NEAR_BOTTOM);
    ctx.closePath();
    const leftGrad = ctx.createLinearGradient(NEAR_LEFT, 0, FAR_LEFT, 0);
    leftGrad.addColorStop(0, '#141e2e');
    leftGrad.addColorStop(1, '#0c1520');
    ctx.fillStyle = leftGrad;
    ctx.fill();

    // Right wall trapezoid
    ctx.beginPath();
    ctx.moveTo(NEAR_RIGHT, NEAR_TOP);
    ctx.lineTo(FAR_RIGHT, FAR_TOP);
    ctx.lineTo(FAR_RIGHT, FAR_BOTTOM);
    ctx.lineTo(NEAR_RIGHT, NEAR_BOTTOM);
    ctx.closePath();
    const rightGrad = ctx.createLinearGradient(NEAR_RIGHT, 0, FAR_RIGHT, 0);
    rightGrad.addColorStop(0, '#141e2e');
    rightGrad.addColorStop(1, '#0c1520');
    ctx.fillStyle = rightGrad;
    ctx.fill();

    // Ceiling trapezoid
    ctx.beginPath();
    ctx.moveTo(NEAR_LEFT, NEAR_TOP);
    ctx.lineTo(FAR_LEFT, FAR_TOP);
    ctx.lineTo(FAR_RIGHT, FAR_TOP);
    ctx.lineTo(NEAR_RIGHT, NEAR_TOP);
    ctx.closePath();
    const ceilGrad = ctx.createLinearGradient(0, NEAR_TOP, 0, FAR_TOP);
    ceilGrad.addColorStop(0, '#0b1020');
    ceilGrad.addColorStop(1, '#111928');
    ctx.fillStyle = ceilGrad;
    ctx.fill();

    // ── 4 depth edges (the 4 "rails" going front→back) ──
    ctx.shadowBlur = 0;
    const edgeColor = 'rgba(80,120,180,0.55)';
    ctx.strokeStyle = edgeColor;
    ctx.lineWidth = 1.5;
    // top-left rail (ceiling left edge)
    ctx.beginPath(); ctx.moveTo(NEAR_LEFT, NEAR_TOP); ctx.lineTo(FAR_LEFT, FAR_TOP); ctx.stroke();
    // top-right rail (ceiling right edge)
    ctx.beginPath(); ctx.moveTo(NEAR_RIGHT, NEAR_TOP); ctx.lineTo(FAR_RIGHT, FAR_TOP); ctx.stroke();
    // bottom-left rail (floor left edge)
    ctx.beginPath(); ctx.moveTo(NEAR_LEFT, NEAR_BOTTOM); ctx.lineTo(FAR_LEFT, FAR_BOTTOM); ctx.stroke();
    // bottom-right rail (floor right edge)
    ctx.beginPath(); ctx.moveTo(NEAR_RIGHT, NEAR_BOTTOM); ctx.lineTo(FAR_RIGHT, FAR_BOTTOM); ctx.stroke();

    // ── Side-wall out lines: slope DOWN from front-wall out line → back-wall top ──
    // WSF: front 4.57m → back 2.13m, linear slope along depth.
    // We sample several points along depth to draw a straight perspective line.
    ctx.strokeStyle = COL.outLine;
    ctx.lineWidth = 2;
    ctx.shadowColor = COL.outLine; ctx.shadowBlur = 4;
    // Left side out line
    ctx.beginPath();
    ctx.moveTo(NEAR_LEFT, LINE_OUT); // front-wall left end of out line (screen top-left)
    ctx.lineTo(FAR_LEFT, sideOutScreenY(1)); // far end at back wall
    ctx.stroke();
    // Right side out line
    ctx.beginPath();
    ctx.moveTo(NEAR_RIGHT, LINE_OUT);
    ctx.lineTo(FAR_RIGHT, sideOutScreenY(1));
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  private drawFloor(s: GameState): void {
    const ctx = this.ctx;

    // Floor trapezoid fill
    ctx.beginPath();
    ctx.moveTo(NEAR_LEFT, NEAR_BOTTOM);
    ctx.lineTo(FAR_LEFT, FAR_BOTTOM);
    ctx.lineTo(FAR_RIGHT, FAR_BOTTOM);
    ctx.lineTo(NEAR_RIGHT, NEAR_BOTTOM);
    ctx.closePath();
    const floorGrad = ctx.createLinearGradient(0, NEAR_BOTTOM, 0, FAR_BOTTOM);
    // Warmer, lighter court-wood tone so the floor reads as a real surface
    // instead of a near-black void (perspective box can't take the flat top-down
    // court_bg art, so we tint the trapezoid itself).
    floorGrad.addColorStop(0, '#22354a');
    floorGrad.addColorStop(1, '#152736');
    ctx.fillStyle = floorGrad;
    ctx.fill();

    // Faint plank lines running front→back to give the floor a wood texture.
    ctx.save();
    ctx.strokeStyle = 'rgba(120,150,190,0.07)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
      const gx = (COURT.width / 8) * i;
      ctx.beginPath();
      ctx.moveTo(screenX(gx, 0), screenY(0, 0));
      ctx.lineTo(screenX(gx, 1), screenY(0, 1));
      ctx.stroke();
    }
    ctx.restore();

    // Floor centre line (court half-width marker)
    const floorMidNearX = screenX(COURT.width / 2, 0);
    const floorMidNearY = screenY(0, 0);
    const floorMidFarX  = screenX(COURT.width / 2, 1);
    const floorMidFarY  = screenY(0, 1);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(floorMidNearX, floorMidNearY);
    ctx.lineTo(floorMidFarX, floorMidFarY);
    ctx.stroke();

    // ── Service boxes (WSF rules) ──────────────────────────────────────────
    // Each box is a SQUARE: 1.6m × 1.6m = SERVICE_BOX_SIZE px (160), tucked into the back
    // CORNERS against the side walls (a square formed by the short line + side wall):
    //   Front edge  = short line (SERVE_LINE_Y = 549px)
    //   Back edge   = SERVICE_BOX_BACK_Y (709px)
    //   Left box:  x = [0, 160]    Right box: x = [width-160, width]
    const SERVICE_BOX_BACK = SERVICE_BOX_BACK_Y;

    const inServe = s.phase === 'serve' && (s.serveSubPhase === 'toss' || s.serveSubPhase === 'swing');

    function floorCorner(gx: number, gy: number): [number, number] {
      const t = depthT(gy);
      return [screenX(gx, t), screenY(0, t)];
    }

    for (let box = 0; box < 2; box++) {
      const x0 = box === 0 ? 0 : COURT.width - SERVICE_BOX_SIZE;
      const x1 = box === 0 ? SERVICE_BOX_SIZE : COURT.width;
      // Service box: short line → back edge of box (1.6m square)
      const [sl0x, sl0y] = floorCorner(x0, SERVE_LINE_Y);
      const [sl1x, sl1y] = floorCorner(x1, SERVE_LINE_Y);
      const [bk0x, bk0y] = floorCorner(x0, SERVICE_BOX_BACK);
      const [bk1x, bk1y] = floorCorner(x1, SERVICE_BOX_BACK);

      const isActive = inServe && s.serveBox === box;
      ctx.beginPath();
      ctx.moveTo(sl0x, sl0y);
      ctx.lineTo(sl1x, sl1y);
      ctx.lineTo(bk1x, bk1y);
      ctx.lineTo(bk0x, bk0y);
      ctx.closePath();
      // Solid filled service box (per request): always a visible filled square,
      // the active box glows brighter so the player sees where they must stand.
      if (isActive) {
        // Pulse the active box so it reads as "stand here to serve".
        const pulse = 0.30 + 0.12 * Math.sin(Date.now() / 220);
        ctx.fillStyle = `rgba(48,200,110,${pulse.toFixed(3)})`;
      } else {
        ctx.fillStyle = 'rgba(48,140,90,0.16)';
      }
      ctx.fill();
      ctx.strokeStyle = isActive ? 'rgba(90,255,150,0.95)' : 'rgba(48,180,96,0.45)';
      ctx.lineWidth = isActive ? 2.5 : 1.2;
      ctx.stroke();
    }

    // Short service line (full width, on top of boxes)
    const yst = depthT(SERVE_LINE_Y);
    const fy  = screenY(0, yst);
    const fx0 = screenX(0, yst);
    const fx1 = screenX(COURT.width, yst);
    ctx.strokeStyle = 'rgba(48,180,96,0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(fx0, fy); ctx.lineTo(fx1, fy);
    ctx.stroke();

    // Centre line (half-court divider, only in the service box region)
    const [cl0x, cl0y] = floorCorner(COURT.width / 2, SERVE_LINE_Y);
    const [cl1x, cl1y] = floorCorner(COURT.width / 2, SERVICE_BOX_BACK);
    ctx.strokeStyle = 'rgba(48,180,96,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cl0x, cl0y); ctx.lineTo(cl1x, cl1y);
    ctx.stroke();
  }

  // ── Glass back wall ───────────────────────────────────────────────────────
  private drawGlassBackWall(_s: GameState): void {
    const ctx = this.ctx;
    ctx.save();

    // Back wall fill (glass)
    ctx.beginPath();
    ctx.rect(FAR_LEFT, FAR_TOP, FAR_W, FAR_H);
    ctx.fillStyle = 'rgba(20,40,70,0.7)';
    ctx.fill();

    // Audience through glass — only below the back-wall out line
    if (this.assetsReady) {
      const img = getImage('audience_side');
      if (img) {
        const backOutY = sideOutScreenY(1);
        const audienceH = FAR_BOTTOM - backOutY;
        if (audienceH > 4) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(FAR_LEFT, backOutY, FAR_W, audienceH);
          ctx.clip();
          ctx.globalAlpha = 0.4;
          ctx.drawImage(img, FAR_LEFT, backOutY, FAR_W, audienceH);
          ctx.globalAlpha = 1;
          ctx.restore();
        }
      }
    }

    // Back wall 4 frame edges
    ctx.strokeStyle = 'rgba(80,120,180,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(FAR_LEFT, FAR_TOP); ctx.lineTo(FAR_RIGHT, FAR_TOP); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(FAR_LEFT, FAR_BOTTOM); ctx.lineTo(FAR_RIGHT, FAR_BOTTOM); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(FAR_LEFT, FAR_TOP); ctx.lineTo(FAR_LEFT, FAR_BOTTOM); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(FAR_RIGHT, FAR_TOP); ctx.lineTo(FAR_RIGHT, FAR_BOTTOM); ctx.stroke();

    // Back wall out line (WSF 2.13m — horizontal across back wall)
    const backOutY = sideOutScreenY(1); // same z interpolated to t=1
    ctx.strokeStyle = COL.outLine;
    ctx.lineWidth = 2;
    ctx.shadowColor = COL.outLine; ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.moveTo(FAR_LEFT, backOutY);
    ctx.lineTo(FAR_RIGHT, backOutY);
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.restore();
  }

  // ── Front wall lines ──────────────────────────────────────────────────────
  // Front wall IS the canvas. 8 lines total:
  //   Outer frame (4): left edge, right edge, top (out), bottom (tin)
  //   Inner lines (4): service line (horizontal), centre vertical,
  //                    out-line continuation on left half, right half
  //   (WSF: only 3 horizontal + 1 vertical on front wall; we add the frame)
  private drawFrontWallLines(): void {
    const ctx = this.ctx;
    ctx.shadowBlur = 0;

    // ── Outer frame: 4 edges of the front wall ──
    // Left edge
    ctx.strokeStyle = 'rgba(80,120,180,0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(NEAR_LEFT, NEAR_TOP); ctx.lineTo(NEAR_LEFT, NEAR_BOTTOM); ctx.stroke();
    // Right edge
    ctx.beginPath(); ctx.moveTo(NEAR_RIGHT, NEAR_TOP); ctx.lineTo(NEAR_RIGHT, NEAR_BOTTOM); ctx.stroke();
    // Top edge = OUT line (front wall top boundary)
    ctx.strokeStyle = COL.outLine;
    ctx.lineWidth = 3;
    ctx.shadowColor = COL.outLine; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.moveTo(NEAR_LEFT, LINE_OUT); ctx.lineTo(NEAR_RIGHT, LINE_OUT); ctx.stroke();
    ctx.shadowBlur = 0;
    // Bottom edge = TIN
    ctx.strokeStyle = COL.tin;
    ctx.lineWidth = 3;
    ctx.shadowColor = COL.tin; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.moveTo(NEAR_LEFT, LINE_TIN); ctx.lineTo(NEAR_RIGHT, LINE_TIN); ctx.stroke();
    ctx.shadowBlur = 0;

    // ── Inner lines ──
    // Service line (horizontal, WSF 1.83m = 40% of wall height)
    ctx.strokeStyle = COL.serviceLine;
    ctx.lineWidth = 2;
    ctx.shadowColor = COL.serviceLine; ctx.shadowBlur = 5;
    ctx.beginPath(); ctx.moveTo(NEAR_LEFT, LINE_SERVICE); ctx.lineTo(NEAR_RIGHT, LINE_SERVICE); ctx.stroke();
    ctx.shadowBlur = 0;

    // Centre vertical line (from out line down to tin)
    ctx.strokeStyle = COL.midLine;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(LINE_MID_X, LINE_OUT); ctx.lineTo(LINE_MID_X, LINE_TIN); ctx.stroke();

    // Labels
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'left';
    ctx.shadowBlur = 0;
    ctx.fillStyle = COL.outLine;
    ctx.fillText('OUT', 6, LINE_OUT + 16);
    ctx.fillStyle = COL.serviceLine;
    ctx.fillText('SERVICE', 6, LINE_SERVICE - 5);
    ctx.fillStyle = COL.tin;
    ctx.fillText('TIN', 6, LINE_TIN - 5);
  }

  // ── Ball trail ─────────────────────────────────────────────────────────────
  private drawBallTrail(): void {
    const ctx = this.ctx;
    for (const t of this.ballTrail) {
      const alpha = (1 - t.age / 12) * 0.35;
      ctx.beginPath();
      ctx.arc(t.sx, t.sy, t.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,180,48,${alpha})`;
      ctx.fill();
    }
  }

  // ── Ball ──────────────────────────────────────────────────────────────────
  private drawBall(s: GameState): void {
    const ctx = this.ctx;
    const ball = s.shuttle;
    if (!ball.inPlay) return;

    const t  = depthT(ball.pos.y);
    const bx = screenX(ball.pos.x, t);
    const by = screenY(ball.z, t);
    const br = ballRadius(t);

    // Add to trail
    this.ballTrail.push({ sx: bx, sy: by, r: br * 0.7, age: 0 });

    // Ball glow
    const grd = ctx.createRadialGradient(bx, by, 0, bx, by, br * 2.5);
    grd.addColorStop(0, '#ffe080');
    grd.addColorStop(0.4, COL.ballGlow);
    grd.addColorStop(1, 'rgba(255,120,0,0)');
    ctx.beginPath();
    ctx.arc(bx, by, br * 2.5, 0, Math.PI * 2);
    ctx.fillStyle = grd;
    ctx.fill();

    // Ball core
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fillStyle = COL.ball;
    ctx.shadowColor = COL.ballGlow;
    ctx.shadowBlur = 12;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Landing marker on floor
    if (ball.landing) {
      const lt = depthT(ball.landing.y);
      const lx = screenX(ball.landing.x, lt);
      const ly = screenY(0, lt);
      const mr = 8 * (1 - lt * 0.6);
      const eta = Math.max(0, ball.landingEta);
      const alpha = 0.3 + 0.5 * (1 - Math.min(eta, 60) / 60);
      ctx.strokeStyle = `rgba(255,180,48,${alpha})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(lx, ly, mr, mr * 0.3, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ── Preview ball (practice: the tossed/struck ball before the rally launches) ──
  //
  // Through the toss ('swing' sub-phase) and the whole M-stepped preview walk the sim
  // moves shuttle.pos but keeps inPlay=false (it isn't a live rally yet), so drawBall()
  // — gated on inPlay — never draws it. Draw the ball at shuttle.pos in both phases so
  // it's visible while tossed, parked at the contact point, mid-flight, and resting on
  // each ring. (Without this the ball looks frozen at the start — "it doesn't move
  // when I press M".)
  private drawPreviewBall(s: GameState): void {
    if (s.serveSubPhase !== 'preview' && s.serveSubPhase !== 'swing') return;
    const ctx = this.ctx;
    const ball = s.shuttle;
    const t = depthT(ball.pos.y);
    const bx = screenX(ball.pos.x, t);
    const by = screenY(ball.z, t);
    const br = ballRadius(t);

    this.ballTrail.push({ sx: bx, sy: by, r: br * 0.7, age: 0 });

    const grd = ctx.createRadialGradient(bx, by, 0, bx, by, br * 2.5);
    grd.addColorStop(0, '#ffe080');
    grd.addColorStop(0.4, COL.ballGlow);
    grd.addColorStop(1, 'rgba(255,120,0,0)');
    ctx.beginPath();
    ctx.arc(bx, by, br * 2.5, 0, Math.PI * 2);
    ctx.fillStyle = grd;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fillStyle = COL.ball;
    ctx.shadowColor = COL.ballGlow;
    ctx.shadowBlur = 12;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // ── Frozen ball (practice: ball stopped on front wall) + rebound line ────
  private drawFrozenBall(s: GameState): void {
    const ball = s.shuttle;
    // Once a shot is in preview, drawPreviewBall owns the ball at every moment (parked
    // at the contact point, mid-flight, and resting on each ring). The frozen-ball glow
    // + rebound line must stay out entirely — otherwise they double up with the preview
    // path and leave a stray ball/dashed line at the old front-wall position.
    if (s.serveSubPhase === 'preview') return;
    // Show only when ball is frozen on front wall (inPlay=false, pos.y≈0, phase=serve)
    if (ball.inPlay || s.phase !== 'serve' || ball.pos.y > 30) return;
    const ctx = this.ctx;

    // Ball frozen on front wall — render at wall position
    const bx = screenX(ball.pos.x, 0);
    const by = screenY(ball.z, 0);
    const br = ballRadius(0);

    // Dim pulsing ball
    const pulse = 0.6 + 0.4 * Math.sin(s.frame * 0.12);
    ctx.beginPath();
    ctx.arc(bx, by, br * 1.2, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,220,80,${0.5 * pulse})`;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,200,60,${0.85 * pulse})`;
    ctx.fill();

    // Dashed rebound path to landing point
    if (ball.landing) {
      const lt = depthT(ball.landing.y);
      const lx = screenX(ball.landing.x, lt);
      const ly = screenY(0, lt);

      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = 'rgba(100,220,255,0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      // Arc midpoint (visually show the ball going down-forward)
      const mx = (bx + lx) / 2;
      const my = Math.min(by, ly) - 20;
      ctx.quadraticCurveTo(mx, my, lx, ly);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // Landing ellipse
      const mr = 8 * (1 - lt * 0.6);
      ctx.strokeStyle = 'rgba(100,220,255,0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(lx, ly, mr, mr * 0.3, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ── Rally freeze (TEST AID) ──────────────────────────────────────────────
  // While s.rallyFrozen the live ball is held still by the sim. Draw a bright dashed guide
  // from the held ball to its predicted landing ring so the tester can walk the character to
  // the spot, then swing. Distinct cyan styling marks it as a test aid, not normal play.
  private drawRallyFreeze(s: GameState): void {
    if (!s.rallyFrozen) return;
    const ball = s.shuttle;
    if (!ball.inPlay) return;
    const ctx = this.ctx;

    const t  = depthT(ball.pos.y);
    const bx = screenX(ball.pos.x, t);
    const by = screenY(ball.z, t);
    const pulse = 0.6 + 0.4 * Math.sin(s.frame * 0.18);

    // Halo around the held ball so it reads as "paused".
    ctx.beginPath();
    ctx.arc(bx, by, ballRadius(t) * 1.9, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(120,230,255,${0.5 * pulse})`;
    ctx.lineWidth = 2;
    ctx.stroke();

    if (ball.landing) {
      const lt = depthT(ball.landing.y);
      const lx = screenX(ball.landing.x, lt);
      const ly = screenY(0, lt);

      // Dashed guide from ball down to the landing spot.
      ctx.save();
      ctx.setLineDash([7, 5]);
      ctx.strokeStyle = `rgba(120,230,255,${0.75 * pulse})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(lx, ly);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // Pulsing target ring — where to stand before swinging.
      const mr = 12 * (1 - lt * 0.5);
      ctx.strokeStyle = `rgba(120,230,255,${0.85 * pulse})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.ellipse(lx, ly, mr, mr * 0.35, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ── Preview path (practice serve) ────────────────────────────────────────
  private drawPreviewPath(s: GameState): void {
    if (!s.previewPath || s.serveSubPhase !== 'preview') return;
    const ctx = this.ctx;
    const pts = s.previewPath;
    if (pts.length < 2) return;

    // Colour by stroke type
    const strokeColors: Record<string, string> = {
      kill:  '#ff6060',
      drop:  '#60d0ff',
      lob:   '#c060ff',
      drive: '#60ff90',
      boast: '#ffcc40',
    };
    // A faulted shot (over the out line / into the tin) paints the whole path red so
    // the player reads "this one's out" at a glance.
    const isFault = pts.some(p => p.wall === 'out' || p.wall === 'tin');
    const baseColor = isFault ? '#ff3030' : (strokeColors[s.previewStroke ?? 'drive'] ?? '#60ff90');

    // ── Draw dashed path line ──
    ctx.save();
    ctx.setLineDash([7, 5]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = baseColor;
    ctx.globalAlpha = 0.7;

    // Build path converting each PathPoint to screen coords
    const toScreen = (p: PathPoint): [number, number] => {
      const t = depthT(p.y);
      return [screenX(p.x, t), screenY(p.z, t)];
    };

    ctx.beginPath();
    const [sx0, sy0] = toScreen(pts[0]);
    ctx.moveTo(sx0, sy0);
    for (let i = 1; i < pts.length; i++) {
      const [sx, sy] = toScreen(pts[i]);
      ctx.lineTo(sx, sy);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // ── Wall contact rings ──
    const wallColors: Record<string, string> = {
      front: '#ff8040',
      back:  '#80c0ff',
      left:  '#ffdd40',
      right: '#ffdd40',
      floor: '#40ffaa',
      out:   '#ff3030', // over the out line — fault
      tin:   '#ff5050', // struck the tin board — fault
    };

    for (const pt of pts) {
      if (!pt.wall) continue;
      const t = depthT(pt.y);
      let sx: number, sy: number;

      // OUT / TIN fault marker: a red X over a ring on the front-wall plane.
      if (pt.wall === 'out' || pt.wall === 'tin') {
        sx = screenX(pt.x, 0);
        sy = screenY(pt.z, 0);
        const col = wallColors[pt.wall];
        const r = 16;
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fillStyle = col + '44';
        ctx.fill();
        ctx.strokeStyle = col;
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(sx - r * 0.6, sy - r * 0.6);
        ctx.lineTo(sx + r * 0.6, sy + r * 0.6);
        ctx.moveTo(sx + r * 0.6, sy - r * 0.6);
        ctx.lineTo(sx - r * 0.6, sy + r * 0.6);
        ctx.stroke();
        continue;
      }

      if (pt.wall === 'floor') {
        // Floor contact: project to floor plane
        sx = screenX(pt.x, t);
        sy = screenY(0, t);
        const r = 10 * (1 - t * 0.5);
        ctx.beginPath();
        ctx.ellipse(sx, sy, r, r * 0.28, 0, 0, Math.PI * 2);
        ctx.fillStyle = wallColors.floor + '55';
        ctx.fill();
        ctx.strokeStyle = wallColors.floor;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        continue;
      }

      // Wall contact: on the wall surface
      if (pt.wall === 'front') {
        sx = screenX(pt.x, 0);
        sy = screenY(pt.z, 0);
      } else if (pt.wall === 'back') {
        sx = screenX(pt.x, 1);
        sy = screenY(pt.z, 1);
      } else {
        // Left / right side walls — project onto visible side
        sx = screenX(pt.x, t);
        sy = screenY(pt.z, t);
      }

      const col = wallColors[pt.wall] ?? '#ffffff';
      const r1 = 14 * (1 - t * 0.4);
      const r2 = r1 * 1.9;

      // Filled inner ring
      ctx.beginPath();
      ctx.arc(sx, sy, r1, 0, Math.PI * 2);
      ctx.fillStyle = col + '55';
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Outer ring
      ctx.beginPath();
      ctx.arc(sx, sy, r2, 0, Math.PI * 2);
      ctx.strokeStyle = col + '88';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // ── Player ────────────────────────────────────────────────────────────────
  private drawPlayer(p: PlayerState): void {
    const ctx = this.ctx;

    // Player is always at the back of the court (near back wall, far from camera)
    // Visual: bottom-centre of the screen, sized to match the perspective
    const gameX = p.pos.x;
    const gameY = p.pos.y;
    const t = depthT(gameY);

    const px = screenX(gameX, t);
    const py = screenY(0, t); // floor level at player's depth

    // Player sprite height scaled by depth
    const spriteH = 160 * (1 - t * 0.5); // 160px near, 80px far
    const spriteW = spriteH * 0.75;

    if (this.assetsReady) {
      // Match-mode parity: player faces the front wall (back to camera). Prefer the
      // v2 action sheet (idle breathing / directional run / per-stroke swing / dive),
      // then fall back to the old back-view sheet, then the opponent sheet. All sheets
      // carry an alpha channel — draw them straight, NO multiply composite (multiply on
      // a dark court turns the sprite into a black blob, which is what made practice-mode
      // players look like silhouettes).
      const actions = getImage('player_actions_v2');
      if (actions) {
        const A = PLAYER_ACTIONS_V2_CROPS;
        let crop;
        let flipX = false;
        let breathScale = 1;
        if (p.diveFrames > 0) {
          crop = A.dive;
        } else if (p.swingCooldown > 0) {
          switch (p.lastStroke) {
            case 'kill':
            case 'lob':
              crop = A.swingKill;
              break;
            case 'drop':
              crop = A.swingDrop;
              break;
            case 'boast':
              crop = A.swingBoast;
              break;
            default:
              crop = A.swingDrive;
              break;
          }
        } else {
          const vx = p.vel.x;
          const vy = p.vel.y;
          const speed = Math.hypot(vx, vy);
          const horizontal = Math.abs(vx) > Math.abs(vy);
          if (speed > 1.0 && horizontal && vx < -1) {
            crop = A.runLeft;
          } else if (speed > 1.0 && horizontal && vx > 1) {
            crop = A.runRight;
            flipX = true;
          } else if (speed > 1.0) {
            crop = A.runRight;
          } else {
            // Idle: stay on a SINGLE frame and breathe purely by a slow vertical
            // scale. Swapping between idleA/idleB every half-cycle made the whole
            // body snap-flip ~once a second (the "詭異抖動"); a smooth scale on one
            // frame reads as breathing without any pose pop.
            crop = A.idleA;
            breathScale = 1 + Math.sin(Date.now() * 0.0022) * 0.012;
          }
        }
        // Keep the sprite cell's aspect ratio (418/314 ≈ 1.33) so the chibi isn't
        // squashed, anchoring bottom-center at the floor point.
        const sh = spriteH * breathScale;
        const sw = sh * (crop.sw / crop.sh);
        ctx.save();
        if (flipX) {
          ctx.translate(px, 0);
          ctx.scale(-1, 1);
          ctx.translate(-px, 0);
        }
        ctx.drawImage(
          actions,
          crop.sx, crop.sy, crop.sw, crop.sh,
          px - sw / 2, py - sh, sw, sh,
        );
        ctx.restore();
        return;
      }

      // Fallback: previous back-view sheet (or opponent sheet) with simpler state set.
      const backview = getImage('player_backview');
      const img = backview ?? getImage('opponent_core');
      if (img) {
        const crops = backview ? PLAYER_BACKVIEW_CROPS : OPPONENT_CROPS;
        let crop;
        if (p.swingCooldown > 0) {
          crop = crops.swing;
        } else {
          const speed = Math.hypot(p.vel.x, p.vel.y);
          crop = speed > 1.0 ? crops.run : crops.ready;
        }
        if (crop) {
          const sw = spriteH * (crop.sw / crop.sh);
          ctx.drawImage(
            img,
            crop.sx, crop.sy, crop.sw, crop.sh,
            px - sw / 2, py - spriteH, sw, spriteH,
          );
          return;
        }
      }
    }

    // Fallback: draw a simple silhouette
    ctx.fillStyle = '#3060cc';
    ctx.shadowColor = '#6090ff';
    ctx.shadowBlur = 10;
    // Body
    ctx.fillRect(px - spriteW * 0.2, py - spriteH, spriteW * 0.4, spriteH * 0.7);
    // Head
    ctx.beginPath();
    ctx.arc(px, py - spriteH - spriteH * 0.12, spriteH * 0.12, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Swing arc when hitting
    if (p.swingCooldown > 0) {
      const progress = 1 - p.swingCooldown / SWING_COOLDOWN_FRAMES;
      ctx.strokeStyle = `rgba(255,220,60,${0.8 - progress * 0.8})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(px, py - spriteH * 0.5, spriteW * 0.6, -Math.PI * 0.8, -Math.PI * 0.1 + progress * Math.PI * 0.9);
      ctx.stroke();
    }
  }

  // ── Wall impact FX ────────────────────────────────────────────────────────
  private drawWallImpacts(): void {
    const ctx = this.ctx;
    for (const w of this.wallImpacts) {
      const alpha = (1 - w.age / 18) * 0.7;
      ctx.strokeStyle = w.color;
      ctx.lineWidth = 2;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(w.x, w.y, w.r, 0, Math.PI * 2);
      ctx.stroke();
      // Spark lines
      for (let i = 0; i < 4; i++) {
        const angle = (i / 4) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(w.x + Math.cos(angle) * w.r * 0.5, w.y + Math.sin(angle) * w.r * 0.5);
        ctx.lineTo(w.x + Math.cos(angle) * w.r * 1.5, w.y + Math.sin(angle) * w.r * 1.5);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  // ── HUD ───────────────────────────────────────────────────────────────────
  private drawHud(s: GameState): void {
    const ctx = this.ctx;

    // Mode label
    ctx.font = 'bold 16px monospace';
    ctx.fillStyle = 'rgba(80,200,120,0.8)';
    ctx.textAlign = 'right';
    ctx.fillText(this.gameMode === 'match' ? '對戰模式' : '練習模式', GAME_WIDTH - 12, 28);

    // Rally hit count
    if (s.rallyHitCount > 0) {
      ctx.fillStyle = '#ffd060';
      ctx.textAlign = 'center';
      ctx.font = 'bold 20px monospace';
      ctx.fillText(`連拍 ×${s.rallyHitCount}`, GAME_WIDTH / 2, 36);
    }

    // Stamina bar
    const stamPct = s.p1.stamina / 100;
    const barW = 200;
    const barX = 16;
    const barY = GAME_HEIGHT - 28;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(barX, barY, barW, 10);
    const barColor = stamPct > 0.5 ? '#40e080' : stamPct > 0.25 ? '#e0c030' : '#e03030';
    ctx.fillStyle = barColor;
    ctx.fillRect(barX, barY, barW * stamPct, 10);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, barY, barW, 10);
    ctx.fillStyle = '#aaa';
    ctx.font = '11px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('體力', barX, barY - 4);

    // Serve choice overlay
    if (s.awaitingServeChoice) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(GAME_WIDTH / 2 - 220, GAME_HEIGHT / 2 - 30, 440, 70);
      ctx.fillStyle = '#7df';
      ctx.font = 'bold 20px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('選發球框：A / ← 左框　D / → 右框', GAME_WIDTH / 2, GAME_HEIGHT / 2 + 12);
    } else if (s.serveSubPhase === 'toss') {
      this.drawServeHint(ctx, '【拋球】按 M 把球拋起', '#ffd060',
        'M→拋球');
    } else if (s.serveSubPhase === 'preview') {
      const strokeName: Record<string, string> = {
        kill: '殺球 (低快)', drop: '截球 (短角)', drive: '直球 (標準)',
        boast: '三星 (側牆)', lob: '高吊 (玻璃牆)',
      };
      const name = strokeName[s.previewStroke ?? 'drive'] ?? s.previewStroke;
      const stops = (s.previewPath ?? []).filter(p => p.wall != null);
      const step = s.previewStep;
      const remaining = stops.length - 1 - step;
      const cur = step >= 0 && step < stops.length ? stops[step] : undefined;
      if (cur?.wall === 'out' || cur?.wall === 'tin') {
        // Reached the fault contact — the shot is OUT / hit the tin.
        const why = cur.wall === 'out' ? '出界！球飛過 out line' : '打到 tin！球太低';
        this.drawServeHint(ctx, `【${name}】${why}`, '#ff4040',
          'M→重新發球  J/K/L/U/Space=揮拍');
      } else {
        const stepLabel = step < 0 ? '起點' : `第${step + 1}面牆`;
        const mLabel = remaining > 0 ? `M→下一段 (剩${remaining})` : 'M→發球！';
        this.drawServeHint(ctx, `【${name}】${stepLabel}  揮拍可打球`, '#60ff90',
          mLabel + '  J/K/L/U/Space=揮拍');
      }
    } else if (s.serveSubPhase === 'swing') {
      this.drawServeHint(ctx, '【揮拍】再按揮拍鍵打出！', '#60ff90',
        'J=低快  K=截擊  L=標準  U=三星  Space=高吊');
    } else if (!s.shuttle.inPlay && s.phase === 'serve') {
      // Waiting before serve sub-phase kicks in (phaseTimer counting down)
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = 'bold 16px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('準備發球…', GAME_WIDTH / 2, GAME_HEIGHT / 2 + 60);
    }

    ctx.textAlign = 'left';
  }

  private drawServeHint(ctx: CanvasRenderingContext2D, title: string, color: string, sub: string): void {
    const cx = GAME_WIDTH / 2;
    const cy = GAME_HEIGHT - 80;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.roundRect(cx - 240, cy - 30, 480, 64, 12);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.font = 'bold 18px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(title, cx, cy);
    ctx.fillStyle = 'rgba(200,220,255,0.75)';
    ctx.font = '13px monospace';
    ctx.fillText(sub, cx, cy + 22);
    ctx.textAlign = 'left';
  }
}

/**
 * Back-compat alias. The class was renamed PracticeRenderer → FrontWallRenderer
 * when it became the shared front-wall view for BOTH practice and match modes.
 * Existing imports of `PracticeRenderer` keep resolving to the same class.
 */
export const PracticeRenderer = FrontWallRenderer;
