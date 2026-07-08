/**
 * M3 每日挑戰(引擎側純函數,決定性 lint 適用):
 * 日期字串 → seed → 當日對手。同一天全世界同 seed 同對手,跨日必換。
 */

/** FNV-1a:date key('2026-07-08')→ 32-bit seed。與 replay hash 同族演算法 */
export function dailySeed(dateKey: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < dateKey.length; i++) {
    h ^= dateKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 當日對手階(0..rungs-1):用 seed 高低位混合,避免只吃低位造成週期感 */
export function dailyRung(seed: number, rungs: number): number {
  const mixed = Math.imul(seed ^ (seed >>> 16), 0x9e3779b1) >>> 0;
  return mixed % rungs;
}
