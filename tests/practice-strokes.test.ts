import { describe, it, expect } from 'vitest';
import { step } from '@/game/sim/simulate';
import { NO_INPUT, type InputFrame } from '@/game/input/InputSource';
import {
  createInitialState,
  resetForServe,
  COURT,
  STRIKE_Z,
  type GameState,
  type ShuttleState,
} from '@/data/gameState';

/**
 * Practice-mode acceptance — stroke / timing / fault-gate items (驗法 A).
 * Covers PLAN.md §8.6 #3 (four stroke types), #11 (timing quality grades),
 * #18 (boast need-angle gate), #19 (drop/kill fault gates), #21 (timing → L/R aim).
 *
 * Strategy: build a fresh practice rally, drop a reachable ball in front of the player at
 * controlled geometry/height, fire one swing, then read the resulting p1.lastStroke /
 * p1.lastQuality / shuttle launch. Pure sim → deterministic.
 */

const TOSS: InputFrame = { ...NO_INPUT, nextStop: true };

function ready(): GameState {
  const m = createInitialState();
  const p = resetForServe({ ...m, gameMode: 'practice', awaitingServeChoice: false }, 0);
  return { ...p, phaseTimer: 0 };
}

/** Toss + serve-swing → live rally. */
function rally(): GameState {
  let s = ready();
  s = step(s, TOSS, NO_INPUT);
  s = step(s, NO_INPUT, NO_INPUT);
  for (let i = 0; i < 30 && s.phase !== 'rally'; i++) {
    s = step(s, { ...NO_INPUT, swing: true, stroke: 'drive', timingAim: true }, NO_INPUT);
    if (s.phase !== 'rally') s = step(s, NO_INPUT, NO_INPUT);
  }
  expect(s.phase).toBe('rally');
  return s;
}

/**
 * Put the player at `pos` with a fresh swing window, and place a reachable ball at
 * (ballX, player.y) at height `z` rising/falling at `vz`. Clears hitstop and cooldown so
 * the very next swing connects.
 */
function primed(opts: { px: number; py: number; ballX: number; z: number; vz: number }): GameState {
  const base = rally();
  const shuttle: ShuttleState = {
    ...base.shuttle,
    inPlay: true,
    pos: { x: opts.ballX, y: opts.py },
    z: opts.z,
    vz: opts.vz,
    vel: { x: 0, y: 0 },
    lastHitBy: 1, // opponent hit it last so it's "ours" to return
    deadReason: null,
    hitFrontWall: true,
    bouncesSinceWall: 0,
    lastWall: 'front',
  };
  return {
    ...base,
    hitstop: 0,
    p1: { ...base.p1, pos: { x: opts.px, y: opts.py }, swingCooldown: 0, justHit: false, lastQuality: null, lastStroke: null },
    shuttle,
  };
}

/** Fire one timed swing of `stroke` and return the post-swing state. */
function swing(s: GameState, stroke: InputFrame['stroke']): GameState {
  return step(s, { ...NO_INPUT, swing: true, stroke, timingAim: true, aimX: 0, aimY: 0 }, NO_INPUT);
}

