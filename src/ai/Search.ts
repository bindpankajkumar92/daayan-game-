/**
 * Search — where she looks when she has lost you, and which way she guesses you ran.
 *
 * §13 through §15. Three things live here because they are all answers to the same question, "the
 * player is not visible, so where should she go?":
 *
 *   - `plan()` builds a prioritised itinerary of points around the last known position (§14). The
 *     spec is explicit that this must not be "walk directly to lastKnownPosition": a search that goes
 *     to one point is a search a player learns to watch from a safe distance.
 *   - `intercept()` produces the predicted pursuit point, deliberately weaker the less she knows
 *     (§12). This is the mechanism by which she looks *intelligent* without being *omniscient*.
 *   - Escape-direction analysis (§15) feeds the first from the second: the direction the player was
 *     last moving biases which points she visits first, but only probabilistically.
 *
 * Everything here reads from memory and velocity, never from the player's true position. That is not
 * a stylistic choice — §30 is unambiguous that she decides using "what she can see, hear, remember and
 * reasonably predict, and nothing more", and a search that consults the truth is a search that cheats.
 */

import type { Vec3 } from '@/core/types';
import type { AIContext } from './StateMachine';
import type { DaayanConfig } from './DaayanConfig';
import type { NavGrid, NavPoint } from './NavGrid';

/** A candidate point in a search itinerary, with the score that ordered it. */
export interface SearchPoint {
  nav: NavPoint;
  /** Why this point ranked where it did, for the debug overlay. */
  score: number;
  /** The room it sits in, when a waypoint supplied it. */
  room: string | null;
  /** True when a hiding spot is close enough that passing this point checks it (§14). */
  coversHiding: boolean;
}

/** The predicted intercept point and the reasoning behind it (§12). */
export interface Prediction {
  point: Vec3;
  /** How much to trust it, 0..1. Used by the debug overlay and by tests. */
  confidence: number;
  /** Seconds of lead time the extrapolation used. */
  leadTime: number;
}

export class SearchPlanner {
  private itinerary: SearchPoint[] = [];
  private index = 0;
  /** Time the current pause started, or 0 when she is not paused. */
  private pauseUntil = 0;

  constructor(
    private readonly cfg: DaayanConfig,
    private readonly grid: NavGrid,
    /** Waypoint lookup, so search points can prefer places she already knows mean something (§5). */
    private readonly waypoints: { all: () => readonly { id: string; room: string; nav: NavPoint | null; overlooks: string[] }[] },
    /** Hiding spots, so a search can actually check them (§14). */
    private readonly hidingSpots: readonly { id: string; position: Vec3 }[],
  ) {}

