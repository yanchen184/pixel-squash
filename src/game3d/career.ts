/**
 * M2 生涯進度:localStorage 存「打到第幾階 + 擊敗過誰」。
 * 渲染殼層(允許 localStorage / try-catch;引擎決定性 lint 不管這裡)。
 */

import { LADDER } from '../engine/ladder';

const KEY = 'pixel-squash.career.v1';

export interface CareerProgress {
  /** 目前可挑戰的最高階(0-based index) */
  readonly unlocked: number;
  /** 擊敗過的階 id(顯示 ✓ 用) */
  readonly beaten: readonly string[];
}

const FRESH: CareerProgress = { unlocked: 0, beaten: [] };

export function loadCareer(): CareerProgress {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return FRESH;
    const p = JSON.parse(raw) as Partial<CareerProgress>;
    const unlocked =
      typeof p.unlocked === 'number' && p.unlocked >= 0 && p.unlocked < LADDER.length
        ? Math.floor(p.unlocked)
        : 0;
    const beaten = Array.isArray(p.beaten) ? p.beaten.filter((x) => typeof x === 'string') : [];
    return { unlocked, beaten };
  } catch {
    return FRESH; // 壞資料/無痕模式:當新檔開始,不炸遊戲
  }
}

function save(p: CareerProgress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // 寫不進去(無痕/滿了)就算了,進度只活在本場
  }
}

/** 打贏第 rung 階 → 記錄擊敗、解鎖下一階;回傳新進度 */
export function recordWin(p: CareerProgress, rung: number): CareerProgress {
  const id = LADDER[rung]?.id;
  const beaten = id !== undefined && !p.beaten.includes(id) ? [...p.beaten, id] : p.beaten;
  const unlocked = rung === p.unlocked && rung < LADDER.length - 1 ? rung + 1 : p.unlocked;
  const next: CareerProgress = { unlocked, beaten };
  save(next);
  return next;
}
