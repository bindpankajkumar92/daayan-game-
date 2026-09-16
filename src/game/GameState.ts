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

/**
 * How many times the Daayan may catch the player before the run ends.
 *
 * Three rather than one, because the escape is long — three puzzles across three storeys — and a
 * single mistake ending a twenty-minute run would make the whole house a punishment rather than a
 * place. Three lives is enough rope to learn her patrol routes by getting caught, and few enough that
 * being caught still costs something. This is the number the brief's §29 leaves open ("a
 * gameplay-specific result"), so it is here, in one place, rather than at the call site.
 */
export const STARTING_LIVES = 3;


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
  private lives = STARTING_LIVES;
  private deaths = 0;
  /**
   * The red key, and the hidden door it turns.
   *
   * Deliberately *not* a fourth `KeyId`. The three `KeyId`s are gate locks: they share one counter
   * (`locksRemaining`), one HUD row, and the rule that any of them may be turned in any order. The
   * hidden door is none of those things — it is one lock, behind one door, opened once, and it is not
   * part of the escape count. Folding it in would make `locksRemaining()` read 4 and put a fourth bolt
   * on a gate that has three.
   */
  private redKey = false;
  private hiddenOpen = false;

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

  /** Lives left, and whether the run is over. */
  getLives(): number {
    return this.lives;
  }

  isDead(): boolean {
    return this.lives <= 0;
  }

  /** How many times she has caught the player, for the debug overlay and the HUD. */
  getDeaths(): number {
    return this.deaths;
  }

  /** Whether the player is carrying the red key, and whether the hidden door has been unlocked. */
  hasRedKey(): boolean {
    return this.redKey;
  }

  isHiddenOpen(): boolean {
    return this.hiddenOpen;
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

  /** Take the red key. Idempotent, like `collectKey`. */
  collectRedKey(): boolean {
    if (this.redKey) return false;
    this.redKey = true;
    globalBus.emit('item:collected', { id: 'key-hidden', kind: 'key' });
    return true;
  }

  /**
   * Turn the red key in the hidden door. False when the key is not held or the door is already open,
   * so the caller can leave the prompt alone rather than playing feedback for nothing — the same
   * contract as `openLock`.
   */
  openHidden(): boolean {
    if (!this.redKey || this.hiddenOpen) return false;
    this.hiddenOpen = true;
    return true;
  }

  escape(): void {
    if (this.escaped) return;
    this.escaped = true;
    globalBus.emit('game:escaped', undefined as never);
  }

  /**
   * She caught the player. Spend a life and report whether the run continues.
   *
   * Returns true while the player still has a life left, so the caller knows whether to respawn them
   * at the bed or end the run — the *outcome* is this method's business, but what respawning actually
   * means (warp, overlay, toast) is the scene's, because only the scene knows where the bed is and
   * what is on the other side of the screen at the time.
   *
   * Guarded on `escaped` so a catch landing on the same frame as the ending cannot spend a life the
   * player has already earned their way out of.
   */
  caught(): boolean {
    if (this.escaped || this.isDead()) return false;
    this.deaths++;
    this.lives--;
    globalBus.emit('player:lives', { remaining: this.lives, atCheckpoint: 'bed' });
    return this.lives > 0;
  }

  /**
   * Full reset, for "begin again" after the last life.
   *
   * Everything progress-related goes back to its opening value, including tension — this is a *new
   * run*, not a continuation, and a player who has to start the three puzzles over should not also
   * begin with the house already at TERRIFYING. `deaths` deliberately survives, so a debug readout can
   * still say how the previous run went.
   */
  reset(): void {
    this.solved.clear();
    this.keys.clear();
    this.locks.clear();
    this.seen.clear();
    this.redKey = false;
    this.hiddenOpen = false;
    this.tension = 'NORMAL';
    this.escaped = false;
    this.lives = STARTING_LIVES;
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
