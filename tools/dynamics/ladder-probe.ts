/**
 * M2 天梯調參探測(CLI,不進 CI):
 * (1) 相鄰階對打勝率(梯度)+ 首尾對打;(2) 每階鏡像對打公平性 + 回合長;(3) 風格指標(球路使用率)。
 * 跑法:npx tsx tools/dynamics/ladder-probe.ts
 */

import { LADDER } from '../../src/engine/ladder';
import { computeMetrics, runRallies } from './lib';

const N = 200;
const SEED = 20260708;

console.log('--- 相鄰梯度(高階 A vs 低階 B,A 勝率) ---');
for (let i = 1; i < LADDER.length; i++) {
  const hi = LADDER[i];
  const lo = LADDER[i - 1];
  const m = computeMetrics(runRallies(hi.skill, lo.skill, SEED + i, N));
  console.log(`${hi.name}(${i + 1}) vs ${lo.name}(${i}): ${(m.rallyWinRateA * 100).toFixed(1)}%`);
}
const ends = computeMetrics(runRallies(LADDER[7].skill, LADDER[0].skill, SEED, N));
console.log(`首尾 ${LADDER[7].name} vs ${LADDER[0].name}: ${(ends.rallyWinRateA * 100).toFixed(1)}%`);

console.log('--- 每階鏡像:公平性 / 回合長中位數 / 可回擊率 ---');
for (let i = 0; i < LADDER.length; i++) {
  const r = LADDER[i];
  const m = computeMetrics(runRallies(r.skill, r.skill, SEED + 100 + i, N));
  console.log(
    `${r.name}: A 勝率 ${(m.rallyWinRateA * 100).toFixed(1)}% | 回合長 ${m.rallyLengthMedian} | 可回擊 ${(m.returnability * 100).toFixed(1)}%`,
  );
}

console.log('--- 風格指標(鏡像對打的球路使用率) ---');
for (let i = 0; i < LADDER.length; i++) {
  const r = LADDER[i];
  const m = computeMetrics(runRallies(r.skill, r.skill, SEED + 100 + i, N));
  const u = Object.entries(m.shotUsage)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${(v * 100).toFixed(1)}%`)
    .join(' ');
  console.log(`${r.name}: ${u}`);
}
