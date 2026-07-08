/**
 * v2 對局協調器:ball(飛行)× rules(判分)× bot/人類輸入,固定 60Hz、純函數 step。
 * harness(L4)與正式遊戲(P5)共用同一條路徑 —— 測的就是玩的。
 */

import type { BallState, Vec3, WallId } from './ball';
import { COURT_W, createBall, DT, stepBall } from './ball';
import type { BotSkill } from './bot';
import { decideShot, interceptPoint, REACH_HEIGHT, REACH_RADIUS } from './bot';
import type { Prng } from './prng';
import type { HitQuality } from './quality';
import { applyQuality, qualityScore, qualityTier } from './quality';
import type { DeadReason, MatchState, PlayerId } from './rules';
import { createMatch, onBallEvent, onRacketHit } from './rules';
import type { ShotKind } from './shot';
import { solveShot } from './shot';

export const SERVE_DELAY_TICKS = 45; // 回合結束到下一發球的間隔(0.75s)

export type Controller =
  | { readonly type: 'bot'; readonly skill: BotSkill }
  | { readonly type: 'external' };

/** 人類玩家每 tick 輸入(bot 忽略) */
export interface InputCmd {
  readonly moveX: number; // -1..1
  readonly moveY: number; // -1..1
  readonly swing: boolean;
  readonly shotKind?: ShotKind;
  readonly targetX?: number;
}

export const IDLE_INPUT: InputCmd = { moveX: 0, moveY: 0, swing: false };

export interface PlayerSim {
  readonly pos: Vec3;
}

export interface GameSim {
  readonly ball: BallState | null;
  readonly match: MatchState;
  readonly playerA: PlayerSim;
  readonly playerB: PlayerSim;
  readonly tick: number;
  readonly lastHitTick: number;
  readonly serveCountdown: number;
  /** 揮拍窗齡:swing 連續 true 的 tick 數,-1 = 沒在揮(bot 恆 -1) */
  readonly swingAgeA: number;
  readonly swingAgeB: number;
}

export type SimEvent =
  | {
      readonly type: 'hit';
      readonly player: PlayerId;
      readonly kind: ShotKind | 'shovel';
      readonly speed: number;
      readonly point: Vec3;
      /** 人類擊球才有:timing×步法品質分級(渲染回饋用) */
      readonly quality?: HitQuality;
    }
  | { readonly type: 'rally-end'; readonly winner: PlayerId; readonly loser: PlayerId; readonly reason: DeadReason }
  | { readonly type: 'match-end'; readonly winner: PlayerId }
  | { readonly type: 'ball-wall'; readonly wall: WallId; readonly speed: number; readonly point: Vec3 }
  | { readonly type: 'ball-floor'; readonly point: Vec3 };

export interface StepOutput {
  readonly sim: GameSim;
  readonly events: readonly SimEvent[];
}

export const HUMAN_MOVE_SPEED = 4.6; // m/s

const T_POS: Vec3 = { x: COURT_W / 2, y: 5.8, z: 0 };
const CONTACT_Z = 1.0; // 發球擊球點高度

function serveBoxPos(box: 'left' | 'right'): Vec3 {
  return { x: box === 'left' ? 0.8 : COURT_W - 0.8, y: 6.24, z: 0 };
}

function receiverPos(box: 'left' | 'right'): Vec3 {
  // 站對角後 1/4 場
  return { x: box === 'left' ? COURT_W - 1.6 : 1.6, y: 8.0, z: 0 };
}

export function createGame(firstServer: PlayerId = 'A'): GameSim {
  const match = createMatch(firstServer);
  const sBox = match.serveBox;
  const server = match.server;
  return {
    ball: null,
    match,
    playerA: { pos: server === 'A' ? serveBoxPos(sBox) : receiverPos(sBox) },
    playerB: { pos: server === 'B' ? serveBoxPos(sBox) : receiverPos(sBox) },
    tick: 0,
    lastHitTick: 0,
    serveCountdown: SERVE_DELAY_TICKS,
    swingAgeA: -1,
    swingAgeB: -1,
  };
}

function horizDist(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function moveToward(pos: Vec3, target: Vec3, maxDist: number): Vec3 {
  const dx = target.x - pos.x;
  const dy = target.y - pos.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= maxDist || d < 1e-9) return { x: target.x, y: target.y, z: 0 };
  const k = maxDist / d;
  return { x: pos.x + dx * k, y: pos.y + dy * k, z: 0 };
}

function clampPos(p: Vec3): Vec3 {
  const x = p.x < 0.2 ? 0.2 : p.x > COURT_W - 0.2 ? COURT_W - 0.2 : p.x;
  const y = p.y < 0.3 ? 0.3 : p.y > 9.45 ? 9.45 : p.y;
  return { x, y, z: 0 };
}