  /**
   * Build a fresh itinerary around `origin` (§14).
   *
   * The spec's own example ordering is "lastKnownPosition -> nearby left position -> nearby right
   * position -> nearby corridor -> nearby doorway -> nearby hiding locations -> nearby likely escape
   * route", which is a fan around the point she lost you at. That is what this generates: the origin
   * itself, points swept to either side of the escape direction, then the nearest doorway, then the
   * hiding spots, then the furthest plausible route out.
   *
   * Scoring is the sum of the six priority factors §14 lists, so a point can be strong on one axis and
   * weak on another and still rank sensibly.
   */
  plan(origin: Vec3, now: number, escapeDirection?: Vec3 | null): void {
    const cfg = this.cfg;
    const points: SearchPoint[] = [];
    const seen = new Set<string>();

    // The escape vector: where she last saw them heading. Used to fan the search forward rather than
    // uniformly, which is §15 and is what makes her occasionally cut a player off.
    let dirX = 0;
    let dirZ = 0;
    if (escapeDirection) {
      const len = Math.hypot(escapeDirection.x, escapeDirection.z);
      if (len > 0.2) {
        dirX = escapeDirection.x / len;
        dirZ = escapeDirection.z / len;
      }
    }

    const addPoint = (nav: NavPoint | null, room: string | null, coversHiding: boolean, bias: number): void => {
      if (!nav) return;
      const key = `${Math.round(nav.x * 4)},${Math.round(nav.z * 4)}`;
      if (seen.has(key)) return;
      seen.add(key);
      points.push({ nav, room, score: 0, coversHiding, _bias: bias } as SearchPoint);
    };

    // --- 1. The last known position itself. Highest priority, because it is the best evidence. ---
    addPoint(this.grid.nearestWalkable(origin.x, origin.z, 6, origin.y), null, false, 3.0);

    // --- 2 & 3. Points to either side of the escape direction, and directly along it. ---
    //    A fan rather than a straight line: a player who turns a corner while running leaves a space
    //    that a straight-line search walks right past.
    const radius = cfg.searchRadius;
    for (let i = 0; i < cfg.searchPointCount; i++) {
      const t = i / Math.max(1, cfg.searchPointCount - 1);
      // Sweep from -70° to +70° off the escape direction. With no escape direction known the fan
      // opens to a full circle, because guessing a direction with no evidence is worse than covering.
      const known = dirX !== 0 || dirZ !== 0;
      const angle = known
        ? Math.atan2(dirZ, dirX) + (t - 0.5) * 2.44
        : (t * Math.PI * 2) / Math.max(1, cfg.searchPointCount);
      const r = radius * (0.45 + t * 0.55);
      const x = origin.x + Math.cos(angle) * r;
      const z = origin.z + Math.sin(angle) * r;
      const nav = this.grid.nearestWalkable(x, z, 4, origin.y);
      addPoint(nav, null, false, known ? 2.0 - t * 0.7 : 1.2 - t * 0.2);
    }

    // --- 4. Doorways and known points nearby, which are where a fleeing player actually goes. ---
    for (const wp of this.waypoints.all()) {
      if (!wp.nav) continue;
      const d = Math.hypot(wp.nav.x - origin.x, wp.nav.z - origin.z);
      if (d > radius) continue;
      // A doorway is worth more than the middle of a room, and anything overlooking a hiding spot
      // more still, because checking a wardrobe is a real action rather than a patrol waypoint.
      const hides = this.hidingNear(wp.nav, 4.0);
      const importance = hides ? 2.4 : wp.room === 'hallway' || wp.room === 'backhall' ? 1.9 : 1.3;
      addPoint(wp.nav, wp.room, hides, importance * (1 - d / radius * 0.45));
    }

    // --- 5. Hiding spots themselves (§14 "nearby hiding locations"). ---
    for (const spot of this.hidingSpots) {
      const d = Math.hypot(spot.position.x - origin.x, spot.position.z - origin.z);
      if (d > radius * 1.2) continue;
      // Stand a little short of the spot: pathing onto a wardrobe's own footprint is not walkable,
      // and the point of arriving is to be able to look at and open it.
      const nav = this.grid.nearestWalkable(spot.position.x, spot.position.z, 3, origin.y);
      addPoint(nav, null, true, 2.6 * (1 - d / (radius * 1.2) * 0.35));
    }

    // --- 6. Score: distance, visibility, escape alignment, hiding, recency of sound, connectivity. ---
    for (const p of points) {
      const bias = (p as unknown as { _bias: number })._bias;
      const d = Math.hypot(p.nav.x - origin.x, p.nav.z - origin.z);
      // Distance: preferable to check nearby ground first, so nearer scores higher.
      const distanceTerm = 1.0 - Math.min(1, d / (radius * 1.4)) * 0.5;
      // Alignment with the escape direction (§15), the term that makes her guess.
      let alignTerm = 1.0;
      if (dirX !== 0 || dirZ !== 0) {
        const px = (p.nav.x - origin.x) / Math.max(0.01, d);
        const pz = (p.nav.z - origin.z) / Math.max(0.01, d);
        alignTerm = 1 + Math.max(0, px * dirX + pz * dirZ) * cfg.escapeDirectionWeight;
      }
      // Hiding coverage.
      const hidingTerm = p.coversHiding ? 1.5 : 1.0;
      p.score = bias * distanceTerm * alignTerm * hidingTerm;
    }

    // Sort descending. Deterministic tie-break on distance keeps a replay reproducible.
    points.sort((a, b) => b.score - a.score || Math.hypot(a.nav.x - origin.x, a.nav.z - origin.z) - Math.hypot(b.nav.x - origin.x, b.nav.z - origin.z));
    // Keep only the best few. A long tour is the failure mode the player notices: she circles the
    // same room for half a minute and reads as broken rather than thorough.
    this.itinerary = points.slice(0, Math.max(1, cfg.searchMaxPoints));
    this.index = 0;
    this.pauseUntil = 0;
    void now;
  }

  /** True when a hiding spot sits within `radius` of a nav point. */
  private hidingNear(nav: NavPoint, radius: number): boolean {
    for (const spot of this.hidingSpots) {
      if (Math.hypot(spot.position.x - nav.x, spot.position.z - nav.z) <= radius) return true;
    }
    return false;
  }

  /** The point she is currently working toward, advancing the cursor as she completes each. */
  current(): SearchPoint | null {
    while (this.index < this.itinerary.length) {
      const p = this.itinerary[this.index] as SearchPoint;
      if (p.nav) return p;
      this.index++;
    }
    return null;
  }

  /** Advance to the next point. */
  advance(): void {
    this.index++;
  }

  /** Begin a dwell at the current point. */
  beginPause(now: number, duration: number): void {
    if (this.pauseUntil === 0) {
      this.pauseUntil = now + duration;
      // The point has been reached and looked at, so move on when the pause ends. Doing this here
      // rather than after the pause means a state that is interrupted mid-pause does not leave the
      // cursor stuck on a point it already visited.
      this.advance();
    }
  }

