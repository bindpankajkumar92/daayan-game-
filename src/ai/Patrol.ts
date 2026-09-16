/**
 * Patrol — where Daayan goes when she has nothing better to do, and why.
 *
 * §5 of the spec is unusually specific that this must not be random wandering: waypoints carry
 * metadata, and the next one is chosen by a weighted score rather than a dice roll. The reason is
 * legibility. Random patrol reads as aimless; *scored* patrol reads as purpose, because the player
 * eventually notices she keeps coming back to the room they are hiding in, and that feels like she is
 * looking for them.
 *
 * The waypoints below are authored, not generated, because their positions are a design statement
 * about the house: a corridor junction is worth standing in, the middle of a large empty room is not.
 * Each is snapped to the nav grid at construction, so a waypoint that lands inside a wall after a
 * layout change fails loudly here rather than silently beaching her.
 *
 * The scoring terms, all from §5's example:
 *
 *   score = distanceWeight × roomImportance × timeSinceLastVisit × recentPlayerActivity × randomness
 *
 * with the terms multiplied rather than summed so that a waypoint scoring zero on any important axis
 * — a room she has just left, one unconnected to where the player was last known — is genuinely
 * deprioritised rather than merely nudged down. That is what stops the classic failure where an AI
 * "patrols" by pacing between two adjacent points.
 *
 * A sixth term was added the day the playtest report said "she never comes upstairs", and the reason
 * it has to exist is worth recording. The five authored terms are all per-*point*, and the house is
 * not point-balanced: 37 of 42 waypoints sit on the ground floor and cellar, so at any moment there
 * is always an unvisited ground point within distance-boost range, and the five upstairs points win
 * a pick only when the randomness term happens to align — about one pick in fifteen. Over a real
 * play session that reads as *never*, which is exactly what was reported. Per-point terms cannot fix
 * a per-*storey* drought, so the score also multiplies by a storey-novelty term: the time since she
 * last stood on that floor, aged on the same scale as a point's own visit age.
 *
 * One subtlety in how it is applied: the boost goes to the **single most-neglected storey only**,
 * not to every storey by its own age. The first version aged all three independently, and once two
 * off-storeys both hit the cap their boosts cancelled and the *nearer* one won on the distance term
 * — she ping-ponged between the ground floor and the cellar shaft at the hallway's west end and
 * still never climbed east to the upper flat. Boosting only the most-neglected floor makes the pull
 * asymmetric: it wins one pick, she sweeps that floor, its age resets, and the pull moves on to the
 * next-neglected — a rotation that emerges from the scores rather than from a schedule.
 */

import type { Vec3 } from '@/core/types';
import type { DaayanConfig } from './DaayanConfig';
import type { NavGrid, NavPoint } from './NavGrid';

/** One authored navigation point, with the metadata §5 asks for. */
export interface Waypoint {
  id: string;
  /** Room id from HouseRooms, so behaviour can reason about *which room* she is in. */
  room: string;
  x: number;
  z: number;
  /**
   * How interesting this point is, 0..1. Authored: doorways and corridor junctions high, the centre of
   * a large room low, because standing in the open is not what a searching predator does.
   */
  importance: number;
  /** How long she should linger here, in seconds. A doorway merits more than a corner. */
  dwell: number;
  /** Ids of hiding spots this point overlooks, so a search can check them (§14). */
  overlooks: string[];
  /** Resolved grid position, filled in at construction. */
  nav: NavPoint | null;
  /** Game time she was last here. -Infinity before the first visit. */
  lastVisit: number;
  /** How many times she has stood here, for the anti-repetition term. */
  visits: number;
}

/**
 * The authored point set. Spread across all three storeys so patrol genuinely covers the house, with
 * the ritual room and the black-magic room absent on purpose: those are the endgame's rooms and she
 * should arrive there because the player led her, not because a patrol schedule said so.
 *
 * Positions are chosen against the actual layout (HouseRooms' constants):
 *   hall x -5..5 z -7..0 · hallway x -9..9 z 0..2.6 · bedroom x -9..-1 z 2.6..10.2
 *   living x -1..9 z 2.6..10.2 · backhall x -9..9 z 10.2..12.2
 *   kitchen x -9..-3 z 12.2..17.2 · pooja x -3..3 z 12.2..17.2 · store x 3..9 z 12.2..17.2
 *   basement x -22..-13.8 z -2..6.6 · upper x 14.4..24.45 z -1.93..9.28
 */