/** 救球墊擊:解不出正經球路時往前牆中線送(可能失誤,這正是動態的一部分) */
function shovelVelocity(from: Vec3): Vec3 {
  const speed = 20;
  const vz = 4;
  const sh = Math.sqrt(speed * speed - vz * vz);
  const dx = COURT_W / 2 - from.x;
  const dy = 0 - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  return { x: (dx / len) * sh, y: (dy / len) * sh, z: vz };
}

interface HitDecision {
  readonly kind: ShotKind | 'shovel';
  readonly velocity: Vec3;
  readonly quality?: HitQuality;
}

function botHitDecision(skill: BotSkill, ballPos: Vec3, prng: Prng): HitDecision {
  const shot = decideShot(skill, ballPos, prng);
  if (shot !== null) return { kind: shot.kind, velocity: shot.velocity };
  return { kind: 'shovel', velocity: shovelVelocity(ballPos) };
}

function humanHitDecision(
  cmd: InputCmd,
  ballPos: Vec3,
  playerPos: Vec3,
  swingAge: number,
  prng: Prng,
): HitDecision {
  const kind = cmd.shotKind ?? 'drive';
  const targetX = cmd.targetX ?? (ballPos.x < COURT_W / 2 ? 1.3 : COURT_W - 1.3);
  const stretch = horizDist(playerPos, ballPos) / REACH_RADIUS;
  const q = qualityScore(swingAge, stretch);
  const quality = qualityTier(q);
  const v = solveShot(ballPos, targetX, kind);
  if (v !== null) return { kind, velocity: applyQuality(v, q, kind, prng), quality };
  // 指定球路解不出 → 退 drive → 再退 shovel
  const fallback = kind === 'drive' ? null : solveShot(ballPos, targetX, 'drive');
  if (fallback !== null) {
    return { kind: 'drive', velocity: applyQuality(fallback, q, 'drive', prng), quality };
  }
  // 墊擊本身就是勉強救球,不再疊擾動
  return { kind: 'shovel', velocity: shovelVelocity(ballPos), quality };
}

/** 這 tick 該回擊的人(規則允許的唯一揮拍者);發球階段回 server */
function returnerOf(match: MatchState): PlayerId | null {
  if (match.phase === 'awaiting-serve') return match.server;
  if (match.phase !== 'in-rally' || match.flight === null) return null;
  if (!match.flight.frontWallHit || match.flight.floorBounces > 1) return null;
  return match.flight.striker === 'A' ? 'B' : 'A';
}

/**
 * 前進一個 tick。inputs 只對 external controller 有效。
 * prng 是可變物件(唯一例外):呼叫序固定 → 決定性不破。
 */
