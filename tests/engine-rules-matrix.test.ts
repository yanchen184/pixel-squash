/**
 * L3 規則矩陣:表格驅動事件序列窮舉判例(每條規則至少一正一反例)
 * + 性質測試(每回合恰 +1 分、勝者≠發球者才轉發球權)
 * + 已知初速真積分打到預期 deadReason(物理×規則整合)。
 */
import { describe, expect, it } from 'vitest';
import type { BallEvent, Vec3 } from '../src/engine/ball';
import { COURT_D, createBall, stepBall } from '../src/engine/ball';
import {
  BACK_OUT_LINE,
  createMatch,
  FRONT_OUT_LINE,
  HALF_COURT_X,
  onBallEvent,
  onRacketHit,
  applyRallyResult,
  SERVICE_LINE,
  SHORT_LINE_Y,
  sideWallOutHeight,
  TIN_HEIGHT,
  type DeadReason,
  type MatchState,
  type PlayerId,
} from '../src/engine/rules';

// ---------- 事件建構 helpers(表格可讀性) ----------
const P = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const front = (z: number, x = 3.2): BallEvent => ({ type: 'wall-hit', wall: 'front', point: P(x, 0, z), speed: 20 });
const back = (z: number, x = 3.2): BallEvent => ({ type: 'wall-hit', wall: 'back', point: P(x, COURT_D, z), speed: 10 });
const side = (z: number, y: number): BallEvent => ({ type: 'wall-hit', wall: 'left', point: P(0, y, z), speed: 10 });
const ceiling = (): BallEvent => ({ type: 'wall-hit', wall: 'ceiling', point: P(3.2, 5, 5.64), speed: 10 });
const bounce = (x: number, y: number): BallEvent => ({ type: 'floor-bounce', point: P(x, y, 0), speed: 8 });
const rest = (): BallEvent => ({ type: 'rest', point: P(3, 5, 0) });

/** 好發球(右格發、落對角左後 1/4):讓回合進行下去 */
const GOOD_SERVE: BallEvent[] = [front(3.0), bounce(1.5, 8.0)];

function feed(m: MatchState, events: BallEvent[]): MatchState {
  let cur = m;
  for (const ev of events) cur = onBallEvent(cur, ev);
  return cur;
}

/** 開一場、A 發球、餵事件,回傳結果 */
function serveAndFeed(events: BallEvent[]): MatchState {
  return feed(onRacketHit(createMatch('A'), 'A'), events);
}

/** 好發球後 B 回擊,再餵事件 */
function rallyAndFeed(events: BallEvent[]): MatchState {
  const afterServe = serveAndFeed([...GOOD_SERVE]);
  return feed(onRacketHit(afterServe, 'B'), events);
}

interface Case {
  name: string;
  run: () => MatchState;
  winner: PlayerId | null; // null = 回合未結束
  reason?: DeadReason;
}

