/**
 * L5 黃金重播 blessing:人眼看過點頭的重播,凍結成(seed + 等級 + 期望 hash)。
 * 物理/擊球/bot/sim 任何改動弄壞 blessed 重播 → 這裡紅 → 必須明示重新祝福
 * (在 /replay.html?seed=<seed> 重看、確認動態仍合理,再更新 hash)。
 *
 * Blessed 2026-07-07:seed 42(medium×medium×4 回合)與 seed 20260707
 * (strong×weak×6 回合)已在重播檢視器人工檢視(P3/P4 round-trip 截圖)。
 */
import { describe, expect, it } from 'vitest';
import { BOT_MEDIUM, BOT_STRONG, BOT_WEAK } from '../src/engine/bot';
import { recordSelfplay } from '../src/engine/selfplayReplay';

const BLESSED = [
  { name: 'seed 42 · medium×medium×4', seed: 42, a: BOT_MEDIUM, b: BOT_MEDIUM, rallies: 4, ticks: 1165, hash: 2080951699 },
  { name: 'seed 20260707 · strong×weak×6', seed: 20260707, a: BOT_STRONG, b: BOT_WEAK, rallies: 6, ticks: 1304, hash: 2710714533 },
] as const;

describe('L5 黃金重播(blessed replays)', () => {
  for (const g of BLESSED) {
    it(`${g.name}:逐 tick 鏈式 hash bit 相同`, () => {
      const r = recordSelfplay(g.seed, g.a, g.b, g.rallies);
      expect(r.frames.length).toBe(g.ticks);
      expect(r.finalHash).toBe(g.hash);
    });
  }

  it('重播檔含揮拍/回合事件(渲染層的動畫觸發源)', () => {
    const r = recordSelfplay(42, BOT_MEDIUM, BOT_MEDIUM, 4);
    expect(r.frames.some((f) => f.hitBy !== null)).toBe(true);
    expect(r.frames.filter((f) => f.rallyEnd !== null).length).toBe(4);
  });
});
