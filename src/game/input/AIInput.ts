import type { InputSource, InputFrame } from './InputSource';
import {
  type GameState,
  type Side,
  type Vec2,
  COURT,
  SWING_REACH,
  SWING_REACH_Z,
  DIVE_REACH_BONUS,
  DIVE_MIN_STAMINA,
  TIMING_WINDOW,
  T_SPOT,
  PLAYER_MARGIN,
} from '@/data/gameState';
import { GRAVITY } from '@/game/sim/simulate';
import { STROKES, distToFrontWall, type StrokeId } from '@/data/strokes';

export type Difficulty = 'easy' | 'medium' | 'hard';

/**
 * AI difficulty knobs. Three difficulties differ ONLY in these params (per the
 * locked design): reaction delay, landing-prediction accuracy, and fumble rate.
 * Same decision loop, different numbers.
 *
 * SQUASH note: both players share the WHOLE court and face the FRONT wall (y=0).
 * "My ball to return" is the ball that's live and the OPPONENT struck last (or a
 * serve aimed at me). After hitting, the AI scrambles back toward the T (centre).
 */
type AIParams = {
  reactionDelay: number;
  predictionAccuracy: number; // 0..1 — landing-spot prediction error radius
  /**
   * Fraction of PLAYER_SPEED the AI uses per tick (stochastic gate per axis).
   * rng < speedFactor → move that axis, else hold. Hard AI = 1.0 (always moves).
   */
  speedFactor: number; // 0.5..1.0
  idleRate: number; // kept at 0 — AI always chases; difficulty from reaction/prediction
  fumbleRate: number; // 0..1 — chance the AI whiffs even when in reach
  faultRate: number; // 0..1 — chance a swing is an unforced error (OUT or TIN)
  deadzone: number; // px slop around target before movement stops
  /**
   * Tactical aggression 0..1. Controls how often pickStroke selects a positional shot
   * instead of a safe drive. 0 = always drive (easy), 1 = full tactical play (hard).
   */
  aggression: number;
};

const PARAMS: Record<Difficulty, AIParams> = {
  // Difficulty via reaction/prediction — not by ignoring balls (idleRate=0 for all).
  // aggression: easy=mostly safe drives, medium=occasional tactical, hard=full positional.
  // Win-rate ranking comes from reactionDelay + predictionAccuracy, not aggression.
  //                         react  predAcc  speed  idle  fumble  fault  dead   aggr
  easy:   { reactionDelay: 20, predictionAccuracy: 0.32, speedFactor: 0.78, idleRate: 0.00, fumbleRate: 0.14, faultRate: 0.14, deadzone: 38, aggression: 0.20 },
  medium: { reactionDelay:  7, predictionAccuracy: 0.76, speedFactor: 0.90, idleRate: 0.00, fumbleRate: 0.07, faultRate: 0.06, deadzone: 22, aggression: 0.55 },
  hard:   { reactionDelay:  2, predictionAccuracy: 0.96, speedFactor: 1.00, idleRate: 0.00, fumbleRate: 0.02, faultRate: 0.01, deadzone: 12, aggression: 1.00 },
};

/**
 * Deterministic-friendly AI. Seeded LCG instead of Math.random so a given
 * (seed, state-sequence) replays identically. Far side (1) by default.
 */
export class AIInput implements InputSource {
  readonly side: Side;
  private p: AIParams;
  private rngState: number;
  private reactCountdown = 0;
  private lastHitterSign = 0;
  private target: Vec2;
  private fumbleThisShuttle = false;
  private practiceMode = false;
  /** Per-ball prediction error offset, rolled once when ball changes hands. */
  private predErrX = 0;
  private predErrY = 0;
  /**
   * Synthetic mistime for THIS ball: 0 = clean, >0 = an over-hit that'll sail OUT (above
   * the out line), <0 = an under-hit that'll die in the TIN. Rolled once per incoming ball
   * (like fumble) so the AI commits to one fate per ball instead of flickering tick-to-tick.
   */
  private faultBiasThisShuttle = 0;
  private wasInPlay = false;

  constructor(difficulty: Difficulty, side: Side = 1, seed = 0x2545f491) {
    this.side = side;
    this.p = PARAMS[difficulty];
    this.rngState = seed >>> 0;
    this.target = this.home();
  }

  setDifficulty(difficulty: Difficulty): void {
    this.p = PARAMS[difficulty];
  }