export function stepGame(
  sim: GameSim,
  controllers: { readonly A: Controller; readonly B: Controller },
  inputs: { readonly A: InputCmd; readonly B: InputCmd },
  prng: Prng,
): StepOutput {
  if (sim.match.phase === 'match-over') return { sim, events: [] };
  const events: SimEvent[] = [];
  const tick = sim.tick + 1;

  let match = sim.match;
  let ball = sim.ball;
  let posA = sim.playerA.pos;
  let posB = sim.playerB.pos;
  let lastHitTick = sim.lastHitTick;
  let serveCountdown = sim.serveCountdown;

  // 揮拍窗齡:external 且 swing=true 才累加(接觸瞬間讀「按下後已過幾 tick」);bot 恆 -1
  const swingAgeA =
    controllers.A.type === 'external' && inputs.A.swing
      ? sim.swingAgeA < 0
        ? 0
        : sim.swingAgeA + 1
      : -1;
  const swingAgeB =
    controllers.B.type === 'external' && inputs.B.swing
      ? sim.swingAgeB < 0
        ? 0
        : sim.swingAgeB + 1
      : -1;

  // ---- 發球階段 ----
  if (match.phase === 'awaiting-serve') {
    const server = match.server;
    const box = match.serveBox;
    // 就位(瞬移:回合間走位不參與動態)
    posA = server === 'A' ? serveBoxPos(box) : receiverPos(box);
    posB = server === 'B' ? serveBoxPos(box) : receiverPos(box);
    const ctrl = controllers[server];
    const ready = serveCountdown <= 0;
    const wantServe = ctrl.type === 'bot' ? ready : inputs[server].swing;
    if (wantServe && (ctrl.type === 'bot' || ready)) {
      const from: Vec3 = { ...serveBoxPos(box), z: CONTACT_Z };
      const targetX = box === 'left' ? COURT_W - 1.6 : 1.6;
      const requireLandHalf = box === 'left' ? 'right' : 'left';
      const v =
        solveShot(from, targetX, 'serve', { requireLandHalf }) ?? shovelVelocity(from);
      match = onRacketHit(match, server);
      ball = createBall(from, v);
      lastHitTick = tick;
      const sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      events.push({ type: 'hit', player: server, kind: 'serve', speed: sp, point: from });
    } else {
      serveCountdown -= 1;
    }
    return {
      sim: {
        ball,
        match,
        playerA: { pos: posA },
        playerB: { pos: posB },
        tick,
        lastHitTick,
        serveCountdown,
        swingAgeA,
        swingAgeB,
      },
      events,
    };
  }

  // ---- 回合中:先物理,再餵規則 ----
  if (ball !== null) {
    const { ball: nextBall, events: ballEvents } = stepBall(ball);
    ball = nextBall;
    for (const ev of ballEvents) {
      // 渲染/音效事件:無論規則層是否已收束都發(拍到牆/地的聲音是物理事實)
      if (ev.type === 'wall-hit') {
        events.push({ type: 'ball-wall', wall: ev.wall, speed: ev.speed, point: ev.point });
      } else if (ev.type === 'floor-bounce') {
        events.push({ type: 'ball-floor', point: ev.point });
      }
      if (match.phase !== 'in-rally') continue;
      match = onBallEvent(match, ev);
    }
    if (match.lastRally !== null && match.phase !== 'in-rally') {
      const r = match.lastRally;
      events.push({ type: 'rally-end', winner: r.winner, loser: r.loser, reason: r.reason });
      if (match.phase === 'match-over' && match.matchWinner !== null) {
        events.push({ type: 'match-end', winner: match.matchWinner });
      }
      return {
        sim: {
          ball: null,
          match,
          playerA: { pos: posA },
          playerB: { pos: posB },
          tick,
          lastHitTick,
          serveCountdown: SERVE_DELAY_TICKS,
          swingAgeA,
          swingAgeB,
        },
        events,
      };
    }
  }

  // ---- 移動 + 回擊 ----
  const returner = returnerOf(match);
  for (const id of ['A', 'B'] as const) {
    const ctrl = controllers[id];
    const pos = id === 'A' ? posA : posB;
    let next = pos;
    if (ctrl.type === 'external') {
      const cmd = inputs[id];
      const dx = cmd.moveX;
      const dy = cmd.moveY;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 1e-6) {
        const k = (HUMAN_MOVE_SPEED * DT) / (len > 1 ? len : 1);
        next = clampPos({ x: pos.x + dx * k, y: pos.y + dy * k, z: 0 });
      }
    } else {
      const skill = ctrl.skill;
      const home = skill.home === undefined ? T_POS : skill.home; // 站位個性
      const reacted = tick - lastHitTick >= skill.reactionTicks;
      if (id === returner && ball !== null && reacted) {
        const target = interceptPoint(ball) ?? home;
        next = clampPos(moveToward(pos, target, skill.moveSpeed * DT));
      } else if (id !== returner) {
        next = clampPos(moveToward(pos, home, skill.moveSpeed * DT));
      }
    }
    if (id === 'A') posA = next;
    else posB = next;
  }

  // 回擊判定(每 tick 至多一人揮拍;returner 唯一)
  if (returner !== null && ball !== null && match.phase === 'in-rally') {
    const ctrl = controllers[returner];
    const pos = returner === 'A' ? posA : posB;
    const inReach = horizDist(pos, ball.pos) <= REACH_RADIUS && ball.pos.z <= REACH_HEIGHT;
    const wants = ctrl.type === 'bot' ? true : inputs[returner].swing;
    const reacted =
      ctrl.type === 'bot' ? tick - lastHitTick >= ctrl.skill.reactionTicks : true;
    if (inReach && wants && reacted) {
      const decision =
        ctrl.type === 'bot'
          ? botHitDecision(ctrl.skill, ball.pos, prng)
          : humanHitDecision(
              inputs[returner],
              ball.pos,
              pos,
              returner === 'A' ? swingAgeA : swingAgeB,
              prng,
            );
      match = onRacketHit(match, returner);
      const from = ball.pos;
      ball = createBall(from, decision.velocity);
      lastHitTick = tick;
      const v = decision.velocity;
      const sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      events.push({
        type: 'hit',
        player: returner,
        kind: decision.kind,
        speed: sp,
        point: from,
        quality: decision.quality,
      });
    }
  }

  return {
    sim: {
      ball,
      match,
      playerA: { pos: posA },
      playerB: { pos: posB },
      tick,
      lastHitTick,
      serveCountdown,
      swingAgeA,
      swingAgeB,
    },
    events,
  };
}
