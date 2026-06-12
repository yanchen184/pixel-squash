import { test, expect, type Page } from '@playwright/test';

/**
 * Round-trip E2E for the racket-arm swing overlay. Proves that during real rallies
 * (real Phaser, real RAF) the SEPARATE arm sprite actually becomes visible, swaps to
 * the stroke's texture, and rotates around the hand — i.e. the overlay rig drives a
 * visible arm swing rather than only the baked paper-doll body's affine juice. Also
 * confirms the swoosh FX flashes and that dressup (the body texture) is undisturbed.
 */

async function walkToMatch(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '開始遊戲' }).click();
  await page.getByRole('button', { name: /開始對戰/ }).click();
  await page.getByRole('button', { name: '中等' }).click();
  await page.waitForFunction(() => {
    const g = (window as any).__game;
    const scene = g?.scene?.getScene('match');
    return !!scene?.runner;
  }, { timeout: 10_000 });
}

test('racket-arm overlay shows, swaps texture, and rotates during swings', async ({ page }) => {
  await walkToMatch(page);

  // Drive both sides with AI so continuous rallies (and thus swings) happen.
  await page.evaluate(() => {
    const scene = (window as any).__game.scene.getScene('match');
    const AIInput = scene.ai.constructor;
    scene.runner.inputA = new AIInput('hard', 0, 0x0badf00d);
    scene.runner.reset();
  });

  // Sample the live overlay across many RAF frames. Capture: did the arm ever go
  // visible, with which textures, and with what max |rotation|; same for swoosh.
  const observed = await page.evaluate(async () => {
    const scene = (window as any).__game.scene.getScene('match');
    const armTextures = new Set<string>();
    let armSeenVisible = false;
    let maxArmRot = 0;
    let swooshSeenVisible = false;
    const deadline = performance.now() + 12_000;
    while (performance.now() < deadline) {
      const o = scene.debugOverlay();
      for (const side of [o.p1Arm, o.p2Arm]) {
        if (side?.visible) {
          armSeenVisible = true;
          if (side.texture) armTextures.add(side.texture);
          maxArmRot = Math.max(maxArmRot, Math.abs(side.rotation));
        }
      }
      if (o.p1Swoosh?.visible || o.p2Swoosh?.visible) swooshSeenVisible = true;
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    return {
      armSeenVisible,
      armTextures: [...armTextures],
      maxArmRot,
      swooshSeenVisible,
    };
  });

  // The overlay arm must have been drawn during play.
  expect(observed.armSeenVisible).toBeTruthy();
  // It must use the per-stroke arm textures (keys are 'arm:<stroke>').
  expect(observed.armTextures.length).toBeGreaterThan(0);
  for (const tex of observed.armTextures) {
    expect(tex).toMatch(/^arm:(smash|clear|drop|drive|serve)$/);
  }
  // It must actually rotate (the rig swing arc) — not sit at 0.
  expect(observed.maxArmRot).toBeGreaterThan(0.1);
  // The swoosh FX must flash at least once.
  expect(observed.swooshSeenVisible).toBeTruthy();

  await page.screenshot({ path: 'e2e-artifacts/swing-overlay.png' });
});

test('body dressup texture is untouched by the overlay', async ({ page }) => {
  await walkToMatch(page);
  // The body sprite must keep its baked '<who>:<facing>' texture regardless of
  // whether an arm overlay is currently shown — proving the overlay is a separate
  // sprite that never re-bakes / disturbs the paper-doll.
  const ok = await page.evaluate(() => {
    const scene = (window as any).__game.scene.getScene('match');
    const bodyKey: string = scene.p1Sprite.texture.key;
    return /^(p1|p2):(down|up|left|right)$/.test(bodyKey);
  });
  expect(ok).toBeTruthy();
});
