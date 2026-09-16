/**
 * UpperDoor — the flat's front door, in the opening at the top of the stair.
 *
 * The opening at UPPER_DOOR was a hole: the upper storey's west wall is drawn with a gap in it and the
 * collider set has a matching gap, so the player walked in through empty air. door.glb fills it with
 * something that reads as a way in and, until it is used, stops being one.
 *
 * Two things this has to get right.
 *
 * - **Only the leaf may swing.** The file is three meshes — frame, leaf, handle — under one root, and
 *   turning the root would take the frame out of the wall with it. So the leaf and the handle are
 *   re-parented, world transform intact, under a pivot standing on the hinge edge.
 * - **The pivot has to stay under the root.** ModelProps hides the whole upper storey by the root's
 *   `visible` flag when the player is downstairs (see ModelPlacement.minEyeY), and a pivot parented
 *   next to the root instead of under it would leave a door leaf hanging in mid-air over the hall.
 *   Being under the root means inheriting the placement yaw, which is cancelled once at build time so
 *   the swing angle below can be read as a world one.
 */

import { Box3, Group, Vector3, type Object3D } from 'three';
import { UPPER, UPPER_DOOR, UP_Y } from '@/world/HouseRooms';
import type { AABB, FPController } from '@/player/FPController';
import type { InteractionSystem } from '@/game/Interaction';
import { aabbOf, trackLeaf } from '@/world/Fixtures';

/**
 * The moving parts, by the names door.glb ships. Matched as substrings because the exporter appends
 * the material to the mesh name, and missing one is not fatal — see the guard below.
 */
const LEAF_PARTS = ['door_', 'handle'];

/** How far it swings. 100 degrees stands it clear of the opening rather than half across it. */
const OPEN_ANGLE = (100 * Math.PI) / 180;

/** Slow enough to be a heavy door and quick enough not to hold the player at the threshold. */
const OPEN_TIME = 1.4;

/** See InnerDoor.SETTLE_TIME: one more attempt to move the keep-out onto a leaf that has swung. */
const SETTLE_TIME = 0.5;

export interface UpperDoorDeps {
  aabbs: AABB[];
  /** For the leaf's own keep-out: its radius, and where it is when the leaf needs to move. */
  player: FPController;
  interact: InteractionSystem;
  tween: (dur: number, apply: (k: number) => void) => void;
  toast: (msg: string) => void;
  onError: (err: unknown, where: string) => void;
}

/**
 * Hinge `root`'s leaf and hold the doorway shut until the player opens it. Called from the onPlaced
 * hook, which is the first moment the fit's scale and yaw are on the root and the world transform
 * means anything.
 */
export function armUpperDoor(root: Object3D, deps: UpperDoorDeps): void {
  const leaf: Object3D[] = [];
  root.traverse((o) => {
    if (o !== root && LEAF_PARTS.some((p) => o.name.toLowerCase().includes(p))) leaf.push(o);
  });
  if (leaf.length === 0) {
    // The frame alone is still a door in a wall; what is lost is the swing, so say so and leave the
    // blocker off rather than sealing the storey shut behind an object that cannot move.
    deps.onError(new Error(`no leaf mesh matching ${LEAF_PARTS.join('/')}`), 'upper-door:leaf');
    return;
  }

  root.updateWorldMatrix(true, true);
  const box = new Box3();
  for (const o of leaf) box.expandByObject(o);
  // Hinge on the low-z jamb, so a positive turn about y carries the leaf toward +x, into the room.
  const hinge = new Vector3((box.min.x + box.max.x) / 2, 0, box.min.z);

  const pivot = new Group();
  pivot.name = 'upper-door.pivot';
  root.add(pivot);
  pivot.position.copy(root.worldToLocal(hinge));
  // Cancel the row's yaw so the pivot's own frame is world-aligned and OPEN_ANGLE is a world angle.
  const shut = -root.rotation.y;
  pivot.rotation.y = shut;
  for (const o of leaf) pivot.attach(o);

  // One box across the opening, held by reference. The gate does the same thing for the same reason:
  // a swinging leaf has no collider of its own, and splicing the controller's array is worse.
  const block = aabbOf(UPPER.x0, UP_Y, UPPER_DOOR.z, 0.14, UPPER_DOOR.half, UPPER_DOOR.top);
  deps.aabbs.push(block);

  // The leaf's own keep-out, over the leaf parts only: the frame stays out of it, because a keep-out
  // measured round a frame would seal the opening it stands in. See leafBoxes for the measurements.
  const follow = trackLeaf(leaf, deps.aabbs, deps.player);
  const settle = (): void => {
    deps.tween(SETTLE_TIME, (k) => {
      if (follow()) return;
      if (k >= 1) settle();
    });
  };

  let open = false;
  /**
   * True while a swing is in flight, so a second press cannot reverse a leaf that is halfway round.
   * The prompt is withdrawn for the duration rather than left up doing nothing.
   */
  let busy = false;
  /** Where the blocker sits when the door is shut, so closing can put it back exactly. */
  const shutBlockY = { min: block.minY, max: block.maxY };

  /**
   * Put the doorway blocker back, once the player is clear of the opening.
   *
   * The box fills the doorway, so restoring it around a player standing in it would leave them inside
   * a solid collider — and `FPController` only ignores boxes that end *under* the feet, which a
   * full-height one does not. So this waits for the player to step out, using the same re-armed tween
   * idiom as `settle` and for the same reason: the geometry has to go somewhere the player currently
   * is, and the player is the one who decides when that stops being true.
   */
  const restoreBlock = (): void => {
    deps.tween(SETTLE_TIME, (k) => {
      const r = deps.player.getRadius();
      const p = deps.player.position;
      const inside =
        p.x + r > block.minX && p.x - r < block.maxX && p.z + r > block.minZ && p.z - r < block.maxZ;
      if (inside) {
        if (k >= 1) restoreBlock();
        return;
      }
      block.minY = shutBlockY.min;
      block.maxY = shutBlockY.max;
    });
  };

  deps.interact.add({
    id: 'upper.door',
    pos: new Vector3(UPPER.x0, UP_Y + 1.2, UPPER_DOOR.z),
    reach: 2.2,
    label: () => (busy ? null : open ? 'Close the door' : 'Open the door'),
    onUse: () => {
      if (busy) return;
      busy = true;
      open = !open;

      if (open) {
        // Dropped below the world rather than removed: FPController ignores boxes that end under the
        // player's feet, and the array is shared.
        block.minY = -60;
        block.maxY = -59.8;
        deps.tween(OPEN_TIME, (k) => {
          pivot.rotation.y = shut + k * OPEN_ANGLE;
          const landed = follow();
          if (k >= 1) {
            busy = false;
            if (!landed) settle();
          }
        });
        deps.toast('The door gives, and the flat exhales.');
        return;
      }

      // Closing. The blocker goes back only once the leaf has finished travelling, because until then
      // the doorway is still the thing the player is walking through.
      deps.tween(OPEN_TIME, (k) => {
        pivot.rotation.y = shut + (1 - k) * OPEN_ANGLE;
        const landed = follow();
        if (k >= 1) {
          busy = false;
          if (!landed) settle();
          restoreBlock();
        }
      });
      deps.toast('You pull the door shut behind you.');
    },
  });
}
