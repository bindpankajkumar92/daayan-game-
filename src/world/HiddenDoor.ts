/**
 * HiddenDoor — the locked leaf in the nook's west wall.
 *
 * The player found this door, not the other way round: they stood in the nook and looked west, and what
 * they were looking at was a plank panel with a red square on it. That panel is painted into
 * `room-upper.glb`'s own texture — a scene-wide scan finds no red material anywhere, and hiding the
 * model takes the square with it — so there was never a prop to make interactive. The doorway is a
 * CarveBox through the model's triangles. The painted square goes with the carve and nothing is
 * rebuilt in its place; the interaction still stands off the leaf where the square used to be.
 *
 * Three things this has to get right.
 *
 * - **It only cracks at the right coordinates.** The almirah note gives an X Y Z; standing there (the
 *   HUD readout says where the player is) turns the prompt from "A solid wall?" into "Crack the hidden
 *   door". The check itself belongs to the scene, which owns the coordinate system (`canCrack`).
 * - **The leaf swings into the stairwell.** The hinge is on the south jamb, so a positive turn carries
 *   the leaf west, away from the nook and into the room it opens onto.
 * - **The pivot has to stay under the root.** ModelProps hides the whole upper storey by the root's
 *   `visible` flag when the player is downstairs (minEyeY), and a pivot parented beside the root would
 *   leave a leaf hanging in mid-air over the hall. Being under it means inheriting the placement yaw,
 *   which is cancelled once at build time so the swing below is a world angle.
 */

import { Box3, Group, Vector3, type Object3D } from 'three';
import { UP_HIDDEN_DOOR, UP_Y } from '@/world/HouseRooms';
import type { AABB, FPController } from '@/player/FPController';
import type { GameState } from '@/game/GameState';
import type { InteractionSystem } from '@/game/Interaction';
import { aabbOf, trackLeaf } from '@/world/Fixtures';

/** How far it swings. Past 90 so the leaf stands clear of the opening rather than half across it. */
const OPEN_ANGLE = (100 * Math.PI) / 180;

/** Heavier and slower than an interior leaf: this one has been shut for a long time. */
const OPEN_TIME = 1.6;

/** See InnerDoor.SETTLE_TIME: one more attempt to move the keep-out onto a leaf that has swung. */
const SETTLE_TIME = 0.5;

/** The leaf's parts, by the names door.glb ships. The frame is dropped at placement. */
const LEAF_PARTS = ['door_', 'handle'];

export interface HiddenDoorDeps {
  aabbs: AABB[];
  /** For the leaf's own keep-out: its radius, and where it is when the leaf needs to move. */
  player: FPController;
  interact: InteractionSystem;
  /** Records the door as open. */
  state: GameState;
  /** True while the player stands on the coordinates the almirah note gives. */
  canCrack: () => boolean;
  tween: (dur: number, apply: (k: number) => void) => void;
  toast: (msg: string) => void;
  /** Fired once, when the leaf has actually started to move — the reveal's cue. */
  onOpened?: () => void;
  onError: (err: unknown, where: string) => void;
}

/**
 * Hinge `root`'s leaf and hold the doorway shut until the red key turns.
 *
 * Called from the placement hook, which is the first moment the fit's scale and yaw are on the root and
 * so the first moment the leaf's world box means anything.
 */
export function armHiddenDoor(root: Object3D, deps: HiddenDoorDeps): void {
  const parts: Object3D[] = [];
  root.traverse((o) => {
    if (o !== root && LEAF_PARTS.some((p) => o.name.toLowerCase().includes(p))) parts.push(o);
  });
  if (parts.length === 0) {
    // Without a leaf there is nothing to swing, so leave the blocker off rather than sealing a room
    // shut behind an object that cannot move — the same call the other two doors make.
    deps.onError(new Error(`no leaf mesh matching ${LEAF_PARTS.join('/')}`), 'hidden-door:leaf');
    return;
  }

  root.updateWorldMatrix(true, true);
  const box = new Box3();
  for (const o of parts) box.expandByObject(o);
  // Hinge on the low-z jamb. The player arrives from the nook to the east, so a positive turn about y
  // carries the leaf west, away from them and into the room it opens onto.
  const hinge = new Vector3((box.min.x + box.max.x) / 2, 0, box.min.z);

  const pivot = new Group();
  pivot.name = 'hidden-door.pivot';
  root.add(pivot);
  pivot.position.copy(root.worldToLocal(hinge));
  // Cancel the placement yaw so the pivot's own frame is world-aligned and OPEN_ANGLE is a world angle.
  const shut = -root.rotation.y;
  pivot.rotation.y = shut;
  for (const o of parts) pivot.attach(o);

  // One box filling the opening, held by reference, as every other swinging leaf in the house does:
  // a leaf has no collider of its own, and splicing the controller's shared array is worse.
  const block = aabbOf(
    UP_HIDDEN_DOOR.x,
    UP_Y,
    UP_HIDDEN_DOOR.z,
    0.14,
    UP_HIDDEN_DOOR.half,
    UP_HIDDEN_DOOR.top,
  );
  deps.aabbs.push(block);

  // The interaction stands where the lock was, on the east face — the nook side, the face the player
  // arrives at. Nothing is drawn there now; 0.62 is the old plate's stand-off, kept so the prompt still
  // appears at the same reach along the leaf.
  const lockAnchor = new Vector3(UP_HIDDEN_DOOR.x + 0.62, UP_Y + 1.15, UP_HIDDEN_DOOR.z);

  // The leaf's own keep-out, over the leaf parts only — a keep-out measured round a frame would seal
  // the opening it stands in. See leafBoxes for the measurements.
  const follow = trackLeaf(parts, deps.aabbs, deps.player);
  const settle = (): void => {
    deps.tween(SETTLE_TIME, (k) => {
      if (follow()) return;
      if (k >= 1) settle();
    });
  };

  let open = false;
  let busy = false;

  deps.interact.add({
    id: 'upper.hidden-door',
    pos: lockAnchor,
    reach: 2.2,
    label: () => {
      if (busy || open) return null;
      return deps.canCrack() ? 'Crack the hidden door' : 'A solid wall?';
    },
    onUse: () => {
      if (busy || open) return;
      if (!deps.canCrack()) {
        deps.toast('The boards do not move. Check the coordinates on the note.');
        return;
      }
      if (!deps.state.openHidden()) return;
      busy = true;
      open = true;

      // Dropped below the world rather than removed: FPController ignores boxes that end under the
      // player's feet, and the array is shared.
      block.minY = -60;
      block.maxY = -59.8;

      deps.onOpened?.();
      deps.tween(OPEN_TIME, (k) => {
        pivot.rotation.y = shut + k * OPEN_ANGLE;
        const landed = follow();
        if (k >= 1) {
          busy = false;
          if (!landed) settle();
        }
      });
      deps.toast('You push where the note said. The wall opens where there was no door.');
    },
  });
}
