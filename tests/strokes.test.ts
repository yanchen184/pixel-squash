import { describe, it, expect } from 'vitest';
import { step } from '@/game/sim/simulate';
import { NO_INPUT, type InputFrame } from '@/game/input/InputSource';
import {
  createInitialState,
  COURT,
  type GameState,
  type ShuttleState,
} from '@/data/gameState';
import { STROKES, type StrokeId } from '@/data/strokes';

/**
 * Build a live rally state where P1 stands right next to a reachable ball, so a single
 * `step` with a swing input resolves a hit. Lets us assert each stroke shapes the ball
 * differently and that the squash fault gates (min-contact-z / max-front-dist /
 * need-angle) misfire when their condition isn't met.
 *
 * The ball is placed in MID court (y away from the front wall at y=0) so most strokes
 * are legal; individual tests override pos/z to probe a gate.
 */
function rallyWithReachableBall(over: Partial<ShuttleState> = {}): GameState {
  const base = createInitialState();
  const shuttle: ShuttleState = {
    pos: { x: COURT.width / 2, y: COURT.depth * 0.55 },
    z: 100,
    vel: { x: 0, y: 0 },
    vz: 0,
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

/** A human swing of a named stroke. timingAim off → no synthetic timing, plays as named. */
function swingWith(stroke: StrokeId): InputFrame {
  return { ...NO_INPUT, swing: true, stroke };
}

describe('stroke table', () => {
  it('defines the six squash strokes with sane bands', () => {
    const ids: StrokeId[] = ['drive', 'boast', 'lob', 'drop', 'kill', 'serve'];
    for (const id of ids) {
      const p = STROKES[id];
      expect(p, `stroke ${id} exists`).toBeTruthy();
      expect(p.tof[0]).toBeLessThanOrEqual(p.tof[1]); // valid time-of-flight band
      expect(p.pace).toBeGreaterThan(0);
    }
    // The kill is aimed at the tin line; the lob floats high.
    expect(STROKES.kill.aim).toBe('tin');
    expect(STROKES.lob.aim).toBe('high');
  });
});

describe('stroke differentiation', () => {
  it('each stroke connects and aims at a distinct front-wall height', () => {
    // kill (just above the tin) launches FLATTER than a lob (high on the wall): a kill's
    // launch vz is smaller than a lob's from the same contact. This is the headline
    // difference between the attacking rail and the defensive float.
    const launchVz = (id: StrokeId, over: Partial<ShuttleState> = {}): number => {
      const next = step(rallyWithReachableBall({ z: 120, ...over }), swingWith(id), NO_INPUT);
      expect(next.shuttle.lastHitBy, `${id} connected`).toBe(0);
      return next.shuttle.vz;
    };
    const kill = launchVz('kill');
    const lob = launchVz('lob');
    // A lob arcs up steeply; a kill skims — the lob's vertical launch is the larger.
    expect(lob).toBeGreaterThan(kill);
  });

  it('a plain drive (default stroke) produces a valid returnable launch', () => {
    const next = step(rallyWithReachableBall(), swingWith('drive'), NO_INPUT);
    expect(next.shuttle.lastHitBy).toBe(0);
    expect(next.shuttle.inPlay).toBe(true);
    // Heading toward the front wall (y decreasing): negative y-velocity.
    expect(next.shuttle.vel.y).toBeLessThan(0);
  });
});

describe('fault gates misfire', () => {
  it('kill misfires on a LOW ball (min-contact-z gate)', () => {
    const fault = STROKES.kill.fault;
    const lowZ = fault?.kind === 'min-contact-z' ? fault.z - 20 : 0;
    const next = step(rallyWithReachableBall({ z: lowZ }), swingWith('kill'), NO_INPUT);
    // Misfire: the ball dribbles (no horizontal launch) and won't reach the front wall.
    expect(next.shuttle.lastHitBy).toBe(0); // P1 still made contact
    expect(Math.hypot(next.shuttle.vel.x, next.shuttle.vel.y)).toBe(0);
    expect(next.shuttle.hitFrontWall).toBe(false);
  });

  it('drop misfires when played from DEEP court (max-front-dist gate)', () => {
    const fault = STROKES.drop.fault;
    const maxDist = fault?.kind === 'max-front-dist' ? fault.dist : COURT.depth * 0.4;
    const deepY = maxDist + 120; // well behind the drop's allowed front distance
    const s = rallyWithReachableBall({ pos: { x: COURT.width / 2, y: deepY }, z: 100 });
    const deep: GameState = { ...s, p1: { ...s.p1, pos: { x: COURT.width / 2, y: deepY } } };
    const next = step(deep, swingWith('drop'), NO_INPUT);
    expect(Math.hypot(next.shuttle.vel.x, next.shuttle.vel.y)).toBe(0); // misfired
  });

  it('boast misfires from mid-court, away from any side wall (need-angle gate)', () => {
    // Ball dead-centre (far from both side walls) → no wall to angle off → misfire.
    const s = rallyWithReachableBall({ pos: { x: COURT.width / 2, y: COURT.depth * 0.5 } });
    const mid: GameState = { ...s, p1: { ...s.p1, pos: { x: COURT.width / 2, y: COURT.depth * 0.5 } } };
    const next = step(mid, swingWith('boast'), NO_INPUT);
    expect(Math.hypot(next.shuttle.vel.x, next.shuttle.vel.y)).toBe(0);
  });

  it('boast CONNECTS when trapped near a side wall (need-angle gate passes)', () => {
    const fault = STROKES.boast.fault;
    const maxX = fault?.kind === 'need-angle' ? fault.maxX : 220;
    const nearWallX = Math.max(0, maxX - 40); // close to the left wall, inside the gate
    const s = rallyWithReachableBall({ pos: { x: nearWallX, y: COURT.depth * 0.55 }, z: 100 });
    const trapped: GameState = { ...s, p1: { ...s.p1, pos: { x: nearWallX, y: COURT.depth * 0.55 } } };
    const next = step(trapped, swingWith('boast'), NO_INPUT);
    expect(next.shuttle.lastHitBy).toBe(0);
    expect(Math.hypot(next.shuttle.vel.x, next.shuttle.vel.y)).toBeGreaterThan(0); // launched
  });
});

describe('auto-downgrade (timingAim) keeps a connect instead of whiffing', () => {
  it('a kill on a low ball with timingAim downgrades to a legal drive', () => {
    // timingAim true → the sim downgrades an illegal stroke to a safe drive that flies.
    const fault = STROKES.kill.fault;
    const lowZ = fault?.kind === 'min-contact-z' ? fault.z - 20 : 0;
    const human: InputFrame = { ...NO_INPUT, swing: true, timingAim: true, stroke: 'kill' };
    const next = step(rallyWithReachableBall({ z: lowZ }), human, NO_INPUT);
    expect(next.p1.lastStroke).toBe('drive'); // downgraded
    expect(next.shuttle.lastHitBy).toBe(0); // still connected
  });
});
