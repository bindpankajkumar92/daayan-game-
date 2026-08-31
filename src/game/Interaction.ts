/**
 * Interaction — proximity + view-angle picking for everything the player can use.
 *
 * No raycasting. A ray against the merged house geometry would need per-prop meshes kept out of
 * the merge to be hittable, and it fails exactly where players expect it to work: the edge of a
 * note lying flat on a table, a candle behind a chair leg. Distance weighted by how close the
 * thing is to the centre of the screen picks what the player *means* far more reliably, and it
 * costs one dot product per candidate.
 *
 * Labels are functions, not strings, because what an object offers changes with state: the same
 * lock is "Locked — needs a key", then "Use Brass Key", then nothing at all. Returning null is
 * how an object says "not now" without being unregistered and re-registered.
 */

import { Vector3 } from 'three';
import type { Engine } from '@/core/Engine';

export interface Interactable {
  id: string;
  /** World position of the thing's grab point — not necessarily its mesh origin. */
  pos: Vector3;
  /** How close the player must stand, in metres. Default 2.2. */
  reach?: number;
  /** Prompt text, or null when this object currently offers nothing. */
  label: () => string | null;
  onUse: () => void;
}

/** Half-angle tolerance, as a dot product against the view direction. ~55 degrees. */
const MIN_FACING = 0.56;
/** Inside this distance, facing is ignored — you are close enough to be touching it. */
const TOUCH_RANGE = 0.9;

export class InteractionSystem {
  private items = new Map<string, Interactable>();
  private readonly fwd = new Vector3();
  private readonly to = new Vector3();
  private current: Interactable | null = null;

  constructor(private engine: Engine) {}

  add(i: Interactable): void {
    this.items.set(i.id, i);
  }

  remove(id: string): void {
    this.items.delete(id);
  }

  clear(): void {
    this.items.clear();
    this.current = null;
  }

  get(id: string): Interactable | undefined {
    return this.items.get(id);
  }

  /** The object the prompt is currently offering. Recomputed by `update`. */
  getCurrent(): Interactable | null {
    return this.current;
  }

  /**
   * Re-pick the best candidate. Called once per frame; the HUD reads `getCurrent()` after.
   * Returns the label so the caller does not have to ask twice.
   */
  update(): string | null {
    const cam = this.engine.camera;
    cam.getWorldDirection(this.fwd);
    let best: Interactable | null = null;
    let bestLabel: string | null = null;
    let bestScore = Infinity;

    for (const it of this.items.values()) {
      this.to.copy(it.pos).sub(cam.position);
      const dist = this.to.length();
      const reach = it.reach ?? 2.2;
      if (dist > reach) continue;
      const facing = dist < 1e-4 ? 1 : this.to.divideScalar(dist).dot(this.fwd);
      if (dist > TOUCH_RANGE && facing < MIN_FACING) continue;
      const label = it.label();
      if (label === null) continue;
      // Centre-of-screen beats proximity: at equal distance the thing you are looking straight
      // at wins, which is what stops a note on a desk losing to the desk itself.
      const score = dist * (1.6 - Math.max(facing, 0));
      if (score < bestScore) {
        bestScore = score;
        best = it;
        bestLabel = label;
      }
    }

    this.current = best;
    return bestLabel;
  }

  /** Fire the current candidate. Safe to call with nothing in range. */
  use(): void {
    const it = this.current;
    if (!it) return;
    // Re-check: a frame can pass between the pick and the tap, and a label that went null in
    // between means the object no longer wants to be used.
    if (it.label() === null) return;
    it.onUse();
  }
}