  setPracticeMode(on: boolean): void {
    this.practiceMode = on;
  }

  reset(): void {
    this.reactCountdown = 0;
    this.lastHitterSign = 0;
    this.fumbleThisShuttle = false;
    this.faultBiasThisShuttle = 0;
    this.wasInPlay = false;
    this.predErrX = 0;
    this.predErrY = 0;
    this.target = this.home();
  }

  private rng(): number {
    this.rngState = (Math.imul(this.rngState, 1664525) + 1013904223) >>> 0;
    return this.rngState / 0xffffffff;
  }

  sample(state: GameState): InputFrame {
    const me = this.side === 0 ? state.p1 : state.p2;
    const opp = this.side === 0 ? state.p2 : state.p1;
    const shuttle = state.shuttle;

    // SQUASH: the ball is "mine to return" when it's live and I am NOT the last striker
    // (the opponent just hit it, or it's a serve I must receive). There's no half-court
    // split — the whole floor is shared, so reach is purely distance-based.
    const mineToReturn = shuttle.inPlay && shuttle.lastHitBy !== this.side;

    // Fresh exchange -> (re)react. Two triggers, OR'd:
    //   1. striker change: the opponent just hit it back to me mid-rally.
    //   2. inPlay false->true edge: a SERVE just launched (a brand-new ball).
    // The serve edge is essential — without it, a serve whose striker matches the
    // previous rally's final striker never flips, so a stale `fumbleThisShuttle` from
    // an earlier ball sticks and the receiver fumbles EVERY serve forever (the
    // deterministic rally-collapse bug). Preserved from the badminton fork.
    const hitterSign = shuttle.lastHitBy === null ? 0 : shuttle.lastHitBy === this.side ? 1 : -1;
    const serveLaunched = shuttle.inPlay && !this.wasInPlay;
    const hitterChanged = hitterSign !== 0 && hitterSign !== this.lastHitterSign;
    this.wasInPlay = shuttle.inPlay;
    if (hitterSign !== 0) this.lastHitterSign = hitterSign;

    if ((hitterChanged || serveLaunched) && mineToReturn) {
      this.reactCountdown = this.p.reactionDelay;
      this.fumbleThisShuttle = this.rng() < this.p.fumbleRate;
      // Unforced error roll: a swing the AI DOES make can be a fault. A fumble already
      // means no contact, so only roll a fault when not fumbling. Sign picks the fate
      // 50/50: a positive bias over-hits OUT (above the out line), negative under-hits
      // into the TIN. Magnitude sits past TIMING_WINDOW so the shared timing-fault ramps
      // to a real fault (severity → 1), with jitter so the out shots don't all land alike.
      if (!this.fumbleThisShuttle && this.rng() < this.p.faultRate) {
        const mag = TIMING_WINDOW + 3 + this.rng() * 4;
        this.faultBiasThisShuttle = this.rng() < 0.5 ? mag : -mag;
      } else {
        this.faultBiasThisShuttle = 0;
      }
      // Roll prediction error ONCE per ball — locks the AI onto the wrong target for the
      // whole rally leg. Re-rolling every tick averages to zero, killing the easy/medium
      // skill gap. A real squash player reads the ball once and commits.
      this.predErrX = (this.rng() * 2 - 1) * (1 - this.p.predictionAccuracy) * (COURT.width * 0.30);
      this.predErrY = (this.rng() * 2 - 1) * (1 - this.p.predictionAccuracy) * (COURT.depth * 0.25);
      this.target = this.predictLanding(state);
    }

    if (this.reactCountdown > 0) {
      this.reactCountdown--;
      // Even during reaction delay, recover toward T rather than standing still.
      return this.moveToward(me.pos, T_SPOT, false);
    }

    if (mineToReturn) {
      // Update target each tick so physics integration (ball moving) refines the aim,
      // but predErrX/predErrY are fixed per ball — no re-rolling of random error here.
      this.target = this.predictLanding(state);
    } else {
      // Not my ball — recover toward the T (centre-court control position).
      this.target = T_SPOT;
    }

    const distToShuttle = this.dist(me.pos, shuttle.pos);
    const inReach = mineToReturn && distToShuttle < SWING_REACH && shuttle.z <= SWING_REACH_Z;
    const swing = inReach && me.swingCooldown === 0 && !this.fumbleThisShuttle;
    // Practice mode: AI always lobs to give the human predictable balls to return.
    // aggression gate: roll once — if below aggression threshold, play a tactical shot,
    // otherwise fall back to safe drive.
    const useTactics = !this.practiceMode && this.rng() < this.p.aggression;
    const stroke = swing ? (this.practiceMode ? 'lob' : useTactics ? this.pickStroke(me.pos, shuttle.z, shuttle.pos, opp.pos, state.momentum) : 'drive') : 'drive';

    // Diving save: the ball is mine + incoming, just out of normal reach but within the
    // dive's extended reach, and I'm not already committed / too gassed. A reflex lunge
    // to keep the rally alive — never wasted on an easy ball.
    const diveReach = SWING_REACH + DIVE_REACH_BONUS;
    const wantDive =
      mineToReturn &&
      !inReach &&
      me.swingCooldown === 0 &&
      me.diveFrames === 0 &&
      me.diveRecovery === 0 &&
      me.stamina >= DIVE_MIN_STAMINA &&
      !this.fumbleThisShuttle &&
      distToShuttle < diveReach &&
      shuttle.z <= SWING_REACH_Z + DIVE_REACH_BONUS;

    // Only carry the fault bias onto a real swing (a dive or a fumble shouldn't leak it).
    const faultBias = swing ? this.faultBiasThisShuttle : 0;
    return this.moveToward(me.pos, this.target, swing, stroke, wantDive, faultBias);
  }

