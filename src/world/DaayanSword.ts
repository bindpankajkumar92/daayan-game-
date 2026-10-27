/**
 * DaayanSword — puts the old rusted crossguard sword in the daayan's right hand *and closes her hand
 * around it*.
 *
 * Three things are worth knowing:
 *
 * - **It must run after her fit, not merely after her load.** fitToHeight writes its factor into her
 *   root's own scale, and every number here is in *bone* units, which inherit that factor. The
 *   onPlaced hook in ModelProps fires at exactly the right moment; attaching any earlier would put a
 *   sword the size of the ritual room in her fist.
 * - **A bone-parented prop needs no update of its own.** Her clip animates the hand bone's local
 *   transform and the graph carries the child along, so the sword also inherits her distance cull and
 *   her visibility for nothing.
 * - **The sword is deliberately not a MODEL_PLACEMENTS row.** ModelLoader hands every caller the same
 *   Group, so a sword on the wall and a sword in her hand cannot both exist. The row was deleted, which
 *   is the same reason lantern.glb has none.
 *
 * The sword is `low_poly_sword_handpainted.glb`: 1.837 units from pommel (y 0.117) to tip (y 1.954),
 * with the guard at about y 0.45 and the file's nominal grip centre at y 0.25. Seating at 0.25 put the
 * fist on the guard with the grip and pommel above it; 0.05 pulls the handle down into the fingers, so
 * the fist closes on the grip, the pommel sits at the top of the fist and the guard hangs ~9 cm below
 * it. The holder below turns the blade onto the hand's z — the axis the old knife grip used — and seats
 * the grip in the palm. At SWORD_SCALE 42 the whole sword is about 0.84 m long, so the tip clears the
 * floor in her idle and drags when she advances.
 *
 * The hand pose is not eyeballed. With the handle turned so its length runs along the hand's z, its
 * cross-section was scored against every phalanx axis, one flesh radius off the handle box — over the
 * whole segment rather than its closest point, because scoring the closest point lets a straight finger
 * graze a corner and call it a grip. The flesh radii come out of the skin weights (for a vertex
 * dominated by one bone, its position in that bone's own frame is boneInverse * bindMatrix * position,
 * which is pose-independent), and the search ran headless against the built bundle. The same closed
 * fist is kept for the sword; only the prop on the palm changes.
 */

import {
  Group,
  MathUtils,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  type AnimationClip,
  type Object3D,
} from 'three';
import type { ModelLoader } from '@/world/ModelLoader';

const SWORD_FILE = 'low_poly_sword_handpainted.glb';

/** Character Creator's right wrist, the last bone before the fingers. */
const HAND_BONE = 'CC_Base_R_Hand_083';

/**
 * Right forearm, the hand's parent. Its local +y runs down the forearm (the hand sits at y 23.8), so
 * a rotation about that axis pronates the fist — and, unlike a wrist twist, it turns the whole hand
 * and the holder parented under it as one rigid chain, which is the only way the measured grip holds.
 */
const FOREARM_BONE = 'CC_Base_R_Forearm_079';

/**
 * File units to hand-bone units. The sword is 1.837 file units long; 42 gives ~0.84 m once the
 * 10.85 mm bone unit is applied, a one-handed sword for a 1.85 m woman rather than a prop.
 */
const SWORD_SCALE = 42;

/** Where the grip centre sits along the file's +y, above the pommel at 0.117 and below the guard. */
const SWORD_GRIP_Y = 0.25;

/**
 * Roll about the blade's own axis. -90 presents the flat to the camera while the blade hangs down.
 * The hand is left in its authored knife-grip pose; the blade is turned around the handle instead of
 * twisting the wrist, so the palm channel the grip was measured against stays untouched.
 */
const SWORD_ROLL_DEG = -90;

