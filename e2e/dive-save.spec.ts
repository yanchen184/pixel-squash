import { test, expect, type Page } from '@playwright/test';

/**
 * Round-trip E2E for the diving save (魚躍救球). Real React app, real Canvas2D, real
 * RAF + 60Hz sim. Proves: (1) a dive lunges with extended reach and SAVES a ball a
 * standing swing would miss; (2) the save launches the ball back (not a dead drop);
 * (3) it bites a heavy stamina cost; (4) on connecting the diver is pinned to the
 * floor for the recovery window.
 *
 * The dive is injected deterministically through the real loop (the AI intercepts
 * most balls within normal reach and rarely needs to dive). We pin the near player
 * mid-court, place an incoming ball just OUT of standing reach (100px) but INSIDE the
 * dive's extended reach (190px), command a dive each tick, and let the loop tick.
 *
 * State is read/armed through the DEV-only `window.__squash` seam.
 */

type Vec = { x: number; y: number };
type SquashState = {
  p1: { pos: Vec; stamina: number; diveFrames: number; diveRecovery: number; swingCooldown: number };
  shuttle: { pos: Vec; z: number; vel: Vec; vz: number; lastHitBy: number | null; inPlay: boolean };
  phase: string;
  winner: number | null;
  phaseTimer: number;
};

declare global {
  interface Window {
    __squash?: {
      state: () => SquashState;
      patch: (p: Partial<SquashState>) => void;
      setInputA: (src: { side: number; sample: () => unknown; reset?: () => void }) => void;
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

test('a dive SAVES an out-of-reach ball, launches it back, costs stamina, and pins the diver', async ({ page }) => {
  await walkToMatch(page);

  const result = await page.evaluate(async () => {
    const dbg = window.__squash!;

    // Command a rightward dive every tick (the panicked-save path auto-aims at the
    // shuttle once it's within extended reach).
    dbg.setInputA({
      side: 0,
      sample: () => ({
        moveX: 1, moveY: 0, swing: false, stroke: 'drive', timingAim: true,
        aimX: 0, aimY: 0, dive: true, serveLeft: false, serveRight: false, faultBias: 0,
      }),
    });

    const arm = () => {
      const s = dbg.state();
      const p1 = { ...s.p1 };
      const shuttle = { ...s.shuttle };
      if (p1.diveFrames === 0 && p1.diveRecovery === 0) {
        p1.pos = { x: 500, y: 450 };
        p1.stamina = 100;
        p1.swingCooldown = 0;
      }
      if (shuttle.lastHitBy !== 0) {
        // 150px to the player's right: outside standing reach (100), inside dive (190).
        shuttle.pos = { x: 650, y: 450 };
        shuttle.z = 50;
        shuttle.vel = { x: 0, y: 0 };
        shuttle.vz = 0;
        shuttle.lastHitBy = 1; // far side hit last → near player must return it
        shuttle.inPlay = true;
      }
      dbg.patch({ p1, shuttle, phase: 'rally', winner: null, phaseTimer: 0 });
    };

    arm();
    const staminaBefore = 100;

    let connected = false;
    let minStamina = staminaBefore;
    let recoveryStarted = false;
    let launchVel: Vec = { x: 0, y: 0 };
    const deadline = performance.now() + 4_000;
    while (performance.now() < deadline) {
      arm();
      const cur = dbg.state();
      minStamina = Math.min(minStamina, cur.p1.stamina);
      if (cur.p1.diveRecovery > 0) recoveryStarted = true;
      if (!connected && cur.shuttle.lastHitBy === 0) {
        connected = true;
        launchVel = { ...cur.shuttle.vel };
        break;
      }
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }

    const after = dbg.state();
    return {
      connected,
      staminaDrop: staminaBefore - minStamina,
      recoveryStarted: recoveryStarted || after.p1.diveRecovery > 0,
      // A real save launches the shuttle back, not a dead drop.
      shuttleLaunched: launchVel.y < -0.1 || Math.abs(launchVel.x) > 0.1,
    };
  });

  // It connected: a racket reached a ball 150px away that a standing swing (100px)
  // never could.
  expect(result.connected).toBeTruthy();
  // The save launched the shuttle back.
  expect(result.shuttleLaunched).toBeTruthy();
  // It bit a heavy stamina cost (DIVE_STAMINA_COST = 25).
  expect(result.staminaDrop).toBeGreaterThan(15);
  // And on connecting, the diver is pinned to the floor for the recovery window.
  expect(result.recoveryStarted).toBeTruthy();
});

test('grounded recovery locks out movement', async ({ page }) => {
  await walkToMatch(page);

  const locked = await page.evaluate(async () => {
    const dbg = window.__squash!;
    // Command full-tilt movement while pinned.
    dbg.setInputA({
      side: 0,
      sample: () => ({
        moveX: 1, moveY: 1, swing: false, stroke: 'drive', timingAim: true,
        aimX: 0, aimY: 0, dive: false, serveLeft: false, serveRight: false, faultBias: 0,
      }),
    });

    // Pin the near player in recovery.
    const s0 = dbg.state();
    const before = { x: 500, y: 450 };
    dbg.patch({
      phase: 'rally',
      winner: null,
      p1: { ...s0.p1, pos: { ...before }, diveRecovery: 20, diveFrames: 0 },
      shuttle: { ...s0.shuttle, inPlay: true },
    });

    // Let the real RAF loop tick for several frames.
    await new Promise((r) => setTimeout(r, 250));

    const after = dbg.state();
    const moved = Math.abs(after.p1.pos.x - before.x) + Math.abs(after.p1.pos.y - before.y);
    return { moved, stillRecovering: after.p1.diveRecovery };
  });

  // While grounded, full-tilt movement input must NOT move the player.
  expect(locked.moved).toBe(0);
  // And the recovery timer must have been counting down under the real loop.
  expect(locked.stillRecovering).toBeLessThan(20);
});
