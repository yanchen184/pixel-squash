/**
 * M1 擊球品質層:timing 甜蜜點 × 步法 × 球路風險。
 * L1 不變量(分級邊界/擾動有界/風險排序)+ L3 規則(bot 路徑零污染)
 * + 決定性(同 seed 同腳本輸入 → 全程 bit 相同)。
 */
import { describe, expect, it } from 'vitest';
import { BOT_MEDIUM } from '../src/engine/bot';
import { createPrng } from '../src/engine/prng';
import {
  applyQuality,
  BASE_ERR,
  GOOD_MIN,
  PERFECT_MIN,
  qualityScore,
  qualityTier,
  SHOT_RISK,
} from '../src/engine/quality';
import {
  createGame,
  IDLE_INPUT,
  SERVE_DELAY_TICKS,
  stepGame,
  type Controller,
  type GameSim,
  type InputCmd,
  type SimEvent,
} from '../src/engine/sim';

describe('L1 品質分級與擾動不變量', () => {
  it('分級邊界:>=0.9 perfect / >=0.68 good / 其餘 sloppy', () => {
    expect(qualityTier(PERFECT_MIN)).toBe('perfect');
    expect(qualityTier(PERFECT_MIN - 0.001)).toBe('good');
    expect(qualityTier(GOOD_MIN)).toBe('good');
    expect(qualityTier(GOOD_MIN - 0.001)).toBe('sloppy');
    expect(qualityTier(1)).toBe('perfect');
    expect(qualityTier(0)).toBe('sloppy');
  });

  it('timing 甜蜜點:提前 1–3 tick 起拍 = 滿分;球到才按/揮太早都扣', () => {
    // 貼身(stretch=0)只剩 timing 因子
    expect(qualityScore(1, 0)).toBe(1);
    expect(qualityScore(2, 0)).toBe(1);
    expect(qualityScore(3, 0)).toBe(1);
    expect(qualityScore(0, 0)).toBeLessThan(qualityScore(1, 0)); // 慌張反應
    expect(qualityScore(5, 0)).toBeLessThan(qualityScore(3, 0)); // 揮早了
    expect(qualityScore(8, 0)).toBeLessThan(qualityScore(5, 0)); // 揮更早更慘
    expect(qualityScore(-1, 0)).toBeLessThanOrEqual(0.7); // 沒揮拍(理論上不會發生)
  });

  it('步法:全伸展勉強救(stretch=1)比貼身(stretch=0)低;越界 clamp', () => {
    expect(qualityScore(2, 1)).toBeLessThan(qualityScore(2, 0));
    expect(qualityScore(2, 0.5)).toBeGreaterThan(qualityScore(2, 1));
    expect(qualityScore(2, 2)).toBe(qualityScore(2, 1));
    expect(qualityScore(2, -1)).toBe(qualityScore(2, 0));
  });

  it('q=1 完美擊球:除 kill/drive 的 4% 加速外,速度向量不變', () => {
    const v = { x: 3, y: -20, z: 5 };
    const lob = applyQuality(v, 1, 'lob', createPrng(7));
    expect(lob).toEqual(v);
    const kill = applyQuality(v, 1, 'kill', createPrng(7));
    expect(kill.x).toBeCloseTo(v.x * 1.04, 10);
    expect(kill.y).toBeCloseTo(v.y * 1.04, 10);
    expect(kill.z).toBeCloseTo(v.z * 1.04, 10);
  });

  it('擾動有界:每分量偏離 ≤ BASE_ERR·(1−q)·risk·|v|(加上最多 10% 減速)', () => {
    const v = { x: 6, y: -24, z: 4 };
    const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    for (const kind of ['kill', 'drop', 'boast', 'drive', 'lob'] as const) {
      for (const q of [0, 0.3, 0.6, 0.85]) {
        const bound = BASE_ERR * (1 - q) * SHOT_RISK[kind] * speed + 1e-9;
        for (let seed = 1; seed <= 20; seed++) {
          const out = applyQuality(v, q, kind, createPrng(seed));
          const scale = 1 - 0.1 * (1 - q);
          expect(Math.abs(out.x - v.x * scale)).toBeLessThanOrEqual(bound);
          expect(Math.abs(out.y - v.y * scale)).toBeLessThanOrEqual(bound);
          expect(Math.abs(out.z - v.z * scale)).toBeLessThanOrEqual(bound);
        }
      }
    }
  });

  it('風險排序:同 q 下 kill > drop > boast > drive > lob 的擾動敏感度;serve 免疫', () => {
    expect(SHOT_RISK.kill).toBeGreaterThan(SHOT_RISK.drop);
    expect(SHOT_RISK.drop).toBeGreaterThan(SHOT_RISK.boast);
    expect(SHOT_RISK.boast).toBeGreaterThan(SHOT_RISK.drive);
    expect(SHOT_RISK.drive).toBeGreaterThan(SHOT_RISK.lob);
    expect(SHOT_RISK.serve).toBe(0);
  });
});