/**
 * The sword does not sit on its own y axis, so the holder cannot be placed by turning +y onto the palm.
 * Measured from the file's own vertices, in the model's local frame:
 *
 *   - the pommel's centre is (0.135, 0.13, -0.16),
 *   - the guard's centre is (0.22, 0.48, -0.07),
 *   - so the handle runs on that line, ~20 deg off the file's +y and a centimetre or two to one side of
 *     it. Seating the y axis in the palm, which is what the numbers here used to do, therefore left the
 *     real handle outside the fingers — the sword hung beside the fist with the guard at her fingertips.
 *
 * The fist's grip channel is the ring through each curled finger's three joints: circumcentre per
 * column, mean centre (-2.06, 6.85, 0.86) in the hand bone's frame, axis along the palm's z. The holder
 * below is the transform that carries the measured pommel-to-guard line onto that channel, so the
 * handle cross-section runs through the middle of the closed fingers — measured on the live rig, the
 * handle sits 1.7–2.3 bone units off every finger joint, which is the fist's own radius.
 *
 * Which end of it she holds is the rotation's job, not this one's — see GRIP_ROT.
 *
 * Re-solve it with the same two landmarks if the sword asset or the fist pose ever changes.
 */
const GRIP_POS = { x: 3.385, y: -0.012, z: -5.208 };

/**
 * Rotation of the holder: Rz(-90) then Ry(-90) (which is what turns the blade's length onto the palm's
 * z), plus the measured 20 deg the handle line leans away from the file's +y, and the half turn that
 * decides *which end* of the sword leaves the fist.
 *
 * That half turn is the whole difference between a sword and a knife held point-down. Measured on the
 * live rig, the first solve had the pommel 12.6 cm past the index side of the fist and the tip 70 cm
 * past the little-finger side: the blade hung out of the bottom of the closed hand, down her thigh and
 * through her leg. That is an icepick grip, not a sword grip, and it read as upside down from every
 * angle — the two screenshots the grip was reported against show exactly that. A sword is held the
 * other way round: the pommel presses into the little-finger side of the palm and the blade leaves past
 * the index finger.
 *
 * So the sword was turned end for end about a pivot on the handle line — the point of that line closest
 * to the fist's grip channel — which leaves the line itself exactly where it was: the fingers close on
 * the same handle, the guard still sits just past them, only the blade now leaves upward instead of
 * hanging down. All twelve finger joints stay on the handle (checked again after the turn: the handle
 * sits 1.7–2.3 bone units off each joint, the same radius as the fist's own ring).
 *
 * Numbers below are the holder quaternion that turn produced, read back as XYZ Euler.
 */
const GRIP_ROT = { x: -76.73, y: -2.12, z: 77.03 };

/**
 * Pronation of the right forearm. The authored knife-grip pose points the blade out to the side; +90
 * spins the forearm about its own length so the fist turns and the blade hangs down.
 *
 * It must be the forearm, not the wrist: the holder is a rigid child of the hand bone, while the palm
 * skin is blended between the hand and the forearm, so twiddling the wrist alone slides the sword off
 * the palm. Rotating the forearm carries the hand and the holder together and the measured grip holds.
 */
const PRONATION_DEG = 90;

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
 * the handle's proximal-outer corner, and the pad lands on the outer face.
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
 * The finger channels are flattened on purpose — a hand holding a sword should not breathe — while the
 * forearm's keeps its authored swing with the pronation folded in.
 */
