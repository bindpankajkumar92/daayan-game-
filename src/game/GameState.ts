/**
 * GameState — the single owner of escape progress.
 *
 * Three things live here and nowhere else: which puzzles are solved, which keys the player
 * holds, and which gate locks are open. Every other module reads this and reacts; nothing keeps
 * its own copy. That is what lets the gate accept keys in any order (brief §7) without the gate
 * and the puzzles having to know about each other.
 *
 * Tension (brief §10) is also here rather than in the scene, because it is progress: it is a
 * monotonic ratchet driven by *discoveries*, not by a timer or by which room you are standing in.
 * Walking into the basement and walking back out does not calm the house down.
 */

import { globalBus } from '@/core/EventBus';

export type PuzzleId = 'ritual' | 'clock' | 'breaker';
/** One key per puzzle, and one gate lock per key. The names are the wiring. */
export type KeyId = 'key-ritual' | 'key-clock' | 'key-breaker';
export type Tension = 'NORMAL' | 'SUSPICIOUS' | 'DISTURBING' | 'TERRIFYING';

const TENSION_ORDER: Tension[] = ['NORMAL', 'SUSPICIOUS', 'DISTURBING', 'TERRIFYING'];

export const KEY_OF: Record<PuzzleId, KeyId> = {
  ritual: 'key-ritual',
  clock: 'key-clock',
  breaker: 'key-breaker',
};

/** Human names, used by the HUD and the gate prompt. */
export const KEY_NAME: Record<KeyId, string> = {
  'key-ritual': 'Iron Key',
  'key-clock': 'Brass Key',
  'key-breaker': 'Rusted Key',
};

export class GameState {
  private solved = new Set<PuzzleId>();
  private keys = new Set<KeyId>();
  private locks = new Set<KeyId>();
  /** Clue ids the player has actually read. Drives tension, so re-reading changes nothing. */
  private seen = new Set<string>();
  private tension: Tension = 'NORMAL';
  private escaped = false;

  // --- queries ---

  isSolved(p: PuzzleId): boolean {
    return this.solved.has(p);
  }

  hasKey(k: KeyId): boolean {
    return this.keys.has(k);
  }

  isLockOpen(k: KeyId): boolean {
    return this.locks.has(k);
  }

  keyCount(): number {
    return this.keys.size;
  }

  locksRemaining(): number {
    return 3 - this.locks.size;
  }

  hasSeen(id: string): boolean {
    return this.seen.has(id);
  }

  getTension(): Tension {
    return this.tension;
  }

  hasEscaped(): boolean {
    return this.escaped;
  }

  // --- mutations ---

  /** Mark a puzzle solved. Idempotent: a second call is a no-op, not a second key. */
  solve(p: PuzzleId): boolean {
    if (this.solved.has(p)) return false;
    this.solved.add(p);
    globalBus.emit('puzzle:solved', { id: p });
    return true;
  }

  collectKey(k: KeyId): boolean {
    if (this.keys.has(k)) return false;
    this.keys.add(k);
    globalBus.emit('item:collected', { id: k, kind: 'key' });
    return true;
  }

  /**
   * Turn a held key in its lock. Returns false if the player does not have it or the lock is
   * already open, so the caller can leave the prompt alone instead of playing feedback for
   * nothing.
   */
  openLock(k: KeyId): boolean {
    if (!this.keys.has(k) || this.locks.has(k)) return false;
    this.locks.add(k);
    globalBus.emit('gate:progress', { locksRemaining: this.locksRemaining() });
    return true;
  }

  gateUnlocked(): boolean {
    return this.locks.size === 3;
  }

  escape(): void {
    if (this.escaped) return;
    this.escaped = true;
    globalBus.emit('game:escaped', undefined as never);
  }

  /** Record a clue as read. Returns true the first time, so callers can gate a one-off beat. */
  markSeen(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    return true;
  }

  /**
   * Raise tension to at least `t`. Never lowers it — the brief's progression is one-way, and a
   * player who has seen the ritual room does not get to un-see it by going back upstairs.
   */
  raiseTension(t: Tension): void {
    const from = TENSION_ORDER.indexOf(this.tension);
    const to = TENSION_ORDER.indexOf(t);
    if (to <= from) return;
    this.tension = t;
    globalBus.emit('story:beat', { id: `tension:${t}` });
  }
}
