/**
 * Perception — how Daayan finds out about the world: her eyes and her ears.
 *
 * Two systems, deliberately independent, per §6–§9 of the spec. Nothing here decides anything; both
 * produce evidence and the memory system (§10) is what turns evidence into belief. Keeping the split
 * is what makes the AI tunable: "she notices too fast" and "she decides too fast" are different bugs
 * and they live in different files.
 *
 * The two rules that matter most, and the ones most horror AIs get wrong:
 *
 * - **Nothing is binary.** Vision produces a confidence in [0, 1] that rises while you are seen and
 *   decays while you are not, with hysteresis on the way down (§7). Sound produces a perceived
 *   loudness that falls off with distance and is *damped* by walls rather than blocked (§8).
 * - **She never sees through a wall and never hears everything (§21).** Every positive result here is
 *   the output of a real geometric test — a raycast for sight, a distance-and-obstruction product for
 *   sound. There is no "the player is within N metres, therefore she knows" anywhere in this file,
 *   which is the single most common way this feature is faked and the single thing the spec forbids
 *   most explicitly.
 */

import type { AABB } from '@/player/FPController';
import type { Vec3 } from '@/core/types';
import type { DaayanConfig } from './DaayanConfig';

/** What a vision sample concluded, and how strongly. */
export interface VisionResult {
  /** Fraction of the sample rays that reached the player, in [0, 1]. */
  visibility: number;
  /** Which part of the player each ray reached, for the debug overlay (§26). */
  rays: { to: Vec3; hit: boolean }[];
  /** Range to the player at the time of the sample. */
  distance: number;
  /** True when the player is even nominally inside range, FOV and vertical limits. */
  inCone: boolean;
}

/** One thing Daayan heard. Position is her *estimate*, already jittered (§9). */
export interface HeardSound {
  /** Where she thinks it came from. Deliberately not the true source — see `hearingPositionJitter`. */
  position: Vec3;
  /** The true source, kept for the debug overlay and for tests. */
  source: Vec3;
  /** Base loudness the emitter declared. */
  baseLoudness: number;
  /** Loudness after distance falloff and obstruction, in [0, ∞). */
  perceivedLoudness: number;
  /** The emitter's own classification. */
  kind: SoundKind;
  /** Game time the sound was perceived. */
  time: number;
}

/** Sound types, per §8. The spec's list, plus the ones this game already emits. */
export type SoundKind =
  | 'footstep'
  | 'sprint'
  | 'door'
  | 'object'
  | 'break'
  | 'fall'
  | 'special'
  | 'cat';

/** An incoming sound event, before perception is applied. */
export interface SoundEvent {
  position: Vec3;
  loudness: number;
  kind: SoundKind;
  time: number;
}

/**
 * Base loudness per sound kind, when the emitter does not supply one.
 *
 * The spec gives these as a ladder — "Crouch movement = very low, Normal walking = low, Running =
 * medium/high, Door slam = high, Heavy object = very high" — so this is that ladder as numbers, on a
 * scale where `hearingThreshold` (0.16) is the quietest thing she can notice at close range and 1.0 is
 * a slammed door beside her.
 */
export const SOUND_LOUDNESS: Record<SoundKind, number> = {
  footstep: 0.1,
  sprint: 0.55,
  door: 0.7,
  object: 0.65,
  break: 0.95,
  fall: 0.8,
  special: 0.85,
  cat: 0.5,
};

const EPS = 1e-6;

/** Squared distance between two Vec3-likes. */
function distSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Does the segment a→b intersect this box? Slab method, the standard branch-free ray/AABB test.
 *
 * Used by both perception systems: vision asks it per ray, hearing asks it per sound to count how much
 * wall is in the way. One implementation so the two can never disagree about what a wall is.
 */
