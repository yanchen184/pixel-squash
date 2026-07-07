/**
 * P5 人類輸入層:鍵盤 + 觸控 → 每 tick 一份 InputCmd(sim 的 external controller 餵料)。
 *
 * 揮拍採「按鍵緩衝」:按下瞬間開一個 8 tick 的揮拍窗(swing=true 連續送),
 * 進拍面範圍就打出去;打中(hit 事件)或窗過期就收窗 —— 有 timing 感又不吃玄學。
 * 瞄準:揮拍當下按著左/右 → targetX 靠那側邊線,沒按 → 交給 sim 預設(遠角)。
 */
import { COURT_W } from '../engine/ball';
import type { ShotKind } from '../engine/shot';
import { IDLE_INPUT, type InputCmd } from '../engine/sim';

const SWING_BUFFER_TICKS = 8;

const KEY_SHOT: Record<string, ShotKind> = {
  Space: 'drive',
  KeyJ: 'drive',
  KeyK: 'lob',
  KeyL: 'drop',
  Semicolon: 'kill',
};

export class HumanInput {
  private readonly held = new Set<string>();
  private swingLeft = 0; // 揮拍窗剩餘 tick
  private swingKind: ShotKind = 'drive';
  // 觸控搖桿(左半螢幕)
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private stick = { x: 0, y: 0 }; // -1..1

  constructor(private readonly root: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    root.addEventListener('pointerdown', this.onPointerDown);
    root.addEventListener('pointermove', this.onPointerMove);
    root.addEventListener('pointerup', this.onPointerEnd);
    root.addEventListener('pointercancel', this.onPointerEnd);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.root.removeEventListener('pointerdown', this.onPointerDown);
    this.root.removeEventListener('pointermove', this.onPointerMove);
    this.root.removeEventListener('pointerup', this.onPointerEnd);
    this.root.removeEventListener('pointercancel', this.onPointerEnd);
  }

  /** 觸控球路鈕(HTML 按鈕綁這個) */
  pressShot(kind: ShotKind): void {
    this.swingKind = kind;
    this.swingLeft = SWING_BUFFER_TICKS;
  }

  /** 打中了 → 收揮拍窗(不連發) */
  onHit(): void {
    this.swingLeft = 0;
  }

  /** 每 sim tick 取一份輸入(會消耗揮拍窗) */
  next(): InputCmd {
    let moveX = 0;
    let moveY = 0;
    if (this.held.has('ArrowLeft') || this.held.has('KeyA')) moveX -= 1;
    if (this.held.has('ArrowRight') || this.held.has('KeyD')) moveX += 1;
    // 畫面「上」= 往前牆 = 引擎 y 變小
    if (this.held.has('ArrowUp') || this.held.has('KeyW')) moveY -= 1;
    if (this.held.has('ArrowDown') || this.held.has('KeyS')) moveY += 1;
    moveX += this.stick.x;
    moveY += this.stick.y;
    if (moveX > 1) moveX = 1;
    if (moveX < -1) moveX = -1;
    if (moveY > 1) moveY = 1;
    if (moveY < -1) moveY = -1;

    const swing = this.swingLeft > 0;
    if (this.swingLeft > 0) this.swingLeft -= 1;
    if (!swing) return moveX === 0 && moveY === 0 ? IDLE_INPUT : { moveX, moveY, swing: false };

    // 瞄準:揮拍當下按著左/右 → 打向那側
    const aim = moveX < -0.3 ? 1.1 : moveX > 0.3 ? COURT_W - 1.1 : undefined;
    return { moveX, moveY, swing: true, shotKind: this.swingKind, targetX: aim };
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    const kind = KEY_SHOT[e.code];
    if (kind !== undefined) {
      e.preventDefault();
      this.pressShot(kind);
      return;
    }
    if (e.code.startsWith('Arrow')) e.preventDefault();
    this.held.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    // 左 55% 螢幕 = 虛擬搖桿;右側交給球路鈕(HTML button 自己攔)
    if (e.clientX > window.innerWidth * 0.55 || this.stickId !== null) return;
    this.stickId = e.pointerId;
    this.stickOrigin = { x: e.clientX, y: e.clientY };
    this.stick = { x: 0, y: 0 };
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.stickId) return;
    const R = 70; // 拖 70px = 全速
    const dx = (e.clientX - this.stickOrigin.x) / R;
    const dy = (e.clientY - this.stickOrigin.y) / R;
    const len = Math.sqrt(dx * dx + dy * dy);
    const k = len > 1 ? 1 / len : 1;
    this.stick = { x: dx * k, y: dy * k };
  };

  private readonly onPointerEnd = (e: PointerEvent): void => {
    if (e.pointerId !== this.stickId) return;
    this.stickId = null;
    this.stick = { x: 0, y: 0 };
  };
}
