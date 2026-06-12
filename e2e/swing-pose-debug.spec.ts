import { test, type Page } from '@playwright/test';

/** Debug-only: freeze each stroke at swing peak and screenshot so the racket-arm
 * grip alignment can be eyeballed against target.jpg. Not a CI assertion. */

async function walkToMatch(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '開始遊戲' }).click();
  await page.getByRole('button', { name: /開始對戰/ }).click();
  await page.getByRole('button', { name: '中等' }).click();
  await page.waitForFunction(() => !!(window as any).__game?.scene?.getScene('match')?.runner, { timeout: 10_000 });
}

for (const stroke of ['smash', 'clear', 'drive', 'drop', 'serve'] as const) {
  test(`pose:${stroke}`, async ({ page }: { page: Page }) => {
    await walkToMatch(page);
    // Freeze the sim (stub update to a no-op) and pin the near player into this
    // stroke at the swing peak. The scene's RAF render(s) keeps drawing the frozen
    // state, so the overlay stays put for a clean screenshot.
    await page.evaluate((stk) => {
      const scene = (window as any).__game.scene.getScene('match');
      const runner = scene.runner;
      runner.update = () => 0; // freeze the sim loop
      const s = runner.current;
      s.p1.facing = 'right';
      s.p1.lastStroke = stk;
      s.p1.swingCooldown = 7; // SWING_COOLDOWN_FRAMES(14) * 0.5 → ease peak
      s.p1.justHit = false;
    }, stroke);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `e2e-artifacts/pose-${stroke}.png` });
  });
}