const AUTHORED: Omit<Waypoint, 'nav' | 'lastVisit' | 'visits'>[] = [
  // --- Ground floor: the main hall and its gate, where the player starts and must return. ---
  { id: 'hall-gate', room: 'hall', x: 0, z: -5.6, importance: 0.95, dwell: 3.0, overlooks: [] },
  { id: 'hall-centre', room: 'hall', x: 0, z: -3.2, importance: 0.55, dwell: 1.6, overlooks: [] },
  { id: 'hall-west', room: 'hall', x: -3.6, z: -4.6, importance: 0.6, dwell: 1.8, overlooks: [] },
  { id: 'hall-east', room: 'hall', x: 3.6, z: -4.6, importance: 0.6, dwell: 1.8, overlooks: [] },
  { id: 'hall-arch', room: 'hall', x: 0, z: -0.4, importance: 0.8, dwell: 2.2, overlooks: [] },

  // --- Hallway: the spine. The two doorways are the points that actually matter. ---
  { id: 'hallway-west', room: 'hallway', x: -7.4, z: 1.3, importance: 0.7, dwell: 2.0, overlooks: [] },
  { id: 'hallway-bedroom-door', room: 'hallway', x: -5, z: 1.6, importance: 0.85, dwell: 2.4, overlooks: ['bedroom-window'] },
  { id: 'hallway-centre', room: 'hallway', x: 0, z: 1.3, importance: 0.5, dwell: 1.4, overlooks: [] },
  { id: 'hallway-living-door', room: 'hallway', x: 5, z: 1.6, importance: 0.85, dwell: 2.4, overlooks: [] },
  { id: 'hallway-cellardoor', room: 'hallway', x: -8.4, z: 1.3, importance: 0.9, dwell: 2.6, overlooks: [] },
  { id: 'hallway-stair', room: 'hallway', x: 8.4, z: 1.3, importance: 0.9, dwell: 2.6, overlooks: [] },

  // --- Bedroom: the player's own hiding room. High importance, and the bed is its whole point. ---
  { id: 'bedroom-door', room: 'bedroom', x: -5, z: 3.8, importance: 0.85, dwell: 2.4, overlooks: ['bedroom-bed'] },
  { id: 'bedroom-centre', room: 'bedroom', x: -5, z: 6.6, importance: 0.6, dwell: 2.0, overlooks: [] },
  { id: 'bedroom-bedside', room: 'bedroom', x: -7.6, z: 8.6, importance: 0.95, dwell: 3.2, overlooks: ['bedroom-bed'] },
  { id: 'bedroom-far', room: 'bedroom', x: -3.2, z: 9.4, importance: 0.65, dwell: 2.0, overlooks: [] },

  // --- Living room: large, so the points sit near its edges and its wardrobe. ---
  { id: 'living-door', room: 'living', x: 5, z: 3.8, importance: 0.85, dwell: 2.4, overlooks: [] },
  { id: 'living-centre', room: 'living', x: 4.2, z: 6.4, importance: 0.5, dwell: 1.6, overlooks: [] },
  { id: 'living-wardrobe', room: 'living', x: 8.0, z: 8.8, importance: 0.95, dwell: 3.0, overlooks: ['living-wardrobe'] },
  { id: 'living-far', room: 'living', x: 1.2, z: 9.2, importance: 0.6, dwell: 1.8, overlooks: [] },

  // --- Back corridor: three doorways, so it is a natural thing to sweep. ---
  { id: 'backhall-west', room: 'backhall', x: -6, z: 11.2, importance: 0.8, dwell: 2.2, overlooks: [] },
  { id: 'backhall-centre', room: 'backhall', x: 0, z: 11.2, importance: 0.75, dwell: 2.0, overlooks: [] },
  { id: 'backhall-east', room: 'backhall', x: 6, z: 11.2, importance: 0.8, dwell: 2.2, overlooks: [] },
  { id: 'backhall-bedroomdoor', room: 'backhall', x: -5, z: 10.8, importance: 0.85, dwell: 2.4, overlooks: [] },
  { id: 'backhall-livingdoor', room: 'backhall', x: 7, z: 10.8, importance: 0.85, dwell: 2.4, overlooks: [] },

  // --- Kitchen, prayer room and store: the back of the house. ---
  { id: 'kitchen-door', room: 'kitchen', x: -6, z: 12.8, importance: 0.8, dwell: 2.2, overlooks: [] },
  { id: 'kitchen-centre', room: 'kitchen', x: -6, z: 14.8, importance: 0.55, dwell: 1.8, overlooks: [] },
  { id: 'kitchen-far', room: 'kitchen', x: -7.8, z: 16.4, importance: 0.6, dwell: 2.0, overlooks: [] },
  { id: 'pooja-door', room: 'pooja', x: 0, z: 12.8, importance: 0.85, dwell: 2.4, overlooks: [] },
  { id: 'pooja-centre', room: 'pooja', x: 0, z: 14.8, importance: 0.7, dwell: 2.6, overlooks: [] },
  { id: 'store-door', room: 'store', x: 6, z: 12.8, importance: 0.8, dwell: 2.2, overlooks: [] },
  { id: 'store-centre', room: 'store', x: 6, z: 14.8, importance: 0.6, dwell: 1.8, overlooks: [] },

  // --- Cellar stair and basement: the way down, and the floor the ritual room opens off. ---
  { id: 'shaft-top', room: 'shaft', x: -9.4, z: 1.3, importance: 0.85, dwell: 2.4, overlooks: [] },
  { id: 'shaft-bottom', room: 'shaft', x: -13.2, z: 1.3, importance: 0.8, dwell: 2.0, overlooks: [] },
  { id: 'basement-west', room: 'basement', x: -20.4, z: 2.4, importance: 0.7, dwell: 2.2, overlooks: [] },
  { id: 'basement-centre', room: 'basement', x: -17.6, z: 2.2, importance: 0.6, dwell: 2.0, overlooks: [] },
  { id: 'basement-ritualdoor', room: 'basement', x: -21.4, z: 2.3, importance: 0.95, dwell: 3.0, overlooks: [] },
  { id: 'basement-north', room: 'basement', x: -17.6, z: 5.6, importance: 0.55, dwell: 1.8, overlooks: [] },

  // --- Upper storey: the apartment above, its store, child's room and shrine. ---
  { id: 'upshaft-top', room: 'upshaft', x: 13.8, z: 1.3, importance: 0.85, dwell: 2.4, overlooks: [] },
  { id: 'upper-west', room: 'upper', x: 15.4, z: 3.6, importance: 0.8, dwell: 2.4, overlooks: [] },
  { id: 'upper-centre', room: 'upper', x: 19.0, z: 3.6, importance: 0.6, dwell: 2.0, overlooks: [] },
  { id: 'upper-east', room: 'upper', x: 22.6, z: 3.6, importance: 0.7, dwell: 2.2, overlooks: [] },
  { id: 'upper-north', room: 'upper', x: 19.0, z: 7.6, importance: 0.65, dwell: 2.0, overlooks: [] },
];

