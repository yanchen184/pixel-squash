/**
 * M2 天梯測試:L1 資料形狀 + L4 走廊(每階鏡像公平性/回合長/可回擊率)
 * + 風格可辨識 + 技術梯度(相鄰與首尾)。
 * 全部決定性(固定 seed),數值走廊由 tools/dynamics/ladder-probe.ts 實跑背書。
 */

import { describe, expect, it } from 'vitest';

import { LADDER } from '../src/engine/ladder';
import { computeMetrics, runRallies, type DynamicsMetrics } from '../tools/dynamics/lib';

const N = 150;
const SEED = 20260708;

/** 每階鏡像對打只跑一次,fairness / 回合長 / 風格斷言共用 */
const mirror: DynamicsMetrics[] = LADDER.map((r, i) =>
  computeMetrics(runRallies(r.skill, r.skill, SEED + 100 + i, N)),
);

describe('L1:天梯資料形狀', () => {
  it('8 階、id 與名字唯一、參數在理智範圍', () => {
    expect(LADDER).toHaveLength(8);
    expect(new Set(LADDER.map((r) => r.id)).size).toBe(8);
    expect(new Set(LADDER.map((r) => r.name)).size).toBe(8);
    for (const r of LADDER) {
      expect(r.skill.reactionTicks).toBeGreaterThanOrEqual(1);
      expect(r.skill.reactionTicks).toBeLessThanOrEqual(30);
      expect(r.skill.aimNoise).toBeGreaterThan(0);
      expect(r.skill.execNoise).toBeGreaterThan(0);
      expect(r.skill.moveSpeed).toBeGreaterThan(2);
      expect(r.skill.moveSpeed).toBeLessThan(6);
      expect(Object.keys(r.skill.weights).length).toBeGreaterThanOrEqual(2);
      expect(r.tagline.length).toBeGreaterThan(4);
    }
  });

  it('反應速度沿天梯單調變快(核心強度軸)', () => {
    for (let i = 1; i < LADDER.length; i++) {
      expect(LADDER[i].skill.reactionTicks).toBeLessThan(LADDER[i - 1].skill.reactionTicks);
    }
  });
});

describe('L4:每階鏡像走廊', () => {
  it.each(LADDER.map((r, i) => [r.name, i] as const))('%s:公平性 50±7%%', (_name, i) => {
    expect(mirror[i].rallyWinRateA).toBeGreaterThanOrEqual(0.43);
    expect(mirror[i].rallyWinRateA).toBeLessThanOrEqual(0.57);
  });

  it.each(LADDER.map((r, i) => [r.name, i] as const))(
    '%s:回合長中位數 3–22、可回擊率 ≥88%%',
    (_name, i) => {
      expect(mirror[i].rallyLengthMedian).toBeGreaterThanOrEqual(3);
      expect(mirror[i].rallyLengthMedian).toBeLessThanOrEqual(22);
      expect(mirror[i].returnability).toBeGreaterThanOrEqual(0.88);
    },
  );

  it('回合長沿天梯遞增趨勢(首 ≤ 尾的一半):高手對打更耐撕', () => {
    expect(mirror[0].rallyLengthMedian * 2).toBeLessThanOrEqual(mirror[7].rallyLengthMedian);
  });
});

describe('風格可辨識(選單上的個性承諾要在數據上成立)', () => {
  const usage = (i: number, kind: string): number => mirror[i].shotUsage[kind] ?? 0;

  it('阿新(1)只會抽球:drive 佔比 >45%', () => {
    expect(usage(0, 'drive')).toBeGreaterThan(0.45);
  });

  it('長城(2)高球磨:lob >35%,且是重砲的 3 倍以上', () => {
    expect(usage(1, 'lob')).toBeGreaterThan(0.35);
    expect(usage(1, 'lob')).toBeGreaterThan(usage(3, 'lob') * 3);
  });

  it('小刀(3)前場小球:drop+boast >45%', () => {
    expect(usage(2, 'drop') + usage(2, 'boast')).toBeGreaterThan(0.45);
  });

  it('重砲(4)殺球狂:kill >22%,且長城幾乎不殺', () => {
    expect(usage(3, 'kill')).toBeGreaterThan(0.22);
    expect(usage(1, 'kill')).toBeLessThan(0.05);
  });

  it('老狐狸(7)五路均衡:沒有單一球路 >30%(serve 除外)', () => {
    for (const [k, v] of Object.entries(mirror[6].shotUsage)) {
      if (k === 'serve') continue;
      expect(v).toBeLessThanOrEqual(0.3);
    }
  });
});

describe('技術梯度', () => {
  it('相鄰階:高階勝率 ≥48%(不得倒掛)', () => {
    for (let i = 1; i < LADDER.length; i++) {
      const m = computeMetrics(runRallies(LADDER[i].skill, LADDER[i - 1].skill, SEED + i, N));
      expect(m.rallyWinRateA, `${LADDER[i].name} vs ${LADDER[i - 1].name}`).toBeGreaterThanOrEqual(
        0.48,
      );
    }
  });

  it('首尾:修羅 vs 阿新 勝率 >80%', () => {
    const m = computeMetrics(runRallies(LADDER[7].skill, LADDER[0].skill, SEED, N));
    expect(m.rallyWinRateA).toBeGreaterThan(0.8);
  });
});
