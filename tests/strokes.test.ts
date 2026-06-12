import { describe, it, expect } from 'vitest';
import { step } from '@/game/sim/simulate';
import { NO_INPUT, type InputFrame } from '@/game/input/InputSource';
import {
  createInitialState,
  COURT,
  NET_Y,
  type GameState,
  type ShuttleState,
} from '@/data/gameState';
import { STROKES, type StrokeId } from '@/data/strokes';

/**
 * Build a live rally state where P1 (near side) stands right next to a reachable
 * shuttle, so a single `step` with a swing input resolves a hit. Lets us assert
 * each stroke shapes the shuttle differently and that fault gates misfire.
 */
function rallyWithReachableShuttle(over: Partial<ShuttleState> = {}): GameState {
  const base = createInitialState();
  const shuttle: ShuttleState = {
    pos: { x: COURT.width / 2, y: NET_Y + 100 }, // near (P1) half
    z: 100,
    vel: { x: 0, y: 0 },
    vz: 0,
    lastHitBy: 1,
    inPlay: true,
    landing: null,
    landingEta: 0,
    ...over,
  };
  return {
    ...base,
    phase: 'rally',
    phaseTimer: 0,
    p1: { ...base.p1, pos: { ...shuttle.pos }, swingCooldown: 0 },
    shuttle,
  };
}

function swingWith(stroke: StrokeId): InputFrame {
  return { ...NO_INPUT, swing: true, stroke };
}

describe('stroke differentiation', () => {
  it('each stroke launches with a distinct SPEED — the smash is fastest, the drop slowest', () => {
    // Speed (horizontal launch px/tick) is now the headline difference between strokes:
    // a smash rockets, a drop barely creeps. (Apex is capped by APEX_CEIL so it's no
    // longer the distinguishing axis — pace + speed + landing are.)
    const spd = new Map<StrokeId, number>();
    for (const id of ['clear', 'smash', 'drop', 'drive'] as StrokeId[]) {
      const next = step(rallyWithReachableShuttle(), swingWith(id), NO_INPUT);
      expect(next.shuttle.lastHitBy).toBe(0); // P1 connected
      spd.set(id, Math.hypot(next.shuttle.vel.x, next.shuttle.vel.y));
    }
    // Smash is the fastest of the four; the drop is the slowest — opposite tempos.
    expect(spd.get('smash')!).toBeGreaterThan(spd.get('drive')!);
    expect(spd.get('smash')!).toBeGreaterThan(spd.get('clear')!);
    expect(spd.get('drop')!).toBeLessThan(spd.get('clear')!);
    expect(spd.get('drop')!).toBeLessThan(spd.get('drive')!);
  });

  it('smash flies flatter and reaches the receiver in less time than a clear', () => {
    // A smash is lethal because of its flat, fast arc — a low apex (small up-velocity)
    // and a short time-of-flight that gives the receiver less time to react. That is
    // the real "kill", not raw floor px/tick (a deep clear can cover more ground). We
    // forward-integrate each launch to the floor and compare descent characteristics.
    const flightTime = (id: StrokeId): { vz: number; ticks: number } => {
      const next = step(rallyWithReachableShuttle(), swingWith(id), NO_INPUT);
      const s = next.shuttle;
      // Reuse the sim's own landing prediction (drag + gravity) for an honest ETA.
      return { vz: s.vz, ticks: s.landingEta };
    };
    const smash = flightTime('smash');
    const clear = flightTime('clear');
    // Flatter: a smash launches with a smaller upward velocity than a floaty clear.
    expect(smash.vz).toBeLessThan(clear.vz);
    // Faster to arrive: less hang time → the receiver gets less reaction window.
    expect(smash.ticks).toBeLessThan(clear.ticks);
  });

  it('smash misfires on a low ball (fault gate min-contact-z)', () => {
    const smashFault = STROKES.smash.fault;
    const lowZ = smashFault?.kind === 'min-contact-z' ? smashFault.z - 20 : 0;
    const s = rallyWithReachableShuttle({ z: lowZ });
    const next = step(s, swingWith('smash'), NO_INPUT);
    // Misfire: shuttle dribbles down on the hitter's own side (negative vz, no drive).
    expect(next.shuttle.vz).toBeLessThan(0);
    expect(Math.hypot(next.shuttle.vel.x, next.shuttle.vel.y)).toBe(0);
  });

  it('drop misfires when played from deep court (fault gate max-net-dist)', () => {
    const dropFault = STROKES.drop.fault!;
    const farY = dropFault.kind === 'max-net-dist'
      ? NET_Y + dropFault.dist + 60 // deeper than the drop's allowed net distance
      : COURT.depth - 30;
    const s = rallyWithReachableShuttle({ pos: { x: COURT.width / 2, y: farY }, z: 100 });
    const stateWithDeepPlayer: GameState = {
      ...s,
      p1: { ...s.p1, pos: { x: COURT.width / 2, y: farY } },
    };
    const next = step(stateWithDeepPlayer, swingWith('drop'), NO_INPUT);
    expect(next.shuttle.vz).toBeLessThan(0); // misfired into the tape
  });

  it('a plain clear (default stroke) still produces a valid returnable arc', () => {
    const next = step(rallyWithReachableShuttle(), swingWith('clear'), NO_INPUT);
    expect(next.shuttle.vz).toBeGreaterThan(0); // launched upward
    expect(next.shuttle.inPlay).toBe(true);
  });
});