  /**
   * Choose a stroke based on ball position, contact height, AND opponent position.
   * Core strategic principle: attack the space opposite to where the opponent stands.
   *
   * Opponent positioning shapes three tactical reads:
   *   - Opponent at T (centre) → play corners (drop or boast) to force movement
   *   - Opponent deep → drop short to the front, dragging them forward
   *   - Opponent near front → lob long to the back corners, driving them back
   *   - Opponent on one side → play the opposite side (cross-court drive or lob)
   *
   * Physical fault gates (kill height, drop distance, boast angle) are checked first
   * so the AI never picks a shot that's guaranteed to misfire.
   */
  private pickStroke(pos: Vec2, z: number, ballPos: Vec2, oppPos: Vec2, momentum = 0): StrokeId {
    // Mirror the sim's fault gates so the AI never picks a guaranteed misfire.
    const killFault = STROKES.kill.fault;
    const canKill = killFault?.kind === 'min-contact-z' ? z >= killFault.z : true;

    const dropFault = STROKES.drop.fault;
    const nearFront =
      dropFault?.kind === 'max-front-dist' && distToFrontWall(pos) <= dropFault.dist;

    const boastFault = STROKES.boast.fault;
    const nearSide =
      boastFault?.kind === 'need-angle' &&
      Math.min(ballPos.x, COURT.width - ballPos.x) <= boastFault.maxX;

    const deep = distToFrontWall(pos) > COURT.depth * 0.6;

    // Opponent positional reads
    const oppDistFront = distToFrontWall(oppPos);
    const oppDeep   = oppDistFront > COURT.depth * 0.55; // opponent stuck at back
    const oppFront  = oppDistFront < COURT.depth * 0.35; // opponent up front
    const oppAtT    = this.dist(oppPos, T_SPOT) < COURT.depth * 0.22; // opponent at the T
    // Is the opponent on the same side as the ball? If so, the OTHER side is open.
    const oppSameSide = (oppPos.x < COURT.width / 2) === (ballPos.x < COURT.width / 2);

    // --- Tactically triggered shots (opponent-aware, randomised so AI isn't robotic) ---

    // Momentum rubber-band: when AI is leading (momentum < -2), play more conservatively
    // with lobs; when losing badly (momentum > 2), push aggressive kills/drops.
    const aggressive = momentum > 2;
    const defensive = momentum < -2;

    if (defensive && deep && this.rng() < 0.55) return 'lob'; // safe reset when winning comfortably
    if (aggressive && canKill && nearFront && this.rng() < 0.65) return 'kill'; // attack when behind

    // Opponent deep + I'm near front → kill or drop to punish their over-run
    if (nearFront && oppDeep && canKill && this.rng() < 0.55) return 'kill';
    if (nearFront && oppDeep && this.rng() < 0.50) return 'drop';

    // Opponent at T covering the court → push them to a corner with boast or drop
    if (oppAtT && nearSide && this.rng() < 0.45) return 'boast';
    if (oppAtT && nearFront && this.rng() < 0.40) return 'drop';

    // Opponent up front → lob to drive them back to the service boxes
    if (oppFront && this.rng() < 0.55) return 'lob';

    // Opponent on same side as ball → cross-court drive to the open side
    if (oppSameSide && !deep && this.rng() < 0.35) return 'drive';

    // --- Positional fall-backs (ball+player position only) ---
    if (canKill && nearFront && this.rng() < 0.50) return 'kill';
    if (nearSide && this.rng() < 0.35) return 'boast'; // trapped on wall → angle out
    if (nearFront && this.rng() < 0.45) return 'drop'; // up front → feather it
    if (deep && this.rng() < 0.50) return 'lob'; // stuck deep → reset high

    return 'drive'; // safe default rail
  }

