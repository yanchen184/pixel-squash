import { describe, it, expect } from 'vitest';
import { step } from '@/game/sim/simulate';
import { NO_INPUT, type InputFrame } from '@/game/input/InputSource';
import {
  createInitialState,
  COURT,
  NET_Y,
  STRIKE_Z,
  HITSTOP_PERFECT,
  type GameState,
  type ShuttleState,
} from '@/data/gameState';

/**
 * "Feel" mechanics: timing window, hit-stop, and the two-axis swing model (depth from
 * the move dir at contact → stroke type; timing → left/right placement). These pillars
 * live in the pure sim, so we can assert them deterministically here.
 *
 * The setup places P1 (near side) exactly on a reachable shuttle so a single swing
 * resolves a hit, and lets us pin the shuttle's height/velocity to land in a chosen
 * timing bucket.
 */
function rally(shuttleOver: Partial<ShuttleState> = {}): GameState {
  const base = createInitialState();
  const shuttle: ShuttleState = {
    pos: { x: COURT.width / 2, y: NET_Y + 100 },
    z: STRIKE_Z, // sitting at the sweet-spot height
    vel: { x: 0, y: 0 },
    vz: 0, // flat at the strike height → a swing now is perfectly timed
    lastHitBy: 1,
    inPlay: true,
    landing: null,
    landingEta: 0,
    ...shuttleOver,
  };
  return {
    ...base,
    phase: 'rally',
    phaseTimer: 0,
    p1: { ...base.p1, pos: { ...shuttle.pos }, swingCooldown: 0 },
    shuttle,
  };
}

// A human swing: an explicit stroke, with timingAim on so the sim derives left/right
// placement from the swing timing (the human mechanic). Default key = clear.
const swing: InputFrame = { ...NO_INPUT, swing: true, timingAim: true, stroke: 'clear' };

describe('timing window', () => {
  it('a swing at the sweet-spot height connects as "perfect"', () => {
    const next = step(rally(), swing, NO_INPUT);
    expect(next.p1.lastQuality).toBe('perfect');
    expect(next.shuttle.lastHitBy).toBe(0);
  });

  it('a swing on a still-rising ball connects weaker than perfect', () => {
    // Far below the strike height and rising fast → early, off-timed contact.
    const next = step(rally({ z: 20, vz: 6 }), swing, NO_INPUT);
    expect(next.p1.lastQuality).not.toBe('perfect');
  });
});

describe('hit-stop', () => {
  it('a clean (perfect) connect freezes the sim for HITSTOP_PERFECT frames', () => {
    const next = step(rally(), swing, NO_INPUT);
    expect(next.hitstop).toBe(HITSTOP_PERFECT);
  });

  it('while hit-stop is active the sim is frozen (only the frame counter ticks)', () => {
    const hit = step(rally(), swing, NO_INPUT);
    expect(hit.hitstop).toBeGreaterThan(0);
    const frozen = step(hit, NO_INPUT, NO_INPUT);
    // Frame advances, hitstop counts down, but the shuttle does NOT move.
    expect(frozen.frame).toBe(hit.frame + 1);
    expect(frozen.hitstop).toBe(hit.hitstop - 1);
    expect(frozen.shuttle.pos).toEqual(hit.shuttle.pos);
    expect(frozen.shuttle.z).toBe(hit.shuttle.z);
  });
});

describe('explicit stroke selection (J/K/L/Space) + auto-downgrade', () => {
  // The human now TAPS the stroke key directly (smash/drop/drive/clear). The sim plays
  // it as named, but downgrades an illegal stroke to a safe clear instead of whiffing.
  const smashKey: InputFrame = { ...swing, stroke: 'smash' };
  const dropKey: InputFrame = { ...swing, stroke: 'drop' };
  const driveKey: InputFrame = { ...swing, stroke: 'drive' };

  it('tapping smash on a HIGH ball plays a smash', () => {
    // High ball (above the smash gate z≥70) → the smash is legal, plays as named.
    const next = step(rally({ z: 90, vz: 0 }), smashKey, NO_INPUT);
    expect(next.p1.lastStroke).toBe('smash');
  });

  it('tapping smash on a LOW ball auto-downgrades to a clear (no whiff)', () => {
    // Ball too low to smash → falls back to clear, and the swing still CONNECTS.
    const next = step(rally({ z: STRIKE_Z, vz: 0 }), smashKey, NO_INPUT);
    expect(next.p1.lastStroke).toBe('clear');
    expect(next.p1.lastQuality).not.toBe('miss');
    expect(next.shuttle.lastHitBy).toBe(0);
  });

  it('tapping drop from NEAR the net plays a drop', () => {
    // Place P1 close to the net so drop's max-net-dist gate passes.
    const state = rally({ pos: { x: COURT.width / 2, y: NET_Y + 80 }, z: STRIKE_Z, vz: 0 });
    const near = { ...state, p1: { ...state.p1, pos: { x: COURT.width / 2, y: NET_Y + 80 } } };
    const next = step(near, dropKey, NO_INPUT);
    expect(next.p1.lastStroke).toBe('drop');
  });

  it('tapping drop from DEEP court auto-downgrades to a clear (no whiff)', () => {
    // P1 is at NET_Y+100 (≥ drop max-net-dist 200? no — 100 ≤ 200, so legal). Push
    // far back past the gate so the drop is illegal and downgrades.
    const state = rally({ z: STRIKE_Z, vz: 0 });
    const deep = { ...state, p1: { ...state.p1, pos: { x: COURT.width / 2, y: COURT.depth - 10 } }, shuttle: { ...state.shuttle, pos: { x: COURT.width / 2, y: COURT.depth - 10 } } };
    const next = step(deep, dropKey, NO_INPUT);
    expect(next.p1.lastStroke).toBe('clear');
    expect(next.p1.lastQuality).not.toBe('miss');
  });

  it('tapping drive plays a drive (no fault gate, always legal)', () => {
    const next = step(rally(), driveKey, NO_INPUT);
    expect(next.p1.lastStroke).toBe('drive');
  });

  it('tapping clear (Space) plays a clear', () => {
    const next = step(rally(), swing, NO_INPUT);
    expect(next.p1.lastStroke).toBe('clear');
  });
});

