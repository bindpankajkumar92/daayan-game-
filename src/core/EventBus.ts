/**
 * Typed EventBus — decoupled pub/sub.
 * No dependencies on three.js (events pass plain payloads).
 */

import type { GameEventMap } from './types';

type Listener<T> = (payload: T) => void;

export class EventBus {
  private listeners = new Map<keyof GameEventMap, Set<Listener<unknown>>>();

  on<K extends keyof GameEventMap>(event: K, fn: Listener<GameEventMap[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as Listener<unknown>);
    return () => {
      set?.delete(fn as Listener<unknown>);
    };
  }

  off<K extends keyof GameEventMap>(event: K, fn: Listener<GameEventMap[K]>): void {
    this.listeners.get(event)?.delete(fn as Listener<unknown>);
  }

  emit<K extends keyof GameEventMap>(event: K, payload: GameEventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Copy to a snapshot so listeners can unsubscribe mid-iteration safely.
    for (const fn of [...set]) {
      try {
        (fn as Listener<GameEventMap[K]>)(payload);
      } catch (err) {
        // Don't let one broken listener take down the rest.
        // eslint-disable-next-line no-console
        console.error(`[EventBus] listener for "${String(event)}" threw:`, err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

/** Process-wide singleton. Tests can construct their own if they need isolation. */
export const globalBus = new EventBus();
