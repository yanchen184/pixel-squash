import { test, expect, type Page } from '@playwright/test';

/**
 * Human-path round-trip: the dive must fire from the REAL keyboard input the
 * player uses (KeyK), routed through LocalInput → touchControls merge → sim — not
 * just from a synthetic injected InputSource. Proves the wiring a real player hits.
 */
async function walkToMatch(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '開始遊戲' }).click();
  await page.getByRole('button', { name: /開始對戰/ }).click();
  await page.getByRole('button', { name: '中等' }).click();
  await page.waitForFunction(() => !!(window as any).__game?.scene?.getScene('match')?.runner, { timeout: 10_000 });
}

test('pressing K fires a dive through the real LocalInput pipeline', async ({ page }) => {
  await walkToMatch(page);

  // Helper to (re)arm the out-of-reach incoming ball. Floating (vz>0) so it can't
  // fall to the floor before the dive lands — keeps the test deterministic under
  // parallel CPU load. Re-arm each poll iteration so a throttled RAF batch that
  // dropped the ball before K registered doesn't end the rally prematurely.
  const arm = () =>
    page.evaluate(() => {
      const s = (window as any).__game.scene.getScene('match').runner.current;
      s.phase = 'rally'; s.phaseTimer = 0; s.winner = null;
      s.p1.diveRecovery = 0;
      if (s.p1.diveFrames === 0) {
        s.p1.pos = { x: 500, y: 450 }; s.p1.stamina = 100; s.p1.swingCooldown = 0;
      }
      // Only re-arm the ball while it hasn't been saved yet.
      if (s.shuttle.lastHitBy !== 0) {
        s.shuttle.pos = { x: 640, y: 450 }; s.shuttle.z = 80; s.shuttle.vel = { x: 0, y: 0 };
        s.shuttle.vz = 1; s.shuttle.lastHitBy = 1; s.shuttle.inPlay = true;
      }
    });

  await arm();

  // Hold K (dive) — a reflex lunge that auto-aims at the shuttle (the panicked-save
  // path). Exercises the real LocalInput → sim wiring: KeyK → dive:true. Poll the
  // real loop (re-arming the ball each tick) until the dive connects.
  await page.keyboard.down('KeyK');
  let r = { lastHitBy: null as number | null, recovery: 0, stamina: 100 };
  for (let i = 0; i < 30; i++) {
    await arm();
    await page.waitForTimeout(40);
    r = await page.evaluate(() => {
      const s = (window as any).__game.scene.getScene('match').debugState();
      return { lastHitBy: s.shuttle.lastHitBy, recovery: s.p1.diveRecovery, stamina: s.p1.stamina };
    });
    if (r.lastHitBy === 0) break;
  }
  await page.keyboard.up('KeyK');

  // The keyboard dive saved the ball (lastHitBy flipped to the player) and paid the
  // dive's heavy stamina cost.
  expect(r.lastHitBy).toBe(0);
  expect(r.stamina).toBeLessThan(90);
});
