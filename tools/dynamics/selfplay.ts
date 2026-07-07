/**
 * L4 儀表板 CLI:`npm run dynamics`(vite-node)。
 * 兩組自對打:medium×medium(公平 + 主指標)、strong×weak(技術梯度),
 * 輸出走廊 pass/fail 表 + tools/dynamics/report.json。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOT_MEDIUM, BOT_STRONG, BOT_WEAK } from '../../src/engine/bot';
import { checkCorridors, computeMetrics, runRallies } from './lib';

const N_FAIR = Number(process.env.N_FAIR ?? 400);
const N_GRAD = Number(process.env.N_GRAD ?? 200);
const SEED = Number(process.env.SEED ?? 20260707);

console.log(`[L4] medium×medium ${N_FAIR} rallies (seed ${SEED}) ...`);
const t0 = Date.now();
const fairRallies = runRallies(BOT_MEDIUM, BOT_MEDIUM, SEED, N_FAIR);
const fair = computeMetrics(fairRallies);
console.log(`[L4] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

console.log(`[L4] strong×weak ${N_GRAD} rallies ...`);
const t1 = Date.now();
const gradRallies = runRallies(BOT_STRONG, BOT_WEAK, SEED + 1, N_GRAD);
const grad = computeMetrics(gradRallies);
console.log(`[L4] done in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

const corridors = checkCorridors(fair, grad.rallyWinRateA);

console.log('\n=== L4 動態感走廊 ===');
for (const c of corridors) {
  console.log(`${c.pass ? '✅' : '❌'} ${c.name} → ${c.value}`);
}
console.log('\n--- medium×medium 細節 ---');
console.log('rally 長度 median/p90:', fair.rallyLengthMedian, '/', fair.rallyLengthP90);
console.log('死因分佈:', fair.deadReasons);
console.log('球路使用率:', Object.fromEntries(Object.entries(fair.shotUsage).map(([k, v]) => [k, (v * 100).toFixed(1) + '%'])));
console.log('制勝球分佈:', Object.fromEntries(Object.entries(fair.winningShotShare).map(([k, v]) => [k, (v * 100).toFixed(1) + '%'])));
console.log('球速直方圖(5m/s/桶):', fair.speedHistogram.join(' '));

const report = {
  generatedAtSeed: SEED,
  nFair: N_FAIR,
  nGrad: N_GRAD,
  fair,
  gradient: { strongWinRate: grad.rallyWinRateA, metrics: grad },
  corridors,
};
const out = fileURLToPath(new URL('./report.json', import.meta.url));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\nreport → ${out}`);

const failed = corridors.filter((c) => !c.pass);
process.exit(failed.length === 0 ? 0 : 1);
