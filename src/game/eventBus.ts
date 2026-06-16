/**
 * Local pub/sub bridging Phaser <-> React.
 *
 * Phase-2 seam: in online play this same emitter interface is replaced by a
 * server socket listener; neither Phaser nor React code needs to change as long
 * as they only talk through these events.
 */

export type GameEvents = {
  'score:changed': { scores: [number, number] };
  'stamina:changed': { p1: number; p2: number };
  'match:over': { winner: 0 | 1; scores: [number, number] };
  'rally:point': { scoredBy: 0 | 1 };
  'sim:reset': undefined;
  /** Human player must choose a service box (true = waiting, false = chosen/not waiting). */
  'serve:awaiting': { waiting: boolean };
};

type Handler<T> = (payload: T) => void;

class EventBus {
  private handlers = new Map<keyof GameEvents, Set<Handler<unknown>>>();

  on<K extends keyof GameEvents>(event: K, handler: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<unknown>);
    return () => set!.delete(handler as Handler<unknown>);
  }

  emit<K extends keyof GameEvents>(event: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      (handler as Handler<GameEvents[K]>)(payload);
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

export const eventBus = new EventBus();
