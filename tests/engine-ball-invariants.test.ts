/**
 * L1 物理不變量:數學上不可能錯的性質。任何一條紅 = 引擎有 bug,不是調參問題。
 */
import { describe, expect, it } from 'vitest';
import {
  BallState,
  COURT_D,
  COURT_H,
  COURT_W,
  createBall,
  G,
  MAX_HIT_SPEED,
  predictLanding,
  stepBall,
  Vec3,
} from '../src/engine/ball';
import { runBallTicks } from '../src/engine/replay';
import { createPrng } from '../src/engine/prng';

/** 帶種子隨機出一批「合法擊球」初始狀態 */
function randomLaunches(seed: number, count: number): BallState[] {
  const rng = createPrng(seed);
  const out: BallState[] = [];
  for (let i = 0; i < count; i++) {
    const pos: Vec3 = {
      x: 0.3 + rng.next() * (COURT_W - 0.6),
      y: 0.5 + rng.next() * (COURT_D - 1),
      z: 0.2 + rng.next() * 2.5,
    };
    const speed = 2 + rng.next() * (MAX_HIT_SPEED - 2);
    // 方向不用三角函數:直接抽分量再正規化
    const dx = rng.next() * 2 - 1;
    const dy = rng.next() * 2 - 1;
    const dz = rng.next() * 1.2 - 0.35;
    const n = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    out.push(createBall(pos, { x: (dx / n) * speed, y: (dy / n) * speed, z: (dz / n) * speed }));
  }
  return out;
}

function energy(b: BallState): number {
  const v2 = b.vel.x * b.vel.x + b.vel.y * b.vel.y + b.vel.z * b.vel.z;
  return 0.5 * v2 + G * b.pos.z;
}

describe('L1-1 決定性:同輸入 → 逐 tick hash 完全相同', () => {
  it('600 ticks 跑兩次,hash 鏈 bit 相同', () => {
    for (const ball of randomLaunches(42, 10)) {
      const a = runBallTicks(ball, 600);
      const b = runBallTicks(ball, 600);
      expect(a.hashes).toEqual(b.hashes);
      expect(a.finalHash).toBe(b.finalHash);
    }
  });
});

describe('L1-2 能量單調遞減', () => {
  it('任何 tick 的機械能都不增加', () => {
    for (const ball of randomLaunches(7, 20)) {
      let cur = ball;
      let e = energy(cur);
      for (let t = 0; t < 60 * 15; t++) {
        cur = stepBall(cur).ball;
        const e2 = energy(cur);
        expect(e2).toBeLessThanOrEqual(e + 1e-9);
        e = e2;
        if (cur.resting) break;
      }
    }
  });
});

describe('L1-3 鏡像對稱', () => {
  it('x 鏡像的初始狀態 → 全程 x 鏡像軌跡', () => {
    for (const ball of randomLaunches(99, 8)) {
      const mirrored = createBall(
        { x: COURT_W - ball.pos.x, y: ball.pos.y, z: ball.pos.z },
        { x: -ball.vel.x, y: ball.vel.y, z: ball.vel.z },
      );
      let a = ball;
      let b = mirrored;
      for (let t = 0; t < 600; t++) {
        a = stepBall(a).ball;
        b = stepBall(b).ball;
        expect(b.pos.x).toBeCloseTo(COURT_W - a.pos.x, 6);
        expect(b.pos.y).toBeCloseTo(a.pos.y, 6);
        expect(b.pos.z).toBeCloseTo(a.pos.z, 6);
      }
    }
  });
});

describe('L1-4 不穿隧、不出界', () => {
  it('50 m/s 全速打向牆角,每 tick 都在球場盒內', () => {
    const launches: BallState[] = [
      createBall({ x: 3.2, y: 9, z: 1 }, { x: 0, y: -MAX_HIT_SPEED, z: 0.5 }),
      createBall({ x: 0.2, y: 9.5, z: 0.5 }, { x: -30, y: -39, z: 5 }),
      createBall({ x: 6.2, y: 0.3, z: 3 }, { x: 35, y: -35, z: 3 }),
      createBall({ x: 3.2, y: 5, z: 0.15 }, { x: 20, y: -20, z: 40 }),
      ...randomLaunches(2026, 30),
    ];
    for (const ball of launches) {
      let cur = ball;
      for (let t = 0; t < 60 * 10; t++) {
        cur = stepBall(cur).ball;
        expect(cur.pos.x).toBeGreaterThanOrEqual(0);
        expect(cur.pos.x).toBeLessThanOrEqual(COURT_W);
        expect(cur.pos.y).toBeGreaterThanOrEqual(0);
        expect(cur.pos.y).toBeLessThanOrEqual(COURT_D);
        expect(cur.pos.z).toBeGreaterThanOrEqual(0);
        expect(cur.pos.z).toBeLessThanOrEqual(COURT_H);
        if (cur.resting) break;
      }
    }
  });
});

describe('L1-5 數值健康', () => {
  it('長跑無 NaN / Infinity', () => {
    for (const ball of randomLaunches(555, 20)) {
      let cur = ball;
      for (let t = 0; t < 60 * 30; t++) {
        cur = stepBall(cur).ball;
        for (const v of [cur.pos.x, cur.pos.y, cur.pos.z, cur.vel.x, cur.vel.y, cur.vel.z]) {
          expect(Number.isFinite(v)).toBe(true);
        }
        if (cur.resting) break;
      }
    }
  });
});

describe('L1-6 保證靜止', () => {
  it('任何 ≤50 m/s 的擊球最終都會 rest(≤30s)', () => {
    for (const ball of randomLaunches(31337, 25)) {
      let cur = ball;
      let rested = false;
      for (let t = 0; t < 60 * 30; t++) {
        cur = stepBall(cur).ball;
        if (cur.resting) {
          rested = true;
          break;
        }
      }
      expect(rested).toBe(true);
    }
  });
});

describe('L1-7 predictLanding ≡ 實跑', () => {
  it('前瞻預測的落點 = 實際軌跡第一次落地點,bit 相同', () => {
    for (const ball of randomLaunches(808, 15)) {
      const predicted = predictLanding(ball);
      expect(predicted).not.toBeNull();
      // 實跑到第一次 floor-bounce
      let cur = ball;
      let live: { point: Vec3; ticks: number } | null = null;
      for (let t = 1; t <= 60 * 30 && live === null; t++) {
        const { ball: next, events } = stepBall(cur);
        for (const ev of events) {
          if ((ev.type === 'floor-bounce' || ev.type === 'rest') && live === null) {
            live = { point: ev.point, ticks: t };
          }
        }
        cur = next;
      }
      expect(live).not.toBeNull();
      // 同一條程式路徑 → 必須完全相等,不是 approximately
      expect(predicted!.point.x).toBe(live!.point.x);
      expect(predicted!.point.y).toBe(live!.point.y);
      expect(predicted!.point.z).toBe(live!.point.z);
      expect(predicted!.ticks).toBe(live!.ticks);
    }
  });
});
