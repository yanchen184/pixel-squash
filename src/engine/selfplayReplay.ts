/**
 * v2 自對打重播錄製:seed + bot 等級 = 完整重播檔(決定性引擎保證同輸入逐 tick 相同)。
 * 重播檢視器(render3d)與黃金重播 blessing 測試(L5)共用這一條路徑。
 *
 * 本檔在 src/engine/:只准 +−×÷√ / Math.imul(lint 把關),隨機只走 prng。
 */
import type { Vec3 } from './ball';
import type { BotSkill } from './bot';
import { createPrng } from './prng';
import { hashBall, hashNumbers } from './replay';
import type { DeadReason, PlayerId } from './rules';
import { createGame, IDLE_INPUT, stepGame, type Controller } from './sim';

/** 一個 tick 的重播切面(渲染層只讀這個) */
export interface ReplayFrame {
  readonly ball: Vec3 | null;
  readonly playerA: Vec3;
  readonly playerB: Vec3;
  readonly scoreA: number;
  readonly scoreB: number;
  /** 這 tick 有人揮拍(渲染層觸發揮拍動畫) */
  readonly hitBy: PlayerId | null;
  readonly rallyEnd: { readonly winner: PlayerId; readonly reason: DeadReason } | null;
  readonly matchWinner: PlayerId | null;
}

export interface SelfplayReplay {
  readonly seed: number;
  readonly frames: readonly ReplayFrame[];
  /** 球 + 兩球員位置的逐 tick 鏈式 hash 最終值(blessing 的凍結對象) */
  readonly finalHash: number;
}

const MAX_TICKS = 60 * 60 * 5; // 5 分鐘保險絲

/** 跑 bot 自對打直到打完 ralliesTarget 回合(或比賽結束),錄每 tick */
export function recordSelfplay(
  seed: number,
  skillA: BotSkill,
  skillB: BotSkill,
  ralliesTarget: number,
): SelfplayReplay {
  const prng = createPrng(seed);
  const controllers: { readonly A: Controller; readonly B: Controller } = {
    A: { type: 'bot', skill: skillA },
    B: { type: 'bot', skill: skillB },
  };
  const inputs = { A: IDLE_INPUT, B: IDLE_INPUT } as const;
  let sim = createGame('A');
  const frames: ReplayFrame[] = [];
  let hash = 0x811c9dc5;
  let rallies = 0;

  for (let t = 0; t < MAX_TICKS && rallies < ralliesTarget; t++) {
    const out = stepGame(sim, controllers, inputs, prng);
    sim = out.sim;
    if (sim.ball !== null) hash = hashBall(sim.ball, hash);
    hash = hashNumbers(
      [sim.playerA.pos.x, sim.playerA.pos.y, sim.playerB.pos.x, sim.playerB.pos.y],
      hash,
    );
    let hitBy: PlayerId | null = null;
    let rallyEnd: ReplayFrame['rallyEnd'] = null;
    for (const ev of out.events) {
      if (ev.type === 'hit') hitBy = ev.player;
      else if (ev.type === 'rally-end') {
        rallies += 1;
        rallyEnd = { winner: ev.winner, reason: ev.reason };
      } else if (ev.type === 'match-end') {
        rallies = ralliesTarget;
      }
    }
    frames.push({
      ball: sim.ball === null ? null : { ...sim.ball.pos },
      playerA: sim.playerA.pos,
      playerB: sim.playerB.pos,
      scoreA: sim.match.scoreA,
      scoreB: sim.match.scoreB,
      hitBy,
      rallyEnd,
      matchWinner: sim.match.matchWinner,
    });
    if (sim.match.phase === 'match-over') break;
  }
  return { seed, frames, finalHash: hash >>> 0 };
}
