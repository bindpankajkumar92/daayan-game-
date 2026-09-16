/**
 * DaayanKnife — puts knife.glb in the daayan's right hand *and closes her hand around it*.
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
 * The offsets below are in the hand bone's own frame, where +y runs out toward the fingertips, -x is
 * palmar and +z runs toward the thumb, and one unit measures 10.85 mm once her fit is applied.
 *
 * The pose is not eyeballed. With the handle turned so its length runs along the hand's z, its
 * cross-section is an axis-aligned 2.08 x 3.12-unit box in the hand's x-y plane, so "this finger wraps
 * the handle" becomes "every point of each phalanx axis sits one flesh radius off that box" — scored
 * over the whole segment rather than its closest point, because scoring the closest point lets a
 * straight finger graze a corner and call it a grip. The flesh radii come out of the skin weights
 * (for a vertex dominated by one bone, its position in that bone's own frame is boneInverse * bindMatrix
 * * position, which is pose-independent), and the search ran headless against the built bundle.
 */

import type { AnimationClip, Object3D } from 'three';
import { MathUtils } from 'three';
import type { ModelLoader } from '@/world/ModelLoader';

const KNIFE_FILE = 'knife.glb';

/** Character Creator's right wrist, the last bone before the fingers. */
const HAND_BONE = 'CC_Base_R_Hand_083';

/**
 * The file measures 2.0 units along its own +x, so 13 gives a 0.26 m blade — a kitchen knife rather
 * than a machete. A plain multiply is safe because the root arrives unfitted: nothing else places it.
 */
const KNIFE_SCALE = 13;

/**
 * Handle centre. x is one handle half-thickness palmar of the palm skin (measured at x = -1.11), so
 * the handle's near face lies *against* the palm instead of floating off it; y sits it across the
 * distal half of the palm, just proximal of the knuckles at y = 7.5; z splits the 66 mm by which this
 * handle is longer than her fist is wide between pommel-past-pinky and bare handle before the bolster.
 */
const KNIFE_POS = { x: -2.15, y: 5.45, z: 6.8 };

/**
 * The handle's length onto the hand's z, i.e. across the palm rather than out along the fingers, which
 * is what a hammer grip does and what lets the fingers close over it. It maps the knife's local
 * (x, y, z) to the hand's (z, x, y) — Rz(-90) then Ry(-90), whose XYZ Euler is (-90, 0, -90).
 */
const KNIFE_ROT = { x: -90, y: 0, z: -90 };

/**
 * Curl, in degrees on each joint's local z — the axis measured to fold a finger toward the palm on this
 * rig. Only z is written: the authored x and y carry each finger's own splay and twist, and replacing
 * them would flatten the hand into four parallel fingers. The totals (~190 deg over three joints) are
 * what it takes to reach round a 23 mm handle from knuckles that start 12 mm off its near face.
 */
const FINGER_CURL: readonly (readonly [string, number])[] = [
  ['CC_Base_R_Index1_093', 70], ['CC_Base_R_Index2_094', 90], ['CC_Base_R_Index3_095', 30],
  ['CC_Base_R_Mid1_087', 80], ['CC_Base_R_Mid2_088', 95], ['CC_Base_R_Mid3_089', 15],
  ['CC_Base_R_Ring1_084', 75], ['CC_Base_R_Ring2_085', 90], ['CC_Base_R_Ring3_086', 30],
  ['CC_Base_R_Pinky1_096', 70], ['CC_Base_R_Pinky2_097', 60], ['CC_Base_R_Pinky3_098', 50],
];

/**
 * The thumb gets all three angles, not just a curl. Its frame is twisted ~52 deg out of the fingers',
 * and measured, its middle and distal phalanges both step almost purely along hand -x whatever their z
 * is — so no z-only sweep can lift the pad to the handle's outer face, and four of them duly ended
 * jammed against a range bound 30 mm short. These come from aiming the two links at an analytic elbow
 * instead: the metacarpal stays within 15 deg of its authored thenar pose, the IP joint arches around
 * the handle's proximal-outer corner, and the pad lands on the outer face at (-3.98, 5.95, 5.20),
 * one flesh radius off the wood and 0.35 units clear of the index fingertip.
 */
