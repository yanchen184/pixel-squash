import type { InputSource, InputFrame } from './InputSource';
import {
  type GameState,
  type Side,
  type Vec2,
  COURT,
  NET_Y,
  SWING_REACH,
  SWING_REACH_Z,
  DIVE_REACH_BONUS,
  DIVE_MIN_STAMINA,
  TIMING_WINDOW,
} from '@/data/gameState';
import { GRAVITY } from '@/game/sim/simulate';
import { STROKES, distToNet, type StrokeId } from '@/data/strokes';

export type Difficulty = 'easy' | 'medium' | 'hard';

/**
 * AI difficulty knobs. Three difficulties differ ONLY in these params (per the
 * locked design): reaction delay, landing-prediction accuracy, and fumble rate.
 * Same decision loop, different numbers. Now operates in the TOP-DOWN 2D court.
 */
type AIParams = {
  reactionDelay: number;
  predictionAccuracy: number; // 0..1
  fumbleRate: number; // 0..1 — chance the AI just whiffs/lets a ball go (no swing)
  /**
   * Chance a swing the AI DOES make is an unforced error — it sails out (出界) or dies in
   * the net (掛網), the same faults a human risks from bad timing. Higher on easy (a
   * beatable opponent that gifts points), near-zero on hard (a wall). Distinct from
   * fumbleRate: fumble = no contact; fault = contact, but a bad shot.
   */
  faultRate: number; // 0..1
  deadzone: number; // px slop around target before it stops shuffling
};