function segmentHitsBox(a: Vec3, b: Vec3, box: AABB): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  let tmin = 0;
  let tmax = 1;

  // X slab
  if (Math.abs(dx) < EPS) {
    if (a.x < box.minX || a.x > box.maxX) return false;
  } else {
    const inv = 1 / dx;
    let t1 = (box.minX - a.x) * inv;
    let t2 = (box.maxX - a.x) * inv;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }

  // Y slab
  if (Math.abs(dy) < EPS) {
    if (a.y < box.minY || a.y > box.maxY) return false;
  } else {
    const inv = 1 / dy;
    let t1 = (box.minY - a.y) * inv;
    let t2 = (box.maxY - a.y) * inv;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }

  // Z slab
  if (Math.abs(dz) < EPS) {
    if (a.z < box.minZ || a.z > box.maxZ) return false;
  } else {
    const inv = 1 / dz;
    let t1 = (box.minZ - a.z) * inv;
    let t2 = (box.maxZ - a.z) * inv;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }

  return true;
}

/**
 * A broadphase over the static world's AABBs, so perception does not test 100 boxes per ray.
 *
 * The house is one connected structure and Daayan can be anywhere in it, so a uniform grid over the
 * whole world with a cell per few metres is the right shape: thousands of boxes would want an octree,
 * a hundred want this, and this is twenty lines.
 */
export class ObstacleGrid {
  private readonly cell: number;
  private readonly buckets = new Map<number, AABB[]>();
  private readonly all: AABB[];

  constructor(boxes: readonly AABB[], cell = 4) {
    this.cell = cell;
    this.all = [...boxes];
    for (const b of this.all) {
      const x0 = Math.floor(b.minX / cell);
      const x1 = Math.floor(b.maxX / cell);
      const z0 = Math.floor(b.minZ / cell);
      const z1 = Math.floor(b.maxZ / cell);
      // A box taller than the world is rare (walls are 3–5 m), so no y bucketing: the vertical test
      // is cheap and a 2D grid keeps the key arithmetic trivial.
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const key = x * 73856093 ^ z * 19349663;
          let list = this.buckets.get(key);
          if (!list) {
            list = [];
            this.buckets.set(key, list);
          }
          list.push(b);
        }
      }
    }
  }

  /**
   * True when the segment a→b is blocked by any box.
   *
   * `ignoreTop` lets a ray pass above short props: a chest-high table does not block the sightline to
   * a standing player's head, and treating it as though it did is what makes an AI blind in a room
   * full of furniture.
   */
  blocked(a: Vec3, b: Vec3, ignoreTop = false): boolean {
    const candidates = this.candidates(a, b);
    for (const box of candidates) {
      if (ignoreTop && box.maxY - box.minY < 1.0) continue;
      if (segmentHitsBox(a, b, box)) return true;
    }
    return false;
  }

  /** Count of boxes the segment passes through. Used to damp sound rather than block it (§8). */
  crossings(a: Vec3, b: Vec3): number {
    let n = 0;
    for (const box of this.candidates(a, b)) {
      // Only walls and full-height geometry count acoustically; a chair does not muffle a footstep.
      if (box.maxY - box.minY < 1.2) continue;
      if (segmentHitsBox(a, b, box)) n++;
    }
    return n;
  }

  private candidates(a: Vec3, b: Vec3): AABB[] {
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minZ = Math.min(a.z, b.z);
    const maxZ = Math.max(a.z, b.z);
    const x0 = Math.floor(minX / this.cell);
    const x1 = Math.floor(maxX / this.cell);
    const z0 = Math.floor(minZ / this.cell);
    const z1 = Math.floor(maxZ / this.cell);
    // A long ray spans many cells; if that set gets large, testing the whole list is cheaper than
    // building a deduplicated set. The threshold is where the two costs cross in practice.
    const span = (x1 - x0 + 1) * (z1 - z0 + 1);
    if (span > 24) return this.all;

    const seen = new Set<AABB>();
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const key = x * 73856093 ^ z * 19349663;
        const list = this.buckets.get(key);
        if (!list) continue;
        for (const b2 of list) seen.add(b2);
      }
    }
    return [...seen];
  }
}

