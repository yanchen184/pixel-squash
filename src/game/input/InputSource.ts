import type { GameState, Side } from '@/data/gameState';
import { DEFAULT_STROKE, type StrokeId } from '@/data/strokes';

/**
 * Per-tick intent from a controller. -1/0/1 movement axes + a swing flag, plus the
 * stroke the player wants on this swing (chosen by modifier keys; see LocalInput).
 *
 * Phase-2 seam: AIInput and LocalInput both implement this. Online play swaps in
 * a NetworkedInputSource with the same shape — the sim never knows the difference.
 */
export type InputFrame = {
  moveX: -1 | 0 | 1;
  moveY: -1 | 0 | 1;
  /**
   * Swing intent for THIS tick. This is an EDGE (just-pressed), not a held flag:
   * the player commits a swing on one tick and its timing (how close the shuttle is
   * to the ideal contact moment) decides the quality AND the left/right placement.
   * Holding the key does nothing after the first tick — you must time each swing.
   */
  swing: boolean;
  /**
   * Which stroke to play if `swing` connects this tick. Now ALWAYS explicit: the human
   * picks it with a dedicated key (J=smash, K=drop, L=drive, Space=clear) and the AI
   * names it from tactics. The sim still applies each stroke's fault gate, so e.g. a
   * smash on a low ball auto-downgrades to a clear rather than whiffing.
   */
  stroke: StrokeId;
  /**
   * Placement source for left/right. When true, the sim DERIVES aimX from swing timing
   * (early = left, late = right, dead-on = center) and ignores the `aimX` field — this
   * is how the human plays: pick the stroke with a key, place it with your timing. When
   * false, the controller's explicit `aimX` is used (the AI's tactical placement).
   */
  timingAim: boolean;
  /**
   * Desired return placement in the opponent's half.
   *   aimX: continuous left↔right, −1 (full left) … 0 (center) … +1 (full right).
   *     Used only when `timingAim` is false (the AI). For the human it's derived from
   *     swing timing instead and this field is ignored.
   *   aimY: continuous depth, −1 (net) … 0 (mid) … +1 (deep baseline). The AI may set
   *     it for tactical depth; the human's depth now comes from the chosen stroke, so
   *     LocalInput leaves it 0.
   */
  aimX: number;
  aimY: number;
  /**
   * Diving save intent. When set, the player lunges along their current move
   * direction (or toward the shuttle if standing still) for a few frames with an
   * extended reach, then crashes to the floor. Ignored if already diving/recovering
   * or too low on stamina.
   */
  dive: boolean;
  /**
   * Service box choice, only meaningful during awaitingServeChoice phase.
   * serveLeft = choose left box (0), serveRight = choose right box (1).
   */
  serveLeft: boolean;
  serveRight: boolean;
  /**
   * AI-only unforced error on THIS swing. The human faults from real swing timing
   * (`timingAim`); the AI has no timing, so it injects a SYNTHETIC mistime here to
   * earn the same out-of-bounds / net faults a human risks. Sign + magnitude mirror a
   * timing delta (dt): POSITIVE = an "early" over-hit that sails the shuttle LONG (出界);
   * NEGATIVE = a "late" under-hit that dies in the tape (掛網). 0 = a clean shot (default,
   * and always 0 for the human, whose faults come from `timingAim` instead). The sim feeds
   * this through the exact same depth-error + net-dip path as a human mistime, so both
   * sides fault by one shared rule.
   */
  faultBias?: number;
};

export const NO_INPUT: InputFrame = { moveX: 0, moveY: 0, swing: false, stroke: DEFAULT_STROKE, timingAim: false, aimX: 0, aimY: 0, dive: false, serveLeft: false, serveRight: false, faultBias: 0 };

export interface InputSource {
  /** Which side this source controls. */
  readonly side: Side;
  /** Sample intent for the upcoming tick. May read current state (AI does). */
  sample(state: GameState): InputFrame;
  /** Reset any internal timers (called on serve/point). */
  reset?(): void;
}
