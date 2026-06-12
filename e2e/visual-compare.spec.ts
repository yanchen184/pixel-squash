import { test, type Page } from '@playwright/test';

async function walkToMatch(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '開始遊戲' }).click();
  await page.getByRole('button', { name: /開始對戰/ }).click();
  await page.getByRole('button', { name: '中等' }).click();
  await page.waitForFunction(() => !!(window as any).__game?.scene?.getScene('match')?.runner, { timeout: 10_000 });
}

test('capture a normal rally frame for visual comparison vs target.jpg', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await walkToMatch(page);
  // Drive an AI-vs-AI rally so both players are in motion mid-court, then freeze.
  await page.evaluate(() => {
    const scene = (window as any).__game.scene.getScene('match');
    const AIInput = scene.ai.constructor;
    scene.runner.inputA = new AIInput('medium', 0, 0x1234);
    scene.runner.reset();
  });
  // Let a few rallies play, then freeze on a frame where the shuttle is in play.
  await page.evaluate(async () => {
    const scene = (window as any).__game.scene.getScene('match');
    const deadline = performance.now() + 8000;
    while (performance.now() < deadline) {
      const s = scene.debugState();
      if (s.phase === 'rally' && s.shuttle.inPlay && s.shuttle.z > 30 && s.shuttle.z < 120) {
        scene.runner.update = () => 0;
        break;
      }
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'e2e-artifacts/visual-now.png' });
});
