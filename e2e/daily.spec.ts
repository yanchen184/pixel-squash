/**
 * M3 每日挑戰 round-trip:
 * (1) 按鈕真的顯示今天的對手 + 日期,分享連結的 seed/對手與引擎推導一致;
 * (2) localStorage 今日最佳真的驅動 UI;
 * (3) 點每日挑戰真的開局(careerRung = null,走每日 seed 的路)。
 */
import { expect, test } from '@playwright/test';

import { dailySeed } from '../src/engine/daily';
import { LADDER } from '../src/engine/ladder';

/** 與 src/game3d/daily.ts 的 todayKey / dailyRung 同一套推導(測試端獨立算一次對帳) */
function expectedDaily(now: Date): { dateKey: string; seed: number; rungId: string; rungName: string } {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const dateKey = `${y}-${m}-${d}`;
  const seed = dailySeed(dateKey);
  const mixed = (Math.imul(seed ^ (seed >>> 16), 0x9e3779b1) >>> 0) % LADDER.length;
  return { dateKey, seed, rungId: LADDER[mixed].id, rungName: LADDER[mixed].name };
}

test('每日按鈕顯示今天的對手+日期;分享連結 seed/對手對得上引擎', async ({ page }) => {
  const exp = expectedDaily(new Date());
  await page.goto('/');
  await expect(page.locator('#btnDaily')).toHaveText(`每日挑戰:${exp.rungName}(${exp.dateKey})`);
  await expect(page.locator('#dailyBest')).toHaveText('今日最佳:尚無紀錄');
  const href = await page.locator('#dailyWatch').getAttribute('href');
  expect(href).toBe(`/replay.html?seed=${exp.seed}&a=${exp.rungId}&b=${exp.rungId}&rallies=6&autoplay=1`);
});

test('localStorage 今日最佳 → UI 顯示', async ({ page }) => {
  const exp = expectedDaily(new Date());
  await page.addInitScript((dateKey: string) => {
    localStorage.setItem(
      'pixel-squash.daily.v1',
      JSON.stringify({ dateKey, best: { win: true, margin: 3, ticks: 3600 } }),
    );
  }, exp.dateKey);
  await page.goto('/');
  await expect(page.locator('#dailyBest')).toHaveText('今日最佳:贏 3 分 · 60s');
});

test('點每日挑戰開局:sim 起跑、不是天梯場', async ({ page }) => {
  await page.goto('/');
  await page.locator('#btnDaily').click();
  await page.waitForFunction(() => {
    const s = (
      window as unknown as { __gameState?: () => { started: boolean; careerRung: number | null } }
    ).__gameState?.();
    return s?.started === true && s?.careerRung === null;
  });
  await expect(page.locator('#menu')).toBeHidden();
});

test('每日表演賽重播頁:天梯 id 當選手能跑,hash 穩定', async ({ page }) => {
  const exp = expectedDaily(new Date());
  await page.goto(`/replay.html?seed=${exp.seed}&a=${exp.rungId}&b=${exp.rungId}&rallies=2`);
  const probe = await page.waitForFunction(() => {
    const r = (window as unknown as { __replay?: { ready: boolean; seed: number; finalHash: number } })
      .__replay;
    return r?.ready === true ? r : null;
  });
  const first = (await probe.jsonValue()) as { seed: number; finalHash: number };
  expect(first.seed).toBe(exp.seed);

  await page.reload();
  const probe2 = await page.waitForFunction(() => {
    const r = (window as unknown as { __replay?: { ready: boolean; finalHash: number } }).__replay;
    return r?.ready === true ? r : null;
  });
  const second = (await probe2.jsonValue()) as { finalHash: number };
  expect(second.finalHash).toBe(first.finalHash); // 同 URL 重載 = 逐 bit 相同重播
});