/** Player state the vision test needs. Kept as a plain struct so perception has no player dependency. */
export interface PlayerSample {
  /** Eye position. Ray origin for the top ray. */
  eye: Vec3;
  /** Feet position. */
  feet: Vec3;
  /** Current velocity, for prediction (§12) and escape analysis (§15). */
  velocity: Vec3;
  /** Eye height above feet, so torso and leg anchors can be derived. */
  eyeHeight: number;
  /** True while the player is in a hiding spot, which caps visibility hard. */
  hidden: boolean;
}

export class VisionSystem {
  /** Smoothed visibility, 0..1. The thing the rest of the AI reads. */
  private confidence = 0;
  /** Result of the most recent sample, for debug and for hysteresis bookkeeping. */
  private last: VisionResult = { visibility: 0, rays: [], distance: Infinity, inCone: false };

  constructor(
    private readonly cfg: DaayanConfig,
    private readonly obstacles: ObstacleGrid,
  ) {}

  getConfidence(): number {
    return this.confidence;
  }

  getLastResult(): VisionResult {
    return this.last;
  }

  /** Hard reset, e.g. on respawn or when the AI is disabled. */
  reset(): void {
    this.confidence = 0;
    this.last = { visibility: 0, rays: [], distance: Infinity, inCone: false };
  }

