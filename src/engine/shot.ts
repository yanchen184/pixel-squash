/**
 * v2 擊球層:固定出手速度、解仰角(v1 的 tof 反解的正向翻轉)。
 *
 * 解法 = 存在性網格掃描:vz 佔比從低到高掃,每個候選用 stepBall 真積分驗證
 * 「第一面牆、前牆高度帶、第一落點縱深」— 世界模型就是引擎本體,零第二份物理。
 * 無解 → null(該位置打不出這球,本身就是合理的遊戲規則)。
 *
 * 決定性:本檔在 src/engine/,只准 +−×÷√(lint 把關);固定網格順序 → 同輸入同解。
 */

import type { BallState, Vec3, WallId } from './ball';
import { clampHitVelocity, COURT_W, createBall, stepBall } from './ball';
import { outLineHeightAt } from './rules';

export type ShotKind = 'drive' | 'kill' | 'drop' | 'lob' | 'boast' | 'serve';

export interface ShotSpec {
  /** m/s,固定出手速度 */
  readonly speed: number;
  /** 前牆目標高度帶 [lo, hi](m) */
  readonly bandLo: number;
  readonly bandHi: number;
  /** 期望第一落點縱深範圍(m,離前牆) */
  readonly landMinY: number;
  readonly landMaxY: number;
}

/**
 * 分球路出手速度倍率 —— 想讓某球路變慢就調小它(1.0 = 原速)。
 * 設計取向(下棋式節奏):
 *   - drive/kill 是主要對打節奏 → 砍到 ~0.65,球慢下來玩家才有時間讀站位+球位、決定落點。
 *   - lob/serve/drop/boast 需要速度撐過整個 9.75m 球場吊高打到前牆,倍率一低就打不到牆變無解,
 *     故維持接近原速(實測 0.7 以下 lob 全滅)。
 * 要整體再慢一點:優先只降 drive/kill;lob/serve 想降須連帶放寬其落點帶/高度帶,
 * 調完務必跑 `npx tsx scan-scale.mts` + `npx vitest run` 確認每球路仍解得出、測試綠。
 * 可用環境變數 SS 全域再乘一層做快速手感試驗(SS=0.9 npx tsx scan-scale.mts),production 預設 1.0。
 */
export const SPEED_SCALE: Record<ShotKind, number> = {
  drive: 0.65,
  kill: 0.65,
  drop: 0.92,
  lob: 1.0,
  boast: 0.8,
  serve: 0.95,
};

const GLOBAL_SS =
  typeof process !== 'undefined' && process.env?.SS ? Number(process.env.SS) : 1.0;

/** 六球路基準速度(未套倍率);實際出手速度 = 基準 × SPEED_SCALE[kind] × GLOBAL_SS */
const BASE_SHOTS: Record<ShotKind, ShotSpec> = {
  drive: { speed: 32, bandLo: 0.55, bandHi: 1.6, landMinY: 6.0, landMaxY: 9.75 },
  kill: { speed: 38, bandLo: 0.49, bandHi: 0.85, landMinY: 0, landMaxY: 5.6 },
  drop: { speed: 11, bandLo: 0.5, bandHi: 1.1, landMinY: 0, landMaxY: 3.8 },
  lob: { speed: 15, bandLo: 2.4, bandHi: 4.4, landMinY: 6.8, landMaxY: 9.75 },
  boast: { speed: 24, bandLo: 0.55, bandHi: 1.9, landMinY: 0, landMaxY: 5.5 },
  serve: { speed: 17, bandLo: 2.0, bandHi: 4.3, landMinY: 5.6, landMaxY: 9.7 },
};

function scaled(kind: ShotKind): ShotSpec {
  const base = BASE_SHOTS[kind];
  return { ...base, speed: base.speed * SPEED_SCALE[kind] * GLOBAL_SS };
}

/** 六球路 = 3 欄位(速度/高度帶/落點帶),fault 條件由規則層统一判 */
export const SHOTS: Record<ShotKind, ShotSpec> = {
  drive: scaled('drive'),
  kill: scaled('kill'),
  drop: scaled('drop'),
  lob: scaled('lob'),
  boast: scaled('boast'),
  serve: scaled('serve'),
};

export interface SolveOptions {
  /** 發球用:第一落點必須在指定左右半場 */
  readonly requireLandHalf?: 'left' | 'right';
}

interface FlightCheck {
  readonly firstWall: WallId | null;
  readonly secondWall: WallId | null;
  readonly frontZ: number;
  readonly landing: Vec3 | null;
  /** 第一落地前任何牆點越界(含天花板)→ 這條解不合法 */
  readonly anyOut: boolean;
}

