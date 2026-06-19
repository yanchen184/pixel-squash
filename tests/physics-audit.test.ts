/**
 * Physics audit — quantitative health check of the squash ball engine.
 *
 * Unlike simulate.test.ts (which asserts invariants), this file MEASURES the
 * actual flight behaviour and logs numbers so a human can judge whether the
 * physics "feels" right: how deep the ball carries, how much energy walls keep,
 * whether gravity produces a real arc, and how long AI rallies run.
 *
 * Run with:  npx vitest run tests/physics-audit.test.ts
 * The console.log lines are the report; the expect() lines are the pass/fail gate.
 */
import { describe, it, expect } from 'vitest';
import { step, GRAVITY } from '@/game/sim/simulate';
import { NO_INPUT } from '@/game/input/InputSource';
import { AIInput } from '@/game/input/AIInput';
import {
  createInitialState,
  COURT,
  TIN_HEIGHT,
  WALL_BOUNCE,
  FRONT_WALL_BOUNCE,
  FLOOR_BOUNCE,
  type GameState,
} from '@/data/gameState';

const SERVE_LEFT = { ...NO_INPUT, serveLeft: true };

/** Advance N frames, auto-feeding a serve choice whenever one is awaited. */
function advance(state: GameState, frames: number, onTick?: (s: GameState) => void): GameState {
  let s = state;
  for (let i = 0; i < frames; i++) {
    const inp = s.awaitingServeChoice ? SERVE_LEFT : NO_INPUT;
    s = step(s, inp, NO_INPUT);
    onTick?.(s);
  }
  return s;
}

describe('physics audit — flight & carry', () => {
  it('a served ball carries deep into the court (not a limp dribble)', () => {
    let s = createInitialState();
    let maxDepth = 0;
    let frontWallZ = -1;
    advance(s, 240, (st) => {
      if (st.shuttle.inPlay) {
        maxDepth = Math.max(maxDepth, st.shuttle.pos.y);
        if (st.shuttle.hitFrontWall && frontWallZ < 0) frontWallZ = st.shuttle.z;
      }
    });
    const carryPct = (maxDepth / COURT.depth) * 100;
    // eslint-disable-next-line no-console
    console.log(
      `[carry] served ball reached y=${maxDepth.toFixed(0)} / ${COURT.depth} ` +
      `(${carryPct.toFixed(0)}% of court depth); front-wall strike z≈${frontWallZ.toFixed(0)}`,
    );
    // A legal serve should carry past the short service line region — at least
    // 40% of the way back, otherwise the ball is dying at the front.
    expect(maxDepth).toBeGreaterThan(COURT.depth * 0.4);
  });

  it('gravity produces a real rising-then-falling arc', () => {
    // Track the ball's z over a rally and confirm it goes up then comes down
    // (vz crosses from positive to negative), i.e. a parabolic arc, not a flat line.
    let s = createInitialState();
    const zs: number[] = [];
    advance(s, 200, (st) => {
      if (st.shuttle.inPlay) zs.push(st.shuttle.z);
    });
    const peak = Math.max(...zs);
    const peakIdx = zs.indexOf(peak);
    const rose = peakIdx > 0 && peak > zs[0];
    const fell = peakIdx < zs.length - 1 && zs[zs.length - 1] < peak;
    // eslint-disable-next-line no-console
    console.log(
      `[arc] z peaked at ${peak.toFixed(0)}px (frame ${peakIdx} of ${zs.length}); ` +
      `gravity=${GRAVITY}px/tick² → rose=${rose} fell=${fell}`,
    );
    expect(rose && fell).toBe(true);
  });
});

