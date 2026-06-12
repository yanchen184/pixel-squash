import { test, expect, type Page } from '@playwright/test';

/**
 * Round-trip E2E for the diving save (魚躍救球). Real Phaser, real RAF, real sim.
 * Proves: (1) a dive lunges with extended reach and SAVES a ball that a standing
 * swing would miss; (2) after the lunge the player is pinned to the floor and
 * cannot move for the recovery window; (3) the dive bites a heavy stamina cost.
 * Also captures a screenshot of the lunge pose.
 *
 * The dive is injected deterministically through the real RAF loop (not left to
 * the AI, which intercepts most balls within normal reach and rarely needs to
 * dive). We pin the near player mid-court, place an incoming ball just OUT of the
 * standing reach (120px) but INSIDE the dive's extended reach (210px), feed a
 * dive input, and let the real loop tick.
 */

async function walkToMatch(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '開始遊戲' }).click();
  await page.getByRole('button', { name: /開始對戰/ }).click();
  await page.getByRole('button', { name: '中等' }).click();
  await page.waitForFunction(() => !!(window as any).__game?.scene?.getScene('match')?.runner, { timeout: 10_000 });
}

/**
 * Inject a dive-save scenario and drive it through the real loop. Returns what the
 * sim actually did: did the dive connect (shuttle's lastHitBy flipped to the near
 * player, 0), what was the stamina drop, and did the player end up pinned.
 */
async function injectDiveSave(page: Page) {
  return page.evaluate(async () => {
    const scene = (window as any).__game.scene.getScene('match');
    const runner = scene.runner;
    const s = runner.current;

    // Live rally, no winner, fresh dive state.
    s.phase = 'rally';
    s.phaseTimer = 0;
    s.winner = null;
    s.frame = 0;

    // Near player (side 0) at mid-court, full stamina, ready to act.
    s.p1.pos = { x: 500, y: 450 };
    s.p1.vel = { x: 0, y: 0 };
    s.p1.stamina = 100;
    s.p1.swingCooldown = 0;
    s.p1.diveFrames = 0;
    s.p1.diveRecovery = 0;

    // Shuttle on the near half, 160px to the player's right — OUTSIDE the 120px
    // standing reach but INSIDE the 210px dive reach. Low, slow, gently dropping,
    // so a rightward lunge slides into it before it hits the floor.
    s.shuttle.pos = { x: 660, y: 450 };
    s.shuttle.z = 40;
    s.shuttle.vel = { x: 0, y: 0 };
    s.shuttle.vz = 0;
    s.shuttle.lastHitBy = 1; // last touched by the far side → near player must return it
    s.shuttle.inPlay = true;

    const staminaBefore = s.p1.stamina;
    const lastHitBefore = s.shuttle.lastHitBy;

    // Command a rightward dive toward the ball. The lunge auto-swings each frame
    // and connects the instant the ball enters extended reach.
    runner.inputA = { sample: () => ({ moveX: 1, moveY: 0, swing: false, stroke: 'drive', dive: true }) };
    runner.inputB = { sample: () => ({ moveX: 0, moveY: 0, swing: false, stroke: 'clear', dive: false }) };

    // Watch the real loop until the dive connects (or we give up). The lunge can
    // start AND connect inside a single RAF batch (up to 5 sim steps/frame), so we
    // track the LOW-WATER stamina and the FIRST post-connect velocity rather than
    // trying to freeze on the transient diveFrames>0 frame.
    let connected = false;
    let minStamina = staminaBefore;
    let launchVel = { x: 0, y: 0 };
    let recoveryStarted = false;
    const deadline = performance.now() + 3_000;
    while (performance.now() < deadline) {
      const cur = scene.debugState();
      minStamina = Math.min(minStamina, cur.p1.stamina);
      if (cur.p1.diveRecovery > 0) recoveryStarted = true;
      if (!connected && cur.shuttle.lastHitBy === 0 && lastHitBefore !== 0) {
        connected = true;
        launchVel = { ...cur.shuttle.vel };
        break;
      }
      // The shuttle died without a save → stop early.
      if (!cur.shuttle.inPlay) break;
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }

    const after = scene.debugState();
    return {
      connected,
      recoveryStarted: recoveryStarted || after.p1.diveRecovery > 0,
      staminaDrop: staminaBefore - minStamina,
      recoveryAfter: Math.max(after.p1.diveRecovery, recoveryStarted ? 1 : 0),
      // A real save launches the shuttle back (toward the far half, vy<0) — not a
      // dead drop. lastHitBy=0 with non-trivial velocity proves the return.
      shuttleLaunched: launchVel.y < -0.1 || Math.abs(launchVel.x) > 0.1,
    };
  });
}