export class PatrolSystem {
  private readonly points: Waypoint[] = [];
  /** The point she is currently walking to, if any. */
  private target: Waypoint | null = null;
  /** Point she most recently completed, so the next choice can avoid it. */
  private previous: Waypoint | null = null;
  /**
   * Game time she last stood on each storey (cellar, ground, upper), for the storey-novelty term.
   * Zero-initialised — "never" ages from game start, so a floor she has not swept yet keeps rising
   * until she goes there rather than starting neutral and never rising at all.
   */
  private readonly storeyLastVisit: number[] = [0, 0, 0];

  /** Storey bucket of a floor height: y < -2 is the cellar, < 1.2 the ground floor, else upper. */
  private static storeyOf(y: number): number {
    return y < -2 ? 0 : y < 1.2 ? 1 : 2;
  }

  constructor(
    private readonly cfg: DaayanConfig,
    grid: NavGrid,
  ) {
    for (const a of AUTHORED) {
      const nav = grid.nearestWalkable(a.x, a.z, 4);
      // A waypoint that cannot be resolved is a layout/data bug, not a runtime condition, so it is
      // dropped with a warning rather than silently skipped at selection time. If every point in a
      // room fails, that room simply will not be patrolled, which is visible in the debug overlay.
      if (!nav) {
        // eslint-disable-next-line no-console
        console.warn(`[DaayanAI] patrol waypoint "${a.id}" at (${a.x}, ${a.z}) is not walkable — dropped`);
        continue;
      }
      this.points.push({ ...a, nav, lastVisit: -Infinity, visits: 0 });
    }
  }

  /** Every waypoint that survived baking. */
  all(): readonly Waypoint[] {
    return this.points;
  }

  byId(id: string): Waypoint | null {
    return this.points.find((p) => p.id === id) ?? null;
  }

  /** Waypoints inside one room, for search behaviour that wants to sweep a specific area (§14). */
  inRoom(room: string): Waypoint[] {
    return this.points.filter((p) => p.room === room);
  }

  /** The point she is heading for. */
  getTarget(): Waypoint | null {
    return this.target;
  }

