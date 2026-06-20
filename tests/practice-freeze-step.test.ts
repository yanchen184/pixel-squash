import { describe, it, expect } from 'vitest';
import { step } from '@/game/sim/simulate';
import { NO_INPUT, type InputFrame } from '@/game/input/InputSource';
import {
  createInitialState,
  resetForServe,
  COURT,
  SWING_REACH_Z,
  type GameState,
  type ShuttleState,
} from '@/data/gameState';

/**
 * Practice-mode M freeze-step — TEST AID for PLAN.md §8.6 #17 (驗法 A).
 *
 * Bob's intent: during a LIVE rally, pressing M (nextStop edge) freezes the ball so the tester
 * can read the predicted landing marker, walk the character to it, then swing successfully.
 * It must COEXIST with free rally — default OFF, and have NO effect outside practice mode.
 *
 * These drive the pure sim directly and assert on state (hard pass/fail per 驗收紀律).
 */

const TOSS: InputFrame = { ...NO_INPUT, nextStop: true };
const M: InputFrame = { ...NO_INPUT, nextStop: true };

function practiceServeReady(): GameState {
  const match = createInitialState();
  const practice = resetForServe({ ...match, gameMode: 'practice', awaitingServeChoice: false }, 0);
  return { ...practice, phaseTimer: 0 };
}

/** Toss + serve-swing into a live rally. */
function launchRally(): GameState {
  let s = practiceServeReady();
  s = step(s, TOSS, NO_INPUT);
  s = step(s, NO_INPUT, NO_INPUT);
  for (let i = 0; i < 30 && s.phase !== 'rally'; i++) {
    s = step(s, { ...NO_INPUT, swing: true, stroke: 'drive', timingAim: true }, NO_INPUT);
    if (s.phase !== 'rally') s = step(s, NO_INPUT, NO_INPUT);
  }
  expect(s.phase, 'serve swing should launch a rally').toBe('rally');
  return s;
}

/** A live rally with the ball airborne mid-flight (so freezing it is meaningful). */
function liveRally(): GameState {
  let s = launchRally();
  // Advance a few ticks so the ball is genuinely in flight (not at the contact point).
  for (let i = 0; i < 5; i++) s = step(s, NO_INPUT, NO_INPUT);
  expect(s.phase).toBe('rally');
  expect(s.shuttle.inPlay).toBe(true);
  expect(s.rallyFrozen).toBe(false); // default OFF — free rally preserved
  return s;
}

