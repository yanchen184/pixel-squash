import { createInitialState, type GameState, type GameMode } from '@/data/gameState';
import { step } from './simulate';
import type { InputSource } from '@/game/input/InputSource';

/**
 * Drives the deterministic sim at a fixed 60Hz independent of render framerate,
 * using an accumulator. Render reads the latest state for interpolation-free
 * (good enough at 60Hz) drawing.
 */
const TICK_MS = 1000 / 60;
const MAX_STEPS_PER_FRAME = 5; // avoid spiral-of-death after a long stall

export class SimRunner {
  private state: GameState = createInitialState();
  private accumulator = 0;

  constructor(private inputA: InputSource, private inputB: InputSource) {}

  get current(): GameState {
    return this.state;
  }

  /**
   * DEV/E2E-only seam. Lets a headless test read sim state, overwrite either player's
   * input source (setInputA / setInputB) — e.g. swap an AI onto BOTH sides to drive a
   * full self-playing hard-vs-hard match — and force a fresh state. Kept here (the sim's
   * owner) so E2E never reaches into private renderer fields. Guard the call site behind
   * `import.meta.env.DEV`.
   */
  debugApi() {
    return {
      state: (): GameState => this.state,
      setInputA: (src: InputSource): void => { this.inputA = src; },
      setInputB: (src: InputSource): void => { this.inputB = src; },
      reset: (): void => this.reset(),
      // Shallow-merge a patch into the live state (immutable replace). Used by E2E
      // to arm a deterministic scenario (e.g. an out-of-reach incoming ball) between
      // ticks. The next step() overwrites it, so callers re-apply each poll.
      patch: (p: Partial<GameState>): void => { this.state = { ...this.state, ...p }; },
    };
  }

  private gameMode: GameMode = 'match';

  setGameMode(mode: GameMode): void {
    this.gameMode = mode;
  }

  reset(): void {
    this.state = { ...createInitialState(), gameMode: this.gameMode };
    this.accumulator = 0;
    this.inputA.reset?.();
    this.inputB.reset?.();
  }

  /** Advance by real elapsed ms; returns how many ticks ran. */
  update(deltaMs: number): number {
    this.accumulator += deltaMs;
    let steps = 0;
    while (this.accumulator >= TICK_MS && steps < MAX_STEPS_PER_FRAME) {
      const a = this.inputA.sample(this.state);
      const b = this.inputB.sample(this.state);
      this.state = step(this.state, a, b);
      this.accumulator -= TICK_MS;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;
    return steps;
  }
}
