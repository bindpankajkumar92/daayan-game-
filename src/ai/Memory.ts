/**
 * Memory — what Daayan believes about where the player is, and how that belief decays.
 *
 * §10 of the spec. The whole point of this file is that it holds *belief* rather than truth. Nothing
 * here can be asked "where is the player?" — only "where does she think the player is, and how sure is
 * she?" That distinction is the difference between an AI that cheats and an AI that feels intelligent,
 * and §30 states it as the central implementation principle: she reasons from what she can see, hear
 * and remember, and nothing more.
 *
 * Three positions, per the spec, and they are genuinely different things:
 *
 *   - `lastSeenPosition`  — the last place her eyes confirmed. Strongest evidence.
 *   - `lastHeardPosition` — the last place a sound suggested. Weaker, and already jittered in
 *                           perception (§9), because a sound only implies a probable location.
 *   - `lastKnownPosition` — her single best current estimate, which is the one the FSM navigates to.
 *
 * The estimate is a weighted merge rather than "most recent wins": a sighting two seconds old is worth
 * more than a footstep now, because a footstep could be the cat.
 */

import type { Vec3 } from '@/core/types';
import type { DaayanConfig } from './DaayanConfig';

/** Where a memory came from, which decides how much it is trusted and how fast it fades. */
type EvidenceKind = 'seen' | 'heard';

interface Evidence {
  position: Vec3;
  time: number;
  /** Reliability at the moment it was recorded, in [0, 1]. */
  strength: number;
  kind: EvidenceKind;
}

export class Memory {
  private lastSeen: Evidence | null = null;
  private lastHeard: Evidence | null = null;
  /** Merged current estimate. Recomputed on each evidence update and each decay tick. */
  private estimate: { position: Vec3; confidence: number } | null = null;
  /** Smoothed player velocity at the last sighting, for escape-direction analysis (§15). */
  private playerVelocity: Vec3 = { x: 0, y: 0, z: 0 } as Vec3;
  private velocityTime = -Infinity;

  constructor(private readonly cfg: DaayanConfig) {}

  /** Wipe all belief. Used on respawn and when the AI resets. */
  clear(): void {
    this.lastSeen = null;
    this.lastHeard = null;
    this.estimate = null;
    this.playerVelocity = { x: 0, y: 0, z: 0 } as Vec3;
    this.velocityTime = -Infinity;
  }

  /**
   * Record a sighting. The strongest evidence available (§10: "When she sees the player:
   * lastSeenPosition = player.position").
   */
  noteSeen(position: Vec3, time: number, playerVelocity: Vec3, confidence: number): void {
    this.lastSeen = {
      position: { x: position.x, y: position.y, z: position.z } as Vec3,
      time,
      // A sighting is only as strong as her current visual confidence, so a glimpse round a corner
      // records a weaker memory than a clear stare — which is what makes her less certain afterwards.
      strength: Math.max(0.25, confidence),
      kind: 'seen',
    };
    this.playerVelocity = { x: playerVelocity.x, y: playerVelocity.y, z: playerVelocity.z } as Vec3;
    this.velocityTime = time;
    this.recompute(time);
  }

  /** Record a heard sound. Weaker than a sighting and never stronger than 0.6 (§9). */
  noteHeard(position: Vec3, time: number, perceivedLoudness: number): void {
    // Heard evidence never overwrites a fresher sighting with something less reliable: standing in
    // plain view of her while a distant door creaks should not degrade her certainty.
    if (this.lastSeen && time - this.lastSeen.time < 0.5) return;
    this.lastHeard = {
      position: { x: position.x, y: position.y, z: position.z } as Vec3,
      time,
      strength: Math.min(0.6, 0.2 + perceivedLoudness * 0.5),
      kind: 'heard',
    };
    this.recompute(time);
  }

  /**
   * Merge the evidence streams into one estimate.
   *
   * Weight is strength times a recency factor, and the recency factor is exponential in the age
   * divided by `memoryDuration` — so a memory a third of the way to its expiry is worth about half as
   * much as a fresh one, and neither stream ever fully wins on age alone while the other is fresh.
   */
  private recompute(now: number): void {
    const parts: { evidence: Evidence; weight: number }[] = [];
    for (const e of [this.lastSeen, this.lastHeard]) {
      if (!e) continue;
      const age = Math.max(0, now - e.time);
      const recency = Math.exp(-age / this.cfg.memoryDuration);
      parts.push({ evidence: e, weight: e.strength * recency });
    }
    if (parts.length === 0) {
      this.estimate = null;
      return;
    }
    let total = 0;
    let x = 0;
    let y = 0;
    let z = 0;
    for (const p of parts) {
      total += p.weight;
      x += p.evidence.position.x * p.weight;
      y += p.evidence.position.y * p.weight;
      z += p.evidence.position.z * p.weight;
    }
    if (total < 1e-6) {
      this.estimate = null;
      return;
    }
    this.estimate = {
      position: { x: x / total, y: y / total, z: z / total } as Vec3,
      // Confidence is the best single piece of evidence, not the sum: two weak guesses do not add up
      // to one good one, and summing lets a dribble of footsteps manufacture certainty.
      confidence: Math.max(...parts.map((p) => p.weight)),
    };
  }

  /**
   * Age everything by `dt`. Call every frame; it is a couple of multiplications.
   *
   * Memory must decay (§10: "The AI should gradually become less certain"). When the estimate drops
   * below `memoryMinConfidence` it is dropped entirely, which is what eventually returns her to patrol
   * after a long fruitless search — and the reason the search has to have a timeout of its own (§13)
   * is that a *loud* memory can otherwise stay just above this bar for a long time.
   */
  decay(dt: number, now: number): void {
    void dt;
    this.recompute(now);
    if (this.estimate && this.estimate.confidence < this.cfg.memoryMinConfidence) {
      this.estimate = null;
    }
  }

  /** Her current best guess at where the player is, or null when she has nothing. */
  getPosition(): Vec3 | null {
    return this.estimate?.position ?? null;
  }

  /**
   * How much to trust the current estimate, in [0, 1].
   *
   * Deliberately *not* the same thing as visual confidence: confidence is "can I see them right now",
   * this is "how sure am I where they are", which stays high for a while after they vanish. §7's
   * hysteresis and §13's search both key off the difference.
   */
  getConfidence(): number {
    return this.estimate?.confidence ?? 0;
  }

  hasAnything(): boolean {
    return this.estimate !== null;
  }

  /** Age of the most recent piece of evidence, in seconds. Infinity when there is none. */
  age(now: number): number {
    let newest = -Infinity;
    for (const e of [this.lastSeen, this.lastHeard]) {
      if (e && e.time > newest) newest = e.time;
    }
    return newest === -Infinity ? Infinity : now - newest;
  }

  getLastSeen(): { position: Vec3; time: number } | null {
    return this.lastSeen ? { position: this.lastSeen.position, time: this.lastSeen.time } : null;
  }

  getLastHeard(): { position: Vec3; time: number } | null {
    return this.lastHeard ? { position: this.lastHeard.position, time: this.lastHeard.time } : null;
  }

  /**
   * The player's recent velocity, or null when the record has gone stale.
   *
   * Stale velocity is worse than none: extrapolating from a two-second-old sprint in the wrong
   * direction is how an AI looks not clever but broken. Hence the explicit expiry.
   */
  getRecentVelocity(now: number): Vec3 | null {
    if (now - this.velocityTime > this.cfg.escapeVelocityMemory) return null;
    return this.playerVelocity;
  }
}
