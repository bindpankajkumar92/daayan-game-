/**
 * DaayanKnife — puts knife.glb in the daayan's right hand.
 *
 * Three things are worth knowing:
 *
 * - **It must run after her fit, not merely after her load.** fitToHeight writes its factor into her
 *   root's own scale, and every number here is in *bone* units, which inherit that factor. The
 *   onPlaced hook in ModelProps fires at exactly the right moment; attaching any earlier would put a
 *   knife the size of the ritual room in her fist.
 * - **A bone-parented prop needs no update of its own.** Her clip animates the hand bone's local
 *   transform and the graph carries the child along, so the knife also inherits her distance cull and
 *   her visibility for nothing.
 * - **knife.glb is deliberately not a MODEL_PLACEMENTS row.** ModelLoader hands every caller the same
 *   Group, so a knife on the living room table and a knife in her hand cannot both exist. The row was
 *   deleted, which is the same reason lantern.glb has none.
 *
 * The offsets below are in the hand bone's own frame, where +y runs out toward the fingertips and +z
 * toward the thumb, and one unit measures about a centimetre once her fit is applied.
 */

import type { Object3D } from 'three';
import type { ModelLoader } from '@/world/ModelLoader';

const KNIFE_FILE = 'knife.glb';

/** Character Creator's right wrist, the last bone before the fingers. */
const HAND_BONE = 'CC_Base_R_Hand_083';

/**
 * The file measures 2.0 units along its own +x, so 13 gives a 0.26 m blade — a kitchen knife rather
 * than a machete. A plain multiply is safe because the root arrives unfitted: nothing else places it.
 */
const KNIFE_SCALE = 13;

/** Where the grip sits: the fist's centre, offset by the knife's origin-to-handle distance. */
const KNIFE_POS = { x: 0, y: 9.9, z: 1.5 };

/** Rz(pi/2) turns the blade's own +x onto the bone's +y, i.e. out past the fingertips. */
const KNIFE_ROT = { x: 0, y: 0, z: Math.PI / 2 };

/**
 * Hang the knife off `daayan`'s right hand. Fire and forget: the file arrives a frame or two later
 * and until it does she is simply empty-handed, exactly like the rest of the imported art. Nothing to
 * dispose — the bone belongs to her root, which ModelProps already removes, and the geometry belongs
 * to the ModelLoader cache.
 */
export function armDaayan(
  loader: ModelLoader,
  daayan: Object3D,
  onError: (err: unknown, where: string) => void,
): void {
  const bone = daayan.getObjectByName(HAND_BONE);
  if (!bone) {
    onError(new Error(`no bone ${HAND_BONE}`), 'daayan:knife');
    return;
  }
  void (async () => {
    try {
      const { root } = await loader.load(KNIFE_FILE);
      root.name = 'daayan.knife';
      // Written rather than nudged: the cached Group is shared, so it may not be assumed to be clean.
      root.position.set(KNIFE_POS.x, KNIFE_POS.y, KNIFE_POS.z);
      root.rotation.set(KNIFE_ROT.x, KNIFE_ROT.y, KNIFE_ROT.z);
      root.scale.setScalar(KNIFE_SCALE);
      bone.add(root);
    } catch (err) {
      onError(err, `daayan:${KNIFE_FILE}`);
    }
  })();
}