/** 積分到第一落地,記錄前兩面牆、前牆擊中高度、是否有越界牆點 */
function probeFlight(from: Vec3, vel: Vec3): FlightCheck {
  let ball: BallState = createBall(from, vel);
  let firstWall: WallId | null = null;
  let secondWall: WallId | null = null;
  let frontZ = -1;
  let anyOut = false;
  for (let t = 0; t < 60 * 12; t++) {
    const { ball: next, events } = stepBall(ball);
    for (const ev of events) {
      if (ev.type === 'wall-hit') {
        if (firstWall === null) firstWall = ev.wall;
        else if (secondWall === null) secondWall = ev.wall;
        if (ev.wall === 'front' && frontZ < 0) frontZ = ev.point.z;
        if (ev.wall === 'ceiling' || ev.point.z >= outLineHeightAt(ev.wall, ev.point.y)) {
          anyOut = true;
        }
      } else if (ev.type === 'floor-bounce' || ev.type === 'rest') {
        return { firstWall, secondWall, frontZ, landing: ev.point, anyOut };
      }
    }
    ball = next;
  }
  return { firstWall, secondWall, frontZ, landing: null, anyOut };
}

const VZ_FRACS: readonly number[] = (() => {
  // -0.25 → 0.9(0.0125 步進):低平到高吊全覆蓋;kill 這種窄走廊需要細網格
  const out: number[] = [];
  for (let f = -0.25; f <= 0.9; f += 0.0125) out.push(f);
  return out;
})();

function candidateVelocity(from: Vec3, aimX: number, aimY: number, speed: number, vzFrac: number): Vec3 | null {
  const vz = speed * vzFrac;
  const shSq = speed * speed - vz * vz;
  if (shSq <= 0) return null;
  const sh = Math.sqrt(shSq);
  const dx = aimX - from.x;
  const dy = aimY - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return null;
  return { x: (dx / len) * sh, y: (dy / len) * sh, z: vz };
}

function checkCandidate(
  kind: ShotKind,
  spec: ShotSpec,
  flight: FlightCheck,
  opts: SolveOptions,
): number | null {
  if (flight.landing === null || flight.frontZ < 0 || flight.anyOut) return null;
  if (kind === 'boast') {
    const sideFirst = flight.firstWall === 'left' || flight.firstWall === 'right';
    if (!sideFirst || flight.secondWall !== 'front') return null;
  } else if (flight.firstWall !== 'front') {
    return null;
  }
  if (flight.frontZ < spec.bandLo || flight.frontZ > spec.bandHi) return null;
  if (flight.landing.y < spec.landMinY || flight.landing.y > spec.landMaxY) return null;
  if (opts.requireLandHalf === 'left' && flight.landing.x > COURT_W / 2) return null;
  if (opts.requireLandHalf === 'right' && flight.landing.x < COURT_W / 2) return null;
  // 分數 = 距高度帶中心(越小越好)
  const center = (spec.bandLo + spec.bandHi) / 2;
  const d = flight.frontZ - center;
  return d < 0 ? -d : d;
}

/**
 * 解一顆球:from(擊球點)→ targetX(前牆橫向瞄點;boast 為前牆最終瞄點)。
 * 回傳出手速度向量(|v| = spec.speed),無解 null。
 */
export function solveShot(from: Vec3, targetX: number, kind: ShotKind, opts: SolveOptions = {}): Vec3 | null {
  const spec = SHOTS[kind];
  let best: Vec3 | null = null;
  let bestScore = Infinity;

  if (kind === 'boast') {
    // 瞄近側牆:牆面 y 掃描(擊球點往前牆方向 25%–75% 處)
    const wallX = from.x < COURT_W / 2 ? 0 : COURT_W;
    for (let wf = 0.25; wf <= 0.75; wf += 0.125) {
      const aimY = from.y * (1 - wf);
      for (const f of VZ_FRACS) {
        const v = candidateVelocity(from, wallX, aimY, spec.speed, f);
        if (v === null) continue;
        const score = checkCandidate(kind, spec, probeFlight(from, clampHitVelocity(v)), opts);
        if (score !== null && score < bestScore) {
          bestScore = score;
          best = v;
        }
      }
    }
    return best;
  }

  for (const f of VZ_FRACS) {
    const v = candidateVelocity(from, targetX, 0, spec.speed, f);
    if (v === null) continue;
    const score = checkCandidate(kind, spec, probeFlight(from, clampHitVelocity(v)), opts);
    if (score !== null && score < bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return best;
}
