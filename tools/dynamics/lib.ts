/**
 * L4 動態感 harness 核心:bot 自對打 N 回合,收原始紀錄、算代理指標。
 * 純函數、無 fs/console → vitest 與 CLI 共用。
 */

import type { BotSkill } from '../../src/engine/bot';
import { createPrng } from '../../src/engine/prng';
import type { DeadReason, PlayerId } from '../../src/engine/rules';
import { createGame, stepGame, type Controller, type GameSim, IDLE_INPUT } from '../../src/engine/sim';
import type { ShotKind } from '../../src/engine/shot';

export interface HitRecord {
  readonly player: PlayerId;
  readonly kind: ShotKind | 'shovel';
  readonly speed: number;
}

export interface RallyRecord {
  readonly hits: readonly HitRecord[];
  readonly winner: PlayerId;
  readonly loser: PlayerId;
  readonly reason: DeadReason;
}

// 4 分鐘保險絲:抓引擎停擺用,不是回合長度上限 —— M2 頂階 bot 鏡像對打實測
// 中位數 ~13s、尾端可到 ~80s(N=100 max 4679 tick),90s 太緊會誤殺合法馬拉松回合
const MAX_TICKS_PER_RALLY = 60 * 240;

export function runRallies(
  skillA: BotSkill,
  skillB: BotSkill,
  seed: number,
  nRallies: number,
): RallyRecord[] {
  const prng = createPrng(seed);
  const controllers: { A: Controller; B: Controller } = {
    A: { type: 'bot', skill: skillA },
    B: { type: 'bot', skill: skillB },
  };
  const inputs = { A: IDLE_INPUT, B: IDLE_INPUT };
  const rallies: RallyRecord[] = [];
  let game: GameSim = createGame('A');
  let matchIndex = 0;
  let hits: HitRecord[] = [];
  let rallyStartTick = 0;

  while (rallies.length < nRallies) {
    const { sim, events } = stepGame(game, controllers, inputs, prng);
    game = sim;
    for (const ev of events) {
      if (ev.type === 'hit') {
        hits.push({ player: ev.player, kind: ev.kind, speed: ev.speed });
      } else if (ev.type === 'rally-end') {
        rallies.push({ hits, winner: ev.winner, loser: ev.loser, reason: ev.reason });
        hits = [];
        rallyStartTick = game.tick;
      } else if (ev.type === 'match-end') {
        // 換場重開(輪流先發,消除發球先手偏差);其餘事件(ball-wall/ball-floor)是音效觸發源,這裡不關心
        matchIndex += 1;
        game = createGame(matchIndex % 2 === 0 ? 'A' : 'B');
        rallyStartTick = game.tick;
      }
    }
    if (game.tick - rallyStartTick > MAX_TICKS_PER_RALLY) {
      throw new Error('rally exceeded safety fuse — engine stall?');
    }
  }
  return rallies;
}

// ---------- 代理指標 ----------

export interface DynamicsMetrics {
  readonly rallies: number;
  readonly rallyLengthMedian: number;
  readonly rallyLengthP90: number;
  readonly returnability: number; // 合法球被回擊的比例
  readonly winnerErrorRatio: { readonly winners: number; readonly errors: number };
  readonly shotUsage: Readonly<Record<string, number>>; // 使用率(0-1)
  readonly winningShotShare: Readonly<Record<string, number>>; // 制勝球佔比(0-1)
  readonly speedHistogram: readonly number[]; // 5 m/s 一桶,0–50
  readonly rallyWinRateA: number;
  readonly deadReasons: Readonly<Record<string, number>>;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computeMetrics(rallies: readonly RallyRecord[]): DynamicsMetrics {
  const lengths = rallies.map((r) => r.hits.length).sort((a, b) => a - b);
  const usage: Record<string, number> = {};
  const winShot: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  const histogram = new Array<number>(10).fill(0);
  let totalHits = 0;
  let returned = 0;
  let opportunities = 0;
  let winners = 0;
  let errors = 0;
  let winsA = 0;

  for (const r of rallies) {
    reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
    if (r.winner === 'A') winsA += 1;
    for (const h of r.hits) {
      usage[h.kind] = (usage[h.kind] ?? 0) + 1;
      totalHits += 1;
      const bucket = Math.min(9, Math.floor(h.speed / 5));
      histogram[bucket] += 1;
    }
    const h = r.hits.length;
    if (r.reason === 'double-bounce') {
      winners += 1;
      returned += h - 1;
      opportunities += h;
      const last = r.hits[h - 1];
      if (last) winShot[last.kind] = (winShot[last.kind] ?? 0) + 1;
    } else {
      errors += 1;
      returned += h - 1;
      opportunities += h - 1;
    }
  }

  const usageShare: Record<string, number> = {};
  for (const [k, v] of Object.entries(usage)) usageShare[k] = v / (totalHits || 1);
  const winShare: Record<string, number> = {};
  for (const [k, v] of Object.entries(winShot)) winShare[k] = v / (winners || 1);

  const p90 = lengths.length === 0 ? 0 : lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * 0.9))];

  return {
    rallies: rallies.length,
    rallyLengthMedian: median(lengths),
    rallyLengthP90: p90,
    returnability: opportunities === 0 ? 0 : returned / opportunities,
    winnerErrorRatio: { winners, errors },
    shotUsage: usageShare,
    winningShotShare: winShare,
    speedHistogram: histogram,
    rallyWinRateA: rallies.length === 0 ? 0 : winsA / rallies.length,
    deadReasons: reasons,
  };
}

/** L4 走廊(可測性金字塔字典) */
export interface CorridorCheck {
  readonly name: string;
  readonly value: string;
  readonly pass: boolean;
}

export function checkCorridors(
  fair: DynamicsMetrics,
  gradientStrongWinRate: number,
): CorridorCheck[] {
  const w = fair.winnerErrorRatio.winners;
  const e = fair.winnerErrorRatio.errors;
  const winnerShare = w + e === 0 ? 0 : w / (w + e);
  const overusedWin = Object.entries(fair.winningShotShare).filter(([k, v]) => k !== 'serve' && v > 0.5);
  return [
    {
      name: '回合長中位數 4–12',
      value: String(fair.rallyLengthMedian),
      pass: fair.rallyLengthMedian >= 4 && fair.rallyLengthMedian <= 12,
    },
    {
      name: '可回擊率 70–95%',
      value: (fair.returnability * 100).toFixed(1) + '%',
      pass: fair.returnability >= 0.7 && fair.returnability <= 0.95,
    },
    {
      name: '制勝:失誤佔比 winner 30–70%',
      value: (winnerShare * 100).toFixed(1) + '%',
      pass: winnerShare >= 0.3 && winnerShare <= 0.7,
    },
    {
      name: '無單招制勝 >50%(serve 除外)',
      value: overusedWin.map(([k, v]) => `${k}:${(v * 100).toFixed(0)}%`).join(',') || 'none',
      pass: overusedWin.length === 0,
    },
    {
      name: '公平性:同 bot 對打 A 勝率 50±5%',
      value: (fair.rallyWinRateA * 100).toFixed(1) + '%',
      pass: fair.rallyWinRateA >= 0.45 && fair.rallyWinRateA <= 0.55,
    },
    {
      name: '技術梯度:強 bot 對弱 bot 勝率 >70%',
      value: (gradientStrongWinRate * 100).toFixed(1) + '%',
      pass: gradientStrongWinRate > 0.7,
    },
  ];
}
