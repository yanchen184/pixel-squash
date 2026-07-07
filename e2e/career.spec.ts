/**
 * M2 生涯天梯 round-trip:
 * (1) 新玩家只解鎖第 1 階,其餘鎖住顯示 ???;
 * (2) localStorage 進度真的驅動 UI(預存進度 → 解鎖階數/✓ 對得上);
 * (3) 點天梯對手真的開局(careerRung 進 sim 探針)。
 */
import { expect, test } from '@playwright/test';

test('新玩家:只有第 1 階可打,第 2 階起鎖住', async ({ page }) => {
  await page.goto('/');
  const buttons = page.locator('#ladder button');
  await expect(buttons).toHaveCount(8);
  await expect(buttons.nth(0)).toBeEnabled();
  await expect(buttons.nth(0)).toContainText('阿新');
  for (let i = 1; i < 8; i++) {
    await expect(buttons.nth(i)).toBeDisabled();
    await expect(buttons.nth(i)).toContainText('???');
  }
});

test('localStorage 進度 → UI 解鎖/✓ 同步;點對手開局進 careerRung', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'pixel-squash.career.v1',
      JSON.stringify({ unlocked: 2, beaten: ['rookie', 'wall'] }),
    );
  });
  await page.goto('/');
  const buttons = page.locator('#ladder button');
  await expect(buttons.nth(0)).toBeEnabled();
  await expect(buttons.nth(1)).toBeEnabled();
  await expect(buttons.nth(2)).toBeEnabled();
  await expect(buttons.nth(3)).toBeDisabled();
  await expect(buttons.nth(0)).toHaveClass(/beaten/);
  await expect(buttons.nth(1)).toHaveClass(/beaten/);
  await expect(buttons.nth(2)).toHaveClass(/next/);
  await expect(buttons.nth(2)).toContainText('小刀');

  await buttons.nth(2).click();
  await page.waitForFunction(() => {
    const s = window.__gameState?.() as { started?: boolean; careerRung?: number | null };
    return s?.started === true && s?.careerRung === 2;
  });
  await expect(page.locator('#menu')).toBeHidden();
});