describe('physics audit — wall energy retention', () => {
  /**
   * Drive the ball straight into a chosen wall and measure the speed ratio
   * across the bounce. The retained fraction must match the configured bounce
   * constant (within a tolerance for the drag applied on the same tick).
   */
  function measureBounce(
    setup: (s: GameState) => GameState,
    axis: 'x' | 'y',
    maxFrames: number,
  ): { before: number; after: number } | null {
    let s = setup(createInitialState());
    let prevV = s.shuttle.vel[axis];
    for (let i = 0; i < maxFrames; i++) {
      const next = step(s, NO_INPUT, NO_INPUT);
      const v = next.shuttle.vel[axis];
      // Detect a sign flip on this axis = a wall bounce on that axis.
      if (prevV !== 0 && Math.sign(v) !== Math.sign(prevV) && Math.abs(prevV) > 1) {
        return { before: Math.abs(prevV), after: Math.abs(v) };
      }
      prevV = v;
      s = next;
    }
    return null;
  }

  it('side wall retains ≈WALL_BOUNCE of horizontal speed', () => {
    const r = measureBounce((s) => ({
      ...s,
      phase: 'rally',
      shuttle: { ...s.shuttle, inPlay: true, hitFrontWall: true, lastHitBy: 0,
        pos: { x: COURT.width - 30, y: 500 }, z: 200, vel: { x: 14, y: 0 }, vz: 0 },
    }), 'x', 120);
    expect(r).not.toBeNull();
    const ratio = r!.after / r!.before;
    // eslint-disable-next-line no-console
    console.log(`[wall:side] ${r!.before.toFixed(1)} → ${r!.after.toFixed(1)} px/tick (ratio ${ratio.toFixed(3)}, target ${WALL_BOUNCE})`);
    expect(ratio).toBeGreaterThan(WALL_BOUNCE - 0.05);
    expect(ratio).toBeLessThan(WALL_BOUNCE + 0.05);
  });

  it('back wall retains ≈WALL_BOUNCE of depth speed', () => {
    const r = measureBounce((s) => ({
      ...s,
      phase: 'rally',
      shuttle: { ...s.shuttle, inPlay: true, hitFrontWall: true, lastHitBy: 0,
        pos: { x: 320, y: COURT.depth - 30 }, z: 200, vel: { x: 0, y: 14 }, vz: 0 },
    }), 'y', 120);
    expect(r).not.toBeNull();
    const ratio = r!.after / r!.before;
    // eslint-disable-next-line no-console
    console.log(`[wall:back] ${r!.before.toFixed(1)} → ${r!.after.toFixed(1)} px/tick (ratio ${ratio.toFixed(3)}, target ${WALL_BOUNCE})`);
    expect(ratio).toBeGreaterThan(WALL_BOUNCE - 0.05);
    expect(ratio).toBeLessThan(WALL_BOUNCE + 0.05);
  });

  it('front wall retains ≈FRONT_WALL_BOUNCE (higher than side walls)', () => {
    const r = measureBounce((s) => ({
      ...s,
      phase: 'rally',
      shuttle: { ...s.shuttle, inPlay: true, hitFrontWall: false, lastHitBy: 0,
        pos: { x: 320, y: 30 }, z: 200, vel: { x: 0, y: -14 }, vz: 0 },
    }), 'y', 120);
    expect(r).not.toBeNull();
    const ratio = r!.after / r!.before;
    // eslint-disable-next-line no-console
    console.log(`[wall:front] ${r!.before.toFixed(1)} → ${r!.after.toFixed(1)} px/tick (ratio ${ratio.toFixed(3)}, target ${FRONT_WALL_BOUNCE})`);
    expect(ratio).toBeGreaterThan(FRONT_WALL_BOUNCE - 0.05);
    expect(FRONT_WALL_BOUNCE).toBeGreaterThan(WALL_BOUNCE); // front carries more energy by design
  });
});

