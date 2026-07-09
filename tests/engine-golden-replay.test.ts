/**
 * L5 黃金重播 blessing:人眼看過點頭的重播,凍結成(seed + 等級 + 期望 hash)。
 * 物理/擊球/bot/sim 任何改動弄壞 blessed 重播 → 這裡紅 → 必須明示重新祝福
 * (在 /replay.html?seed=<seed> 重看、確認動態仍合理,再更新 hash)。
 *
 * Blessed 2026-07-07:seed 42(medium×medium×4 回合)與 seed 20260707
 * (strong×weak×6 回合)已在重播檢視器人工檢視(P3/P4 round-trip 截圖)。
 * Re-blessed 2026-07-09:分球路球速倍率上線(SPEED_SCALE,drive/kill 0.65 等)→
 * 節奏放慢、回合更長,重播動態重新祝福,hash/ticks 依新物理更新。
 * Re-blessed 2026-07-09(#16 兩段發球):發球改「拋球→擊球」兩段,每回合開球
 * 多出拋球滯空的 tick,重播自然變長(1209→1357、2432→2654),hash 依新發球路徑更新。
 * Re-blessed 2026-07-09(#17 落點戰術):bot 依對手站位往空檔打(skill.tactical),
 * 落點改變 → hash 更新(ticks 不變:回合結構同,只是球送去別的空檔)。
 * 鏡像公平性/技術梯度測試全數仍綠 → 戰術加成對稱、未破壞天梯平衡。
 * Re-blessed 2026-07-09(#17 站位可讀):非回擊方依球半場輕微偏防(lean 0.12×tactical),
 * 走位改變 → ticks/hash 更新。回合長中位數走廊(3–22)仍綠,平均回合 5.6–9.1s
 * 屬真實 squash 長回合區間,節奏未失控。
 */
import { describe, expect, it } from 'vitest';
import { BOT_MEDIUM, BOT_STRONG, BOT_WEAK } from '../src/engine/bot';
import { recordSelfplay } from '../src/engine/selfplayReplay';

const BLESSED = [
  { name: 'seed 42 · medium×medium×4', seed: 42, a: BOT_MEDIUM, b: BOT_MEDIUM, rallies: 4, ticks: 1345, hash: 3078900976 },
  { name: 'seed 20260707 · strong×weak×6', seed: 20260707, a: BOT_STRONG, b: BOT_WEAK, rallies: 6, ticks: 3258, hash: 4220709503 },
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
