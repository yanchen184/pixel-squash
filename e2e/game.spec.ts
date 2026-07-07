/**
 * v2 正式遊戲 round-trip:選單 → 選難度 → 人類發球 → 回合真的跑 → 比分真的走。
 * 玩家掛機(只發球不回擊),bot 會得分 —— 這正好證明規則層/迴圈/HUD 全通。
 */
import { expect, test } from '@playwright/test';

interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

declare global {
  interface Window {
    __gameState?: () => {
      started: boolean;
      scoreA: number;
      scoreB: number;
      phase: string;
      server: string;
      tick: number;
      posA: Vec3Like;
      ball: Vec3Like | null;
    };
  }
}

test('遊戲頁:選難度開局、發球進回合、比分推進、HUD 同步', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#menu')).toBeVisible();

  await page.click('#btnMedium');
  await page.waitForFunction(() => window.__gameState?.().started === true);
  await expect(page.locator('#menu')).toBeHidden();

  // 人類是首發球者:等「可以發了」的提示(倒數中顯示的是「準備發球…」)→ 空白鍵 → 進回合
  await page.waitForFunction(
    () => document.getElementById('serveHint')?.textContent?.includes('按 空白鍵') === true,
  );
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__gameState?.().phase === 'in-rally');

  // 掛機打 2 分:輪到自己發球就按空白鍵,比分應該推進
  await page.waitForFunction(
    () => {
      const s = window.__gameState?.();
      if (s === undefined) return false;
      const hint = document.getElementById('serveHint')?.textContent ?? '';
      if (hint.includes('按 空白鍵')) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
      }
      return s.scoreA + s.scoreB >= 2;
    },
    null,
    { timeout: 60_000, polling: 250 },
  );

  const s = await page.evaluate(() => window.__gameState!());
  expect(s.scoreA + s.scoreB).toBeGreaterThanOrEqual(2);
  // HUD 分數與 sim 一致
  const hud = await page.locator('#score').textContent();
  expect(hud).toContain(`${s.scoreA} : ${s.scoreB}`);
});

test('M1 品質閃字:玩家追球揮拍,#quality 真的在畫面亮起', async ({ page }) => {
  await page.goto('/');
  await page.click('#btnMedium');
  await page.waitForFunction(() => window.__gameState?.().started === true);

  // 探針:輪到自己就發球;回合中按住方向鍵追球、持續開揮拍窗;
  // 直到 #quality 帶上 q-* class(= 引擎 quality 事件 → flashQuality → DOM 全鏈路通)
  await page.waitForFunction(
    () => {
      const q = document.getElementById('quality');
      if (q !== null && /\bq-(perfect|good|sloppy)\b/.test(q.className)) return true;

      const s = window.__gameState?.();
      if (s === undefined || !s.started) return false;
      const key = (type: 'keydown' | 'keyup', code: string): void => {
        window.dispatchEvent(new KeyboardEvent(type, { code }));
      };

      const hint = document.getElementById('serveHint')?.textContent ?? '';
      if (hint.includes('按 空白鍵')) {
        key('keydown', 'Space');
        return false;
      }
      if (s.phase === 'in-rally' && s.ball !== null) {
        // 追球:x 軸 KeyA/KeyD,y 軸 KeyW(y 減)/KeyS(y 增),按住想去的方向、放開反向
        const dx = s.ball.x - s.posA.x;
        key('keydown', dx > 0 ? 'KeyD' : 'KeyA');
        key('keyup', dx > 0 ? 'KeyA' : 'KeyD');
        const dy = s.ball.y - s.posA.y;
        key('keydown', dy > 0 ? 'KeyS' : 'KeyW');
        key('keyup', dy > 0 ? 'KeyW' : 'KeyS');
        key('keydown', 'Space'); // 持續開揮拍窗,球進 reach 就會揮到
        key('keyup', 'Space');
      }
      return false;
    },
    null,
    { timeout: 60_000, polling: 100 },
  );

  // 閃字內容是三個等級之一,且真的可見(opacity 動畫由 class 驅動)
  const label = await page.locator('#quality').textContent();
  expect(['PERFECT!', 'GOOD', '毛掉了…']).toContain(label ?? '');
});
