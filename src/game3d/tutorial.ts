/**
 * M4 互動教學:純步驟機。事件(移動/擊球)進、步數出,UI 與偵測都在 main;
 * 這層零 DOM、零 localStorage 依賴 → vitest 直測。
 *
 * 完成定義:五步都「真的做出來」(引擎事件為證),不是看完文字就算。
 */

import type { HitQuality } from '../engine/quality';
import type { ShotKind } from '../engine/shot';

export interface TutorialStep {
  readonly id: string;
  readonly text: string;
}

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  { id: 'move', text: '① 移動:WASD / 方向鍵(或左半螢幕拖搖桿)走幾步' },
  { id: 'serve', text: '② 發球:輪到你時按 空白鍵' },
  { id: 'return', text: '③ 回擊:靠近來球,按 空白鍵 打回前牆' },
  { id: 'quality', text: '④ 抓節奏:球彈起的瞬間揮拍,打出 GOOD 或 PERFECT' },
  { id: 'shots', text: '⑤ 換球路:K=挑高 · L=放小 · ;=殺球,任打一種' },
];

/** 教學完成的步數(= 步驟總數) */
export const TUTORIAL_DONE = TUTORIAL_STEPS.length;

export type TutorialEvent =
  | { readonly type: 'move' }
  | {
      readonly type: 'hit';
      readonly kind: ShotKind | 'shovel' | 'serve';
      readonly quality?: HitQuality;
    };

/** 步驟機:目前在第 step 步(0-based),事件進來後回到達的步數 */
export function advanceTutorial(step: number, ev: TutorialEvent): number {
  if (step >= TUTORIAL_DONE) return step;
  switch (TUTORIAL_STEPS[step].id) {
    case 'move':
      return ev.type === 'move' ? step + 1 : step;
    case 'serve':
      return ev.type === 'hit' && ev.kind === 'serve' ? step + 1 : step;
    case 'return':
      return ev.type === 'hit' && ev.kind !== 'serve' ? step + 1 : step;
    case 'quality':
      return ev.type === 'hit' && (ev.quality === 'good' || ev.quality === 'perfect')
        ? step + 1
        : step;
    case 'shots':
      return ev.type === 'hit' && (ev.kind === 'lob' || ev.kind === 'drop' || ev.kind === 'kill')
        ? step + 1
        : step;
    default:
      return step;
  }
}

const KEY = 'pixel-squash.tutorial.v1';

export function isTutorialDone(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function markTutorialDone(): void {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    // 記不住就下次再教
  }
}
