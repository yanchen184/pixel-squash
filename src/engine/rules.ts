/**
 * v2 規則層:只吃 ball.ts 事件流 + 擊球事件,輸出判死原因與 PAR-11 計分。
 * 不碰物理 → L3 可表格驅動窮舉判例,不用真的模擬飛行。
 *
 * 世界壁球規則(SI,對現實可查核):
 * - 前牆 tin 0.48m、前牆 out line 4.57m、後牆 out line 2.13m,
 *   側牆 out line 由前(4.57)線性斜降到後(2.13)。天花板 = out。
 * - 發球:須直接打中前牆(先碰其他牆=fault)、高於發球線 1.78m、低於 out line;
 *   第一落點須過 short line(離前牆 5.44m)且在對角後半場;接球方截擊則免落點檢查。
 * - 回合:擊球須在(至多一彈前)打中前牆(tin 之上);對手須在第二彈前回擊。
 * - PAR-11:每回合得 1 分,先到 11 且領先 ≥2;勝者取得發球權,
 *   連續發球換格,新發球者從右格開始。
 */

import type { BallEvent, WallId } from './ball';
import { COURT_D, COURT_W } from './ball';

export const TIN_HEIGHT = 0.48; // m,前牆鐵皮上緣
export const FRONT_OUT_LINE = 4.57; // m,前牆界外線
export const BACK_OUT_LINE = 2.13; // m,後牆界外線
export const SERVICE_LINE = 1.78; // m,前牆發球線(發球須高於此)
export const SHORT_LINE_Y = 5.44; // m,short line 離前牆距離
export const HALF_COURT_X = COURT_W / 2; // m,後場左右分界

export const TARGET_SCORE = 11;
export const WIN_BY = 2;

export type PlayerId = 'A' | 'B';
export type ServeBox = 'left' | 'right';

export type DeadReason =
  | 'tin' // 前牆低於 tin
  | 'out' // 任一牆高於界外線 / 天花板
  | 'not-front-wall' // 落地前沒碰到前牆
  | 'double-bounce' // 對手沒能在第二彈前回擊(記在輸家頭上)
  | 'serve-fault-front' // 發球未直接打中前牆 / 低於發球線
  | 'serve-fault-box'; // 發球第一落點不在對角後 1/4 場

export interface RallyOutcome {
  readonly winner: PlayerId;
  readonly loser: PlayerId;
  /** 輸家輸球的原因 */
  readonly reason: DeadReason;
}

/** 單次飛行(從某次擊球到下次擊球/死球)的追蹤 */
interface FlightTrack {
  readonly striker: PlayerId;
  readonly isServe: boolean;
  readonly serveBox: ServeBox;
  readonly frontWallHit: boolean;
  /** 打中前牆之前碰過其他牆(發球 fault 判定用;回合中 boast 合法) */
  readonly wallBeforeFront: boolean;
  readonly floorBounces: number;
}

export interface MatchState {
  readonly scoreA: number;
  readonly scoreB: number;
  readonly server: PlayerId;
  readonly serveBox: ServeBox;
  readonly phase: 'awaiting-serve' | 'in-rally' | 'match-over';
  readonly flight: FlightTrack | null;
  readonly matchWinner: PlayerId | null;
  /** 最近一次回合結果(UI/測試讀) */
  readonly lastRally: RallyOutcome | null;
}

export function opponentOf(p: PlayerId): PlayerId {
  return p === 'A' ? 'B' : 'A';
}

/** 側牆界外線高度:前 4.57 → 後 2.13 線性斜降 */
export function sideWallOutHeight(y: number): number {
  const t = y / COURT_D;
  return FRONT_OUT_LINE + (BACK_OUT_LINE - FRONT_OUT_LINE) * t;
}

/** 該牆在擊中點的界外線高度 */
export function outLineHeightAt(wall: WallId, y: number): number {
  if (wall === 'front') return FRONT_OUT_LINE;
  if (wall === 'back') return BACK_OUT_LINE;
  if (wall === 'ceiling') return 0; // 碰到就是 out
  return sideWallOutHeight(y);
}

export function createMatch(firstServer: PlayerId = 'A'): MatchState {
  return {
    scoreA: 0,
    scoreB: 0,
    server: firstServer,
    serveBox: 'right',
    phase: 'awaiting-serve',
    flight: null,
    matchWinner: null,
    lastRally: null,
  };
}

