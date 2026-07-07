/**
 * M1 擊球品質層(人類專用;bot 走自己的 execNoise,路徑不相交 → 黃金重播不破)。
 *
 * 品質 = timing × 步法:
 * - timing:揮拍窗第幾 tick 碰到球。按下後 1–3 tick 內接觸 = 甜蜜點(預判提前量);
 *   0 tick(球已在拍面內才按)= 慌張反應;拖到 4+ tick = 揮早了等球。
 * - 步法:接觸瞬間離球的水平距離 / 觸及半徑。貼身擊球乾淨,全伸展勉強救就毛。
 *
 * 品質怎麼咬進物理:solve 出合法軌跡後,速度向量加 ±err·|v| 均勻擾動,
 * err = BASE_ERR × (1−q) × 球路風險係數 —— 殺球對品質最敏感(高風險高報酬),
 * 挑高最寬容。擾動只用帶種子 prng → 同輸入序列同結果,決定性不破。
 */

import type { Vec3 } from './ball';
import type { Prng } from './prng';
import type { ShotKind } from './shot';

export type HitQuality = 'perfect' | 'good' | 'sloppy';

/** 各球路對品質的敏感度(乘在擾動幅度上) */
export const SHOT_RISK: Record<ShotKind, number> = {
  kill: 1.7,
  drop: 1.35,
  boast: 1.25,
  drive: 1.0,
  lob: 0.7,
  serve: 0,
};

/** 擾動幅度基底(佔出手速度的比例,q=0 且 risk=1 時) */
export const BASE_ERR = 0.16;

/** 品質好壞對出手速度的縮放:q=0 慢 10%,perfect 快 4% */
const SLOPPY_SPEED_LOSS = 0.1;
const PERFECT_SPEED_BONUS = 1.04;

export const PERFECT_MIN = 0.9;
export const GOOD_MIN = 0.68;

function timingFactor(swingAge: number): number {
  if (swingAge <= 0) return 0.7; // 球到了才按:慌張反應
  if (swingAge <= 3) return 1.0; // 甜蜜點:提前 1–3 tick 起拍
  if (swingAge <= 5) return 0.8;
  return 0.55; // 揮太早,球到時拍已過力
}

/**
 * 品質分數 0..1。stretch = 接觸時水平距離 / REACH_RADIUS(0 貼身、1 全伸展)。
 */
export function qualityScore(swingAge: number, stretch: number): number {
  const s = stretch < 0 ? 0 : stretch > 1 ? 1 : stretch;
  const footwork = 1 - 0.45 * s * s;
  return timingFactor(swingAge) * footwork;
}

export function qualityTier(q: number): HitQuality {
  if (q >= PERFECT_MIN) return 'perfect';
  if (q >= GOOD_MIN) return 'good';
  return 'sloppy';
}

/**
 * 把品質咬進出手速度:方向/速率擾動 + 速度縮放。
 * prng 消耗固定 3 次(決定性:呼叫次數不隨 q 變)。
 */
export function applyQuality(v: Vec3, q: number, kind: ShotKind, prng: Prng): Vec3 {
  const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  const err = BASE_ERR * (1 - q) * SHOT_RISK[kind] * speed;
  const jx = (prng.next() * 2 - 1) * err;
  const jy = (prng.next() * 2 - 1) * err;
  const jz = (prng.next() * 2 - 1) * err;
  const scale =
    (1 - SLOPPY_SPEED_LOSS * (1 - q)) *
    (q >= PERFECT_MIN && (kind === 'kill' || kind === 'drive') ? PERFECT_SPEED_BONUS : 1);
  return { x: v.x * scale + jx, y: v.y * scale + jy, z: v.z * scale + jz };
}