function closeHandOnGrip(
  hand: Object3D,
  forearm: Object3D,
  clips: readonly AnimationClip[],
): void {
  const posed: Object3D[] = [];
  const twist = new Quaternion().setFromAxisAngle(
    new Vector3(0, 1, 0),
    MathUtils.degToRad(PRONATION_DEG),
  );
  // The forearm's +y is its length, so this is pronation. Applied to the bone for the frames before
  // the mixer first ticks, and to every keyframe below so the animation's own forearm swing survives.
  forearm.quaternion.multiply(twist);
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
      // The forearm's own track gets the pronation on every keyframe, not flattened: its swing is
      // what carries the whole arm, and the twist only turns the fist around that swing.
      if (track.name === `${forearm.name}.quaternion`) {
        for (let i = 0; i + 3 < track.values.length; i += 4) {
          const q = new Quaternion(
            track.values[i],
            track.values[i + 1],
            track.values[i + 2],
            track.values[i + 3],
          ).multiply(twist);
          track.values[i] = q.x;
          track.values[i + 1] = q.y;
          track.values[i + 2] = q.z;
          track.values[i + 3] = q.w;
        }
        continue;
      }
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
 * Put the closed sword fist into a clip that has its own finger tracks.
 *
 * A crossfaded action replaces the tracks it owns. The walk clip's finger channels were flattened to
 * the grip by `closeHandOnGrip`, but the kill clip was authored separately and exports every bone at
 * its own pose, so during the fade the right fingers would open and the sword would sit in an open
 * hand. The fix is exact rather than approximate: delete the kill clip's right finger channels and
 * append the *current* closed local rotations as one-key tracks. The bones are already in the grip
 * pose at this point (the direct bone write at placement, or the flattened walk channels), so this
 * copies the real grip, not a second guess at it.
 *
 * The left hand is deliberately untouched: its finger channels carry the grab.
 */
export function stampKillClipGrip(clip: AnimationClip, root: Object3D): boolean {
  const hand = root.getObjectByName(HAND_BONE);
  if (!hand) return false;
  const names = [
    ...FINGER_CURL.map(([name]) => name),
    ...THUMB_POSE.map(([name]) => name),
  ];
  const gripBones = new Set(names);
  // All three channel kinds: a finger must not be translated or scaled by the kill clip either.
  clip.tracks = clip.tracks.filter((track) => {
    const dot = track.name.lastIndexOf('.');
    return !gripBones.has(dot === -1 ? track.name : track.name.slice(0, dot));
  });
  for (const name of names) {
    const bone = hand.getObjectByName(name);
    if (!bone) continue;
    const q = bone.quaternion;
    clip.tracks.push(new QuaternionKeyframeTrack(`${name}.quaternion`, [0], [q.x, q.y, q.z, q.w]));
  }
  return true;
}

/**
 * Hang the sword off `daayan`'s right hand. Fire and forget: the file arrives a frame or two later and
 * until it does she is simply empty-handed, exactly like the rest of the imported art. Nothing to
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
  const forearm = daayan.getObjectByName(FOREARM_BONE);
  if (!bone || !forearm) {
    onError(new Error(`no bone ${bone ? FOREARM_BONE : HAND_BONE}`), 'daayan:sword');
    return;
  }
  // Before the load, and synchronously: the grip is hers, not the sword's, so a sword that fails to
  // arrive should still leave her with a closed fist rather than a flat presenting palm.
  closeHandOnGrip(bone, forearm, clips);
  void (async () => {
    try {
      const { root } = await loader.load(SWORD_FILE);
      root.name = 'daayan.sword.mesh';
      // The file's +y runs from pommel to tip; the blade pivot below turns it onto the hand's z. Seating
      // the grip centre on the pivot origin keeps the guard above the fist and the pommel below it.
      root.position.set(0, -SWORD_GRIP_Y, 0);
      root.rotation.y = MathUtils.degToRad(SWORD_ROLL_DEG);

      const blade = new Group();
      blade.name = 'daayan.sword.blade';
      // +90 rather than -90: the knife's blade ran along its local -x, so turning the sword's +y
      // (pommel-to-tip) onto -x makes it hang down from the fist like the knife did, not point outward.
      blade.rotation.z = Math.PI / 2;
      blade.add(root);

      // Written rather than nudged: the cached Group is shared, so it may not be assumed to be clean.
      const holder = new Group();
      holder.name = 'daayan.sword';
      holder.position.set(GRIP_POS.x, GRIP_POS.y, GRIP_POS.z);
      holder.rotation.set(
        MathUtils.degToRad(GRIP_ROT.x),
        MathUtils.degToRad(GRIP_ROT.y),
        MathUtils.degToRad(GRIP_ROT.z),
      );
      holder.scale.setScalar(SWORD_SCALE);
      holder.add(blade);
      bone.add(holder);
    } catch (err) {
      onError(err, `daayan:${SWORD_FILE}`);
    }
  })();
}
