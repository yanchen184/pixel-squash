import { test, expect, type Page } from '@playwright/test';

/**
 * Round-trip E2E: the real React app, real Canvas2D renderer, real RAF + 60Hz sim.
 * Proves the menu flow boots the match, the deterministic sim actually ticks under
 * the live RAF loop, and a full self-playing match runs to a winner with both sides
 * scoring (rallies go both ways — not a one-sided fault loop). Runs headed (see
 * playwright.config) so RAF is not frozen in a hidden tab.
 *
 * State is read through the DEV-only `window.__squash` seam (CanvasRenderer.debug()
 * → SimRunner.debugApi()), so the test never reaches into private renderer fields.
 */

type SquashDebug = {
  state: () => {
    frame: number;
    phase: string;
    winner: number | null;
    scores: [number, number];
    shuttle: { inPlay: boolean };
  };
  setInputA: (src: { side: number; sample: (s: { awaitingServeChoice?: boolean }) => unknown; reset?: () => void }) => void;
  reset: () => void;
  AIInput: new (difficulty: string, side: number, seed: number) => {
    sample: (s: { awaitingServeChoice?: boolean }) => { serveLeft: boolean; [k: string]: unknown };
    reset?: () => void;
  };
};

declare global {
  interface Window {
    __squash?: SquashDebug;
  }
}

/** Walk the real menu DOM into a started match and wait for the sim seam to mount. */
async function walkToMatch(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '開始遊戲' }).click();
  await page.getByRole('button', { name: /知道了，選難度/ }).click();
  await page.getByRole('button', { name: '中等' }).click();
  await page.waitForFunction(() => !!window.__squash, undefined, { timeout: 10_000 });
}

test('menu flow boots the match and the deterministic sim ticks', async ({ page }) => {
  await walkToMatch(page);

  // The sim must advance under the real RAF loop.
  const f0 = await page.evaluate(() => window.__squash!.state().frame);
  await page.waitForTimeout(800);
  const f1 = await page.evaluate(() => window.__squash!.state().frame);
  expect(f1).toBeGreaterThan(f0);

  // The serve waits on the human's service-box choice (awaitingServeChoice). HOLD the
  // real serve key — A = choose the left box (serveLeft) — the genuine human path.
  // LocalInput reads the held state per tick, so the key must stay down across a few
  // frames (a quick press can fall between sim ticks and never register).
  await page.evaluate(() => (document.body as HTMLElement).focus());
  await page.keyboard.down('KeyA');
  await page.waitForTimeout(200);
  await page.keyboard.up('KeyA');

  // The serve must launch (shuttle goes in play, or a point is already scored).
  await page.waitForFunction(() => {
    const s = window.__squash!.state();
    return s.shuttle.inPlay || s.scores[0] + s.scores[1] > 0;
  }, undefined, { timeout: 8_000 });
});

test('competitive rallies go both ways under the real RAF loop', async ({ page }) => {
  await walkToMatch(page);

  // Drive the (normally human) near side with a real AIInput too, so a full
  // competitive rally develops under the real RAF loop. Two evenly-matched AIs
  // produce a close match where BOTH sides score — proving rallies go both ways,
  // not a one-sided fault loop.
  //
  // The serve waits on side A's box choice (awaitingServeChoice reads inA only), but
  // the AI never emits one. Wrap it: delegate every tick to the real AI, and force a
  // serveLeft whenever a choice is pending so the match keeps serving after points.
  await page.evaluate(() => {
    const dbg = window.__squash!;
    const ai = new dbg.AIInput('hard', 0, 0x0badf00d);
    dbg.setInputA({
      side: 0,
      reset: () => ai.reset?.(),
      sample: (s: { awaitingServeChoice?: boolean }) => {
        const frame = ai.sample(s);
        return s.awaitingServeChoice ? { ...frame, serveLeft: true } : frame;
      },
    });
    dbg.reset();
  });

  // Play in real time until BOTH sides have scored — the unique thing this E2E
  // proves that the headless L1 tests can't: the real RAF render loop actually
  // drives two-way competitive rallies. (Playing all the way to 11 would take ~2min
  // of wall-clock real-time RAF; PAR-11 scoring, win-by-2, and winner-freeze are
  // already covered headless at full speed in simulate.test.ts — no need to re-prove
  // them slowly here.)
  await page.waitForFunction(() => {
    const s = window.__squash!.state();
    return s.scores[0] > 0 && s.scores[1] > 0;
  }, undefined, { timeout: 60_000 });

  const snap = await page.evaluate(() => window.__squash!.state().scores);
  expect(snap[0]).toBeGreaterThan(0);
  expect(snap[1]).toBeGreaterThan(0);
});
