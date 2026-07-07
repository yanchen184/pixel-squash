/**
 * L5 精華影片管線:開重播檢視器 → 錄影 → 驗決定性(同 seed 重載 hash 相同)。
 * 跑法:npm run l5:replay;影片落在 test-results/ 下各測試資料夾的 video.webm。
 */
import { expect, test } from '@playwright/test';

test.use({ video: { mode: 'on', size: { width: 1280, height: 720 } } });

interface ReplayProbe {
  ready: boolean;
  seed: number;
  totalTicks: number;
  finalHash: number;
}

declare global {
  interface Window {
    __replay?: ReplayProbe;
    __replayTickNow?: () => number;
  }
}

test('重播檢視器:決定性重播可播放並錄成影片', async ({ page }) => {
  await page.goto('/replay.html?seed=42&rallies=4&speed=2&autoplay=1');
  await page.waitForFunction(() => window.__replay?.ready === true, undefined, { timeout: 20_000 });

  const first = await page.evaluate(() => window.__replay!);
  expect(first.totalTicks).toBeGreaterThan(120); // 至少幾個回合的長度
  expect(first.seed).toBe(42);

  // 真的在播:tick 前進
  await page.waitForFunction(() => (window.__replayTickNow?.() ?? 0) > 120, undefined, { timeout: 15_000 });

  // 播到收尾(2× 速度;上限給足)
  await page.waitForFunction(
    () => (window.__replayTickNow?.() ?? 0) >= (window.__replay?.totalTicks ?? Infinity) - 1,
    undefined,
    { timeout: 90_000 },
  );

  // 決定性:同 seed 重載,總長與最終 hash bit 相同
  await page.reload();
  await page.waitForFunction(() => window.__replay?.ready === true, undefined, { timeout: 20_000 });
  const second = await page.evaluate(() => window.__replay!);
  expect(second.totalTicks).toBe(first.totalTicks);
  expect(second.finalHash).toBe(first.finalHash);
});
