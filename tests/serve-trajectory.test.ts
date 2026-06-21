import { describe, it, expect } from 'vitest';
import { step } from '@/game/sim/simulate';
import { NO_INPUT, type InputFrame } from '@/game/input/InputSource';
import { createInitialState, type GameState } from '@/data/gameState';

/**
 * Regression: the practice serve's dashed PREDICTED path (previewPath, sampled by
 * sampleServePath with PRACTICE_FLOOR_FRICTION) must match the ACTUAL live-rally flight
 * the same launch produces under step(). Before the fix the live rally ran the match
 * default FLOOR_FRICTION (0.6) while the preview ran 0.35, so the two diverged after the
 * first floor bounce ("球一開始的軌跡跟實際軌跡不同").
 */
function inp(over: Partial<InputFrame>): InputFrame {
  return { ...NO_INPUT, ...over };
}

/** Drive the practice serve flow until the ball is launched into a live rally. */
function launchPractice(stroke: InputFrame['stroke']): GameState {
  let s = createInitialState();
  s = { ...s, gameMode: 'practice', server: 0 };
  for (let i = 0; i < 200 && s.serveSubPhase !== 'toss'; i++) {
    s = step(s, inp({}), NO_INPUT);
  }
  expect(s.serveSubPhase).toBe('toss');
  s = step(s, inp({ nextStop: true }), NO_INPUT); // toss
  expect(s.serveSubPhase).toBe('airborne');
  for (let i = 0; i < 3; i++) s = step(s, inp({}), NO_INPUT); // let it drift down a touch
  s = step(s, inp({ swing: true, stroke, timingAim: true }), NO_INPUT); // swing → launch
  expect(s.phase).toBe('rally');
  expect(s.previewPath && s.previewPath.length).toBeGreaterThan(2);
  return s;
}

describe('practice serve: predicted dashed path vs actual live flight', () => {
  for (const stroke of ['drive', 'kill', 'drop', 'lob'] as const) {
    it(`${stroke}: live ball hugs the dashed preview within tolerance`, () => {
      const launched = launchPractice(stroke);
      const path = launched.previewPath!;

      const actual: { x: number; y: number; z: number }[] = [];
      let s = launched;
      for (let i = 0; i < 160; i++) {
        actual.push({ x: s.shuttle.pos.x, y: s.shuttle.pos.y, z: s.shuttle.z });
        if (!s.shuttle.inPlay || s.phase !== 'rally') break;
        s = step(s, NO_INPUT, NO_INPUT);
      }

      let maxGap = 0;
      let gapAt = -1;
      for (let i = 0; i < actual.length; i++) {
        const a = actual[i];
        let best = Infinity;
        for (const p of path) {
          const d = Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z);
          if (d < best) best = d;
        }
        if (best > maxGap) { maxGap = best; gapAt = i; }
      }

      expect(maxGap, `max gap ${maxGap.toFixed(1)}px at tick ${gapAt}`).toBeLessThan(60);
    });
  }
});