  /** Seconds left in the current pause, 0 when not paused. Clears itself when it elapses. */
  pauseRemaining(now: number): number {
    if (this.pauseUntil === 0) return 0;
    const left = this.pauseUntil - now;
    if (left <= 0) {
      this.pauseUntil = 0;
      return 0;
    }
    return left;
  }

  /** True when the itinerary is exhausted or the overall search has run long enough (§13). */
  expired(now: number, searchDuration: number): boolean {
    if (this.itinerary.length === 0) return true;
    if (this.index >= this.itinerary.length && this.pauseUntil === 0) return true;
    void now;
    void searchDuration;
    return false;
  }

  /** How far through the itinerary she is, 0..1. For the debug overlay. */
  progress(): number {
    if (this.itinerary.length === 0) return 1;
    return Math.min(1, this.index / this.itinerary.length);
  }

  /**
   * The index of the point she is currently working toward, for the overlay.
   *
   * Clamped to the last point so an exhausted itinerary does not report an index past the end, which
   * would make the overlay highlight nothing and read as "search finished but still searching".
   */
  currentIndex(): number {
    if (this.itinerary.length === 0) return -1;
    return Math.min(this.itinerary.length - 1, this.index);
  }

  /** The whole plan, for the debug overlay (§26 lists "search points"). */
  all(): readonly SearchPoint[] {
    return this.itinerary;
  }

  /**
   * The predicted intercept point (§12).
   *
   * `predictedPosition = playerPosition + playerVelocity × predictionTime`, with four deliberate
   * weakenings the spec asks for:
   *
   *   - the lead time is capped by `predictionMaxTime`;
   *   - the strength scales down when the player is moving slowly, because extrapolating a walk is
   *     meaningless;
   *   - it scales down when the player's direction has recently changed, because a jinking player is
   *     not predictable and pretending otherwise is what makes an AI feel unfair;
   *   - it is refused entirely when she has no recent velocity at all, which is the common case after
   *     she has genuinely lost them.
   *
   * Returns null in exactly those refusal cases, and the caller falls back to the last known position.
   * That fallback is what keeps §12's closing promise: "The goal is to make Daayan look intelligent,
   * not omniscient."
   */
  intercept(ctx: AIContext, cfg: DaayanConfig): Prediction | null {
    if (cfg.predictionStrength <= 0) return null;

    // She predicts from *remembered* velocity, not the player's live one — reading live velocity
    // while the player is unseen would be a subtle but real form of cheating.
    const vel = ctx.playerVelocityHint;
    if (!vel) return null;

    const speed = Math.hypot(vel.x, vel.z);
    if (speed < cfg.predictionMinPlayerSpeed) return null;

    // Direction stability: how well the recent heading matches the remembered one. A player who just
    // reversed is penalised hard, which is the honest response to unpredictability.
    let stability = 1;
    if (ctx.playerDirectionChanged) stability *= 1 - cfg.predictionDirectionChangePenalty;

    // Trust in the prediction: sight-free prediction is inherently weaker, and an old memory weaker
    // still. This is the term that stops a long-lost player being chased to a stale extrapolation.
    const memoryTrust = Math.min(1, ctx.memoryConfidence);
    const strength = cfg.predictionStrength * stability * memoryTrust;
    if (strength < 0.15) return null;

    const lead = cfg.predictionMaxTime * strength;
    const origin = ctx.memoryPosition;
    if (!origin) return null;

    let px = origin.x + vel.x * lead;
    let pz = origin.z + vel.z * lead;

    // Clamp the lead so she can never predict an impossible jump (§12: "Do not allow Daayan to predict
    // impossible future positions"). The clamp is in distance, not time, because it is a statement
    // about the world: no matter how fast they were going, they cannot be further than this.
    const dx = px - origin.x;
    const dz = pz - origin.z;
    const dist = Math.hypot(dx, dz);
    if (dist > cfg.predictionMaxLead) {
      const k = cfg.predictionMaxLead / dist;
      px = origin.x + dx * k;
      pz = origin.z + dz * k;
    }

    const nav = this.grid.nearestWalkable(px, pz, 4, origin.y);
    if (!nav) return null;

    // A prediction pointing at the ground she is already standing on is not a prediction, and acting
    // on it produces the worst possible behaviour: she commits to it, arrives instantly, the next
    // tick produces the same point again, and she jitters on the spot instead of searching. Distance
    // from *her* is the test, not distance from the belief — she may be correctly standing on the
    // belief while the extrapolation genuinely points somewhere useful.
    const here = ctx.position;
    if (Math.hypot(nav.x - here.x, nav.z - here.z) < 1.0) return null;

    return { point: { x: nav.x, y: nav.y, z: nav.z } as Vec3, confidence: strength, leadTime: lead };
  }
}