const PARAMS: Record<Difficulty, AIParams> = {
  easy: { reactionDelay: 10, predictionAccuracy: 0.5, fumbleRate: 0.22, faultRate: 0.2, deadzone: 28 },
  medium: { reactionDelay: 5, predictionAccuracy: 0.82, fumbleRate: 0.09, faultRate: 0.08, deadzone: 18 },
  hard: { reactionDelay: 2, predictionAccuracy: 1.0, fumbleRate: 0.02, faultRate: 0.02, deadzone: 10 },
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
  private lastTowardSign = 0;
  private target: Vec2;
  private fumbleThisShuttle = false;
  /**
   * Synthetic mistime for THIS shuttle: 0 = clean, >0 = an over-hit that'll sail OUT (出界),
   * <0 = an under-hit that'll die in the NET (掛網). Rolled once per incoming shuttle (like
   * fumble) so the AI commits to one fate per ball instead of flickering tick-to-tick.
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

  reset(): void {
    this.reactCountdown = 0;
    this.lastTowardSign = 0;
    this.fumbleThisShuttle = false;
    this.faultBiasThisShuttle = 0;
    this.wasInPlay = false;
    this.target = this.home();
  }

  private rng(): number {
    this.rngState = (Math.imul(this.rngState, 1664525) + 1013904223) >>> 0;
    return this.rngState / 0xffffffff;
  }

  sample(state: GameState): InputFrame {
    const me = this.side === 0 ? state.p1 : state.p2;
    const shuttle = state.shuttle;

    const onMyHalf = this.side === 0 ? shuttle.pos.y > NET_Y : shuttle.pos.y < NET_Y;
    // Incoming = heading toward my half (y velocity points my way).
    const incoming = shuttle.inPlay && (this.side === 0 ? shuttle.vel.y > 0 : shuttle.vel.y < 0);

    // Fresh trajectory -> (re)react. Two triggers, OR'd:
    //   1. toward-sign flip: the opponent just hit it back our way mid-rally.
    //   2. inPlay false->true edge: a SERVE just launched (a brand-new shuttle).
    // The serve edge is essential — without it, a serve whose direction matches the
    // previous rally's final motion never flips the sign, so a stale `fumbleThisShuttle`
    // from an earlier shuttle sticks and the receiver fumbles EVERY serve forever
    // (the deterministic rally-collapse bug).
    const towardSign = Math.sign(shuttle.vel.y);
    const serveLaunched = shuttle.inPlay && !this.wasInPlay;
    const signFlipped = towardSign !== 0 && towardSign !== this.lastTowardSign;
    this.wasInPlay = shuttle.inPlay;
    if (signFlipped) this.lastTowardSign = towardSign;
    if ((signFlipped || serveLaunched) && incoming) {
      this.reactCountdown = this.p.reactionDelay;
      this.fumbleThisShuttle = this.rng() < this.p.fumbleRate;
      // Unforced error roll: a swing the AI DOES make can be a fault. A fumble already
      // means no contact, so only roll a fault when not fumbling. Sign picks the fate
      // 50/50: a positive bias over-hits LONG (出界), negative under-hits into the NET (掛網).
      // Magnitude sits past TIMING_WINDOW so the shared depth-error/net-dip ramps to a real
      // fault (severity → 1), with a little jitter so the out shots don't all land identically.
      if (!this.fumbleThisShuttle && this.rng() < this.p.faultRate) {
        const mag = TIMING_WINDOW + 3 + this.rng() * 4;
        this.faultBiasThisShuttle = this.rng() < 0.5 ? mag : -mag;
      } else {
        this.faultBiasThisShuttle = 0;
      }
      this.target = this.predictLanding(state);
    }

    if (this.reactCountdown > 0) {
      this.reactCountdown--;
      return this.moveToward(me.pos, this.home(), false);
    }

    if (incoming) {
      this.target = this.predictLanding(state);
    } else if (!onMyHalf) {
      this.target = this.home();
    }

    const distToShuttle = this.dist(me.pos, shuttle.pos);
    const inReach = onMyHalf && distToShuttle < SWING_REACH && shuttle.z <= SWING_REACH_Z;
    const swing = inReach && me.swingCooldown === 0 && !this.fumbleThisShuttle;
    const stroke = swing ? this.pickStroke(me.pos, shuttle.z) : 'clear';

    // Diving save: the ball is on my half + incoming, just out of normal reach but
    // within the dive's extended reach, and I'm not already committed / too gassed.
    // A reflex lunge to keep the rally alive — never on an easy ball (would waste it).
    const diveReach = SWING_REACH + DIVE_REACH_BONUS;
    const wantDive =
      onMyHalf &&
      incoming &&
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
   * Choose a stroke that won't misfire, so the AI also varies its shots (a high
   * ball gets smashed, a net ball gets dropped, otherwise a safe clear). Respects
   * the same fault gates the sim enforces, so the AI never picks a guaranteed miss.
   */
  private pickStroke(pos: Vec2, z: number): StrokeId {
    // Mirror the sim's fault gates so the AI never picks a guaranteed misfire.
    const dropFault = STROKES.drop.fault;
    const nearNet = dropFault?.kind === 'max-net-dist' && distToNet(pos) <= dropFault.dist;
    const smashFault = STROKES.smash.fault;
    const canSmash = smashFault?.kind === 'min-contact-z' ? z >= smashFault.z : true;
    if (canSmash && this.rng() < 0.6) return 'smash';
    if (nearNet && this.rng() < 0.4) return 'drop';
    return 'clear';
  }

  private moveToward(
    cur: Vec2,
    target: Vec2,
    swing: boolean,
    stroke: StrokeId = 'clear',
    dive = false,
    faultBias = 0,
  ): InputFrame {
    const dx = target.x - cur.x;
    const dy = target.y - cur.y;
    const moveX = Math.abs(dx) <= this.p.deadzone ? 0 : dx > 0 ? 1 : -1;
    const moveY = Math.abs(dy) <= this.p.deadzone ? 0 : dy > 0 ? 1 : -1;
    // The AI gives no explicit aim — it relies on the stroke's natural auto-placement
    // (hit away from the human). aimX/aimY = 0 selects that fallback in the sim. It uses
    // explicit (named) strokes and explicit aim, so timingAim is false (no timing-based
    // left/right — that's the human's mechanic). `faultBias` injects an unforced error on
    // this swing (out/net), which the sim runs through the same fault path as a human mistime.
    return { moveX, moveY, swing, stroke, timingAim: false, dive, aimX: 0, aimY: 0, faultBias };
  }

  /** Predict where the shuttle crosses the AI's strike height, with error. */
  private predictLanding(state: GameState): Vec2 {
    const s = state.shuttle;
    // Solve time to descend to a comfortable strike height (z(t)=strikeZ).
    // z(t) = z0 + vz*t - 0.5*g*t^2
    const strikeZ = 60;
    const a = 0.5 * GRAVITY;
    const b = -s.vz;
    const c = strikeZ - s.z; // z0 - strikeZ moved over... solve a t^2 + b t + c = 0
    const disc = b * b - 4 * a * c;
    let t = 28;
    if (disc >= 0) {
      const root = (-b + Math.sqrt(disc)) / (2 * a);
      if (root > 0) t = root;
    }
    let px = s.pos.x + s.vel.x * t;
    let py = s.pos.y + s.vel.y * t;

    // Clamp to my half.
    px = clamp(px, 30, COURT.width - 30);
    py = this.side === 0 ? clamp(py, NET_Y + 20, COURT.depth - 30) : clamp(py, 30, NET_Y - 20);

    // Accuracy: inject error proportional to (1-acc). Kept modest so even an
    // imperfect AI still gets a racket on most balls (errors cost placement, not
    // a guaranteed whiff).
    const errX = (this.rng() * 2 - 1) * (1 - this.p.predictionAccuracy) * (COURT.width * 0.12);
    const errY = (this.rng() * 2 - 1) * (1 - this.p.predictionAccuracy) * (COURT.depth * 0.1);
    return { x: px + errX, y: py + errY };
  }

  private home(): Vec2 {
    return this.side === 0
      ? { x: COURT.width / 2, y: COURT.depth * 0.78 }
      : { x: COURT.width / 2, y: COURT.depth * 0.22 };
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
