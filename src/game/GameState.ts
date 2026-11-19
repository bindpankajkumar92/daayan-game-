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

/**
 * The mission chain's milestones (see docs/mission-flow.md): the hidden door cracked by its
 * coordinates, the basement screen's code entered, and the son's coffin burned.
 */
export type PuzzleId = 'hidden-door' | 'screen-code' | 'coffin-burn';
/**
 * The main door's three keys, one per lock. `key-father` is with the diary in the hidden room,
 * `key-coffin` beside the son's bones; `key-second` is still to be designed (see HouseScene's
 * SECOND_KEY_PENDING).
 */
export type KeyId = 'key-father' | 'key-second' | 'key-coffin';
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

/** Gate lock order, left to right in the HUD. */
export const GATE_KEYS: readonly KeyId[] = ['key-father', 'key-second', 'key-coffin'];

/** Human names, used by the HUD and the gate prompt. */
export const KEY_NAME: Record<KeyId, string> = {
  'key-father': "Father's Key",
  'key-second': 'Second Key',
  'key-coffin': 'Coffin Key',
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
  /** The hidden door upstairs, cracked once the player stands at the coordinates in the note. */
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

  /**
   * Has this clue been read? A pure query, unlike `markSeen`.
   *
   * The two are not interchangeable: `markSeen` *consumes* the first-read flag and returns whether
   * this call was that first read, so calling it merely to test the flag makes the real handler see
   * a second read and silently drop its one-off beat. Anything that wants to add a side effect to
   * another handler's first run — as the hidden-room book does with its key — must ask with this.
   */
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

  /**
   * Crack the hidden door. The caller (HiddenDoor) decides *whether* it may open — the player has to
   * be standing on the coordinates — so this only records it. False when it is already open, so the
   * caller can skip the feedback, the same contract as `openLock`.
   */
  openHidden(): boolean {
    if (this.hiddenOpen) return false;
    this.hiddenOpen = true;
    this.solve('hidden-door');
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
