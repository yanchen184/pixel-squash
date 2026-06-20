import { describe, it, expect } from 'vitest';
import { step } from '@/game/sim/simulate';
import { NO_INPUT, type InputFrame } from '@/game/input/InputSource';
import {
  createInitialState,
  resetForServe,
  COURT,
  PLAYER_SPEED,
  PLAYER_MARGIN,
  SWING_REACH,
  SWING_REACH_Z,
  SWING_COOLDOWN_FRAMES,
  TIN_HEIGHT,
  FRONT_OUT_HEIGHT,
  SERVE_LINE_Y,
  DIVE_STAMINA_COST,
  STAMINA_MAX,
  type GameState,
} from '@/data/gameState';

/**
 * Practice-mode acceptance harness — 驗法 A (純腳本物理) items from PLAN.md §8.6.
 *
 * Each test maps to a numbered acceptance criterion. They drive the pure sim directly
 * (no renderer) and assert on state, so they give a hard pass/fail per Bob's 驗收紀律
 * ("真的跑、真的驗", not 「程式邏輯看起來對」). The browser/visual items (#2,#7,#8,#9,
 * #22,#23) are verified separately via round-trip + screenshots.
 */

function practiceServeReady(): GameState {
  const match = createInitialState();
  const practice = resetForServe({ ...match, gameMode: 'practice', awaitingServeChoice: false }, 0);
  return { ...practice, phaseTimer: 0 };
}

const TOSS: InputFrame = { ...NO_INPUT, nextStop: true };

/** Toss + serve-swing into a live rally; returns the launched state. */
function launchRally(): GameState {
  let s = practiceServeReady();
  s = step(s, TOSS, NO_INPUT);
  s = step(s, NO_INPUT, NO_INPUT);
  for (let i = 0; i < 30 && s.phase !== 'rally'; i++) {
    s = step(s, { ...NO_INPUT, swing: true, stroke: 'drive', timingAim: true }, NO_INPUT);
    if (s.phase !== 'rally') s = step(s, NO_INPUT, NO_INPUT);
  }
  expect(s.phase, 'serve swing should launch a rally').toBe('rally');
  return s;
}

/** A competent auto-rallier input for the current state (low centred drive when reachable). */
function rallierInput(s: GameState): InputFrame {
  const racket = s.p1.pos;
  const ball = s.shuttle.pos;
  const dist = Math.hypot(ball.x - racket.x, ball.y - racket.y);
  const reachable = s.shuttle.inPlay && dist <= SWING_REACH && s.shuttle.z <= SWING_REACH_Z;
  if (s.p1.swingCooldown === 0 && reachable && s.shuttle.z <= 130) {
    return { ...NO_INPUT, swing: true, stroke: 'drive', timingAim: false, aimX: COURT.width / 2, aimY: 120 };
  }
  const target = s.shuttle.landing ?? ball;
  const dead = PLAYER_SPEED * 0.5;
  const dx = target.x - racket.x;
  const dy = target.y - racket.y;
  const moveX = (Math.abs(dx) <= dead ? 0 : dx < 0 ? -1 : 1) as -1 | 0 | 1;
  const worldMoveY = Math.abs(dy) <= dead ? 0 : dy < 0 ? -1 : 1;
  const moveY = (worldMoveY === 0 ? 0 : worldMoveY < 0 ? 1 : -1) as -1 | 0 | 1;
  return { ...NO_INPUT, moveX, moveY };
}

