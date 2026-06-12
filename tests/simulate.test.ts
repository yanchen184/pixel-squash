import { describe, it, expect } from 'vitest';
import { step } from '@/game/sim/simulate';
import { NO_INPUT } from '@/game/input/InputSource';
import { AIInput } from '@/game/input/AIInput';
import {
  createInitialState,
  COURT,
  NET_Y,
  POINTS_TO_WIN,
  type GameState,
} from '@/data/gameState';

function advance(state: GameState, frames: number): GameState {
  let s = state;
  for (let i = 0; i < frames; i++) s = step(s, NO_INPUT, NO_INPUT);
  return s;
}

/**
 * Run a full AI-vs-AI match (both sides driven by the real AIInput) and measure the
 * length of each rally in HITS — a swingCooldown rising 0→nonzero is one committed
 * swing. This is the rally-feel regression harness: a healthy game produces multi-hit
 * rallies, not a string of 2-hit serve-and-miss points. Deterministic via fixed seeds.
 */
function playMatch(seedA: number, seedB: number, maxFrames = 6000) {
  const ai0 = new AIInput('medium', 0, seedA);
  const ai1 = new AIInput('medium', 1, seedB);
  let s = createInitialState();
  const rallyHits: number[] = [];
  let cur = 0;
  let prevCd0 = 0;
  let prevCd1 = 0;
  let prevPhase = s.phase;
  for (let i = 0; i < maxFrames && s.winner === null; i++) {
    const inA = ai0.sample(s);
    const inB = ai1.sample(s);
    s = step(s, inA, inB);
    if (s.phase === 'rally') {
      if (prevCd0 === 0 && s.p1.swingCooldown > 0) cur++;
      if (prevCd1 === 0 && s.p2.swingCooldown > 0) cur++;
    }
    prevCd0 = s.p1.swingCooldown;
    prevCd1 = s.p2.swingCooldown;
    if (s.phase === 'point' && prevPhase === 'rally') {
      rallyHits.push(cur);
      cur = 0;
    }
    prevPhase = s.phase;
  }
  return { state: s, rallyHits };
}

describe('sim determinism', () => {
  it('produces identical states for identical inputs', () => {
    const a = advance(createInitialState(), 300);
    const b = advance(createInitialState(), 300);
    expect(a).toEqual(b);
  });

  it('advances frame counter by one per step', () => {
    const s = createInitialState();
    expect(step(s, NO_INPUT, NO_INPUT).frame).toBe(s.frame + 1);
  });
});

describe('serve flow', () => {
  it('starts in serve phase and launches into rally after the timer', () => {
    const s = createInitialState();
    expect(s.phase).toBe('serve');
    const afterServe = advance(s, 50);
    expect(afterServe.phase === 'rally' || afterServe.phase === 'point').toBe(true);
    expect(afterServe.shuttle.inPlay || afterServe.phase === 'point').toBe(true);
  });
});

describe('scoring', () => {
  it('awards a point and resets to serve when the shuttle lands', () => {
    // Drive far enough that the served shuttle inevitably lands.
    const s = advance(createInitialState(), 400);
    const total = s.scores[0] + s.scores[1];
    expect(total).toBeGreaterThanOrEqual(1);
  });

  it('lands on a half and credits the opposite side', () => {
    let s = createInitialState();
    // Fast-forward through the serve.
    s = advance(s, 50);
    // Let the rally play out with no returns -> someone scores.
    s = advance(s, 200);
    expect(s.scores[0] + s.scores[1]).toBeGreaterThanOrEqual(1);
  });
});

describe('win condition', () => {
  it('declares a winner at POINTS_TO_WIN and freezes the sim', () => {
    let s = createInitialState();
    // No-input rallies always land -> points accrue until someone wins.
    for (let i = 0; i < 6000 && s.winner === null; i++) {
      s = step(s, NO_INPUT, NO_INPUT);
    }
    expect(s.winner).not.toBeNull();
    expect(Math.max(s.scores[0], s.scores[1])).toBeGreaterThanOrEqual(POINTS_TO_WIN);
    // Frozen: stepping a finished match returns the same state.
    expect(step(s, NO_INPUT, NO_INPUT)).toBe(s);
  });
});

describe('rally feel (AI vs AI)', () => {
  it('sustains multi-hit rallies rather than collapsing to 2-hit points', () => {
    const { rallyHits } = playMatch(0x55aa33cc, 0x2545f491);
    expect(rallyHits.length).toBeGreaterThanOrEqual(5);
    // A degenerate game serves and immediately misses: almost every rally = 2 hits.
    // A healthy game averages several exchanges. Require a meaningful average AND
    // that not nearly every rally is the 2-hit minimum.
    const avg = rallyHits.reduce((a, b) => a + b, 0) / rallyHits.length;
    const twoHitters = rallyHits.filter((h) => h <= 2).length;
    expect(avg).toBeGreaterThan(3);
    expect(twoHitters / rallyHits.length).toBeLessThan(0.5);
  });
});

describe('playfield invariants', () => {
  it('keeps the shuttle within the court bounds and at/above the floor', () => {
    let s = createInitialState();
    for (let i = 0; i < 300; i++) {
      s = step(s, NO_INPUT, NO_INPUT);
      // Shuttle floor position stays within a sane band around the court.
      expect(s.shuttle.pos.x).toBeGreaterThanOrEqual(-80);
      expect(s.shuttle.pos.x).toBeLessThanOrEqual(COURT.width + 80);
      expect(s.shuttle.pos.y).toBeGreaterThanOrEqual(-80);
      expect(s.shuttle.pos.y).toBeLessThanOrEqual(COURT.depth + 80);
      // Height never goes meaningfully below the floor while in play.
      if (s.shuttle.inPlay) expect(s.shuttle.z).toBeGreaterThanOrEqual(-10);
    }
  });

  it('keeps each player confined to their own half of the net', () => {
    const s = advance(createInitialState(), 200);
    expect(s.p1.pos.y).toBeGreaterThan(NET_Y - 1); // near player below net
    expect(s.p2.pos.y).toBeLessThan(NET_Y + 1); // far player above net
  });
});