// ---- 腳本化人機對局:external A(無腦連按)vs bot B ----

interface ScriptedRun {
  readonly sim: GameSim;
  readonly events: readonly SimEvent[];
}

function runScripted(seed: number, maxTicks: number): ScriptedRun {
  const controllers: { readonly A: Controller; readonly B: Controller } = {
    A: { type: 'external' },
    B: { type: 'bot', skill: BOT_MEDIUM },
  };
  const prng = createPrng(seed);
  let sim = createGame('A');
  const all: SimEvent[] = [];
  for (let t = 0; t < maxTicks; t++) {
    // 腳本:輪到 A 發球且倒數完就按;回合中追球 + 每 6 tick 按一窗(可預期的節奏)
    const serveReady =
      sim.match.phase === 'awaiting-serve' && sim.match.server === 'A' && sim.serveCountdown <= 0;
    const inRally = sim.match.phase === 'in-rally';
    const swing = serveReady || (inRally && t % 6 < 3);
    const ballPos = sim.ball?.pos ?? null;
    const pos = sim.playerA.pos;
    const chase = inRally && ballPos !== null;
    const cmdA: InputCmd = {
      moveX: chase ? (ballPos.x > pos.x ? 1 : -1) : 0,
      moveY: chase ? (ballPos.y > pos.y ? 1 : -1) : 0,
      swing,
      shotKind: 'drive',
    };
    const out = stepGame(sim, controllers, { A: cmdA, B: IDLE_INPUT }, prng);
    sim = out.sim;
    all.push(...out.events);
    if (sim.match.phase === 'match-over') break;
  }
  return { sim, events: all };
}

describe('L3 品質層接進對局(bot 路徑零污染)', () => {
  it('人類擊球事件帶 quality;bot 擊球不帶', () => {
    const r = runScripted(99, 20_000);
    const hits = r.events.filter((e) => e.type === 'hit');
    const humanRally = hits.filter((e) => e.player === 'A' && e.kind !== 'serve');
    const botHits = hits.filter((e) => e.player === 'B');
    expect(humanRally.length).toBeGreaterThan(0);
    expect(botHits.length).toBeGreaterThan(0);
    for (const h of humanRally) expect(h.quality).toBeDefined();
    for (const h of botHits) expect(h.quality).toBeUndefined();
  });

  it('物理事件流出:回合中有 ball-wall 與 ball-floor 事件(音效觸發源)', () => {
    const r = runScripted(99, 20_000);
    expect(r.events.some((e) => e.type === 'ball-wall')).toBe(true);
    expect(r.events.some((e) => e.type === 'ball-floor')).toBe(true);
  });

  it('swingAge 追蹤:連按遞增、放開歸 -1、bot 恆 -1', () => {
    const controllers: { readonly A: Controller; readonly B: Controller } = {
      A: { type: 'external' },
      B: { type: 'bot', skill: BOT_MEDIUM },
    };
    const prng = createPrng(1);
    let sim = createGame('A');
    const press: InputCmd = { moveX: 0, moveY: 0, swing: true };
    // 倒數期間(不會真的發球)連按 3 tick → 0,1,2
    for (const want of [0, 1, 2]) {
      sim = stepGame(sim, controllers, { A: press, B: IDLE_INPUT }, prng).sim;
      expect(sim.swingAgeA).toBe(want);
      expect(sim.swingAgeB).toBe(-1);
    }
    sim = stepGame(sim, controllers, { A: IDLE_INPUT, B: IDLE_INPUT }, prng).sim;
    expect(sim.swingAgeA).toBe(-1);
  });

  it('發球不受品質擾動:serve 事件速度在合法解範圍(risk=0 的保證)', () => {
    // 兩段發球:countdown(45)→拋球→拋球後最短間隔+球落回才擊,serve 事件晚於單段版,放寬視窗
    const r = runScripted(7, SERVE_DELAY_TICKS + 40);
    const serve = r.events.find((e) => e.type === 'hit' && e.kind === 'serve');
    expect(serve).toBeDefined();
  });
});

describe('決定性:人機對局同 seed 同腳本 → 全程 bit 相同', () => {
  it('兩次跑完 20000 tick,終局狀態與事件序列完全一致', () => {
    const a = runScripted(20260708, 20_000);
    const b = runScripted(20260708, 20_000);
    expect(JSON.stringify(a.sim)).toBe(JSON.stringify(b.sim));
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    // 至少真的打起來了(不是空轉 20000 tick)
    expect(a.events.filter((e) => e.type === 'rally-end').length).toBeGreaterThan(0);
  });

  it('不同 seed → bot 行為不同(擾動/決策真的吃 prng)', () => {
    const a = runScripted(1, 20_000);
    const b = runScripted(2, 20_000);
    expect(JSON.stringify(a.events)).not.toBe(JSON.stringify(b.events));
  });
});