const THUMB_POSE: readonly (readonly [string, number, number, number])[] = [
  ['CC_Base_R_Thumb1_090', 67.2, 16.2, 16.5],
  ['CC_Base_R_Thumb2_091', -60.8, -29.8, 48.7],
  ['CC_Base_R_Thumb3_092', -31.9, 17.4, -56.3],
];

/**
 * Close the hand. Two writes are needed for one pose, because she is animated: the bones so she is
 * gripping on the frames before her mixer first ticks, and the clip so she is still gripping after it
 * does. Her single clip carries a rotation channel for every joint in this hand, so a bone write alone
 * survives exactly until the player walks into her cull radius.
 *
 * The clip's keyframes are overwritten *in place*. `AnimationAction` binds its interpolants to the
 * `values` buffer when it is constructed, and ModelProps has already called playClip by the time the
 * onPlaced hook runs, so assigning a fresh array here would leave the action reading the old one.
 * Flattening every keyframe to one value is the intent, not a shortcut: a hand holding a knife should
 * not breathe.
 */
function closeHandOnGrip(hand: Object3D, clips: readonly AnimationClip[]): void {
  const posed: Object3D[] = [];
  for (const [name, z] of FINGER_CURL) {
    const bone = hand.getObjectByName(name);
    if (!bone) continue;
    bone.rotation.z = MathUtils.degToRad(z);
    posed.push(bone);
  }
  for (const [name, x, y, z] of THUMB_POSE) {
    const bone = hand.getObjectByName(name);
    if (!bone) continue;
    bone.rotation.set(MathUtils.degToRad(x), MathUtils.degToRad(y), MathUtils.degToRad(z));
    posed.push(bone);
  }
  for (const clip of clips) {
    for (const track of clip.tracks) {
      const bone = posed.find((b) => track.name === `${b.name}.quaternion`);
      if (!bone) continue;
      const { x, y, z, w } = bone.quaternion;
      for (let i = 0; i + 3 < track.values.length; i += 4) {
        track.values[i] = x;
        track.values[i + 1] = y;
        track.values[i + 2] = z;
        track.values[i + 3] = w;
      }
    }
  }
}

/**
 * Hang the knife off `daayan`'s right hand. Fire and forget: the file arrives a frame or two later
 * and until it does she is simply empty-handed, exactly like the rest of the imported art. Nothing to
 * dispose — the bone belongs to her root, which ModelProps already removes, and the geometry belongs
 * to the ModelLoader cache.
 */
export function armDaayan(
  loader: ModelLoader,
  daayan: Object3D,
  clips: readonly AnimationClip[],
  onError: (err: unknown, where: string) => void,
): void {
  const bone = daayan.getObjectByName(HAND_BONE);
  if (!bone) {
    onError(new Error(`no bone ${HAND_BONE}`), 'daayan:knife');
    return;
  }
  // Before the load, and synchronously: the grip is hers, not the knife's, so a knife that fails to
  // arrive should still leave her with a closed fist rather than a flat presenting palm.
  closeHandOnGrip(bone, clips);
  void (async () => {
    try {
      const { root } = await loader.load(KNIFE_FILE);
      root.name = 'daayan.knife';
      // Written rather than nudged: the cached Group is shared, so it may not be assumed to be clean.
      root.position.set(KNIFE_POS.x, KNIFE_POS.y, KNIFE_POS.z);
      root.rotation.set(
        MathUtils.degToRad(KNIFE_ROT.x),
        MathUtils.degToRad(KNIFE_ROT.y),
        MathUtils.degToRad(KNIFE_ROT.z),
      );
      root.scale.setScalar(KNIFE_SCALE);
      bone.add(root);
    } catch (err) {
      onError(err, `daayan:${KNIFE_FILE}`);
    }
  })();
}