// ---------- 判例矩陣 ----------
const CASES: Case[] = [
  // 發球
  { name: '發球合法:前牆高於發球線、落對角後 1/4 → 回合繼續', run: () => serveAndFeed([...GOOD_SERVE]), winner: null },
  { name: '發球低於發球線 → 接方得分', run: () => serveAndFeed([front(SERVICE_LINE - 0.1)]), winner: 'B', reason: 'serve-fault-front' },
  { name: '發球打中 tin 之下 → 判 tin', run: () => serveAndFeed([front(TIN_HEIGHT - 0.1)]), winner: 'B', reason: 'tin' },
  { name: '發球高於前牆界外線 → out', run: () => serveAndFeed([front(FRONT_OUT_LINE + 0.1)]), winner: 'B', reason: 'out' },
  { name: '發球先碰側牆才到前牆 → fault', run: () => serveAndFeed([side(2.0, 3.0), front(3.0)]), winner: 'B', reason: 'serve-fault-front' },
  { name: '發球沒碰前牆就落地 → fault', run: () => serveAndFeed([bounce(3, 5)]), winner: 'B', reason: 'serve-fault-front' },
  { name: '發球落點未過 short line → fault', run: () => serveAndFeed([front(3.0), bounce(1.5, SHORT_LINE_Y - 0.2)]), winner: 'B', reason: 'serve-fault-box' },
  { name: '發球(右格)落到同側右後 → fault', run: () => serveAndFeed([front(3.0), bounce(HALF_COURT_X + 1, 8)]), winner: 'B', reason: 'serve-fault-box' },
  {
    name: '接發截擊:落地前回擊 → 免落點檢查,回合繼續',
    run: () => {
      const afterServe = serveAndFeed([front(3.0)]); // 還沒落地
      return onRacketHit(afterServe, 'B'); // B 截擊
    },
    winner: null,
  },
  // 回合:前牆判定
  { name: '回擊打中 tin 之下 → 對手得分', run: () => rallyAndFeed([front(TIN_HEIGHT - 0.05)]), winner: 'A', reason: 'tin' },
  { name: '回擊 tin 之上(低平球)合法 → 回合繼續', run: () => rallyAndFeed([front(TIN_HEIGHT + 0.05)]), winner: null },
  { name: '回擊高於前牆界外線 → out', run: () => rallyAndFeed([front(FRONT_OUT_LINE + 0.01)]), winner: 'A', reason: 'out' },
  { name: '回擊貼著界外線之下 → 合法', run: () => rallyAndFeed([front(FRONT_OUT_LINE - 0.01)]), winner: null },
  // 回合:側/後牆與天花板
  { name: '天花板 → out', run: () => rallyAndFeed([ceiling()]), winner: 'A', reason: 'out' },
  { name: '側牆高於斜線 → out', run: () => rallyAndFeed([side(sideWallOutHeight(5) + 0.05, 5)]), winner: 'A', reason: 'out' },
  { name: '側牆低於斜線 → 合法(boast 前段)', run: () => rallyAndFeed([side(sideWallOutHeight(5) - 0.05, 5), front(1.0)]), winner: null },
  { name: '後牆高於 2.13 → out', run: () => rallyAndFeed([back(BACK_OUT_LINE + 0.05)]), winner: 'A', reason: 'out' },
  { name: '後牆之下反彈再到前牆(back-wall boast)→ 合法', run: () => rallyAndFeed([back(BACK_OUT_LINE - 0.05), front(1.5)]), winner: null },
  // 回合:落地
  { name: '落地前沒碰前牆 → not-front-wall', run: () => rallyAndFeed([side(1.0, 5), bounce(3, 5)]), winner: 'A', reason: 'not-front-wall' },
  { name: '過前牆後兩彈 → 擊球者贏(double-bounce)', run: () => rallyAndFeed([front(1.0), bounce(3, 6), bounce(3.2, 7)]), winner: 'B', reason: 'double-bounce' },
  { name: '過前牆後一彈就滾停 → 擊球者贏', run: () => rallyAndFeed([front(1.0), bounce(3, 6), rest()]), winner: 'B', reason: 'double-bounce' },
  { name: '過前牆後一彈 → 回合繼續(對手還有機會)', run: () => rallyAndFeed([front(1.0), bounce(3, 6)]), winner: null },
];

describe('L3 規則矩陣(表格驅動)', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const m = c.run();
      if (c.winner === null) {
        expect(m.lastRally).toBeNull();
        expect(m.phase).toBe('in-rally');
      } else {
        expect(m.lastRally?.winner).toBe(c.winner);
        expect(m.lastRally?.reason).toBe(c.reason);
        expect(m.phase).toBe('awaiting-serve');
      }
    });
  }
});

