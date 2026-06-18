import { test, expect, type Page } from '@playwright/test';

/**
 * Smoke test (automated L3): the menu reaches both modes and each renders a non-blank
 * canvas. Guards against the whole app silently failing to draw — the failure mode a
 * pure state-level test (match/dive) wouldn't catch.
 */

/** True if the canvas has meaningful drawn content (not a single flat colour). */
async function canvasHasContent(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const c = document.querySelector('canvas') as HTMLCanvasElement | null;
    if (!c) return false;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    // Sample distinct pixel colours; a rendered scene has many, a blank one has ~1.
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4 * 997) {
      seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      if (seen.size > 8) return true;
    }
    return seen.size > 8;
  });
}

test('match mode renders a non-blank canvas', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '開始遊戲' }).click();
  await page.getByRole('button', { name: /知道了，選難度/ }).click();
  await page.getByRole('button', { name: '中等' }).click();
  await page.waitForFunction(() => !!window.__squash, undefined, { timeout: 10_000 });
  await page.waitForTimeout(500); // let a few frames draw
  expect(await canvasHasContent(page)).toBeTruthy();
});

test('practice mode renders a non-blank canvas', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '練習模式' }).click();
  await page.waitForSelector('canvas', { timeout: 10_000 });
  await page.waitForTimeout(500);
  expect(await canvasHasContent(page)).toBeTruthy();
});
