/**
 * L2 現實錨點(黃金走廊):SI 常數對得上現實。斷言的是「區間」不是點值 ——
 * 調參可以在走廊內自由移動,弄破走廊 = 物理失真,不是手感偏好問題。
 */
import { describe, expect, it } from 'vitest';
import {
  BallState,
  COURT_D,
  COURT_H,
  createBall,
  stepBall,
} from '../src/engine/ball';

/** 跑到第一次指定事件,回傳 (tick, point);沒發生回 null */
function runUntil(
  ball: BallState,
  match: (ev: { type: string; wall?: string; point: { x: number; y: number; z: number } }) => boolean,
  maxTicks = 60 * 30,
): { tick: number; point: { x: number; y: number; z: number }; ball: BallState } | null {
  let cur = ball;
  for (let t = 1; t <= maxTicks; t++) {
    const { ball: next, events } = stepBall(cur);
    for (const ev of events) {
      if (match(ev)) return { tick: t, point: ev.point, ball: next };
    }
    cur = next;
  }
  return null;
}

describe('L2-1 反彈高度:1m 自由落下', () => {
  it('第一次反彈的頂點在 0.30–0.45m(壁球是低彈球)', () => {
    let cur = createBall({ x: 3.2, y: 5, z: 1 }, { x: 0, y: 0, z: 0 });
    // 跑到第一次落地
    const bounced = runUntil(cur, (ev) => ev.type === 'floor-bounce');
    expect(bounced).not.toBeNull();
    // 之後追蹤頂點
    cur = bounced!.ball;
    let apex = 0;
    for (let t = 0; t < 120; t++) {
      cur = stepBall(cur).ball;
      if (cur.pos.z > apex) apex = cur.pos.z;
      if (cur.vel.z < 0) break; // 過了頂點
    }
    expect(apex).toBeGreaterThanOrEqual(0.3);
    expect(apex).toBeLessThanOrEqual(0.45);
  });
});

describe('L2-2 平抽速度感:40 m/s drive', () => {
  it('從後場(y=8)到前牆 <0.4s', () => {
    const ball = createBall({ x: 3.2, y: 8, z: 1 }, { x: 0, y: -40, z: 0 });
    const hit = runUntil(ball, (ev) => ev.type === 'wall-hit' && ev.wall === 'front');
    expect(hit).not.toBeNull();
    expect(hit!.tick / 60).toBeLessThan(0.4);
  });
});

describe('L2-3 lob 存在性', () => {
  it('存在一種前場擊球:打前牆高處、不碰天花板、落進後 1/4 場', () => {
    // 存在性測試:掃一小格出手參數,至少一組滿足 lob 走廊。
    // 不用三角函數 —— 直接掃 (vy, vz) 分量。
    let found = false;
    for (let vy = -14; vy <= -6 && !found; vy += 1) {
      for (let vz = 6; vz <= 14 && !found; vz += 1) {
        const ball = createBall({ x: 3.2, y: 1.5, z: 0.8 }, { x: 0, y: vy, z: vz });
        let cur = ball;
        let hitFront = false;
        let hitCeiling = false;
        let landing: { y: number } | null = null;
        for (let t = 0; t < 60 * 10 && landing === null; t++) {
          const { ball: next, events } = stepBall(cur);
          for (const ev of events) {
            if (ev.type === 'wall-hit' && ev.wall === 'front') hitFront = true;
            if (ev.type === 'wall-hit' && ev.wall === 'ceiling') hitCeiling = true;
            if (ev.type === 'floor-bounce') landing = { y: ev.point.y };
          }
          cur = next;
        }
        if (hitFront && !hitCeiling && landing !== null && landing.y > COURT_D * 0.75) {
          found = true;
        }
      }
    }
    expect(found).toBe(true);
  });

  it('天花板(5.64m)真的擋得住太高的吊球', () => {
    // 反向錨點:超高仰角必碰天花板 → 規則層才有 out 可判
    const ball = createBall({ x: 3.2, y: 1.5, z: 0.8 }, { x: 0, y: -3, z: 20 });
    const hit = runUntil(ball, (ev) => ev.type === 'wall-hit' && ev.wall === 'ceiling');
    expect(hit).not.toBeNull();
    expect(COURT_H).toBe(5.64);
  });
});

describe('L2-4 靜止時間', () => {
  it('典型 drive(20 m/s)在 4–8 秒內完全靜止', () => {
    const ball = createBall({ x: 3.2, y: 7, z: 1 }, { x: 1, y: -19, z: 2 });
    const rest = runUntil(ball, (ev) => ev.type === 'rest', 60 * 20);
    expect(rest).not.toBeNull();
    const seconds = rest!.tick / 60;
    expect(seconds).toBeGreaterThanOrEqual(4);
    expect(seconds).toBeLessThanOrEqual(8);
  });
});