describe('physics audit — death conditions', () => {
  it('a ball striking the front wall below the tin dies as tin', () => {
    // Aim a fast, low shot straight at the front wall under TIN_HEIGHT.
    let s = createInitialState();
    s = {
      ...s,
      phase: 'rally',
      shuttle: { ...s.shuttle, inPlay: true, hitFrontWall: false, lastHitBy: 0,
        pos: { x: 320, y: 40 }, z: TIN_HEIGHT - 20, vel: { x: 0, y: -12 }, vz: 0 },
    };
    let reason: string | null = null;
    for (let i = 0; i < 60; i++) {
      s = step(s, NO_INPUT, NO_INPUT);
      if (s.shuttle.deadReason) { reason = s.shuttle.deadReason; break; }
    }
    // eslint-disable-next-line no-console
    console.log(`[death:tin] low front-wall strike → deadReason="${reason}"`);
    expect(reason).toBe('tin');
  });

  it('a second floor bounce kills the ball (double-bounce)', () => {
    // Legal ball (already hit front wall) bouncing twice on the floor must die.
    let s = createInitialState();
    s = {
      ...s,
      phase: 'rally',
      shuttle: { ...s.shuttle, inPlay: true, hitFrontWall: true, lastHitBy: 0,
        pos: { x: 320, y: 500 }, z: 60, vel: { x: 0, y: 2 }, vz: -3, bouncesSinceWall: 0 },
    };
    let reason: string | null = null;
    let bounces = 0;
    let prevZ = s.shuttle.z;
    for (let i = 0; i < 400; i++) {
      s = step(s, NO_INPUT, NO_INPUT);
      if (prevZ > 0 && s.shuttle.z <= 0) bounces++;
      prevZ = s.shuttle.z;
      if (s.shuttle.deadReason) { reason = s.shuttle.deadReason; break; }
    }
    // eslint-disable-next-line no-console
    console.log(`[death:double-bounce] floor bounces seen=${bounces} → deadReason="${reason}" (FLOOR_BOUNCE=${FLOOR_BOUNCE})`);
    expect(reason).toBe('double-bounce');
  });

  it('after its one legal floor bounce, touching a wall kills the ball (dead-after-bounce)', () => {
    // House rule: a legal ball that has already taken its single floor bounce dies the
    // instant it touches anything. Here we set bouncesSinceWall=1 (the one allowed bounce
    // already happened) and send the ball laterally into the right side wall in the air.
    let s = createInitialState();
    s = {
      ...s,
      phase: 'rally',
      shuttle: { ...s.shuttle, inPlay: true, hitFrontWall: true, lastHitBy: 0,
        pos: { x: COURT.width - 30, y: 500 }, z: 200, vel: { x: 14, y: 0 }, vz: 0,
        bouncesSinceWall: 1 },
    };
    let reason: string | null = null;
    for (let i = 0; i < 60; i++) {
      s = step(s, NO_INPUT, NO_INPUT);
      if (s.shuttle.deadReason) { reason = s.shuttle.deadReason; break; }
    }
    // eslint-disable-next-line no-console
    console.log(`[death:dead-after-bounce] post-bounce side-wall touch → deadReason="${reason}"`);
    expect(reason).toBe('dead-after-bounce');
  });

  it('a wall touch BEFORE the floor bounce does NOT kill (regression guard)', () => {
    // The same lateral shot but with bouncesSinceWall=0 (no floor bounce yet) is a normal
    // rally ball — hitting the side wall must reflect it, never end the rally.
    let s = createInitialState();
    s = {
      ...s,
      phase: 'rally',
      shuttle: { ...s.shuttle, inPlay: true, hitFrontWall: true, lastHitBy: 0,
        pos: { x: COURT.width - 30, y: 500 }, z: 200, vel: { x: 14, y: 0 }, vz: 0,
        bouncesSinceWall: 0 },
    };
    let reason: string | null = null;
    for (let i = 0; i < 30; i++) {
      s = step(s, NO_INPUT, NO_INPUT);
      if (s.shuttle.deadReason) { reason = s.shuttle.deadReason; break; }
    }
    // eslint-disable-next-line no-console
    console.log(`[death:pre-bounce-wall] side-wall touch before any floor bounce → deadReason="${reason}" (expect null)`);
    expect(reason).toBeNull();
  });
});