describe('L3 性質:計分與發球輪轉', () => {
  it('每回合結束總分恰 +1', () => {
    for (const c of CASES) {
      const m = c.run();
      if (c.winner !== null) expect(m.scoreA + m.scoreB).toBe(1);
      else expect(m.scoreA + m.scoreB).toBe(0);
    }
  });

  it('勝者保住發球權 → 換發球格;搶到發球權 → 從右格開始', () => {
    const m0 = createMatch('A'); // A 在右格
    const kept = applyRallyResult(m0, 'A', 'double-bounce');
    expect(kept.server).toBe('A');
    expect(kept.serveBox).toBe('left');
    const kept2 = applyRallyResult(kept, 'A', 'tin');
    expect(kept2.serveBox).toBe('right');
    const lost = applyRallyResult(kept2, 'B', 'out');
    expect(lost.server).toBe('B');
    expect(lost.serveBox).toBe('right');
  });

  it('PAR-11:先到 11 領先 ≥2 即勝;10-10 要贏 2 分', () => {
    let m: MatchState = { ...createMatch('A'), scoreA: 10, scoreB: 5 };
    m = applyRallyResult(m, 'A', 'double-bounce');
    expect(m.phase).toBe('match-over');
    expect(m.matchWinner).toBe('A');

    let d: MatchState = { ...createMatch('A'), scoreA: 10, scoreB: 10 };
    d = applyRallyResult(d, 'B', 'tin'); // 10-11:未結束
    expect(d.phase).toBe('awaiting-serve');
    expect(d.matchWinner).toBeNull();
    d = { ...d, phase: 'awaiting-serve' };
    d = applyRallyResult(d, 'B', 'tin'); // 10-12:結束
    expect(d.phase).toBe('match-over');
    expect(d.matchWinner).toBe('B');
  });

  it('非法擊球會炸:發球方連打兩次 / 球死後再打', () => {
    const inRally = serveAndFeed([...GOOD_SERVE]);
    expect(() => onRacketHit(inRally, 'A')).toThrow(); // striker 連打
    const dead = rallyAndFeed([front(1.0), bounce(3, 6), bounce(3.2, 7)]);
    expect(() => onRacketHit(dead, 'A')).toThrow(); // 回合已結束(awaiting-serve 由 B 發? A 才是輸家)
  });
});

describe('L3 整合:真積分打到預期 deadReason', () => {
  function playOut(pos: Vec3, vel: Vec3, hitter: 'serve' | 'rally'): MatchState {
    let m = hitter === 'serve' ? onRacketHit(createMatch('A'), 'A') : rallyAndFeedNothing();
    let ball = createBall(pos, vel);
    for (let t = 0; t < 60 * 30 && m.phase === 'in-rally'; t++) {
      const { ball: next, events } = stepBall(ball);
      for (const ev of events) m = onBallEvent(m, ev);
      ball = next;
    }
    return m;
  }
  function rallyAndFeedNothing(): MatchState {
    const afterServe = serveAndFeed([...GOOD_SERVE]);
    return onRacketHit(afterServe, 'B');
  }

  it('平射太低 → 真的撞 tin,對手得分', () => {
    // 從後場往前牆水平打,高度 0.3m(tin 0.48 之下);40 m/s 才趕得在墜地前到牆
    const m = playOut(P(3.2, 8, 0.3), P(0, -40, 0), 'rally');
    expect(m.lastRally?.reason).toBe('tin');
    expect(m.lastRally?.winner).toBe('A');
  });

  it('往地上砸 → 沒到前牆先落地,not-front-wall', () => {
    const m = playOut(P(3.2, 5, 1.0), P(0, -3, -10), 'rally');
    expect(m.lastRally?.reason).toBe('not-front-wall');
  });

  it('合法低平回擊 → 過前牆、兩彈,擊球者贏', () => {
    const m = playOut(P(3.2, 6, 1.0), P(0, -20, 2), 'rally');
    expect(m.lastRally?.reason).toBe('double-bounce');
    expect(m.lastRally?.winner).toBe('B');
  });
});
