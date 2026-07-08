/**
 * M4 round-trip:
 * (1) 暫停:Esc 開面板、tick 真的凍結、再 Esc 恢復真的走;
 * (2) 教學:點按鈕開局出橫幅,真的移動(按鍵)→ 步驟推進,真的發球 → 再推進;
 * (3) favicon:兩頁的 icon 連結真的回 200 PNG。
 */
import { expect, test } from '@playwright/test';

interface ProbeState {
  started: boolean;
  tick: number;
  paused: boolean;
  tutorialActive: boolean;
  tutorialStep: number;
  phase: string;
}
const probe = `window.__gameState?.()`;

async function state(page: import('@playwright/test').Page): Promise<ProbeState> {
  return (await page.evaluate(probe)) as ProbeState;
}

test('暫停:Esc 凍結 tick、面板可見;恢復後 tick 繼續走', async ({ page }) => {
  await page.goto('/');
  await page.click('#btnMedium');
  await page.waitForFunction(() => window.__gameState?.().started === true);
  await expect(page.locator('#btnPause')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('#pause')).toBeVisible();
  const t1 = (await state(page)).tick;
  await page.waitForTimeout(600);
  const t2 = (await state(page)).tick;
  expect(t2).toBe(t1); // 凍結:0.6 秒內 tick 一步都沒走

  await page.keyboard.press('Escape');
  await expect(page.locator('#pause')).toBeHidden();
  await page.waitForFunction((t) => (window.__gameState?.().tick ?? 0) > t, t1, {
    timeout: 5_000,
  });
});

test('暫停面板:回主選單真的回選單', async ({ page }) => {
  await page.goto('/');
  await page.click('#btnMedium');
  await page.waitForFunction(() => window.__gameState?.().started === true);
  await page.locator('#btnPause').click();
  await expect(page.locator('#pause')).toBeVisible();
  await page.click('#btnQuit');
  await expect(page.locator('#menu')).toBeVisible();
  await expect(page.locator('#pause')).toBeHidden();
  await expect(page.locator('#btnPause')).toBeHidden();
});

test('教學:開局出橫幅;移動→步驟 1;發球→步驟 2;localStorage 完成態驅動按鈕文案', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#btnTutorial')).toContainText('3 分鐘上手');
  await page.click('#btnTutorial');
  await page.waitForFunction(() => window.__gameState?.().started === true);
  await expect(page.locator('#tutorial')).toBeVisible();
  await expect(page.locator('#tutorial')).toContainText('移動');

  // 真的按住 D 走一段 → 步驟推進到 1(發球)
  await page.keyboard.down('KeyD');
  await page.waitForFunction(() => window.__gameState?.().tutorialStep === 1, null, {
    timeout: 10_000,
  });
  await page.keyboard.up('KeyD');
  await expect(page.locator('#tutorial')).toContainText('發球');

  // 等發球提示、真的發球 → 步驟 2(回擊)
  await page.waitForFunction(
    () => document.getElementById('serveHint')?.textContent?.includes('按 空白鍵') === true,
  );
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__gameState?.().tutorialStep === 2, null, {
    timeout: 10_000,
  });
  await expect(page.locator('#tutorial')).toContainText('回擊');
});

test('教學完成態:localStorage 標記 → 按鈕顯示已完成', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pixel-squash.tutorial.v1', '1'));
  await page.goto('/');
  await expect(page.locator('#btnTutorial')).toContainText('已完成 ✓');
});

test('favicon:主頁與重播頁的 icon 真的回 200 PNG', async ({ page, request }) => {
  for (const path of ['/', '/replay.html']) {
    await page.goto(path);
    const href = await page.locator('link[rel="icon"]').getAttribute('href');
    expect(href).toBe('/favicon-32.png');
  }
  for (const icon of ['/favicon-32.png', '/apple-touch-icon.png']) {
    const res = await request.get(icon);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image/png');
  }
});
