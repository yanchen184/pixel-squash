import type { InputSource, InputFrame } from './InputSource';
import type { Side } from '@/data/gameState';
import { getTouchIntent } from './touchControls';
import type { StrokeId } from '@/data/strokes';

/**
 * Keyboard controller for the human player (P1). Left hand MOVES, right hand SWINGS —
 * and the swing key you press picks the SHOT TYPE. SQUASH: both players share the
 * whole court and face the FRONT wall (y=0 at the top of the screen), so the axes map
 * straight through — UP moves you toward the front wall.
 *
 *   STROKE TYPE = which swing key you tap:
 *     J = 殺球 kill    (flat hard rail just above the tin — only on a HIGH ball)
 *     K = 小球 drop    (feathered touch into the front corner — only from near the front)
 *     L = 直線球 drive  (the straight rail, the safe default)
 *     U = 反角球 boast  (angle off a side wall — only when trapped near a side wall)
 *     Space = 高吊球 lob (float high to the back corners — the reset)
 *   Each is a press EDGE: tap to hit, time it against the ball. The sim still applies
 *   fault gates, so a kill on a low ball auto-downgrades to a drive.
 *
 *   LEFT/RIGHT on the FRONT WALL (左右落點) = your SWING TIMING (resolved in the sim, not
 *     here): swing a touch EARLY → the ball strikes the front wall LEFT; swing LATE → it
 *     strikes RIGHT; dead-on → centre. We send `timingAim:true` so the sim derives
 *     placement from timing.
 *
 *   DEPTH/height comes from the chosen stroke (kill low, lob high, …), so the move
 *   direction is purely positioning.
 *
 *   魚躍救球 dive = Shift, or the on-screen dive button.
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
    // Touch joystick (on-screen control) merges with the keyboard: either source past
    // the deadzone counts as that direction.
    const touch = getTouchIntent();
    const DZ = 0.35;
    const left = this.held.has('KeyA') || this.held.has('ArrowLeft') || touch.horiz < -DZ;
    const right = this.held.has('KeyD') || this.held.has('ArrowRight') || touch.horiz > DZ;
    const up = this.held.has('KeyW') || this.held.has('ArrowUp') || touch.vert < -DZ;
    const down = this.held.has('KeyS') || this.held.has('ArrowDown') || touch.vert > DZ;

    // Each stroke key is its own PRESS edge. Tap J/K/L/U/Space to swing that shot; the
    // sim times the contact against the ball. On-screen swing button supplies its own
    // selected stroke via touch.stroke. First key pressed THIS tick wins.
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

    // Dive (魚躍救球): Shift, or the on-screen dive button.
    const dive =
      this.held.has('ShiftLeft') ||
      this.held.has('ShiftRight') ||
      touch.dive;

    // SQUASH axis mapping: the player faces the FRONT wall (screen top = y 0). The
    // on-screen vertical (W/S, ↑/↓) maps DIRECTLY to logic Y (up = toward front wall =
    // moveY −1); the on-screen horizontal (A/D, ←/→) maps to logic X. No swap — unlike
    // the badminton fork, both axes read as they look on screen.
    const moveX: -1 | 0 | 1 = right && !left ? 1 : left && !right ? -1 : 0;
    const moveY: -1 | 0 | 1 = down && !up ? 1 : up && !down ? -1 : 0;

    // Stroke is picked by which key you tapped (above). Height/depth comes from the
    // stroke itself, so we don't fold the move dir into aimY. LEFT/RIGHT on the front
    // wall is derived by the sim from swing TIMING — we flag timingAim so it ignores
    // aimX and uses the timing.
    return {
      moveX,
      moveY,
      swing,
      stroke: stroke ?? 'drive',
      timingAim: true,
      dive,
      aimX: 0,
      aimY: 0,
      serveLeft: left,
      serveRight: right,
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
  ['KeyJ', 'kill'],
  ['KeyK', 'drop'],
  ['KeyL', 'drive'],
  ['KeyU', 'boast'],
  ['Space', 'lob'],
];

const SWING_KEYS = new Set(['Space', 'KeyJ', 'KeyK', 'KeyL', 'KeyU', 'ShiftLeft', 'ShiftRight']);
const MOVE_KEYS = new Set([
  'KeyA', 'KeyD', 'KeyW', 'KeyS',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
]);
