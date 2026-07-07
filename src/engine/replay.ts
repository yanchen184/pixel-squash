/**
 * v2 重播/雜湊基礎。
 *
 * 重播檔 = 初始狀態 + (P2 起的)輸入流 + 最終 hash。決定性引擎保證同輸入 → 逐 tick
 * hash 完全相同;黃金重播 blessing(L5)與 CI 回歸都靠這裡。
 *
 * hash 演算法:FNV-1a 32-bit,餵 float64 的原始 8 bytes(不是十進位字串)——
 * 任何最低位元的浮點差異都會被抓到。
 */
import type { BallState } from './ball';
import { stepBall } from './ball';

const HASH_BUF = new ArrayBuffer(8);
const HASH_F64 = new Float64Array(HASH_BUF);
const HASH_U8 = new Uint8Array(HASH_BUF);

/** FNV-1a over float64 bytes;h 為前一輪 hash(鏈式)或省略取種子 */
export function hashNumbers(values: readonly number[], h = 0x811c9dc5): number {
  let acc = h >>> 0;
  for (const v of values) {
    HASH_F64[0] = v;
    for (let i = 0; i < 8; i++) {
      acc ^= HASH_U8[i];
      acc = Math.imul(acc, 0x01000193) >>> 0;
    }
  }
  return acc >>> 0;
}

export function hashBall(ball: BallState, prev = 0x811c9dc5): number {
  return hashNumbers(
    [
      ball.pos.x,
      ball.pos.y,
      ball.pos.z,
      ball.vel.x,
      ball.vel.y,
      ball.vel.z,
      ball.rolling ? 1 : 0,
      ball.resting ? 1 : 0,
    ],
    prev,
  );
}

export interface BallReplay {
  readonly initial: BallState;
  readonly ticks: number;
  /** 逐 tick 鏈式 hash 的最終值 */
  readonly finalHash: number;
}

export interface ReplayRun {
  readonly finalBall: BallState;
  readonly finalHash: number;
  /** 每 tick 的鏈式 hash(索引 0 = 第 1 tick 後) */
  readonly hashes: readonly number[];
}

/** 跑 n ticks 並產生逐 tick 鏈式 hash */
export function runBallTicks(initial: BallState, ticks: number): ReplayRun {
  let ball = initial;
  let h = hashBall(initial);
  const hashes: number[] = [];
  for (let t = 0; t < ticks; t++) {
    ball = stepBall(ball).ball;
    h = hashBall(ball, h);
    hashes.push(h);
  }
  return { finalBall: ball, finalHash: h, hashes };
}

export function recordBallReplay(initial: BallState, ticks: number): BallReplay {
  return { initial, ticks, finalHash: runBallTicks(initial, ticks).finalHash };
}

/** 驗證重播:重跑一次,最終 hash 必須 bit 相同 */
export function verifyBallReplay(replay: BallReplay): boolean {
  return runBallTicks(replay.initial, replay.ticks).finalHash === replay.finalHash;
}
