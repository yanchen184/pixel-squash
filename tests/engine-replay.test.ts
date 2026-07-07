/**
 * 重播基建:hash 靈敏度 + 錄放 round-trip。
 */
import { describe, expect, it } from 'vitest';
import { createBall } from '../src/engine/ball';
import { hashBall, hashNumbers, recordBallReplay, verifyBallReplay } from '../src/engine/replay';
import { createPrng } from '../src/engine/prng';

describe('hash 靈敏度', () => {
  it('最低位元的浮點差異就會改變 hash', () => {
    const a = hashNumbers([1.0000000000000002]); // 1 + 2^-52
    const b = hashNumbers([1.0]);
    expect(a).not.toBe(b);
  });

  it('同狀態同 hash;rolling/resting 旗標參與 hash', () => {
    const ball = createBall({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 });
    expect(hashBall(ball)).toBe(hashBall({ ...ball }));
    expect(hashBall(ball)).not.toBe(hashBall({ ...ball, rolling: true }));
  });
});

describe('重播 round-trip', () => {
  it('錄下的重播重跑必過驗證;竄改最終 hash 必不過', () => {
    const ball = createBall({ x: 2, y: 8, z: 1.2 }, { x: 3, y: -25, z: 4 });
    const replay = recordBallReplay(ball, 600);
    expect(verifyBallReplay(replay)).toBe(true);
    expect(verifyBallReplay({ ...replay, finalHash: (replay.finalHash + 1) >>> 0 })).toBe(false);
  });
});

describe('PRNG 決定性', () => {
  it('同種子同序列;不同種子不同序列', () => {
    const a1 = createPrng(123);
    const a2 = createPrng(123);
    const b = createPrng(124);
    const seqA1 = Array.from({ length: 20 }, () => a1.next());
    const seqA2 = Array.from({ length: 20 }, () => a2.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA1).toEqual(seqA2);
    expect(seqA1).not.toEqual(seqB);
    for (const v of seqA1) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
