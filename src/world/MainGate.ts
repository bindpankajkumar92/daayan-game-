/**
 * MainGate — hinges the imported gate leaf and hands the caller its swing.
 *
 * gate-main.glb is a bare slab: four meshes, no frame, no jambs. That is what makes it a drop-in for
 * the procedural gate's leaves — the opening's own casing (makeCasing) is the frame, and the three
 * locks stay where they were, procedural, on the fixed centre line where the puzzle needs them to be
 * legible from the spawn point.
 *
 * So the surgery here is the smaller half of UpperDoor's: the whole file is the leaf, so instead of
 * picking meshes out of a frame it re-parents the model's own subtree, world transform intact, under a
 * pivot standing on the hinge edge. The pivot is a child of the root for the same reason as there —
 * ModelProps owns the root's visibility and position, and anything parented beside it would come
 * adrift of the wall.
 */

import { Box3, Group, Vector3, type Object3D } from 'three';

/** How far it swings. Past 90 so the leaf stands clear of the gateway the player walks out through. */
const OPEN_ANGLE = (100 * Math.PI) / 180;

/**
 * Hinge `root` on the edge away from its handles and return the function that turns it, or null if
 * the model arrived empty. `k` runs 0 shut to 1 open, so a tween can drive it directly.
 *
 * Called from the placement hook: the hinge is read off the leaf's world box, which only means
 * anything once the fit has written the root's scale and position.
 */
export function hingeMainGate(root: Object3D): ((k: number) => void) | null {
  const parts = root.children.filter((c) => c.name !== 'main-gate.pivot');
  if (parts.length === 0) return null;

  root.updateWorldMatrix(true, true);
  const box = new Box3();
  for (const o of parts) box.expandByObject(o);
  // The handles are on the +x stile, so the hinge is the other one. A positive turn about y then
  // carries the leaf toward -z, out onto the porch, which is the way a front door should open and the
  // one direction with nothing in it — the porch posts stand at x +/-1.7, wide of the sweep.
  const hinge = new Vector3(box.min.x, 0, (box.min.z + box.max.z) / 2);

  const pivot = new Group();
  pivot.name = 'main-gate.pivot';
  root.add(pivot);
  pivot.position.copy(root.worldToLocal(hinge));
  // Cancel the row's yaw so the pivot's own frame is world-aligned and OPEN_ANGLE is a world angle.
  const shut = -root.rotation.y;
  pivot.rotation.y = shut;
  for (const o of parts) pivot.attach(o);

  return (k: number) => {
    pivot.rotation.y = shut + k * OPEN_ANGLE;
  };
}