describe('practice freeze-step — M test aid (驗法 A, #17)', () => {
  it('starts a live rally UNFROZEN (free rally is the default)', () => {
    const s = liveRally();
    expect(s.rallyFrozen).toBe(false);
  });

  it('an M edge during a live rally FREEZES the ball, and it stays put for many ticks', () => {
    let s = liveRally();
    const before = { ...s.shuttle.pos, z: s.shuttle.z };

    s = step(s, M, NO_INPUT); // M edge → freeze
    expect(s.rallyFrozen, 'M should freeze the rally').toBe(true);

    // Hold M released; the frozen ball must not move or die across a long pause while the
    // tester walks to the landing spot.
    let maxDrift = 0;
    for (let i = 0; i < 120; i++) {
      s = step(s, NO_INPUT, NO_INPUT);
      expect(s.rallyFrozen, `still frozen at tick ${i}`).toBe(true);
      expect(s.phase, 'frozen ball must not die into a serve reset').toBe('rally');
      const drift = Math.hypot(s.shuttle.pos.x - before.x, s.shuttle.pos.y - before.y) + Math.abs(s.shuttle.z - before.z);
      maxDrift = Math.max(maxDrift, drift);
    }
    expect(maxDrift, 'frozen ball should be held still').toBeLessThan(1e-6);
  });

  it('frozen ball exposes a landing marker so the tester knows where to stand', () => {
    let s = liveRally();
    s = step(s, M, NO_INPUT);
    expect(s.rallyFrozen).toBe(true);
    expect(s.shuttle.landing, 'frozen ball must predict a landing spot').not.toBeNull();
  });

  it('a second M edge UNFREEZES and normal physics resume (ball flies again)', () => {
    let s = liveRally();
    s = step(s, M, NO_INPUT);            // freeze
    expect(s.rallyFrozen).toBe(true);
    const frozenPos = { ...s.shuttle.pos, z: s.shuttle.z };
    for (let i = 0; i < 30; i++) s = step(s, NO_INPUT, NO_INPUT); // sit frozen a while

    s = step(s, M, NO_INPUT);            // second M edge → unfreeze
    expect(s.rallyFrozen, 'second M should lift the freeze').toBe(false);

    // Now the ball must actually move under physics again.
    let moved = false;
    for (let i = 0; i < 20 && s.phase === 'rally'; i++) {
      s = step(s, NO_INPUT, NO_INPUT);
      if (Math.hypot(s.shuttle.pos.x - frozenPos.x, s.shuttle.pos.y - frozenPos.y) + Math.abs(s.shuttle.z - frozenPos.z) > 1) {
        moved = true;
        break;
      }
    }
    expect(moved, 'after unfreeze the ball flies again').toBe(true);
  });

  it('swinging on a frozen ball connects, relaunches it, and lifts the freeze', () => {
    // Place a reachable frozen ball right in front of the player, then swing.
    let s = launchRally();
    const shuttle: ShuttleState = {
      ...s.shuttle,
      inPlay: true,
      pos: { x: s.p1.pos.x, y: s.p1.pos.y },
      z: 55,
      vz: 0,
      vel: { x: 0, y: 0 },
      lastHitBy: 1, // opponent's ball → ours to return
      deadReason: null,
      hitFrontWall: true,
      bouncesSinceWall: 0,
      lastWall: 'front',
    };
    s = { ...s, hitstop: 0, rallyFrozen: true, p1: { ...s.p1, swingCooldown: 0, justHit: false }, shuttle };
    expect(s.rallyFrozen).toBe(true);

    const after = step(s, { ...NO_INPUT, swing: true, stroke: 'drive', timingAim: true, aimX: 0, aimY: 0 }, NO_INPUT);
    expect(after.p1.justHit, 'swing on the frozen ball should connect').toBe(true);
    expect(after.rallyFrozen, 'a connecting swing lifts the freeze so the rally resumes live').toBe(false);
    expect(after.shuttle.inPlay).toBe(true);
  });

  it('match mode IGNORES M — no freeze, free play unaffected outside practice', () => {
    const m = createInitialState();
    const matchRally: GameState = {
      ...m,
      phase: 'rally',
      winner: null,
      scores: [0, 0],
      rallyFrozen: false,
      shuttle: {
        ...m.shuttle,
        inPlay: true,
        pos: { x: COURT.width / 2, y: 300 },
        z: 120,
        vz: 4,
        vel: { x: 0, y: -6 },
        lastHitBy: 1,
        deadReason: null,
        hitFrontWall: true,
        bouncesSinceWall: 0,
        lastWall: 'front',
      },
    };
    const after = step({ ...matchRally, hitstop: 0 }, M, NO_INPUT);
    expect(after.rallyFrozen, 'M must not freeze a match-mode rally').toBe(false);
    // And the ball kept flying (match physics ran).
    expect(after.shuttle.z !== 120 || after.shuttle.pos.y !== 300).toBe(true);
  });

  it('a swing key alone (no M) does not freeze — free rally stays the default', () => {
    let s = liveRally();
    // The ball is far/high, so this swing misses; the point is M wasn't pressed → no freeze.
    void SWING_REACH_Z;
    s = step(s, { ...NO_INPUT, swing: true, stroke: 'drive', timingAim: true }, NO_INPUT);
    expect(s.rallyFrozen).toBe(false);
  });
});