  /**
   * Score every candidate and take the best, per §5.
   *
   * The score is a product of five terms. The two that carry the feel of the system are
   * `timeSinceLastVisit` and the repetition penalty: together they are what stops her oscillating
   * between the two nearest points, which is the single most common way a patrol system looks fake.
   */
  chooseNext(now: number, playerHint: Vec3 | null, herPosition: Vec3): Waypoint {
    let best: Waypoint | null = null;
    let bestScore = -Infinity;
    const cfg = this.cfg;
    // Candidate set excludes the point just left, so she never immediately doubles back. With points
    // this dense that matters: bedroom-centre and bedroom-door are 3 m apart.
    const candidates = this.points.filter((p) => p !== this.previous);

    // The most-neglected storey, which alone gets the novelty boost this pick. Computed once for
    // all candidates: boosting every aged storey equally lets the nearer of two stale floors win on
    // distance and the farther one is never reached (the cellar-vs-upper ping-pong).
    let boostStorey = 0;
    let boostAge = -Infinity;
    for (let s = 0; s < 3; s++) {
      const age = now - (this.storeyLastVisit[s] as number);
      if (age > boostAge) {
        boostAge = age;
        boostStorey = s;
      }
    }

    for (const p of candidates) {
      // --- Distance: nearer is preferred, but only mildly, so she still crosses the house. ---
      const dist = p.nav
        ? Math.hypot(p.nav.x - herPosition.x, p.nav.z - herPosition.z)
        : 0;
      // A linear falloff to a 1.0 floor at `patrolDistanceFalloff`: beyond that every point is equally
      // far away, which keeps the term from overwhelming the others on a three-storey house.
      const distanceWeight = Math.max(1.0, 3.0 - dist / cfg.patrolDistanceFalloff);

      // --- Time since last visit: the anti-stagnation term. Rises with age, capped so a very old
      //     visit does not permanently pin her to one corner of the map. ---
      const age = p.lastVisit === -Infinity ? 999 : now - p.lastVisit;
      const timeSince = Math.min(1.0 + age / cfg.patrolVisitAgeScale, cfg.patrolVisitAgeCap);

      // --- Recent player activity: a point near where the player was last known outranks a distant
      //     one. This is the term that makes patrol feel like searching rather than routine. ---
      let activity = 1.0;
      if (playerHint && p.nav) {
        const pd = Math.hypot(p.nav.x - playerHint.x, p.nav.z - playerHint.z);
        activity = 1.0 + Math.max(0, 1 - pd / cfg.patrolActivityRadius) * cfg.patrolActivityWeight;
      }

      // --- Anti-repetition: already-visited points drift down, so a long patrol spreads out. ---
      const repetition = 1 / (1 + p.visits * cfg.patrolRepetitionPenalty);

      // --- Storey novelty: how long since she patrolled *that floor* at all, applied only to the
      //     single most-neglected storey (see above). This is the term that gets her upstairs:
      //     per-point terms alone leave the five upper waypoints outnumbered 37:5 by an
      //     always-nearer ground set, and "rarely rolls the right dice" reads as "never comes up"
      //     over a whole play session. ---
      const storey = p.nav ? PatrolSystem.storeyOf(p.nav.y) : 1;
      const storeyNovelty =
        storey === boostStorey ? Math.min(1 + boostAge / cfg.patrolStoreyAgeScale, cfg.patrolStoreyAgeCap) : 1.0;

      // --- Controlled randomness (§5). Two-sided and modest, so her route is not identical every lap
      //     but the other four terms still dominate. ---
      const randomness = 1 - cfg.patrolRandomness + Math.random() * cfg.patrolRandomness * 2;

      const score = distanceWeight * p.importance * timeSince * activity * repetition * storeyNovelty * randomness;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }

    // Every candidate filtered out (a one-point patrol network) — fall back to anything at all.
    if (!best) best = this.points[0] ?? null;
    if (!best) throw new Error('[DaayanAI] patrol network is empty; no walkable waypoints');
    this.target = best;
    return best;
  }

  /** Mark the current target reached and return it, so the caller can dwell and inspect it. */
  arrive(now: number): Waypoint | null {
    const p = this.target;
    if (!p) return null;
    p.lastVisit = now;
    p.visits++;
    if (p.nav) this.storeyLastVisit[PatrolSystem.storeyOf(p.nav.y)] = now;
    this.previous = p;
    this.target = null;
    return p;
  }

  /**
   * The nearest waypoint to a position, for resuming patrol from wherever she happens to be.
   *
   * Used by RETURN_TO_PATROL (§29) and by failure recovery (§28), where she may be standing somewhere
   * no plan put her.
   */
  nearest(position: Vec3): Waypoint | null {
    let best: Waypoint | null = null;
    let bestD = Infinity;
    for (const p of this.points) {
      if (!p.nav) continue;
      const d = Math.hypot(p.nav.x - position.x, p.nav.z - position.z);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  /** Which room a world position falls in, by nearest waypoint. Null when she is off the network. */
  roomAt(position: Vec3): string | null {
    const p = this.nearest(position);
    if (!p || !p.nav) return null;
    // Only claim a room when she is genuinely inside its waypoints' neighbourhood; a point 30 m away
    // through two walls is not "the room she is in".
    const d = Math.hypot(p.nav.x - position.x, p.nav.z - position.z);
    return d < 8 ? p.room : null;
  }
}