  /**
   * Take one vision sample. Called at the throttled perception rate (§27), never per frame.
   *
   * The flow is the spec's exactly (§6):
   *   distance check → FOV check → line-of-sight check → visibility evaluation → confidence update.
   *
   * Each stage returns early, so the expensive raycast only runs for a player who could plausibly be
   * seen at all — which on a normal frame is nobody, making the common case nearly free.
   */
  sample(eye: Vec3, forwardYaw: number, forwardPitch: number, player: PlayerSample, dt: number): VisionResult {
    const result: VisionResult = { visibility: 0, rays: [], distance: Infinity, inCone: false };

    // --- Stage 1: distance. Cheapest test first, and the one that most often saves the raycast. ---
    const toPlayer = { x: player.eye.x - eye.x, y: player.eye.y - eye.y, z: player.eye.z - eye.z } as Vec3;
    const distance = Math.sqrt(toPlayer.x ** 2 + toPlayer.y ** 2 + toPlayer.z ** 2);
    result.distance = distance;
    if (distance > this.cfg.visionRange || distance < EPS) {
      this.decayConfidence(0, dt);
      this.last = result;
      return result;
    }

    // --- Stage 2: FOV. Horizontal first, then vertical, both in the *gaze* frame rather than the
    // body's — §19 keeps lookDirection separate from movementDirection precisely so she can glance at
    // something without turning her whole body to face it.
    const flatDist = Math.hypot(toPlayer.x, toPlayer.z);
    const targetYaw = Math.atan2(toPlayer.x, toPlayer.z);
    let yawDelta = targetYaw - forwardYaw;
    // Wrap to [-π, π] so a target just past due north reads as a small angle, not a huge one.
    while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
    while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
    const halfFov = (this.cfg.visionFOVDeg * Math.PI) / 360;
    if (Math.abs(yawDelta) > halfFov) {
      this.decayConfidence(0, dt);
      this.last = result;
      return result;
    }

    const targetPitch = Math.atan2(toPlayer.y, flatDist);
    const halfVertical = (this.cfg.visionVerticalDeg * Math.PI) / 360;
    // Vertical limits are generous relative to gaze because she looks around constantly; the point of
    // this test is to stop her noticing someone through a floor, not to model a letterbox.
    if (Math.abs(targetPitch - forwardPitch) > halfVertical + 0.35) {
      this.decayConfidence(0, dt);
      this.last = result;
      return result;
    }

    result.inCone = true;

    // --- Stage 3: line of sight, from her *eyes* rather than her body centre (§6), to three points
    // on the player. Multi-ray because a single ray to the torso can be stopped by a chair while the
    // player's head is plainly visible, and one blocked ray must not mean blindness.
    const anchors: Vec3[] = [];
    const rayCount = Math.max(1, Math.min(3, this.cfg.visionRays));
    if (rayCount === 1) {
      anchors.push({ ...player.eye } as Vec3);
    } else {
      // Head, torso, legs — the spec's own list.
      anchors.push({ x: player.eye.x, y: player.eye.y, z: player.eye.z } as Vec3);
      if (rayCount >= 2) {
        anchors.push({
          x: player.feet.x,
          y: player.feet.y + player.eyeHeight * 0.55,
          z: player.feet.z,
        } as Vec3);
      }
      if (rayCount >= 3) {
        anchors.push({ x: player.feet.x, y: player.feet.y + 0.2, z: player.feet.z } as Vec3);
      }
    }

    let hits = 0;
    for (const anchor of anchors) {
      // A crouched or hidden player is a shorter target, so the leg ray is the one that survives a
      // low obstacle — which is exactly the behaviour that makes hiding under a table work.
      const blocked = this.obstacles.blocked(eye, anchor, false);
      result.rays.push({ to: anchor, hit: !blocked });
      if (!blocked) hits++;
    }

    let visibility = hits / anchors.length;

    // --- Partial visibility (§6): a hidden player is never fully visible, however clear the line. ---
    //
    // The cap is on *gain*, not just on the reported number. Scaling visibility down and then letting
    // the ordinary partial-visibility branch accumulate confidence still walked a player under a bed
    // up to 0.84 over a few seconds, because 0.15 of visibility is above `visionMinVisibility` and so
    // counts as a positive sighting. Being hidden has to mean the confidence cannot climb, which is
    // the one thing the whole hiding mechanic rests on.
    const hidden = player.hidden;
    if (hidden) visibility = Math.min(visibility, 0.15);

    result.visibility = visibility;

    // --- Stage 4: confidence, with hysteresis (§7). ---
    const cfg = this.cfg;
    if (hidden) {
      // She can see that *something* is there but not clearly enough to resolve who — so this decays
      // at the slow "partially visible" rate rather than the fast one, while never gaining.
      this.confidence = Math.max(0, this.confidence - cfg.visionConfidenceDecayPartial * dt);
    } else if (visibility >= cfg.visionFullVisibility) {
      // Fully visible: rises fast. Scaled down slightly by distance so a far-off glimpse is weaker
      // than a close one, which is what makes backing away down a corridor a real tactic.
      const near = 1 - Math.min(1, distance / cfg.visionRange) * 0.35;
      this.confidence = Math.min(1, this.confidence + cfg.visionConfidenceGain * near * dt);
    } else if (visibility > cfg.visionMinVisibility) {
      // Partially visible: still positive, but slower than the decay in the other direction, so a
      // flicker of an arm does not cancel a solid sighting.
      this.confidence = Math.min(1, this.confidence + cfg.visionConfidenceGain * visibility * 0.7 * dt);
    } else {
      this.decayConfidence(0, dt);
    }

    this.last = result;
    return result;
  }

  /**
   * Lose confidence while nothing is visible.
   *
   * Two different rates on purpose (§7): while the player is *partially* visible confidence falls
   * slowly, because she can still see something and should not forget it; once they are completely
   * hidden it falls faster, because she has nothing to go on but memory. The distinction is what makes
   * breaking line of sight feel like it works, while ducking behind a chair for a moment does not.
   */
  private decayConfidence(visibility: number, dt: number): void {
    const cfg = this.cfg;
    // The visibility reported for *this* sample decides the rate, not the previous one: the caller
    // passes 0 when the player failed an early-out test (out of range, outside the cone, or behind
    // them), which is genuinely "she has nothing to go on" and so takes the fast decay.
    const rate =
      visibility > cfg.visionMinVisibility
        ? cfg.visionConfidenceDecayPartial
        : cfg.visionConfidenceDecay;
    this.confidence = Math.max(0, this.confidence - rate * dt);
  }

