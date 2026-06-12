import type { InputSource, InputFrame } from './InputSource';
import type { Side } from '@/data/gameState';
import { getTouchIntent } from './touchControls';
import type { StrokeId } from '@/data/strokes';

/**
 * Keyboard controller for the human player (P1, left side). Left hand MOVES, right
 * hand SWINGS — and the swing key you press picks the SHOT TYPE:
 *
 *   STROKE TYPE = which swing key you tap:
 *     J = 殺球 smash   (fast, deep, downward kill — only on a high ball)
 *     K = 吊球 drop    (feathered net shot — only from near the net)
 *     L = 平抽 drive   (flat, quick straight push)
 *     Space = 高遠球 clear (the safe floaty deep default)
 *   Each is a press EDGE: tap to hit, time it against the shuttle. The sim still
 *   applies fault gates, so a smash on a low ball auto-downgrades to a clear.
 *
 *   LEFT/RIGHT (左右落點) = your SWING TIMING (resolved in the sim, not here): swing a
 *     touch EARLY → the ball goes LEFT; swing LATE → it goes RIGHT; dead-on → center.
 *     We send `timingAim:true` so the sim derives placement from timing.
 *
 *   DEPTH now comes from the chosen stroke (smash deep, drop net, …), so the move
 *   direction no longer doubles as depth — move is purely positioning.
 *
 *   魚躍救球 dive = Shift (K is now drop), or the on-screen dive button.
 *
 * Listens on window; the held-key set is sampled each tick so input is
 * frame-synchronous with the fixed-60Hz sim.
 */
export class LocalInput implements InputSource {
  readonly side: Side;
  private held = new Set<string>();
  /** Per-stroke-key held state on the PREVIOUS sample, for press-edge detection. */
  private heldLast = new Set<string>();
  /** On-screen swing button held state last sample (its own press edge). */
  private touchSwingLast = false;
  private onDown = (e: KeyboardEvent) => {
    this.held.add(e.code);
    if (SWING_KEYS.has(e.code) || MOVE_KEYS.has(e.code)) e.preventDefault();
  };
  private onUp = (e: KeyboardEvent) => {
    this.held.delete(e.code);
  };

  constructor(side: Side = 0) {
    this.side = side;
    window.addEventListener('keydown', this.onDown);
    window.addEventListener('keyup', this.onUp);
  }

  sample(): InputFrame {
    // Touch joystick (on-screen Kairo control) merges with the keyboard: either
    // source past the deadzone counts as that direction.
    const touch = getTouchIntent();
    const DZ = 0.35;
    const left = this.held.has('KeyA') || this.held.has('ArrowLeft') || touch.horiz < -DZ;
    const right = this.held.has('KeyD') || this.held.has('ArrowRight') || touch.horiz > DZ;
    const up = this.held.has('KeyW') || this.held.has('ArrowUp') || touch.vert < -DZ;
    const down = this.held.has('KeyS') || this.held.has('ArrowDown') || touch.vert > DZ;

    // Each stroke key is its own PRESS edge. Tap J/K/L/Space to swing that shot; the
    // sim times the contact against the shuttle. On-screen swing button supplies its
    // own selected stroke via touch.stroke. First key pressed THIS tick wins.
    let stroke: StrokeId | null = null;
    for (const [code, id] of STROKE_KEYS) {
      if (this.held.has(code) && !this.heldLast.has(code)) {
        stroke = id;
        break;
      }
    }
    const touchSwingEdge = touch.swing && !this.touchSwingLast;
    this.touchSwingLast = touch.swing;
    if (stroke === null && touchSwingEdge) stroke = touch.stroke;
    const swing = stroke !== null;

    // Remember this tick's stroke-key state for next-tick edge detection.
    this.heldLast.clear();
    for (const [code] of STROKE_KEYS) if (this.held.has(code)) this.heldLast.add(code);

    // Dive (魚躍救球): Shift (K is now the drop stroke), or the on-screen dive button.
    const dive =
      this.held.has('ShiftLeft') ||
      this.held.has('ShiftRight') ||
      touch.dive;

    // L↔R court: the screen's up/down axis is logic X; the screen's left/right
    // axis (toward/away from the vertical net) is logic Y. Map the keys to what
    // they LOOK like on screen, not to the raw logic axis names.
    //   ↑/↓ (screen vertical) → moveX   |   ←/→ (screen horizontal) → moveY
    const moveX: -1 | 0 | 1 = down && !up ? 1 : up && !down ? -1 : 0;
    const moveY: -1 | 0 | 1 = right && !left ? 1 : left && !right ? -1 : 0;

    // Stroke is now picked by which key you tapped (above). Depth comes from the stroke
    // itself, so we no longer fold the move dir into aimY. LEFT/RIGHT is derived by the
    // sim from swing TIMING — we flag timingAim so it ignores aimX and uses the timing.
    return {
      moveX,
      moveY,
      swing,
      stroke: stroke ?? 'clear',
      timingAim: true,
      dive,
      aimX: 0,
      aimY: 0,
    };
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onDown);
    window.removeEventListener('keyup', this.onUp);
    this.held.clear();
  }
}

/** Stroke selector keys → the shot they fire. Order = priority if several are pressed. */
const STROKE_KEYS: ReadonlyArray<readonly [string, StrokeId]> = [
  ['KeyJ', 'smash'],
  ['KeyK', 'drop'],
  ['KeyL', 'drive'],
  ['Space', 'clear'],
];

const SWING_KEYS = new Set(['Space', 'KeyJ', 'KeyK', 'KeyL', 'ShiftLeft', 'ShiftRight']);
const MOVE_KEYS = new Set([
  'KeyA', 'KeyD', 'KeyW', 'KeyS',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
]);