describe('faults: out of bounds (出界) + net (掛網) from mistimed swings', () => {
  // The human (timingAim) can now FAULT: a badly EARLY swing over-hits and sails the
  // shuttle past the baseline (out); a badly LATE swing under-hits into the net. Both
  // make the HITTER (side 0 here) LOSE the rally. A clean swing always stays in.
  // We hit, then run the rally out to the scored point and read the result.
  const human: InputFrame = { ...NO_INPUT, swing: true, timingAim: true, stroke: 'clear' };

  // Run from a hit frame until the point is scored (or a safety cap), returning the
  // final state so we can read the landing + score.
  function playOut(initial: GameState): GameState {
    let s = step(initial, human, NO_INPUT);
    for (let i = 0; i < 400 && s.phase !== 'point'; i++) {
      s = step(s, NO_INPUT, NO_INPUT);
    }
    return s;
  }

  it('a perfectly-timed clear lands IN — the hitter (side 0) WINS the rally', () => {
    const s = playOut(rally({ z: STRIKE_Z, vz: 0 }));
    const { x, y } = s.shuttle.pos;
    const inBounds = x >= 0 && x <= COURT.width && y >= 0 && y <= COURT.depth;
    expect(inBounds).toBe(true);
    expect(s.scores[0]).toBe(1); // side 0 scored
  });

  it('a badly EARLY swing sails OUT past the baseline — the hitter LOSES', () => {
    // Ball well above the sweet spot (still reachable) → big early dt → over-hit long.
    const s = playOut(rally({ z: STRIKE_Z + 55, vz: 0 }));
    expect(s.shuttle.pos.y).toBeLessThan(0); // past side-1's baseline (out)
    expect(s.scores[1]).toBe(1); // the opponent scores — hitter lost
  });

  it('a badly LATE swing dies in the NET on the hitter side — the hitter LOSES', () => {
    // Ball dropped below the sweet spot, descending → late dt → under-hit short.
    const s = playOut(rally({ z: STRIKE_Z - 45, vz: -3 }));
    expect(s.shuttle.pos.y).toBeGreaterThan(NET_Y); // fell back on the hitter's own half
    expect(s.scores[1]).toBe(1); // the opponent scores — hitter lost
  });
});

describe('left/right placement from swing timing', () => {
  // Early swing (ball still above the sweet spot) → ball goes LEFT; late swing (ball
  // dropped past the spot) → RIGHT; dead-on → center. We assert the landing X side.
  const centerX = COURT.width / 2;

  it('an EARLY swing places the ball LEFT of center', () => {
    // Ball still high & rising-ish above STRIKE_Z → positive dt (early).
    const next = step(rally({ z: STRIKE_Z + 40, vz: 0 }), swing, NO_INPUT);
    expect(next.shuttle.lastHitBy).toBe(0);
    expect(next.shuttle.vel.x).toBeLessThan(0); // heading left
  });

  it('a LATE swing places the ball RIGHT of center', () => {
    // Ball already dropped below STRIKE_Z, still descending → negative dt (late).
    const next = step(rally({ z: STRIKE_Z - 30, vz: -3 }), swing, NO_INPUT);
    expect(next.shuttle.lastHitBy).toBe(0);
    expect(next.shuttle.vel.x).toBeGreaterThan(0); // heading right
  });

  it('a dead-on swing places the ball roughly center', () => {
    const next = step(rally({ z: STRIKE_Z, vz: 0 }), swing, NO_INPUT);
    expect(next.shuttle.lastHitBy).toBe(0);
    // landing X near center (within a quarter-court of the middle).
    const landX = next.shuttle.landing?.x ?? centerX;
    expect(Math.abs(landX - centerX)).toBeLessThan(COURT.width * 0.25);
  });
});
