import { describe, it, expect } from 'vitest';
import { step } from '@/game/sim/simulate';
import { NO_INPUT, type InputFrame } from '@/game/input/InputSource';
import {
  createInitialState,
  COURT,
  STRIKE_Z,
  HITSTOP_PERFECT,
  type GameState,
  type ShuttleState,
} from '@/data/gameState';

/**
 * "Feel" mechanics for SQUASH: the timing window, hit-stop, explicit stroke keys with
 * fault auto-downgrade, and the timing→placement model (early raises the front-wall
 * strike point toward OUT, late drops it toward the TIN). These pillars live in the pure
 * sim, so we assert them deterministically.
 *
 * The setup parks P1 exactly on a reachable ball so a single swing resolves a hit, and
 * lets us pin the ball's height/velocity to land in a chosen timing bucket. The ball
 * sits in MID court (away from the front wall at y=0) so a clean shot has room to fly.
 */
function rally(over: Partial<ShuttleState> = {}): GameState {
  const base = createInitialState();
  const shuttle: ShuttleState = {
    pos: { x: COURT.width / 2, y: COURT.depth * 0.55 },
    z: STRIKE_Z, // sitting at the sweet-spot height
    vel: { x: 0, y: 0 },
    vz: 0, // flat at the strike height → a swing now is perfectly timed
    lastHitBy: 1,
    inPlay: true,
    bouncesSinceWall: 0,
    hitFrontWall: false,
    lastWall: null,
    deadReason: null,
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

// A human swing: explicit stroke, timingAim on so the sim derives placement/fault from
// swing timing (the human mechanic). Default key = drive (the safe rail).
const swing: InputFrame = { ...NO_INPUT, swing: true, timingAim: true, stroke: 'drive' };

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
    // Frame advances, hitstop counts down, but the ball does NOT move.
    expect(frozen.frame).toBe(hit.frame + 1);
    expect(frozen.hitstop).toBe(hit.hitstop - 1);
    expect(frozen.shuttle.pos).toEqual(hit.shuttle.pos);
    expect(frozen.shuttle.z).toBe(hit.shuttle.z);
  });
});

describe('explicit stroke selection (J/K/L/U/Space) + auto-downgrade', () => {
  // The human taps the stroke key directly (kill/drop/drive/boast/lob). The sim plays it
  // as named, but downgrades an illegal stroke to a safe drive instead of whiffing.
  const killKey: InputFrame = { ...swing, stroke: 'kill' };
  const dropKey: InputFrame = { ...swing, stroke: 'drop' };
  const driveKey: InputFrame = { ...swing, stroke: 'drive' };
  const lobKey: InputFrame = { ...swing, stroke: 'lob' };

  it('tapping kill on a HIGH ball plays a kill', () => {
    // High ball (above the kill gate min-contact-z) → the kill is legal, plays as named.
    const next = step(rally({ z: 120, vz: 0 }), killKey, NO_INPUT);
    expect(next.p1.lastStroke).toBe('kill');
  });

  it('tapping kill on a LOW ball auto-downgrades to a drive (no whiff)', () => {
    // Ball too low to kill → falls back to drive, and the swing still CONNECTS.
    const next = step(rally({ z: STRIKE_Z, vz: 0 }), killKey, NO_INPUT);
    expect(next.p1.lastStroke).toBe('drive');
    expect(next.p1.lastQuality).not.toBe('miss');
    expect(next.shuttle.lastHitBy).toBe(0);
  });

  it('tapping drop from NEAR the front wall plays a drop', () => {
    // Place P1 close to the front wall so drop's max-front-dist gate passes.
    const nearY = COURT.depth * 0.18;
    const state = rally({ pos: { x: COURT.width / 2, y: nearY }, z: STRIKE_Z, vz: 0 });
    const near: GameState = { ...state, p1: { ...state.p1, pos: { x: COURT.width / 2, y: nearY } } };
    const next = step(near, dropKey, NO_INPUT);
    expect(next.p1.lastStroke).toBe('drop');
  });

  it('tapping drop from DEEP court auto-downgrades to a drive (no whiff)', () => {
    const deepY = COURT.depth - 40;
    const state = rally({ pos: { x: COURT.width / 2, y: deepY }, z: STRIKE_Z, vz: 0 });
    const deep: GameState = { ...state, p1: { ...state.p1, pos: { x: COURT.width / 2, y: deepY } } };
    const next = step(deep, dropKey, NO_INPUT);
    expect(next.p1.lastStroke).toBe('drive');
    expect(next.p1.lastQuality).not.toBe('miss');
  });

  it('tapping drive plays a drive (no fault gate, always legal)', () => {
    const next = step(rally(), driveKey, NO_INPUT);
    expect(next.p1.lastStroke).toBe('drive');
  });

  it('tapping lob (Space) plays a lob (no fault gate)', () => {
    const next = step(rally(), lobKey, NO_INPUT);
    expect(next.p1.lastStroke).toBe('lob');
  });
});

