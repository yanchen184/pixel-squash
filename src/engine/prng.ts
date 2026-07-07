/**
 * 決定性 PRNG(mulberry32)。引擎內唯一合法隨機源 — src/engine/ 禁 Math.random。
 * 只用整數位元運算 + Math.imul(IEEE 精確),跨引擎 byte 相同。
 */
export interface Prng {
  /** [0, 1) 均勻分佈 */
  next(): number;
  /** 目前內部狀態(存進 replay 可續跑) */
  state(): number;
}

export function createPrng(seed: number): Prng {
  let s = seed >>> 0;
  return {
    next(): number {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    state(): number {
      return s;
    },
  };
}
