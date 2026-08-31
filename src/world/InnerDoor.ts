/**
 * InnerDoor — the leaf standing in the doorway cut through the upper flat's east partition.
 *
 * This one exists because of a hole that was made rather than one that was found. room-upper.glb is a
 * cutaway diorama and that partition is sealed on both faces, so 43.8 of the flat's 59 m2 — the
 * corridor and every room off it — sat behind an unbroken wall. CarveBox subtracts the opening out of
 * the model's own triangles at load, which is what makes the collider gap real too, since the flat's
 * colliders are sliced from the faces the model draws. See UPPER_INNER for the numbers.
 *
 * The surgery is MainGate's rather than UpperDoor's: door-inner.glb is two meshes and both of them are
 * the leaf, so instead of picking a leaf out of a frame the whole subtree is re-parented, world
 * transform intact, under a pivot standing on the hinge edge. The frame is makeCasing()'s, as it is at
 * the main gate — which is also what covers the paper-thin skin edges the cut leaves behind.
 *
 * Three things this has to get right.
 *
 * - **The pivot has to stay under the root.** ModelProps hides the whole upper storey by the root's
 *   `visible` flag when the player is downstairs (minEyeY 1.9), and a pivot parented beside the root
 *   would leave a door leaf hanging in mid-air over the hall. Being under it means inheriting the
 *   placement yaw, which is cancelled once at build time so the swing below is a world angle.
 * - **It swings away from the player.** The approach is from the west, out of the room the stair lands
 *   in, so hinging on the low-z jamb carries the leaf east into the corridor rather than back into the
 *   face of whoever opened it. At full swing its free edge reaches x 20.93, clear of the corridor's
 *   own wall line at 21.12.
 * - **Shut means shut.** The carve leaves no collider anywhere in the opening, so without a blocker the
 *   player would walk straight through a closed door.
 */

import { Box3, Group, Vector3, type Object3D } from 'three';
import { UPPER_INNER, UP_Y } from '@/world/HouseRooms';
import type { AABB } from '@/player/FPController';
import type { InteractionSystem } from '@/game/Interaction';
import { aabbOf } from '@/world/Fixtures';

/** How far it swings. Past 90 so the leaf stands clear of the opening rather than half across it. */
const OPEN_ANGLE = (100 * Math.PI) / 180;

/** Quicker than the flat's front door: an interior leaf, and the player is already inside. */
const OPEN_TIME = 1.0;

export interface InnerDoorDeps {
  aabbs: AABB[];
  interact: InteractionSystem;
  tween: (dur: number, apply: (k: number) => void) => void;
  toast: (msg: string) => void;
  onError: (err: unknown, where: string) => void;
}

/**
 * Hinge `root` and hold the carved doorway shut until the player pushes it open. Called from the
 * placement hook, which is the first moment the fit's scale and yaw are on the root and so the first
 * moment the leaf's world box means anything.
 */
export function armInnerDoor(root: Object3D, deps: InnerDoorDeps): void {
  const parts = root.children.filter((c) => c.name !== 'inner-door.pivot');
  if (parts.length === 0) {
    // An empty file here would seal the flat again, which is the bug this whole cut was made to fix.
    // So say so and leave the blocker off: an open hole is worse-looking and better than a dead end.
    deps.onError(new Error('door-inner.glb arrived with no children'), 'inner-door:leaf');
    return;
  }

  root.updateWorldMatrix(true, true);
  const box = new Box3();
  for (const o of parts) box.expandByObject(o);
  // Hinge on the low-z jamb, so a positive turn about y carries the leaf toward +x, out into the
  // corridor and away from the player coming through.
  const hinge = new Vector3((box.min.x + box.max.x) / 2, 0, box.min.z);

  const pivot = new Group();
  pivot.name = 'inner-door.pivot';
  root.add(pivot);
  pivot.position.copy(root.worldToLocal(hinge));
  // Cancel the placement yaw so the pivot's own frame is world-aligned and OPEN_ANGLE is a world angle.
  const shut = -root.rotation.y;
  pivot.rotation.y = shut;
  for (const o of parts) pivot.attach(o);

  // One box filling the opening, held by reference, exactly as the flat's front door and the gate do:
  // a swinging leaf has no collider of its own, and splicing the controller's shared array is worse.
  const block = aabbOf(UPPER_INNER.x, UP_Y, UPPER_INNER.z, 0.14, UPPER_INNER.half, UPPER_INNER.top);
  deps.aabbs.push(block);

  let open = false;
  deps.interact.add({
    id: 'upper.inner-door',
    pos: new Vector3(UPPER_INNER.x, UP_Y + 1.2, UPPER_INNER.z),
    reach: 2.2,
    label: () => (open ? null : 'Push the door open'),
    onUse: () => {
      if (open) return;
      open = true;
      // Dropped below the world rather than removed: FPController ignores boxes that end under the
      // player's feet, and the array is shared.
      block.minY = -60;
      block.maxY = -59.8;
      deps.tween(OPEN_TIME, (k) => {
        pivot.rotation.y = shut + k * OPEN_ANGLE;
      });
      deps.toast('The door swings back, and the rest of the flat opens up.');
    },
  });
}
