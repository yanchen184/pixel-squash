import { describe, it, expect } from 'vitest';
import { stepShuttle, sampleServePath, type StepOpts } from '@/game/sim/simulate';
import { FLOOR_FRICTION, type ShuttleState } from '@/data/gameState';

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
});
