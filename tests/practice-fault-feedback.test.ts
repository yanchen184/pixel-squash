import { describe, it, expect } from 'vitest';
import { step } from '@/game/sim/simulate';
import { NO_INPUT, type InputFrame } from '@/game/input/InputSource';
import {
  createInitialState,
  resetForServe,
  type GameState,
  type ShuttleState,
} from '@/data/gameState';

/**
 * Practice fault-feedback contract (PLAN.md §8.6 #8 — 打到牆壁回饋優質, audio half).
 *
 * In practice a fault resets straight back to serve the SAME tick (no 'point' phase), so the
 * renderer can't read deadReason off the post-reset shuttle to play the tin/out call. The sim
 * therefore carries the reason forward on state.lastFaultReason for one serve frame. These tests
 * pin that contract so the practice tin/out sounds (wired in PracticeRenderer.detectSounds) keep
 * firing. The renderer's actual SoundEngine calls are verified separately by a browser round-trip.
 */

const M: InputFrame = { ...NO_INPUT, nextStop: true };

function practiceRally(shuttle: Partial<ShuttleState>): GameState {
  const base = resetForServe(
    { ...createInitialState(), gameMode: 'practice', awaitingServeChoice: false },
    0,
  );
  return {
    ...base,
    phase: 'rally',
    hitstop: 0,
    rallyFrozen: false,
    lastFaultReason: null,
    shuttle: {
      ...base.shuttle,
      inPlay: true,
      lastHitBy: 0,
      deadReason: null,
      hitFrontWall: false,
      bouncesSinceWall: 0,
      lastWall: null,
      ...shuttle,
    },
  };
}

describe('practice fault feedback — lastFaultReason carry (#8 audio)', () => {
  it('a tin fault surfaces lastFaultReason="tin" after the same-tick serve reset', () => {
    // Ball pressed against the front wall (y≈0) below the tin → struck the board.
    let s = practiceRally({ pos: { x: 320, y: 3 }, z: 20, vz: 0, vel: { x: 0, y: -6 } });
    let reason: string | null = null;
    for (let i = 0; i < 30 && s.phase === 'rally'; i++) s = step(s, NO_INPUT, NO_INPUT);
    reason = s.lastFaultReason;
    expect(s.phase, 'practice resets to serve, not point').toBe('serve');
    expect(reason).toBe('tin');
  });

  it('an out fault surfaces lastFaultReason="out"', () => {
    let s = practiceRally({ pos: { x: 320, y: 3 }, z: 520, vz: 4, vel: { x: 0, y: -6 } });
    for (let i = 0; i < 30 && s.phase === 'rally'; i++) s = step(s, NO_INPUT, NO_INPUT);
    expect(s.phase).toBe('serve');
    expect(s.lastFaultReason).toBe('out');
  });

  it('launching a fresh rally clears the previous fault marker', () => {
    // First, end a rally with a tin.
    let s = practiceRally({ pos: { x: 320, y: 3 }, z: 20, vz: 0, vel: { x: 0, y: -6 } });
    for (let i = 0; i < 30 && s.phase === 'rally'; i++) s = step(s, NO_INPUT, NO_INPUT);
    expect(s.lastFaultReason).toBe('tin');

    // Toss + serve to launch a new rally — the marker must reset so the NEXT fault re-fires.
    s = { ...s, phaseTimer: 0 };
    s = step(s, M, NO_INPUT);
    s = step(s, NO_INPUT, NO_INPUT);
    for (let i = 0; i < 30 && s.phase !== 'rally'; i++) {
      s = step(s, { ...NO_INPUT, swing: true, stroke: 'drive', timingAim: true }, NO_INPUT);
      if (s.phase !== 'rally') s = step(s, NO_INPUT, NO_INPUT);
    }
    expect(s.phase, 'serve swing should launch a rally').toBe('rally');
    expect(s.lastFaultReason, 'a fresh rally clears the old fault marker').toBeNull();
  });

  it('match mode does NOT use lastFaultReason (it has a real point phase)', () => {
    const m = createInitialState();
    const matchRally: GameState = {
      ...m,
      phase: 'rally',
      hitstop: 0,
      lastFaultReason: null,
      shuttle: {
        ...m.shuttle,
        inPlay: true,
        pos: { x: 320, y: 3 },
        z: 20,
        vz: 0,
        vel: { x: 0, y: -6 },
        lastHitBy: 0,
        deadReason: null,
        hitFrontWall: false,
        bouncesSinceWall: 0,
        lastWall: null,
      },
    };
    let s = matchRally;
    for (let i = 0; i < 30 && s.phase === 'rally'; i++) s = step(s, NO_INPUT, NO_INPUT);
    // Match enters 'point' and the renderer reads deadReason there; lastFaultReason stays null.
    expect(s.lastFaultReason).toBeNull();
  });
});
