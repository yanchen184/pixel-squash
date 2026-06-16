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