  /**
   * Is she confident enough to commit to a chase?
   *
   * Hysteresis lives here rather than in the FSM so that every caller agrees on the answer: `chasing`
   * remembers whether the bar is currently raised (`threshold`) or lowered (`threshold -
   * hysteresis`), which is what stops CHASE and SEARCH flickering on a single occluded frame (§7).
   */
  isConfident(chasing: boolean): boolean {
    const threshold = chasing
      ? this.cfg.visionConfidenceThreshold - this.cfg.visionConfidenceHysteresis
      : this.cfg.visionConfidenceThreshold;
    return this.confidence >= threshold;
  }
}

export class HearingSystem {
  constructor(
    private readonly cfg: DaayanConfig,
    private readonly obstacles: ObstacleGrid,
  ) {}

  /**
   * Perceive a sound event, or reject it as inaudible.
   *
   * `perceivedLoudness = baseLoudness × distanceFalloff × obstructionModifier` — the spec's formula
   * (§8), with one addition: obstruction is applied per wall crossed rather than as a single factor,
   * because a sound through three walls should be quieter than one through a doorway, and a flat
   * modifier cannot express that.
   *
   * Returns null when the sound never reaches her, which is the common case and costs one distance
   * calculation.
   */
  /**
   * Perceive a sound, or null if it is out of earshot or too faint to matter.
   *
   * `rangeOverride` raises the audible radius for this one event. It exists for the noise bar at
   * maximum: that is the loudest thing the player can do, and refusing to let her hear it because they
   * were on another floor is not a plausible outcome. Everything else — falloff, wall damping, jitter —
   * still applies, so she still only gets a probable location rather than the exact one.
   */
  perceive(event: SoundEvent, ear: Vec3, rangeOverride?: number): HeardSound | null {
    const cfg = this.cfg;
    const range = rangeOverride ?? cfg.hearingRange;
    const distance = Math.sqrt(distSq(ear, event.position));
    if (distance > range) return null;

    // Linear falloff to the edge of her hearing, squared a little so near sounds dominate: a sound at
    // half her range should be clearly more important than one at the edge, not twice as loud.
    // Normalised against `range`, not `cfg.hearingRange`, so an override scales the whole curve rather
    // than measuring everything against a limit it has already passed.
    const t = distance / range;
    const falloff = (1 - t) * (1 - t);

    const walls = this.obstacles.crossings(ear, event.position);
    // Damp, never block (§8): each wall multiplies, so even a distant, muffled sound is *something*.
    // The floor of 0.2 means no amount of wall makes a sound vanish entirely once it is in range.
    const obstruction = Math.max(0.2, Math.pow(cfg.hearingObstructionModifier, walls));

    const base = event.loudness > 0 ? event.loudness : SOUND_LOUDNESS[event.kind];
    const perceived = base * falloff * obstruction * cfg.hearingSensitivity;
    if (perceived < cfg.hearingThreshold) return null;

    // She goes to roughly where it came from, not exactly (§9): "Do not make her instantly know that
    // the player was responsible. The sound only provides a probable location."
    const jitter = cfg.hearingPositionJitter;
    const position = {
      x: event.position.x + (Math.random() * 2 - 1) * jitter,
      y: event.position.y,
      z: event.position.z + (Math.random() * 2 - 1) * jitter,
    } as Vec3;

    return {
      position,
      source: event.position,
      baseLoudness: base,
      perceivedLoudness: perceived,
      kind: event.kind,
      time: event.time,
    };
  }

  /** Whether a perceived sound is loud enough to be a hard interrupt rather than a nudge (§4). */
  isLoud(sound: HeardSound): boolean {
    return sound.perceivedLoudness >= this.cfg.hearingLoudThreshold;
  }
}
