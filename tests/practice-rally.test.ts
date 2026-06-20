import { describe, it, expect } from 'vitest';
import { step } from '@/game/sim/simulate';
import { NO_INPUT, type InputFrame } from '@/game/input/InputSource';
import {
  createInitialState,
  resetForServe,
  COURT,
  PLAYER_SPEED,
  SWING_REACH,
  SWING_REACH_Z,
  type GameState,
} from '@/data/gameState';

/**
 * Practice free-rally acceptance harness (Bob: 「我要你揮十次拍」 + 「軌跡一直留著 然後自由對打」).
 *
 * Verifies the rewritten practice serve: the serve swing launches the ball LIVE into a
 * real-physics rally, the ball rebounds off the front wall and stays in play, and a
 * competent player can keep the rally going for >=10 consecutive swings.
 *
 * The "player" is a deterministic auto-rallier: it runs to the ball's PREDICTED landing
 * spot and plays a low, centred drive whenever the ball is reachable. No Math.random — the
 * sim is pure, so this replays byte-for-byte. (The engine itself sustains 50+ hit rallies
 * in match mode; this test proves the practice rewrite doesn't cap the rally at the serve.)
 */

/** Build a practice-mode state sitting at the toss sub-phase (server side 0). */
function practiceServeReady(): GameState {
  const match = createInitialState();
  const practice = resetForServe({ ...match, gameMode: 'practice', awaitingServeChoice: false }, 0);
  return { ...practice, phaseTimer: 0 };
}

const TOSS_INPUT: InputFrame = { ...NO_INPUT, nextStop: true };

interface RallyResult {
  maxRallyHit: number;
  reachedFrontWall: boolean;
  endedBy: string;
}

function runRally(): RallyResult {
  let s = practiceServeReady();

  // 1) Toss (M press-edge), settle one tick → 'airborne'.
  s = step(s, TOSS_INPUT, NO_INPUT);
  s = step(s, NO_INPUT, NO_INPUT);

  // 2) Serve swing: ball is airborne near the body → swing to launch the live rally.
  let launched = false;
  for (let i = 0; i < 30 && !launched; i++) {
    s = step(s, { ...NO_INPUT, swing: true, stroke: 'drive', timingAim: true }, NO_INPUT);
    if (s.phase === 'rally') launched = true;
    else s = step(s, NO_INPUT, NO_INPUT);
  }
  expect(launched, 'serve swing should launch a live rally').toBe(true);

  // 3) Free rally: run to the predicted landing, play a low centred drive when reachable.
  let maxRallyHit = s.rallyHitCount;
  let reachedFrontWall = false;
  let endedBy = 'timeout';

  for (let i = 0; i < 6000; i++) {
    if (s.shuttle.hitFrontWall || s.shuttle.lastWall === 'front') reachedFrontWall = true;

    const racket = s.p1.pos;
    const ball = s.shuttle.pos;
    const target = s.shuttle.landing ?? ball; // chase where the ball WILL be
    const dist = Math.hypot(ball.x - racket.x, ball.y - racket.y);
    const reachable = s.shuttle.inPlay && dist <= SWING_REACH && s.shuttle.z <= SWING_REACH_Z;
    const comfortableHeight = s.shuttle.z <= 130;
    const canSwing = s.p1.swingCooldown === 0 && reachable && comfortableHeight;

    let inA: InputFrame;
    if (canSwing) {
      // Low, centred drive keeps the ball under the out line and in front of the player.
      inA = { ...NO_INPUT, swing: true, stroke: 'drive', timingAim: false, aimX: COURT.width / 2, aimY: 120 };
    } else {
      const dx = target.x - racket.x;
      const dy = target.y - racket.y;
      const dead = PLAYER_SPEED * 0.5;
      const moveX = (Math.abs(dx) <= dead ? 0 : dx < 0 ? -1 : 1) as -1 | 0 | 1;
      const worldMoveY = Math.abs(dy) <= dead ? 0 : dy < 0 ? -1 : 1;
      // step() flips moveY for the human in practice mode — pre-flip so we chase world-Y.
      const moveY = (worldMoveY === 0 ? 0 : worldMoveY < 0 ? 1 : -1) as -1 | 0 | 1;
      inA = { ...NO_INPUT, moveX, moveY };
    }

    s = step(s, inA, NO_INPUT);
    maxRallyHit = Math.max(maxRallyHit, s.rallyHitCount);

    if (maxRallyHit >= 12) {
      endedBy = 'target-reached';
      break;
    }
    if (s.phase === 'serve') {
      endedBy = `died@rhc${maxRallyHit}`;
      break;
    }
  }

  return { maxRallyHit, reachedFrontWall, endedBy };
}

describe('practice free rally', () => {
  it('serve swing reaches the front wall (real squash: front wall is the main wall)', () => {
    const { reachedFrontWall } = runRally();
    expect(reachedFrontWall).toBe(true);
  });

  it('supports >=10 consecutive swings in a single rally', () => {
    const { maxRallyHit, endedBy } = runRally();
    expect(maxRallyHit, `rally ended by ${endedBy}`).toBeGreaterThanOrEqual(10);
  });
});