  private moveToward(
    cur: Vec2,
    target: Vec2,
    swing: boolean,
    stroke: StrokeId = 'drive',
    dive = false,
    faultBias = 0,
  ): InputFrame {
    const dx = target.x - cur.x;
    const dy = target.y - cur.y;
    // speedFactor < 1 → stochastically suppress movement inputs so the AI effectively
    // moves slower. Each axis is independently gated: rng < speedFactor → move, else hold.
    // This is the primary easy/hard differentiator: a slow AI simply doesn't arrive in time.
    const sf = this.p.speedFactor;
    const moveX = Math.abs(dx) <= this.p.deadzone ? 0
      : (sf >= 1.0 || this.rng() < sf) ? (dx > 0 ? 1 : -1) : 0;
    const moveY = Math.abs(dy) <= this.p.deadzone ? 0
      : (sf >= 1.0 || this.rng() < sf) ? (dy > 0 ? 1 : -1) : 0;
    // The AI gives no explicit aim — it relies on the stroke's natural auto-placement
    // (centre-of-front-wall rail). aimX/aimY = 0 selects that fallback in the sim. It uses
    // explicit (named) strokes, so timingAim is false (no timing-based left/right — that's
    // the human's mechanic). `faultBias` injects an unforced error on this swing
    // (out/tin), which the sim runs through the same timing-fault path as a human mistime.
    return { moveX, moveY, swing, stroke, timingAim: false, dive, aimX: 0, aimY: 0, faultBias, serveLeft: false, serveRight: false };
  }

  /** Predict where the ball crosses the AI's strike height, with error. */
  private predictLanding(state: GameState): Vec2 {
    const s = state.shuttle;
    // Use the pre-rolled per-ball error (set once when ball changes hands).
    // This locks the AI onto a committed (possibly wrong) target for the whole leg —
    // re-rolling every tick would average to zero and kill the easy/hard skill gap.
    const errX = this.predErrX;
    const errY = this.predErrY;
    // The sim already forward-integrates the ball's first floor landing (after wall
    // bounces). Trust it when present — it's the honest target a real player chases.
    if (s.landing) {
      const px = clamp(s.landing.x, PLAYER_MARGIN, COURT.width - PLAYER_MARGIN);
      const py = clamp(s.landing.y, PLAYER_MARGIN, COURT.depth - PLAYER_MARGIN);
      return { x: clamp(px + errX, PLAYER_MARGIN, COURT.width - PLAYER_MARGIN), y: clamp(py + errY, PLAYER_MARGIN, COURT.depth - PLAYER_MARGIN) };
    }

    // Fallback: solve time to descend to a comfortable strike height (z(t)=strikeZ).
    // z(t) = z0 + vz*t - 0.5*g*t^2
    const strikeZ = 60;
    const a = 0.5 * GRAVITY;
    const b = -s.vz;
    const c = strikeZ - s.z;
    const disc = b * b - 4 * a * c;
    let t = 28;
    if (disc >= 0) {
      const root = (-b + Math.sqrt(disc)) / (2 * a);
      if (root > 0) t = root;
    }
    let px = s.pos.x + s.vel.x * t;
    let py = s.pos.y + s.vel.y * t;
    px = clamp(px, PLAYER_MARGIN, COURT.width - PLAYER_MARGIN);
    py = clamp(py, PLAYER_MARGIN, COURT.depth - PLAYER_MARGIN);

    return { x: px + errX, y: py + errY };
  }

  /** Recovery home is the T (court centre) — the squash neutral position. */
  private home(): Vec2 {
    return { x: T_SPOT.x, y: T_SPOT.y };
  }

  private dist(a: Vec2, b: Vec2): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
