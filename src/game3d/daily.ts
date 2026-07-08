/**
 * M3 每日挑戰(渲染殼層):今天是誰 + 本地最佳紀錄的存取。
 * 比較規則:贏 > 輸;同為贏比分差大,再比用時短;同為輸比分差(輸越少越好)。
 */

import { dailyRung, dailySeed } from '../engine/daily';
import { LADDER, type LadderRung } from '../engine/ladder';

const KEY = 'pixel-squash.daily.v1';

export interface DailyResult {
  readonly win: boolean;
  /** scoreA - scoreB(輸時為負) */
  readonly margin: number;
  /** 全場 tick 數(60Hz;贏得越快越強) */
  readonly ticks: number;
}

/** UTC 日期 key:全世界同一天換題,不吃時區便宜 */
export function todayKey(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface DailyChallenge {
  readonly dateKey: string;
  readonly seed: number;
  readonly rungIndex: number;
  readonly rung: LadderRung;
}

export function dailyChallenge(dateKey: string): DailyChallenge {
  const seed = dailySeed(dateKey);
  const rungIndex = dailyRung(seed, LADDER.length);
  return { dateKey, seed, rungIndex, rung: LADDER[rungIndex] };
}

/** a 是否比 b 好(b 可為 null = 沒紀錄) */
export function isBetter(a: DailyResult, b: DailyResult | null): boolean {
  if (b === null) return true;
  if (a.win !== b.win) return a.win;
  if (a.margin !== b.margin) return a.margin > b.margin;
  return a.ticks < b.ticks;
}

interface Stored {
  readonly dateKey: string;
  readonly best: DailyResult;
}

export function loadDailyBest(dateKey: string): DailyResult | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return null;
    const s = JSON.parse(raw) as Partial<Stored>;
    if (s.dateKey !== dateKey || s.best === undefined) return null; // 跨日自動作廢
    const b = s.best;
    if (typeof b.win !== 'boolean' || typeof b.margin !== 'number' || typeof b.ticks !== 'number')
      return null;
    return b;
  } catch {
    return null;
  }
}

/** 記錄一場結果;回傳(可能更新後的)當日最佳與是否破紀錄 */
export function recordDaily(
  dateKey: string,
  result: DailyResult,
): { readonly best: DailyResult; readonly improved: boolean } {
  const prev = loadDailyBest(dateKey);
  if (!isBetter(result, prev)) return { best: prev!, improved: false };
  try {
    localStorage.setItem(KEY, JSON.stringify({ dateKey, best: result } satisfies Stored));
  } catch {
    // 寫不進去就只活在本場
  }
  return { best: result, improved: true };
}

export function formatBest(b: DailyResult | null): string {
  if (b === null) return '尚無紀錄';
  const sec = Math.round(b.ticks / 60);
  return b.win ? `贏 ${b.margin} 分 · ${sec}s` : `輸 ${-b.margin} 分`;
}