test('a dive SAVES an out-of-reach ball, costs heavy stamina, and pins the diver', async ({ page }) => {
  await walkToMatch(page);

  const r = await injectDiveSave(page);

  // It connected: the near player got a racket on a ball a standing swing (120px)
  // could never have reached (it was 160px away).
  expect(r.connected).toBeTruthy();
  // The save launched the shuttle back (not just a dead drop).
  expect(r.shuttleLaunched).toBeTruthy();
  // It bit a heavy stamina cost (DIVE_STAMINA_COST = 25).
  expect(r.staminaDrop).toBeGreaterThan(15);
  // And on connecting, the diver is pinned to the floor for the recovery window.
  expect(r.recoveryStarted).toBeTruthy();
  expect(r.recoveryAfter).toBeGreaterThan(0);
});

test('dive lunge pose — screenshot for eyeballing against the north star', async ({ page }) => {
  await walkToMatch(page);

  // Re-inject and freeze ON a lunge frame so the prone pose can be captured.
  await page.evaluate(async () => {
    const scene = (window as any).__game.scene.getScene('match');
    const runner = scene.runner;
    const s = runner.current;
    s.phase = 'rally';
    s.phaseTimer = 0;
    s.winner = null;
    s.p1.pos = { x: 500, y: 450 };
    s.p1.stamina = 100;
    s.p1.swingCooldown = 0;
    s.p1.diveFrames = 0;
    s.p1.diveRecovery = 0;
    // Ball BEYOND the dive's extended reach (210px) so the lunge slides for
    // several frames before it can connect — giving us a window to freeze on the
    // prone pose. 240px away (x=740), drifting in slowly.
    s.shuttle.pos = { x: 740, y: 450 };
    s.shuttle.z = 70;
    s.shuttle.vel = { x: -1.5, y: 0 };
    s.shuttle.vz = 0;
    s.shuttle.lastHitBy = 1;
    s.shuttle.inPlay = true;
    runner.inputA = { sample: () => ({ moveX: 1, moveY: 0, swing: false, stroke: 'drive', dive: true }) };
    runner.inputB = { sample: () => ({ moveX: 0, moveY: 0, swing: false, stroke: 'clear', dive: false }) };

    const deadline = performance.now() + 3_000;
    while (performance.now() < deadline) {
      if (scene.debugState().p1.diveFrames > 0) {
        scene.runner.update = () => 0; // freeze on this lunge frame
        break;
      }
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'e2e-artifacts/dive-save.png' });
});

test('grounded recovery locks out movement (deterministic injection)', async ({ page }) => {
  await walkToMatch(page);

  const locked = await page.evaluate(async () => {
    const scene = (window as any).__game.scene.getScene('match');
    const runner = scene.runner;
    const s = runner.current;
    s.phase = 'rally';
    s.winner = null;
    s.shuttle.inPlay = true;
    // Pin the near player in recovery and command full-tilt movement.
    s.p1.diveRecovery = 20;
    s.p1.diveFrames = 0;
    s.p1.pos = { x: 500, y: 450 };
    const before = { ...s.p1.pos };
    runner.inputA = { sample: () => ({ moveX: 1, moveY: 1, swing: false, stroke: 'clear', dive: false }) };
    runner.inputB = { sample: () => ({ moveX: 0, moveY: 0, swing: false, stroke: 'clear', dive: false }) };
    // Let the real RAF loop tick several frames.
    await new Promise((r) => setTimeout(r, 200));
    const after = scene.debugState().p1.pos;
    const moved = Math.abs(after.x - before.x) + Math.abs(after.y - before.y);
    const stillRecovering = scene.debugState().p1.diveRecovery;
    return { moved, stillRecovering };
  });

  // While grounded, full-tilt movement input must NOT move the player.
  expect(locked.moved).toBe(0);
  // And the recovery timer must have been counting down under the real loop.
  expect(locked.stillRecovering).toBeLessThan(20);
});
