import { test, expect, type Page } from '@playwright/test';

/**
 * Round-trip E2E: the real app, real Phaser, real RAF loop. Proves the menu flow
 * works and that the deterministic sim actually ticks and plays a full match to a
 * winner with both sides able to score. Runs headed (see playwright.config) so RAF
 * is not frozen.
 */

async function walkToMatch(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '開始遊戲' }).click();
  await page.getByRole('button', { name: /開始對戰/ }).click();
  await page.getByRole('button', { name: '中等' }).click();
  // Wait for the Phaser game + sim runner to come up.
  await page.waitForFunction(() => {
    const g = (window as any).__game;
    const scene = g?.scene?.getScene('match');
    return !!scene?.runner;
  }, { timeout: 10_000 });
}

test('menu flow boots the match scene and the sim ticks', async ({ page }) => {
  await walkToMatch(page);

  // The deterministic sim must advance under the real RAF loop.
  const f0 = await page.evaluate(() => (window as any).__game.scene.getScene('match').debugState().frame);
  await page.waitForTimeout(800);
  const f1 = await page.evaluate(() => (window as any).__game.scene.getScene('match').debugState().frame);
  expect(f1).toBeGreaterThan(f0);

  // The serve must launch (phase leaves 'serve', shuttle goes in play).
  await page.waitForFunction(() => {
    const s = (window as any).__game.scene.getScene('match').debugState();
    return s.shuttle.inPlay || s.scores[0] + s.scores[1] > 0;
  }, { timeout: 5_000 });
});

test('a full match plays to a winner with both sides scoring', async ({ page }) => {
  await walkToMatch(page);

  // Drive the (normally human) near side with a real AIInput too, so a full
  // competitive rally develops under the real RAF loop. Two evenly-matched AIs
  // produce a close match where BOTH sides score — proving rallies go both ways,
  // not a one-sided net-fault loop. The scene's AIInput class is reachable via the
  // live opponent's constructor.
  await page.evaluate(() => {
    const scene = (window as any).__game.scene.getScene('match');
    const runner = scene.runner;
    const AIInput = scene.ai.constructor; // same class the scene already uses
    runner.inputA = new AIInput('hard', 0, 0x0badf00d);
    runner.reset();
  });

  // Real-time play until a winner emerges.
  await page.waitForFunction(() => {
    const s = (window as any).__game.scene.getScene('match').debugState();
    return s.winner !== null;
  }, { timeout: 45_000 });

  const final = await page.evaluate(() => {
    const s = (window as any).__game.scene.getScene('match').debugState();
    return { scores: s.scores, winner: s.winner };
  });

  expect(final.winner === 0 || final.winner === 1).toBeTruthy();
  expect(Math.max(final.scores[0], final.scores[1])).toBe(11);
  // Both sides should have scored at least once — proves rallies go both ways,
  // not a one-sided net-fault loop.
  expect(final.scores[0]).toBeGreaterThan(0);
  expect(final.scores[1]).toBeGreaterThan(0);
});
