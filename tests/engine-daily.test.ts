/**
 * M3 每日挑戰測試:
 * L1 — 同日同 seed、跨日必換、對手階在範圍內且分佈不退化;
 * L3 — 紀錄比較規則(勝負 > 分差 > 用時)+ localStorage round-trip(mock);
 * L5 — 每日 seed 餵重播管線,兩次錄製 hash 逐 bit 相等(分享 URL 的決定性承諾)。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { dailyRung, dailySeed } from '../src/engine/daily';
import { LADDER } from '../src/engine/ladder';
import { recordSelfplay } from '../src/engine/selfplayReplay';
import {
  dailyChallenge,
  formatBest,
  isBetter,
  loadDailyBest,
  recordDaily,
  todayKey,
  type DailyResult,
} from '../src/game3d/daily';

describe('L1:日期 → seed → 對手', () => {
  it('同日同 seed;跨日必換(連續 60 天無碰撞)', () => {
    expect(dailySeed('2026-07-08')).toBe(dailySeed('2026-07-08'));
    const seeds = new Set<number>();
    const d = new Date(Date.UTC(2026, 6, 8));
    for (let i = 0; i < 60; i++) {
      seeds.add(dailySeed(todayKey(d)));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    expect(seeds.size).toBe(60);
  });

  it('todayKey 用 UTC(跨時區同一天同題)', () => {
    // UTC 2026-07-08 23:59 與 07-09 00:01 是不同 key;同一瞬間不同本地時區是同 key
    expect(todayKey(new Date(Date.UTC(2026, 6, 8, 23, 59)))).toBe('2026-07-08');
    expect(todayKey(new Date(Date.UTC(2026, 6, 9, 0, 1)))).toBe('2026-07-09');
  });

  it('對手階在 0..7,且 60 天內每階都出現過(輪替不退化)', () => {
    const seen = new Set<number>();
    const d = new Date(Date.UTC(2026, 6, 8));
    for (let i = 0; i < 60; i++) {
      const r = dailyRung(dailySeed(todayKey(d)), LADDER.length);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(LADDER.length);
      seen.add(r);
      d.setUTCDate(d.getUTCDate() + 1);
    }
    expect(seen.size).toBe(LADDER.length);
  });

  it('dailyChallenge 綁定正確的階', () => {
    const c = dailyChallenge('2026-07-08');
    expect(c.seed).toBe(dailySeed('2026-07-08'));
    expect(c.rung).toBe(LADDER[c.rungIndex]);
  });
});

describe('L3:紀錄比較 + localStorage round-trip', () => {
  const W = (margin: number, ticks: number): DailyResult => ({ win: true, margin, ticks });
  const L = (margin: number, ticks: number): DailyResult => ({ win: false, margin, ticks });

  it('勝負 > 分差 > 用時', () => {
    expect(isBetter(W(1, 9999), L(-1, 100))).toBe(true); // 贏就是比輸好
    expect(isBetter(L(-1, 100), W(1, 9999))).toBe(false);
    expect(isBetter(W(5, 5000), W(3, 100))).toBe(true); // 同贏比分差
    expect(isBetter(W(3, 900), W(3, 1000))).toBe(true); // 同分差比用時
    expect(isBetter(W(3, 1000), W(3, 900))).toBe(false);
    expect(isBetter(L(-2, 100), L(-5, 100))).toBe(true); // 同輸,輸越少越好
    expect(isBetter(W(1, 1), null)).toBe(true); // 沒紀錄什麼都算破
  });

  describe('localStorage 存取(mock)', () => {
    beforeEach(() => {
      const store = new Map<string, string>();
      globalThis.localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        key: () => null,
        length: 0,
      } as unknown as Storage;
    });

    it('寫入後讀回;更差的不覆蓋;跨日作廢', () => {
      expect(loadDailyBest('2026-07-08')).toBeNull();
      const r1 = recordDaily('2026-07-08', W(3, 5000));
      expect(r1.improved).toBe(true);
      expect(loadDailyBest('2026-07-08')).toEqual(W(3, 5000));

      const r2 = recordDaily('2026-07-08', W(1, 100)); // 分差較小 → 不破
      expect(r2.improved).toBe(false);
      expect(loadDailyBest('2026-07-08')).toEqual(W(3, 5000));

      const r3 = recordDaily('2026-07-08', W(3, 4000)); // 同分差更快 → 破
      expect(r3.improved).toBe(true);
      expect(loadDailyBest('2026-07-08')).toEqual(W(3, 4000));

      expect(loadDailyBest('2026-07-09')).toBeNull(); // 跨日自動作廢
    });

    it('壞資料不炸,當沒紀錄', () => {
      localStorage.setItem('pixel-squash.daily.v1', '{not json');
      expect(loadDailyBest('2026-07-08')).toBeNull();
    });
  });

  it('formatBest 可讀', () => {
    expect(formatBest(null)).toBe('尚無紀錄');
    expect(formatBest(W(4, 3600))).toBe('贏 4 分 · 60s');
    expect(formatBest(L(-3, 100))).toBe('輸 3 分');
  });
});

describe('L5:每日 seed × 重播管線決定性(分享 URL 的承諾)', () => {
  it('同 seed 同對手兩次錄製,hash 與 tick 數逐 bit 相等', () => {
    const c = dailyChallenge('2026-07-08');
    const a = recordSelfplay(c.seed, c.rung.skill, c.rung.skill, 4);
    const b = recordSelfplay(c.seed, c.rung.skill, c.rung.skill, 4);
    expect(a.finalHash).toBe(b.finalHash);
    expect(a.frames.length).toBe(b.frames.length);
    expect(a.frames.length).toBeGreaterThan(0);
  });

  it('不同日期的 seed → 不同重播', () => {
    const c1 = dailyChallenge('2026-07-08');
    const c2 = dailyChallenge('2026-07-09');
    const a = recordSelfplay(c1.seed, LADDER[4].skill, LADDER[4].skill, 3);
    const b = recordSelfplay(c2.seed, LADDER[4].skill, LADDER[4].skill, 3);
    expect(a.finalHash).not.toBe(b.finalHash);
  });
});