describe('physics audit — practice serve speed', () => {
  /** Peak |vy| while the ball is live = how fast it drives toward the front wall. */
  function peakVy(s0: GameState, frames: number): number {
    let s = s0;
    let peak = 0;
    for (let i = 0; i < frames; i++) {
      const inp = s.awaitingServeChoice ? SERVE_LEFT : NO_INPUT;
      s = step(s, inp, NO_INPUT);
      if (s.shuttle.inPlay) {
        peak = Math.max(peak, Math.abs(s.shuttle.vel.y));
      }
    }
    return peak;
  }

  it('a practice M-key serve launches at roughly the same speed as a match serve', () => {
    // Match serve: drive a normal match from the menu serve and read its launch speed.
    // The first serve waits on the box choice + a short countdown, so give it room.
    const matchVy = peakVy(createInitialState(), 120);

    // Practice serve: build a practice toss state, swing to enter preview, then tap M
    // (nextStop) repeatedly to walk the preview and launch into the rally.
    let s: GameState = { ...createInitialState(), gameMode: 'practice', awaitingServeChoice: false,
      phase: 'serve', serveSubPhase: 'toss' };
    const M = { ...NO_INPUT, nextStop: true };
    const SWING_DRIVE = { ...NO_INPUT, swing: true, stroke: 'drive' as const };
    s = step(s, M, NO_INPUT);                 // toss → airborne
    s = step(s, SWING_DRIVE, NO_INPUT);       // swing near body → preview
    // Walk the preview to launch: tap M until the ball is live in the rally.
    let practiceVy = 0;
    for (let i = 0; i < 60 && practiceVy === 0; i++) {
      s = step(s, M, NO_INPUT);
      // After launch the ball is in play; sample its drive speed over the next few frames.
      if (s.shuttle.inPlay && s.phase === 'rally') {
        practiceVy = peakVy(s, 20);
      }
    }

    // eslint-disable-next-line no-console
    console.log(`[serve-speed] match |vy|=${matchVy.toFixed(1)}  practice |vy|=${practiceVy.toFixed(1)}  ratio=${(practiceVy / matchVy).toFixed(2)}`);
    expect(practiceVy).toBeGreaterThan(0);
    // The fix targets parity; allow a generous band (different strokes/positions differ a bit).
    expect(practiceVy).toBeLessThan(matchVy * 1.5);
  });
});

describe('physics audit — AI rally quality', () => {
  it('AI-vs-AI rallies are sustained, not serve-and-miss', () => {
    function playMatch(seedA: number, seedB: number, maxFrames = 6000): number[] {
      const ai0 = new AIInput('medium', 0, seedA);
      const ai1 = new AIInput('medium', 1, seedB);
      let s = createInitialState();
      const hits: number[] = [];
      let cur = 0, pc0 = 0, pc1 = 0, prevPhase = s.phase;
      for (let i = 0; i < maxFrames && s.winner === null; i++) {
        const inA = s.awaitingServeChoice ? SERVE_LEFT : ai0.sample(s);
        const inB = ai1.sample(s);
        s = step(s, inA, inB);
        if (s.phase === 'rally') {
          if (pc0 === 0 && s.p1.swingCooldown > 0) cur++;
          if (pc1 === 0 && s.p2.swingCooldown > 0) cur++;
        }
        pc0 = s.p1.swingCooldown; pc1 = s.p2.swingCooldown;
        if (s.phase === 'point' && prevPhase === 'rally') { hits.push(cur); cur = 0; }
        prevPhase = s.phase;
      }
      return hits;
    }

    const allHits: number[] = [];
    for (let seed = 1; seed <= 8; seed++) allHits.push(...playMatch(seed * 7, seed * 13));
    const avg = allHits.reduce((a, b) => a + b, 0) / allHits.length;
    const twoOrFewer = allHits.filter((h) => h <= 2).length / allHits.length;
    const longest = Math.max(...allHits);
    // eslint-disable-next-line no-console
    console.log(
      `[ai-rally] ${allHits.length} rallies across 8 matches: ` +
      `avg ${avg.toFixed(1)} hits, longest ${longest}, ` +
      `${(twoOrFewer * 100).toFixed(0)}% were ≤2-hit`,
    );
    expect(allHits.length).toBeGreaterThan(5);
    expect(avg).toBeGreaterThan(3);
    expect(twoOrFewer).toBeLessThan(0.5);
  });
});