/** 回合結束:PAR-11 計分 + 發球輪轉。純函數。 */
export function applyRallyResult(m: MatchState, winner: PlayerId, reason: DeadReason): MatchState {
  const loser = opponentOf(winner);
  const scoreA = m.scoreA + (winner === 'A' ? 1 : 0);
  const scoreB = m.scoreB + (winner === 'B' ? 1 : 0);
  const winScore = winner === 'A' ? scoreA : scoreB;
  const loseScore = winner === 'A' ? scoreB : scoreA;
  const over = winScore >= TARGET_SCORE && winScore - loseScore >= WIN_BY;
  // 勝者發球;保住發球權 → 換格,搶到發球權 → 從右格開始
  const serveBox: ServeBox =
    winner === m.server ? (m.serveBox === 'right' ? 'left' : 'right') : 'right';
  return {
    scoreA,
    scoreB,
    server: winner,
    serveBox,
    phase: over ? 'match-over' : 'awaiting-serve',
    flight: null,
    matchWinner: over ? winner : null,
    lastRally: { winner, loser, reason },
  };
}

/**
 * 擊球事件。發球 = phase 'awaiting-serve' 時由發球者擊出;
 * 回合中 = 對手回擊(接發截擊也走這裡,自動免落點檢查)。
 * 非法呼叫(不是你的回合)直接 throw —— 引擎接線 bug 要炸出來,不是吞掉。
 */
export function onRacketHit(m: MatchState, player: PlayerId): MatchState {
  if (m.phase === 'match-over') throw new Error('match is over');
  if (m.phase === 'awaiting-serve') {
    if (player !== m.server) throw new Error(`serve must come from ${m.server}`);
    return {
      ...m,
      phase: 'in-rally',
      flight: {
        striker: player,
        isServe: true,
        serveBox: m.serveBox,
        frontWallHit: false,
        wallBeforeFront: false,
        floorBounces: 0,
      },
    };
  }
  const f = m.flight;
  if (f === null) throw new Error('no flight in rally');
  if (player === f.striker) throw new Error('striker cannot hit twice');
  if (!f.frontWallHit) throw new Error('cannot return before ball reaches front wall');
  if (f.floorBounces > 1) throw new Error('ball already dead');
  return {
    ...m,
    flight: {
      striker: player,
      isServe: false,
      serveBox: m.serveBox,
      frontWallHit: false,
      wallBeforeFront: false,
      floorBounces: 0,
    },
  };
}

/**
 * 球事件(來自 ball.ts 事件流)。回傳新 MatchState;回合結束時已把分數/發球權轉好。
 */
export function onBallEvent(m: MatchState, ev: BallEvent): MatchState {
  if (m.phase !== 'in-rally' || m.flight === null) return m;
  const f = m.flight;
  const striker = f.striker;
  const other = opponentOf(striker);

  if (ev.type === 'wall-hit') {
    if (ev.wall === 'ceiling') return applyRallyResult(m, other, 'out');
    const limit = outLineHeightAt(ev.wall, ev.point.y);
    if (ev.point.z >= limit) return applyRallyResult(m, other, 'out');
    if (ev.wall === 'front') {
      if (f.frontWallHit) return m; // 前牆二次觸(反彈回來又碰),不改變狀態
      if (ev.point.z < TIN_HEIGHT) return applyRallyResult(m, other, 'tin');
      if (f.isServe) {
        if (f.wallBeforeFront) return applyRallyResult(m, other, 'serve-fault-front');
        if (ev.point.z < SERVICE_LINE) return applyRallyResult(m, other, 'serve-fault-front');
      }
      return { ...m, flight: { ...f, frontWallHit: true } };
    }
    // 側牆/後牆(界內):打中前牆之前碰到要記下來(發球 fault;回合 boast 合法)
    if (!f.frontWallHit) return { ...m, flight: { ...f, wallBeforeFront: true } };
    return m;
  }

  if (ev.type === 'floor-bounce') {
    if (!f.frontWallHit) {
      // 落地前沒碰前牆:發球歸發球 fault,回合歸 not-front-wall
      return applyRallyResult(m, other, f.isServe ? 'serve-fault-front' : 'not-front-wall');
    }
    const bounces = f.floorBounces + 1;
    if (bounces === 1 && f.isServe) {
      // 發球第一落點:須過 short line 且在對角後 1/4 場
      const correctHalf =
        f.serveBox === 'left' ? ev.point.x > HALF_COURT_X : ev.point.x < HALF_COURT_X;
      if (ev.point.y < SHORT_LINE_Y || !correctHalf) {
        return applyRallyResult(m, other, 'serve-fault-box');
      }
    }
    if (bounces >= 2) {
      // 對手沒能在第二彈前回擊 → 擊球者贏
      return applyRallyResult(m, striker, 'double-bounce');
    }
    return { ...m, flight: { ...f, floorBounces: bounces } };
  }

  // rest:球停了。有過前牆+至少一彈 → 對手沒回到 = double-bounce;
  // 理論上沒過前牆就 rest 會先被 floor-bounce 判掉,保險起見同判。
  if (!f.frontWallHit) {
    return applyRallyResult(m, other, f.isServe ? 'serve-fault-front' : 'not-front-wall');
  }
  return applyRallyResult(m, striker, 'double-bounce');
}