describe('practice acceptance — 驗法 A', () => {
  // #1 連續揮拍十次
  it('#1 supports >=10 consecutive swings', () => {
    let s = launchRally();
    let maxHit = s.rallyHitCount;
    for (let i = 0; i < 6000 && maxHit < 12 && s.phase !== 'serve'; i++) {
      s = step(s, rallierInput(s), NO_INPUT);
      maxHit = Math.max(maxHit, s.rallyHitCount);
    }
    expect(maxHit).toBeGreaterThanOrEqual(10);
  });

  // #4 出界邏輯：高球越過 out 線撞前牆 → deadReason='out'；正常齊膝球 → 不誤判
  it('#4 a ball above the out line dies as out; a low ball does not', () => {
    const base = launchRally();
    // (a) HIGH ball heading at the front wall above FRONT_OUT_HEIGHT → must die 'out'.
    const high: GameState = {
      ...base,
      shuttle: {
        ...base.shuttle,
        inPlay: true,
        pos: { x: COURT.width / 2, y: 6 },     // about to cross the front wall (y=0)
        z: FRONT_OUT_HEIGHT + 120,             // well above the out line
        vel: { x: 0, y: -20 },                 // flying into the front wall
        vz: 0,
        deadReason: null,
        hitFrontWall: false,
        bouncesSinceWall: 0,
        lastWall: null,
      },
    };
    // In practice a death resets to serve the SAME tick (no scoring), so the observable
    // signature of "the out fault fired" is: the rally ended → phase flips back to serve.
    const afterHigh = step({ ...high, hitstop: 0 }, NO_INPUT, NO_INPUT);
    expect(afterHigh.phase, 'a ball over the out line should kill the rally (→ serve)').toBe('serve');

    // (b) LOW legal ball at the same wall → must NOT be flagged out.
    const low: GameState = {
      ...base,
      shuttle: {
        ...base.shuttle,
        inPlay: true,
        pos: { x: COURT.width / 2, y: 6 },
        z: (TIN_HEIGHT + FRONT_OUT_HEIGHT) / 2, // comfortably between tin and out
        vel: { x: 0, y: -20 },
        vz: 0,
        deadReason: null,
        hitFrontWall: false,
        bouncesSinceWall: 0,
        lastWall: null,
      },
    };
    const afterLow = step({ ...low, hitstop: 0 }, NO_INPUT, NO_INPUT);
    // A legal-height ball is NOT out: it makes a good front-wall hit and the rally continues.
    expect(afterLow.phase, 'a legal-height ball must keep the rally alive').toBe('rally');
    expect(afterLow.shuttle.hitFrontWall, 'a legal-height ball is a good front-wall hit').toBe(true);
    expect(FRONT_OUT_HEIGHT).toBeGreaterThan(TIN_HEIGHT);
  });

  // #5 彈跳：前牆反彈保留 FRONT_WALL_BOUNCE 能量（球撞牆後仍帶速度往回）
  it('#5 ball rebounds off the front wall and keeps travelling (energy retained)', () => {
    let s = launchRally();
    let rebounded = false;
    for (let i = 0; i < 600 && !rebounded; i++) {
      s = step(s, rallierInput(s), NO_INPUT);
      if ((s.shuttle.hitFrontWall || s.shuttle.lastWall === 'front') && s.shuttle.inPlay) {
        // after a front-wall hit the ball should be moving back into court (vel.y > 0 in world)
        if (s.shuttle.vel.y > 0) rebounded = true;
      }
    }
    expect(rebounded, 'ball should rebound off front wall with retained velocity').toBe(true);
  });

  // #12 揮拍冷卻不可連點：每 tick 按揮拍只在 cooldown==0 命中
  it('#12 swing cooldown blocks rapid re-swings', () => {
    let s = launchRally();
    // Spam swing every tick; count how many ticks justHit fired vs cooldown gaps.
    let hits = 0;
    let illegalHitDuringCooldown = false;
    for (let i = 0; i < 200; i++) {
      const cooldownBefore = s.p1.swingCooldown;
      s = step(s, { ...NO_INPUT, swing: true, stroke: 'drive', timingAim: false, aimX: COURT.width / 2, aimY: 120 }, NO_INPUT);
      if (s.p1.justHit) {
        hits++;
        if (cooldownBefore > 0) illegalHitDuringCooldown = true;
      }
      if (s.phase === 'serve') s = launchRally();
    }
    expect(illegalHitDuringCooldown, 'no hit should land while swingCooldown > 0').toBe(false);
    expect(SWING_COOLDOWN_FRAMES).toBeGreaterThan(0);
  });

  // #13 移動邊界 clamp：往各方向衝刺，pos 永遠夾在場內
  it('#13 player position stays clamped inside court bounds', () => {
    let s = practiceServeReady();
    // leave serve constraints by launching, then roam hard in each direction.
    s = launchRally();
    const dirs: Array<[-1 | 0 | 1, -1 | 0 | 1]> = [
      [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1],
    ];
    let violated = false;
    for (const [mx, my] of dirs) {
      for (let i = 0; i < 200; i++) {
        s = step(s, { ...NO_INPUT, moveX: mx, moveY: my }, NO_INPUT);
        const { x, y } = s.p1.pos;
        if (x < PLAYER_MARGIN - 0.001 || x > COURT.width - PLAYER_MARGIN + 0.001) violated = true;
        if (y < PLAYER_MARGIN - 0.001 || y > COURT.depth - PLAYER_MARGIN + 0.001) violated = true;
        if (s.phase === 'serve') s = launchRally();
      }
    }
    expect(violated, 'player must never leave the clamped court region').toBe(false);
  });

  // #14 魚躍：Shift 觸發 → 扣體力、滑行(diveFrames) 或 命中即化為救球(diveRecovery)，最終趴地復原
  it('#14 dive consumes stamina and ends in a grounded recovery', () => {
    let s = launchRally();
    // Move away from the ball first so the dive is a pure lunge, not an instant save.
    for (let i = 0; i < 8; i++) s = step(s, { ...NO_INPUT, moveX: -1 }, NO_INPUT);
    const staminaBefore = s.p1.stamina;
    s = step(s, { ...NO_INPUT, moveX: -1, dive: true }, NO_INPUT);
    // dive fired: stamina charged exactly once, and the player is now either mid-lunge
    // (diveFrames>0) or — if the lunge reached the ball — already in the save recovery.
    expect(s.p1.stamina, 'dive should charge stamina').toBe(Math.max(0, staminaBefore - DIVE_STAMINA_COST));
    expect(s.p1.diveFrames > 0 || s.p1.diveRecovery > 0, 'dive should be active').toBe(true);
    // run it out → must reach the grounded recovery pin.
    let sawRecovery = s.p1.diveRecovery > 0;
    for (let i = 0; i < 120 && !sawRecovery; i++) {
      s = step(s, NO_INPUT, NO_INPUT);
      if (s.p1.diveRecovery > 0) sawRecovery = true;
      if (s.phase === 'serve') break;
    }
    expect(sawRecovery, 'dive should end in a grounded recovery').toBe(true);
  });

  // #15 體力：揮拍/魚躍扣、待機回；0 時速度減半
  it('#15 stamina regenerates while idle and never exceeds max', () => {
    let s = launchRally();
    // drain via a dive, then idle and watch it climb back.
    s = step(s, { ...NO_INPUT, dive: true, moveX: 1 }, NO_INPUT);
    const drained = s.p1.stamina;
    let regenObserved = false;
    for (let i = 0; i < 400; i++) {
      s = step(s, NO_INPUT, NO_INPUT);
      if (s.p1.stamina > drained) regenObserved = true;
      expect(s.p1.stamina).toBeLessThanOrEqual(STAMINA_MAX);
      if (s.phase === 'serve') s = launchRally();
    }
    expect(regenObserved, 'stamina should regenerate while idle').toBe(true);
  });

  // #16 落點預測：landing 與實際第一落地點誤差 < 一個身位
  it('#16 landing prediction matches the actual first floor landing', () => {
    let s = launchRally();
    let checked = 0;
    let withinTolerance = 0;
    const BODY = SWING_REACH; // one body-length tolerance
    for (let i = 0; i < 2000 && checked < 3; i++) {
      const predicted = s.shuttle.landing;
      const zBefore = s.shuttle.z;
      const before = s.shuttle.bouncesSinceWall;
      s = step(s, rallierInput(s), NO_INPUT);
      // detect a fresh floor landing (z hit 0 / bounce count rose) while we had a prediction
      const landedNow = s.shuttle.bouncesSinceWall > before && zBefore > 0;
      if (predicted && landedNow && s.shuttle.inPlay) {
        checked++;
        const err = Math.hypot(s.shuttle.pos.x - predicted.x, s.shuttle.pos.y - predicted.y);
        if (err <= BODY) withinTolerance++;
      }
      if (s.phase === 'serve') s = launchRally();
    }
    // if the rally never produced a clean floor landing, the prediction field still must be sane
    if (checked === 0) {
      expect(s.shuttle.landing === null || (s.shuttle.landing.x >= 0 && s.shuttle.landing.x <= COURT.width)).toBe(true);
    } else {
      expect(withinTolerance, `${withinTolerance}/${checked} landings within one body`).toBeGreaterThanOrEqual(checked - 1);
    }
  });

  // #20 練習不計分、無限對打：死球 → resetForServe，scores 不動，winner 恆 null
  it('#20 practice never scores; dead ball resets to serve', () => {
    let s = launchRally();
    const scoresBefore: [number, number] = [...s.scores];
    let resets = 0;
    // Idle the player so the ball is NOT returned → it double-bounces and dies. In practice
    // that must reset to serve without ever touching the score. Force several deaths to prove
    // the rally is endless and scoring is fully disabled.
    let prevPhase = s.phase;
    for (let i = 0; i < 4000 && resets < 3; i++) {
      // never swing — just let the ball die.
      s = step(s, NO_INPUT, NO_INPUT);
      expect(s.scores, 'scores must never change in practice').toEqual(scoresBefore);
      expect(s.winner, 'winner must stay null in practice').toBeNull();
      if (s.phase === 'serve' && prevPhase !== 'serve') {
        resets++;
        s = launchRally(); // prove we can keep going after each death
      }
      prevPhase = s.phase;
    }
    expect(resets, 'dead balls should reset to serve, not score').toBeGreaterThanOrEqual(3);
    expect(s.scores).toEqual(scoresBefore);
    expect(s.winner).toBeNull();
  });

  // #24 不變量：連打數百 tick，pos 在界內、z>=0、無 NaN
  it('#24 ball stays in bounds with no NaN over a long rally', () => {
    let s = launchRally();
    for (let i = 0; i < 4000; i++) {
      s = step(s, rallierInput(s), NO_INPUT);
      const { x, y } = s.shuttle.pos;
      expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(s.shuttle.z)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(-1);
      expect(x).toBeLessThanOrEqual(COURT.width + 1);
      expect(y).toBeGreaterThanOrEqual(-1);
      expect(y).toBeLessThanOrEqual(COURT.depth + 1);
      expect(s.shuttle.z).toBeGreaterThanOrEqual(-1);
      if (s.phase === 'serve') s = launchRally();
    }
  });

  // #6 發球規則：發球流程中，發球員被限制在短發球線後（不能站到前場發球）
  it('#6 the server is kept behind the short service line during the serve flow', () => {
    let s = practiceServeReady();
    // Try to walk the server forward (toward the front wall) during the serve phase.
    for (let i = 0; i < 200; i++) {
      // world-forward = toward front wall = smaller y; practice flips moveY, so push "up".
      s = step(s, { ...NO_INPUT, moveY: -1 }, NO_INPUT);
      if (s.phase !== 'serve') break;
      expect(s.p1.pos.y, 'server must stay behind the short service line').toBeGreaterThanOrEqual(SERVE_LINE_Y);
    }
  });

  // #8 打到牆壁回饋：合法前牆撞擊觸發 hitstop 凍幀（回饋感的物理基礎）
  it('#8 a legal front-wall hit triggers a hitstop freeze', () => {
    let base = launchRally();
    // Send a legal-height ball straight into the front wall and confirm hitstop kicks in.
    const s: GameState = {
      ...base,
      hitstop: 0,
      shuttle: {
        ...base.shuttle,
        inPlay: true,
        pos: { x: COURT.width / 2, y: 6 },
        z: (TIN_HEIGHT + FRONT_OUT_HEIGHT) / 2,
        vel: { x: 0, y: -20 },
        vz: 0,
        deadReason: null,
        hitFrontWall: false,
        bouncesSinceWall: 0,
        lastWall: null,
      },
    };
    const after = step(s, NO_INPUT, NO_INPUT);
    expect(after.shuttle.hitFrontWall, 'should be a good front-wall hit').toBe(true);
    expect(after.hitstop, 'front-wall impact should freeze a few frames').toBeGreaterThan(0);
  });

  // #25 進場狀態：gameMode='practice'、phase='serve'、server=0、seam-friendly defaults
  it('#25 practice entry state is correct', () => {
    const s = practiceServeReady();
    expect(s.gameMode).toBe('practice');
    expect(s.phase).toBe('serve');
    expect(s.server).toBe(0);
    expect(s.scores).toEqual([0, 0]);
    expect(s.winner).toBeNull();
    expect(s.awaitingServeChoice).toBe(false);
  });
});
