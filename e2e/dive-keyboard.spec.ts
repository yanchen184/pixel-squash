import { test, expect, type Page } from '@playwright/test';

/**
 * Human-path round-trip: the diving save (魚躍救球) must fire from the REAL keyboard
 * input a player uses — Shift — routed through LocalInput → sim, not from a synthetic
 * injected InputSource. Proves the wiring a real player hits.
 *
 * Standing reach is 100px; the dive extends it to 190px (SWING_REACH 100 +
 * DIVE_REACH_BONUS 90). We arm an incoming ball ~150px to the player's right — out of
 * standing reach, inside dive reach — and hold Shift while moving right toward it.
 */

type SquashState = {
  p1: { pos: { x: number; y: number }; stamina: number; diveFrames: number; diveRecovery: number; swingCooldown: number };
  shuttle: { pos: { x: number; y: number }; z: number; vel: { x: number; y: number }; vz: number; lastHitBy: number | null; inPlay: boolean };
  phase: string;
  winner: number | null;
  phaseTimer: number;
};

declare global {
  interface Window {
    __squash?: {
      state: () => SquashState;
      patch: (p: Partial<SquashState>) => void;
    };
  }
}

async function walkToMatch(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '開始遊戲' }).click();
  await page.getByRole('button', { name: /知道了，選難度/ }).click();
  await page.getByRole('button', { name: '中等' }).click();
  await page.waitForFunction(() => !!window.__squash, undefined, { timeout: 10_000 });
}

test('holding Shift fires a dive save through the real LocalInput pipeline', async ({ page }) => {
  await walkToMatch(page);

  // (Re)arm the scenario: live rally, near player mid-court at full stamina, an
  // out-of-standing-reach ball drifting in from the right. Floating gently (vz≈0)
  // so it can't hit the floor before the lunge slides into it. Re-applied each poll
  // because step() overwrites the patched state every tick.
  const arm = () =>
    page.evaluate(() => {
      const s = window.__squash!.state();
      const p1 = { ...s.p1 };
      const shuttle = { ...s.shuttle };
      const phase = 'rally';
      const winner = null;
      const phaseTimer = 0;
      if (p1.diveFrames === 0 && p1.diveRecovery === 0) {
        p1.pos = { x: 500, y: 450 };
        p1.stamina = 100;
        p1.swingCooldown = 0;
      }
      // Only re-arm the ball until the player has saved it (lastHitBy flips to 0).
      if (shuttle.lastHitBy !== 0) {
        shuttle.pos = { x: 650, y: 450 };
        shuttle.z = 70;
        shuttle.vel = { x: -1, y: 0 };
        shuttle.vz = 0;
        shuttle.lastHitBy = 1;
        shuttle.inPlay = true;
      }
      window.__squash!.patch({ p1, shuttle, phase, winner, phaseTimer });
    });

  await arm();

  // Hold Shift (dive) + move right toward the ball. The lunge auto-swings each frame
  // and connects the instant the ball enters extended reach.
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyD');

  let r = { lastHitBy: null as number | null, stamina: 100 };
  for (let i = 0; i < 40; i++) {
    await arm();
    await page.waitForTimeout(40);
    r = await page.evaluate(() => {
      const s = window.__squash!.state();
      return { lastHitBy: s.shuttle.lastHitBy, stamina: s.p1.stamina };
    });
    if (r.lastHitBy === 0) break;
  }

  await page.keyboard.up('KeyD');
  await page.keyboard.up('ShiftLeft');

  // The keyboard dive saved the ball (lastHitBy flipped to the near player) and paid
  // the dive's heavy stamina cost (DIVE_STAMINA_COST = 25).
  expect(r.lastHitBy).toBe(0);
  expect(r.stamina).toBeLessThan(90);
});
