/**
 * P2 驗收:擊球層解算性質 + bot/sim 決定性 + 自對打煙霧測試。
 * (L4 走廊全綠是 P5 的完成定義;這裡鎖「基建可跑且決定性」。)
 */
import { describe, expect, it } from 'vitest';
import { createBall, predictLanding, stepBall, type Vec3 } from '../src/engine/ball';
import { BOT_MEDIUM } from '../src/engine/bot';
import { createMatch, onBallEvent, onRacketHit } from '../src/engine/rules';
import { SHOTS, solveShot, type ShotKind } from '../src/engine/shot';
import { computeMetrics, runRallies } from '../tools/dynamics/lib';

const speedOf = (v: Vec3) => Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);

describe('shot 解算層', () => {
  const FROM: Vec3 = { x: 3.2, y: 7.5, z: 0.9 }; // 後場中路,典型擊球點

  const KINDS: ShotKind[] = ['drive', 'kill', 'drop', 'lob', 'boast'];
  for (const kind of KINDS) {
    it(`${kind}:後場中路有解,|v| = 規格速度`, () => {
      const v = solveShot(FROM, kind === 'boast' ? 3.2 : 1.3, kind);
      expect(v).not.toBeNull();
      expect(speedOf(v!)).toBeCloseTo(SHOTS[kind].speed, 6);
    });
  }

  it('解是決定性的:同輸入兩次解 bit 相同', () => {
    const a = solveShot(FROM, 1.3, 'drive');
    const b = solveShot(FROM, 1.3, 'drive');
    expect(a).toEqual(b);
  });

  it('解出的 drive 真的落在規格縱深帶', () => {
    const v = solveShot(FROM, 1.3, 'drive')!;
    const landing = predictLanding(createBall(FROM, v));
    expect(landing).not.toBeNull();
    expect(landing!.point.y).toBeGreaterThanOrEqual(SHOTS.drive.landMinY);
    expect(landing!.point.y).toBeLessThanOrEqual(SHOTS.drive.landMaxY);
  });

  it('發球解通過規則層(不 fault):右格發、落對角左後 1/4', () => {
    const from: Vec3 = { x: 5.6, y: 6.24, z: 1.0 };
    const v = solveShot(from, 1.6, 'serve', { requireLandHalf: 'left' });
    expect(v).not.toBeNull();
    // 真積分餵規則層:落地後回合必須還活著(無 serve fault)
    let m = onRacketHit(createMatch('A'), 'A');
    let ball = createBall(from, v!);
    let bounced = false;
    for (let t = 0; t < 60 * 10 && !bounced; t++) {
      const { ball: next, events } = stepBall(ball);
      for (const ev of events) {
        m = onBallEvent(m, ev);
        if (ev.type === 'floor-bounce') bounced = true;
      }
      ball = next;
    }
    expect(bounced).toBe(true);
    expect(m.phase).toBe('in-rally'); // fault 會直接結束回合
    expect(m.lastRally).toBeNull();
  });
});

describe('bot 自對打(L4 基建)', () => {
  it('決定性:同種子兩次自對打,逐回合紀錄完全相同', () => {
    const a = runRallies(BOT_MEDIUM, BOT_MEDIUM, 42, 8);
    const b = runRallies(BOT_MEDIUM, BOT_MEDIUM, 42, 8);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('煙霧:30 回合能打完,每回合有勝者、至少 1 擊,指標可計算', () => {
    const rallies = runRallies(BOT_MEDIUM, BOT_MEDIUM, 7, 30);
    expect(rallies).toHaveLength(30);
    for (const r of rallies) {
      expect(r.hits.length).toBeGreaterThanOrEqual(1);
      expect(['A', 'B']).toContain(r.winner);
    }
    const m = computeMetrics(rallies);
    expect(m.rallies).toBe(30);
    expect(m.rallyLengthMedian).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(m.returnability)).toBe(true);
  });
});
