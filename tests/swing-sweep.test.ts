import { describe, it, expect } from 'vitest';
import { step } from '@/game/sim/simulate';
import { NO_INPUT, type InputFrame } from '@/game/input/InputSource';
import {
  createInitialState,
  racketCenter,
  SWING_REACH,
  RACKET_REACH_OFFSET,
  COURT,
  type GameState,
} from '@/data/gameState';

/**
 * AC4 — 揮拍與球的真實物理碰撞 (swept swing collision).
 *
 * Bug: resolveSwing compared the racket head to the ball's CURRENT-tick position only.
 * A fast ball that crossed the racket BETWEEN ticks — far on one side last tick, far on
 * the other side this tick — never had a single tick where its endpoint sat inside
 * SWING_REACH, so the swing whiffed and the ball tunnelled straight through the racket.
 *
 * Fix: the hit test sweeps the ball's path this tick (prevPos → pos) against the racket
 * volume. SWING_REACH(100) is unchanged — it is now the radius of that swept volume, not
 * a point-to-point threshold. A clean closest-approach inside SWING_REACH connects even if
 * both segment endpoints are outside it.
 */

/** A live rally-phase state with p1 placed and the ball mid-flight, p2 parked far away. */
function rallyState(): GameState {
  const init = createInitialState();
  return {
    ...init,
    awaitingServeChoice: false,
    phase: 'rally',
    phaseTimer: 0,
    gameMode: 'match',
    p1: { ...init.p1, pos: { x: COURT.width / 2, y: 300 }, swingCooldown: 0 },
    // Park p2 in the far corner so its own resolveSwing can never touch this ball.
    p2: { ...init.p2, pos: { x: 20, y: COURT.depth - 20 }, swingCooldown: 0 },
    shuttle: {
      ...init.shuttle,
      inPlay: true,
      lastHitBy: 1, // hit by the opponent → it's p1's turn to return
      hitFrontWall: true,
      bouncesSinceWall: 0,
      z: 55, // STRIKE_Z — comfortable contact height, inside SWING_REACH_Z
      vz: 0,
    },
  };
}

const SWING_DRIVE: InputFrame = {
  ...NO_INPUT,
  swing: true,
  stroke: 'drive',
  timingAim: false,
  aimX: COURT.width / 2,
  aimY: 120,
};

describe('swept swing collision (AC4)', () => {
  it('a fast ball whose path crosses the racket connects, even though neither endpoint is in reach', () => {
    const base = rallyState();
    const racket = racketCenter(base.p1.pos, 0); // { x: width/2, y: 300 - 48 = 252 }

    // Ball flies horizontally along y = racket.y - 60 (60px in front-wall-band, < SWING_REACH).
    // prevPos sits 130px LEFT of the racket; one tick of vx carries it 130px to the RIGHT.
    // Both endpoints: dist = hypot(130, 60) ≈ 143 > SWING_REACH(100).
    // Closest approach (at x = racket.x): 60 < SWING_REACH(100) → swept hit must connect.
    const bandY = racket.y - 60;
    const startX = racket.x - 130;
    const vx = 260; // one stepBall tick moves +260 (drag 0.998 ≈ negligible)

    const s0: GameState = {
      ...base,
      shuttle: { ...base.shuttle, pos: { x: startX, y: bandY }, vel: { x: vx, y: 0 } },
    };

    // Sanity: BOTH the start and the post-step endpoint are outside SWING_REACH of the racket.
    const distStart = Math.hypot(startX - racket.x, bandY - racket.y);
    const endX = startX + vx; // ≈ racket.x + 130
    const distEnd = Math.hypot(endX - racket.x, bandY - racket.y);
    expect(distStart).toBeGreaterThan(SWING_REACH);
    expect(distEnd).toBeGreaterThan(SWING_REACH);

    const s1 = step(s0, SWING_DRIVE, NO_INPUT);

    // The swing must have connected: p1 struck the ball this tick and it's now heading
    // toward the front wall (negative vy) rather than continuing its straight-through flight.
    expect(s1.p1.justHit, 'p1 should connect with the swept ball').toBe(true);
    expect(s1.p1.lastQuality).not.toBe('miss');
  });

  it('a genuine miss (ball nowhere near the swept volume) still whiffs', () => {
    const base = rallyState();
    const racket = racketCenter(base.p1.pos, 0);

    // Ball flies far above the reach band — closest approach >> SWING_REACH the whole tick.
    const farY = racket.y - (SWING_REACH + 80);
    const s0: GameState = {
      ...base,
      shuttle: { ...base.shuttle, pos: { x: racket.x - 130, y: farY }, vel: { x: 260, y: 0 } },
    };

    const s1 = step(s0, SWING_DRIVE, NO_INPUT);
    expect(s1.p1.justHit, 'an out-of-range swing should whiff').toBe(false);
  });

  it('the unchanged near-body single-frame hit still connects (no regression)', () => {
    const base = rallyState();
    const racket = racketCenter(base.p1.pos, 0);

    // Ball sitting right on the racket head, slow — the classic in-reach contact.
    const s0: GameState = {
      ...base,
      shuttle: {
        ...base.shuttle,
        pos: { x: racket.x, y: racket.y + RACKET_REACH_OFFSET * 0.2 },
        vel: { x: 0, y: 0 },
      },
    };

    const s1 = step(s0, SWING_DRIVE, NO_INPUT);
    expect(s1.p1.justHit, 'an in-reach stationary ball should connect').toBe(true);
  });
});
