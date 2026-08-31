/**
 * Hiding — enter/leave pockets under imported beds and inside the old wardrobe.
 *
 * Hiding is not a second movement mode. It owns the camera position for a while, locks controller
 * translation (including gravity), and gives the same INTERACT button a "Leave hiding place" action.
 * Look remains live, so hiding is not a modal screen and the player can still watch the room.
 *
 * Spots are measured from the fitted Object3D rather than copied from MODEL_PLACEMENTS. Those rows scale
 * each file by its longest axis, and the source files do not share origins; a hand-written offset that
 * is correct for bed.glb can put the camera in bed-old.glb's headboard or outside closet-old.glb.
 *
 * There is no collision manipulation here. A hidden player is intentionally inside a prop's collider,
 * and FPController.setMovementLocked makes collision irrelevant until exit. Exit returns to the exact
 * position occupied before entering — a position already proven collision-free — rather than guessing
 * which face of a rotated model is its front.
 */

import { Box3, Vector3, type Object3D } from 'three';
import { globalBus } from '@/core/EventBus';
import type { InteractionSystem } from '@/game/Interaction';
import type { FPController } from '@/player/FPController';

export type HidingKind = 'bed' | 'wardrobe';

interface Spot {
  id: string;
  kind: HidingKind;
  /** Interaction point at the accessible centre of the model. */
  use: Vector3;
  /** Camera pocket while hidden. */
  pocket: Vector3;
  /** Range includes half a large bed plus one arm's reach. */
  reach: number;
}

export interface HidingDeps {
  player: FPController;
  interact: InteractionSystem;
}

export interface HidingHandles {
  /** Arm one fitted imported model. Non-hiding model names are ignored. */
  onPlaced: (name: string, root: Object3D) => void;
  /** Arm procedural furniture from its known world box. */
  addBox: (id: string, kind: HidingKind, bounds: Box3) => void;
  isHidden: () => boolean;
  dispose: () => void;
}

const BED_NAMES = new Set(['bed.glb', 'bed-horror.glb', 'bed-old.glb']);
const WARDROBE_NAMES = new Set(['closet-old.glb']);

/** Eye height under a bed. Low enough to read as underneath, high enough not to z-fight the floor. */
const UNDER_BED_EYE = 0.27;

export function armHiding(deps: HidingDeps): HidingHandles {
  const { player, interact } = deps;
  const box = new Box3();
  const size = new Vector3();
  const centre = new Vector3();
  const exit = new Vector3();
  let exitYaw = 0;
  let exitPitch = 0;
  let active: Spot | null = null;
  const ids: string[] = [];

  // A screen-space silhouette supplies the enclosure the camera cannot get from a model alone. It is
  // plain gradients, not backdrop-filter, so it does not read the WebGL framebuffer back every frame.
  const mask = document.createElement('div');
  mask.id = 'hiding-mask';
  mask.style.cssText = `
    position: fixed; inset: 0; z-index: 7100; display: none; pointer-events: none;
  `;
  document.body.appendChild(mask);

  const showMask = (kind: HidingKind): void => {
    mask.style.display = 'block';
    mask.style.background =
      kind === 'bed'
        ? `linear-gradient(to bottom,
            rgba(0,0,0,0.98) 0%, rgba(0,0,0,0.96) 36%, rgba(0,0,0,0.38) 48%,
            rgba(0,0,0,0.08) 60%, rgba(0,0,0,0.62) 82%, rgba(0,0,0,0.94) 100%)`
        : `linear-gradient(to right,
            rgba(0,0,0,0.98) 0%, rgba(0,0,0,0.88) 42%, rgba(0,0,0,0.28) 48%,
            rgba(0,0,0,0.28) 52%, rgba(0,0,0,0.88) 58%, rgba(0,0,0,0.98) 100%)`;
  };

  const leave = (): void => {
    const spot = active;
    if (spot === null) return;
    active = null;
    player.setMovementLocked(false);
    player.warpTo(exit, exitYaw);
    player.look(exitYaw, exitPitch);
    mask.style.display = 'none';
    globalBus.emit('player:hidden', { hidden: false, spotId: spot.id });
  };

  const enter = (spot: Spot): void => {
    if (active !== null) return;
    exit.copy(player.position);
    exitYaw = player.facing.y;
    exitPitch = player.facing.x;
    active = spot;

    // Warp first, then lock. warpTo resolves its floor bookkeeping, while the lock prevents the next
    // frame's gravity/ground-snap from pulling this deliberately non-standing camera back to the floor.
    player.warpTo(spot.pocket, player.facing.y);
    player.setMovementLocked(true);
    showMask(spot.kind);
    globalBus.emit('player:hidden', { hidden: true, spotId: spot.id });
  };

  const addBox = (sourceId: string, kind: HidingKind, bounds: Box3): void => {
    bounds.getSize(size);
    bounds.getCenter(centre);

    const id = `hide:${sourceId}:${ids.length}`;
    ids.push(id);
    const spot: Spot = {
      id,
      kind,
      use: new Vector3(centre.x, kind === 'bed' ? bounds.min.y + 0.48 : centre.y, centre.z),
      pocket:
        kind === 'bed'
          ? new Vector3(centre.x, bounds.min.y + UNDER_BED_EYE, centre.z)
          : new Vector3(centre.x, Math.min(bounds.max.y - 0.25, bounds.min.y + 1.35), centre.z),
      reach: Math.max(size.x, size.z) * 0.52 + 0.85,
    };

    interact.add({
      id,
      pos: spot.use,
      reach: spot.reach,
      label: () => {
        if (active === spot) return 'Leave hiding place';
        if (active !== null) return null;
        return kind === 'bed' ? 'Hide under the bed' : 'Hide inside the wardrobe';
      },
      verb: () => (active === spot ? 'exit' : 'hide'),
      onUse: () => {
        if (active === spot) leave();
        else enter(spot);
      },
    });
  };

  const onPlaced = (name: string, root: Object3D): void => {
    const kind: HidingKind | null = BED_NAMES.has(name)
      ? 'bed'
      : WARDROBE_NAMES.has(name)
        ? 'wardrobe'
        : null;
    if (kind === null) return;

    root.updateWorldMatrix(true, true);
    box.setFromObject(root);
    // addBox reads the bounds synchronously, so reusing the scratch Box3 on the next placement is safe.
    addBox(name, kind, box);
  };

  return {
    onPlaced,
    addBox,
    isHidden: () => active !== null,
    dispose: () => {
      if (active !== null) leave();
      for (const id of ids) interact.remove(id);
      mask.remove();
    },
  };
}