describe('faults: tin (掛板) + out (出界) from a mistimed swing', () => {
  // A mistime raises or lowers the front-wall strike point past the legal zone. The
  // human's mistime comes from swing timing (timingAim); the AI's from an explicit
  // `faultBias` — BOTH feed the same applyTimingFault path, so we drive the fault
  // deterministically here via faultBias (timingAim off): a strong POSITIVE bias is an
  // "early" over-hit that lifts the strike point above the OUT line; a strong NEGATIVE
  // bias is a "late" under-hit that drops it below the TIN. Either way the HITTER
  // (side 0) faults and LOSES; the opponent (side 1) scores. We hit, then run the rally
  // out to the scored point and read the result.
  function playOut(initial: GameState, hit: InputFrame): GameState {
    let s = step(initial, hit, NO_INPUT);
    for (let i = 0; i < 600 && s.phase !== 'point'; i++) {
      s = step(s, NO_INPUT, NO_INPUT);
    }
    return s;
  }

  // A clean tactical swing (no mistime): explicit drive, no timing fault injected.
  const clean: InputFrame = { ...NO_INPUT, swing: true, timingAim: false, stroke: 'drive', faultBias: 0 };

  it('a clean drive lands a legal front-wall hit — the hitter (side 0) WINS', () => {
    const s = playOut(rally({ z: STRIKE_Z, vz: 0 }), clean);
    expect(s.phase).toBe('point');
    // A clean shot reaches the front wall valid zone, then double-bounces uncontested →
    // the striker (side 0) wins the rally.
    expect(s.scores[0]).toBe(1);
  });

  it('a badly EARLY over-hit sails OUT above the out line — the hitter LOSES', () => {
    // faultBias well past the timing window → the strike point lifts above
    // FRONT_OUT_HEIGHT → deadReason "out".
    const early: InputFrame = { ...clean, faultBias: 40 };
    const s = playOut(rally({ z: STRIKE_Z, vz: 0 }), early);
    expect(s.phase).toBe('point');
    expect(s.scores[1]).toBe(1); // the opponent scores — hitter faulted out
  });

  it('a badly LATE under-hit dies in the TIN — the hitter LOSES', () => {
    // Negative faultBias well past the window → the strike point drops below TIN_HEIGHT
    // → deadReason "tin".
    const late: InputFrame = { ...clean, faultBias: -40 };
    const s = playOut(rally({ z: STRIKE_Z, vz: 0 }), late);
    expect(s.phase).toBe('point');
    expect(s.scores[1]).toBe(1); // the opponent scores — hitter hit the tin
  });
});

describe('left/right placement from swing timing', () => {
  // Early swing (ball still above the sweet spot) → ball aimed LEFT on the front wall;
  // late swing (ball dropped past the spot) → RIGHT; dead-on → centre. We assert the
  // horizontal launch direction. (A modest mistime that still clears the tin/out gates.)
  it('an EARLY swing sends the ball LEFT', () => {
    const next = step(rally({ z: STRIKE_Z + 25, vz: 0 }), swing, NO_INPUT);
    expect(next.shuttle.lastHitBy).toBe(0);
    expect(next.shuttle.vel.x).toBeLessThan(0); // heading left
  });

  it('a LATE swing sends the ball RIGHT', () => {
    const next = step(rally({ z: STRIKE_Z - 18, vz: -2 }), swing, NO_INPUT);
    expect(next.shuttle.lastHitBy).toBe(0);
    expect(next.shuttle.vel.x).toBeGreaterThan(0); // heading right
  });

  it('a dead-on swing sends the ball roughly straight ahead', () => {
    const next = step(rally({ z: STRIKE_Z, vz: 0 }), swing, NO_INPUT);
    expect(next.shuttle.lastHitBy).toBe(0);
    // Centred shot: little sideways drift relative to its forward (toward-wall) speed.
    const lateral = Math.abs(next.shuttle.vel.x);
    const forward = Math.abs(next.shuttle.vel.y);
    expect(lateral).toBeLessThan(forward);
  });
});
