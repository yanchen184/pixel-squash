/**
 * v2 正式遊戲 round-trip:選單 → 選難度 → 人類發球 → 回合真的跑 → 比分真的走。
 * 玩家掛機(只發球不回擊),bot 會得分 —— 這正好證明規則層/迴圈/HUD 全通。
 */
import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    __gameState?: () => {
      started: boolean;
      scoreA: number;
      scoreB: number;
      phase: string;
      server: string;
      tick: number;
    };
  }
}

test('遊戲頁:選難度開局、發球進回合、比分推進、HUD 同步', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#menu')).toBeVisible();

  await page.click('#btnMedium');
  await page.waitForFunction(() => window.__gameState?.().started === true);
  await expect(page.locator('#menu')).toBeHidden();

  // 人類是首發球者:等「可以發了」的提示(倒數中顯示的是「準備發球…」)→ 空白鍵 → 進回合
  await page.waitForFunction(
    () => document.getElementById('serveHint')?.textContent?.includes('按 空白鍵') === true,
  );
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__gameState?.().phase === 'in-rally');

  // 掛機打 2 分:輪到自己發球就按空白鍵,比分應該推進
  await page.waitForFunction(
    () => {
      const s = window.__gameState?.();
      if (s === undefined) return false;
      const hint = document.getElementById('serveHint')?.textContent ?? '';
      if (hint.includes('按 空白鍵')) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
      }
      return s.scoreA + s.scoreB >= 2;
    },
    null,
    { timeout: 60_000, polling: 250 },
  );

  const s = await page.evaluate(() => window.__gameState!());
  expect(s.scoreA + s.scoreB).toBeGreaterThanOrEqual(2);
  // HUD 分數與 sim 一致
  const hud = await page.locator('#score').textContent();
  expect(hud).toContain(`${s.scoreA} : ${s.scoreB}`);
});