describe('practice acceptance — strokes / timing / faults (驗法 A)', () => {
  // #19 drop fault gate: far from front wall → drop downgrades to drive; close → stays drop.
  it('#19 drop downgrades to drive when too far from the front wall', () => {
    // distToFrontWall = pos.y (front wall at y=0). drop fault max-front-dist = 380.
    const far = swing(primed({ px: COURT.width / 2, py: 600, ballX: COURT.width / 2, z: STRIKE_Z, vz: 0 }), 'drop');
    expect(far.p1.justHit, 'swing should connect').toBe(true);
    expect(far.p1.lastStroke, 'far drop must downgrade to drive').toBe('drive');

    const near = swing(primed({ px: COURT.width / 2, py: 200, ballX: COURT.width / 2, z: STRIKE_Z, vz: 0 }), 'drop');
    expect(near.p1.lastStroke, 'a drop close to the front wall stays a drop').toBe('drop');
  });

  // #19 kill fault gate: ball too low (z<70) → kill downgrades to drive; high enough → stays kill.
  it('#19 kill downgrades to drive when the ball is too low', () => {
    const low = swing(primed({ px: COURT.width / 2, py: 300, ballX: COURT.width / 2, z: 40, vz: 0 }), 'kill');
    expect(low.p1.justHit).toBe(true);
    expect(low.p1.lastStroke, 'a low kill must downgrade to drive').toBe('drive');

    const high = swing(primed({ px: COURT.width / 2, py: 300, ballX: COURT.width / 2, z: 110, vz: 0 }), 'kill');
    expect(high.p1.lastStroke, 'a high enough kill stays a kill').toBe('kill');
  });

  // #18 boast need-angle gate: ball centred → downgrade to drive; near a side wall → stays boast.
  it('#18 boast downgrades to drive unless the ball is near a side wall', () => {
    // need-angle maxX = 220: nearSide = min(x, width-x) must be <= 220.
    const centred = swing(primed({ px: COURT.width / 2, py: 300, ballX: COURT.width / 2, z: STRIKE_Z, vz: 0 }), 'boast');
    expect(centred.p1.justHit).toBe(true);
    expect(centred.p1.lastStroke, 'a centred boast must downgrade to drive').toBe('drive');

    const sideBall = swing(primed({ px: 90, py: 300, ballX: 60, z: STRIKE_Z, vz: 0 }), 'boast');
    expect(sideBall.p1.lastStroke, 'a boast played off a side wall stays a boast').toBe('boast');
  });

  // #3 four stroke types all resolve as their own stroke under valid geometry.
  it('#3 kill / drop / drive / boast each resolve as themselves under valid geometry', () => {
    const drive = swing(primed({ px: COURT.width / 2, py: 300, ballX: COURT.width / 2, z: STRIKE_Z, vz: 0 }), 'drive');
    expect(drive.p1.lastStroke).toBe('drive');

    const kill = swing(primed({ px: COURT.width / 2, py: 300, ballX: COURT.width / 2, z: 110, vz: 0 }), 'kill');
    expect(kill.p1.lastStroke).toBe('kill');

    const drop = swing(primed({ px: COURT.width / 2, py: 200, ballX: COURT.width / 2, z: STRIKE_Z, vz: 0 }), 'drop');
    expect(drop.p1.lastStroke).toBe('drop');

    const boast = swing(primed({ px: 90, py: 300, ballX: 60, z: STRIKE_Z, vz: 0 }), 'boast');
    expect(boast.p1.lastStroke).toBe('boast');

    // each launched a live ball toward the wall
    for (const st of [drive, kill, drop, boast]) {
      expect(st.shuttle.inPlay).toBe(true);
      expect(Number.isFinite(st.shuttle.vel.x) && Number.isFinite(st.shuttle.vel.y) && Number.isFinite(st.shuttle.vz)).toBe(true);
    }
  });

  // #11 timing quality grades: a dead-on contact is perfect; a badly mistimed one is not.
  it('#11 swing timing yields perfect on a sweet-spot contact and degrades when mistimed', () => {
    // dt ≈ 0 at z == STRIKE_Z, vz == 0 → perfect.
    const onTime = swing(primed({ px: COURT.width / 2, py: 300, ballX: COURT.width / 2, z: STRIKE_Z, vz: 0 }), 'drive');
    expect(onTime.p1.lastQuality, 'sweet-spot contact should be perfect').toBe('perfect');

    // A ball still high and rising fast is contacted EARLY (over-hit) → not perfect.
    const early = swing(primed({ px: COURT.width / 2, py: 300, ballX: COURT.width / 2, z: 140, vz: 8 }), 'drive');
    expect(early.p1.lastQuality, 'an early over-hit must not grade perfect').not.toBe('perfect');
    expect(['good', 'early', 'late', 'miss']).toContain(early.p1.lastQuality);
  });

  // #10 scoring attribution (match-mode rule, shared by practice physics): a striker who
  // faults (tin/out/not-front-wall) loses the point; a ball that dies after its one legal
  // bounce gives the striker the point.
  it('#10 fault gives the point to the opponent; dead-after-bounce gives it to the striker', () => {
    const m = createInitialState(); // match mode (scoring on)
    const matchRally: GameState = { ...m, phase: 'rally', winner: null, scores: [0, 0] };

    // (a) side-0 strikes the ball into the tin → side 1 should score.
    const tinState: GameState = {
      ...matchRally,
      shuttle: {
        ...matchRally.shuttle,
        inPlay: true,
        lastHitBy: 0,
        pos: { x: COURT.width / 2, y: 6 },
        z: 10,                 // below the tin
        vel: { x: 0, y: -20 },
        vz: 0,
        deadReason: null,
        hitFrontWall: false,
        bouncesSinceWall: 0,
        lastWall: null,
      },
    };
    const afterTin = step({ ...tinState, hitstop: 0 }, NO_INPUT, NO_INPUT);
    expect(afterTin.scores[1], 'tin by side 0 → side 1 scores').toBe(1);
    expect(afterTin.scores[0]).toBe(0);

    // (b) side-0 hits a good ball that then double-bounces (opponent failed to return) →
    // side 0 should score.
    const dbState: GameState = {
      ...matchRally,
      shuttle: {
        ...matchRally.shuttle,
        inPlay: true,
        lastHitBy: 0,
        pos: { x: COURT.width / 2, y: 400 },
        z: 2,
        vz: -4,               // dropping onto the floor for its SECOND bounce
        vel: { x: 0, y: 0 },
        deadReason: null,
        hitFrontWall: true,
        bouncesSinceWall: 1,  // already took its one legal bounce
        lastWall: 'front',
      },
    };
    const afterDb = step({ ...dbState, hitstop: 0 }, NO_INPUT, NO_INPUT);
    expect(afterDb.scores[0], 'double-bounce after side-0 good shot → side 0 scores').toBe(1);
    expect(afterDb.scores[1]).toBe(0);
  });

  // #21 timing controls L/R front-wall placement: early aims left, late aims right (mirror).
  it('#21 early vs late timing steer the shot to opposite sides of the front wall', () => {
    // Build two contacts that differ only in timing sign, same lateral start (centre).
    const early = swing(primed({ px: COURT.width / 2, py: 300, ballX: COURT.width / 2, z: 150, vz: 10 }), 'drive');
    const late = swing(primed({ px: COURT.width / 2, py: 300, ballX: COURT.width / 2, z: 18, vz: -10 }), 'drive');
    // Horizontal launch velocity sign encodes which way the ball heads across the court.
    // Early and late must steer to OPPOSITE lateral directions (one vx<0, the other vx>0),
    // and neither should be exactly centred (|vx| meaningfully non-zero).
    expect(early.p1.justHit && late.p1.justHit).toBe(true);
    expect(Math.sign(early.shuttle.vel.x)).not.toBe(Math.sign(late.shuttle.vel.x));
    expect(Math.abs(early.shuttle.vel.x) + Math.abs(late.shuttle.vel.x)).toBeGreaterThan(0.5);
  });
});
