import { describe, it, expect } from 'vitest';
import { step, stepShuttle, sampleServePath, predictLanding, type StepOpts } from '@/game/sim/simulate';
import { NO_INPUT, type InputFrame } from '@/game/input/InputSource';
import { FLOOR_FRICTION, createInitialState, type ShuttleState, type GameState } from '@/data/gameState';

/**
 * AC1：虛線(sampleServePath) 與 live 逐 tick(stepShuttle) 必須用同一份物理。
 * 同一發球，把 sampleServePath 取 sampleEvery=1（逐 tick）的點，
 * 對照 stepShuttle 逐 tick 推進的位置，逐點誤差必須 < 1px。
 */
function freshShuttle(
  pos: { x: number; y: number },
  z: number,
  vel: { x: number; y: number },
  vz: number,
  hitFrontWall = false,
  lastWall: ShuttleState['lastWall'] = null,
): ShuttleState {
  return {
    pos: { ...pos }, z, vel: { ...vel }, vz,
    inPlay: true, lastHitBy: 0, bouncesSinceWall: 0,
    hitFrontWall, lastWall, deadReason: null,
    landing: null, landingEta: 0,
  };
}

describe('AC1: dashed preview vs live trajectory coherence', () => {
  it('sampleServePath(every=1) matches stepShuttle tick-by-tick within 1px', () => {
    const start = { x: 300, y: 600 };
    const startZ = 80;
    const vel = { x: -2, y: -8 };
    const vz = 7;

    const dashed = sampleServePath(start, startZ, vel, vz, 1, FLOOR_FRICTION);

    let s = freshShuttle(start, startZ, vel, vz);
    const opts: StepOpts = { dt: 1, floorFriction: FLOOR_FRICTION };

    let maxErr = 0;
    for (let i = 1; i < Math.min(dashed.length, 60); i++) {
      s = stepShuttle(s, opts);
      const d = dashed[i];
      if (d.wall === 'tin' || d.wall === 'out' || d.wall === 'floor') break;
      const err = Math.hypot(s.pos.x - d.x, s.pos.y - d.y);
      maxErr = Math.max(maxErr, err);
    }
    expect(maxErr).toBeLessThan(1);
  });

  it('matches through a front-wall bounce within 1px', () => {
    const start = { x: 320, y: 600 }; // 場中央，避開側牆邊界
    const startZ = 90;
    const vel = { x: 0, y: -20 }; // 快速直衝前牆
    const vz = 8; // z 在 y=0 時落在 valid zone [50,480] → 記到 'front' 事件
    const dashed = sampleServePath(start, startZ, vel, vz, 1, FLOOR_FRICTION);
    const sawFrontWall = dashed.some(d => d.wall === 'front');

    // Build the live trajectory tick-by-tick. Because dashed mixes per-tick samples with
    // inserted wall-event points, we can't compare by index. Instead: every plain (non-event)
    // dashed sample must lie within 1px of SOME live tick — they share one integrator, so the
    // dashed sample points must fall exactly on the live flight path.
    const live: { x: number; y: number }[] = [];
    let s = freshShuttle(start, startZ, vel, vz);
    const opts: StepOpts = { dt: 1, floorFriction: FLOOR_FRICTION };
    for (let i = 0; i < 120; i++) {
      s = stepShuttle(s, opts);
      live.push({ x: s.pos.x, y: s.pos.y });
      if (s.deadReason != null || s.bouncesSinceWall >= 2) break;
    }

    let maxErr = Infinity;
    let checked = 0;
    for (let di = 1; di < dashed.length; di++) { // skip dashed[0]: it's the t=0 start; live begins at t=1
      const d = dashed[di];
      if (d.wall) continue; // skip labelled event points (y locked to 0/EPS)
      // nearest live tick to this dashed sample
      const nearest = Math.min(...live.map(p => Math.hypot(p.x - d.x, p.y - d.y)));
      maxErr = checked === 0 ? nearest : Math.max(maxErr, nearest);
      checked++;
    }
    expect(sawFrontWall).toBe(true);
    expect(checked).toBeGreaterThan(5); // sanity: actually compared points
    expect(maxErr).toBeLessThan(1);
  });

  it('AC2: predictLanding lands where stepShuttle actually lands (<2px)', () => {
    const base = freshShuttle({ x: 400, y: 200 }, 150, { x: 1, y: 6 }, 3, true, 'front');
    const predicted = predictLanding(base).landing!;

    // 用 stepShuttle 跑到第一次地板落點
    let s = { ...base };
    const opts: StepOpts = { dt: 1, floorFriction: FLOOR_FRICTION };
    let landed = { ...s.pos };
    for (let i = 0; i < 300; i++) {
      const prevB = s.bouncesSinceWall;
      s = stepShuttle(s, opts);
      if (s.bouncesSinceWall > prevB) { landed = { ...s.pos }; break; }
      if (s.deadReason != null) { landed = { ...s.pos }; break; }
    }
    expect(Math.hypot(predicted.x - landed.x, predicted.y - landed.y)).toBeLessThan(2);
  });

  it('AC3: live rally main-loop physics equals stepShuttle (no 5th divergent copy)', () => {
    // The live main loop integrates via stepBall→applyWalls→applyFloorBounce(rallyFloorFriction).
    // stepShuttle(dt=1, same friction) must produce the IDENTICAL ball state, otherwise the
    // dashed guide (now on stepShuttle) and the real rally would still drift apart.
    // We drive a free-flight ball (no swing input) through the real step() and compare.
    const noInput: InputFrame = NO_INPUT;
    // Build a practice rally state with a ball already in flight (no players near it).
    let gs: GameState = { ...createInitialState(), gameMode: 'practice', phase: 'rally' };
    gs = {
      ...gs,
      shuttle: {
        ...gs.shuttle,
        pos: { x: 300, y: 300 }, z: 200, vel: { x: 2, y: 4 }, vz: 2,
        inPlay: true, lastHitBy: 0, hitFrontWall: true, bouncesSinceWall: 0,
        lastWall: 'front', deadReason: null,
      },
      // park players far from the ball so resolveSwing never fires
      p1: { ...gs.p1, pos: { x: 50, y: 950 } },
      p2: { ...gs.p2, pos: { x: 600, y: 950 } },
    };

    // Mirror with stepShuttle (practice friction, matching rallyFloorFriction).
    let mirror: ShuttleState = { ...gs.shuttle };
    const opts: StepOpts = { dt: 1, floorFriction: 0.35 }; // PRACTICE_FLOOR_FRICTION

    let maxErr = 0;
    for (let i = 0; i < 30; i++) {
      gs = step(gs, noInput, noInput);
      mirror = stepShuttle(mirror, opts);
      maxErr = Math.max(maxErr, Math.hypot(gs.shuttle.pos.x - mirror.pos.x, gs.shuttle.pos.y - mirror.pos.y));
      if (gs.shuttle.deadReason != null) break;
    }
    expect(maxErr).toBeLessThan(0.001); // bit-for-bit equivalent
  });
});
