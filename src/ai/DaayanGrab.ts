/**
 * DaayanGrab — her left hand actually takes hold of the player during the kill, and *stays* there.
 *
 * The kill clip was authored with the grab reaching toward the lens, but measured on the live rig the
 * left hand stops at about (0.05, -0.14, -0.44) in camera space: 44 cm in front of the eye, against her
 * own chest. So after her mixer has posed her, a two-bone IK bends the upper arm and forearm until the
 * hand lands on a point fixed in *camera* space, which is where a fist closing on the player's collar
 * shows up in a first-person frame.
 *
 * **Why the first version still swam.** Pinning the wrist to one point was not enough, because two
 * other things were still read off the clip every frame:
 *
 * - **The elbow's bend plane** came from wherever the clip's elbow happened to be. Her body sways
 *   13-18 cm toward and away from the player through the beat (her head goes from z -0.53 to -0.71),
 *   and that swung the elbow round the shoulder-to-hand line, so the forearm visibly pumped in and out.
 *   The pole is now a fixed direction in camera space: elbow down and out to her side.
 * - **The wrist's own rotation** was still the clip's, and the clip keeps working the hand after the
 *   grab lands. The fist's angle to the lens is now captured on the frame the grab completes and held
 *   in camera space for the rest of the beat, so a closed hand stays closed on the same spot.
 *
 * The target and the held orientation are both re-read from the camera every frame, so the hand rides
 * the hit shake *with* the player, which is what makes it read as gripping them rather than hovering.
 * Fingers are not touched: the clip's finger tracks still close the hand.
 */

import { Quaternion, Vector3, type Camera, type Object3D } from 'three';

const UPPER = 'CC_Base_L_Upperarm_050';
const LOWER = 'CC_Base_L_Forearm_051';
const HAND = 'CC_Base_L_Hand_055';

/** Where the wrist lands, in camera space (-z is forward). Lower middle of the frame. */
export const GRAB_TARGET = { x: 0.05, y: -0.21, z: -0.32 } as const;

/**
 * Which way the elbow points, in camera space. Her left arm is on the player's right, so out is +x;
 * down is -y. A hand on someone's collar has the elbow low and wide, never up.
 */
const POLE = { x: 0.75, y: -0.65, z: 0.1 } as const;

/** Wall-clock seconds into the kill: the reach starts with the clip's lift and is full by the grab. */
const GRAB_IN = 0.3;
const GRAB_FULL = 0.62;

const a = new Vector3();
const b = new Vector3();
const c = new Vector3();
const t = new Vector3();
const dir = new Vector3();
const pole = new Vector3();
const elbow = new Vector3();
const reach = new Vector3();
const from = new Vector3();
const to = new Vector3();
const qDelta = new Quaternion();
const qWorld = new Quaternion();
const qParent = new Quaternion();
const qCam = new Quaternion();
const qHand = new Quaternion();
const qWant = new Quaternion();
const IDENTITY = new Quaternion();

function smoothstep(e0: number, e1: number, x: number): number {
  const k = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return k * k * (3 - 2 * k);
}

/** Turn `bone` in world space so the vector `fromV` points along `toV`, blended by `w`. */
function aim(bone: Object3D, fromV: Vector3, toV: Vector3, w: number): void {
  if (fromV.lengthSq() < 1e-10 || toV.lengthSq() < 1e-10 || !bone.parent) return;
  qDelta.setFromUnitVectors(fromV.normalize(), toV.normalize());
  if (w < 1) qDelta.slerp(IDENTITY, 1 - w);
  bone.getWorldQuaternion(qWorld);
  bone.parent.getWorldQuaternion(qParent);
  bone.quaternion.copy(qParent.invert().multiply(qDelta.multiply(qWorld)));
  bone.updateWorldMatrix(false, true);
}

export class DaayanGrab {
  private bound: Object3D | null = null;
  private upper: Object3D | null = null;
  private lower: Object3D | null = null;
  private hand: Object3D | null = null;
  /** The fist's orientation relative to the camera, captured when the grab lands. */
  private held: Quaternion | null = null;
  private lastElapsed = Infinity;

  constructor(
    private readonly getRoot: () => Object3D | null,
    private readonly camera: Camera,
  ) {}

  /**
   * Pose the arm for `elapsed` seconds into the kill. Returns how far the wrist ended from the target
   * in metres, or -1 when there was nothing to pose.
   */
  apply(elapsed: number): number {
    // A new kill restarts the clock; forget the last one's held fist.
    if (elapsed < this.lastElapsed) this.held = null;
    this.lastElapsed = elapsed;

    const root = this.getRoot();
    if (!root) return -1;
    if (root !== this.bound) {
      this.bound = root;
      this.upper = root.getObjectByName(UPPER) ?? null;
      this.lower = root.getObjectByName(LOWER) ?? null;
      this.hand = root.getObjectByName(HAND) ?? null;
      this.held = null;
    }
    const { upper, lower, hand } = this;
    if (!upper || !lower || !hand) return -1;
    const w = smoothstep(GRAB_IN, GRAB_FULL, elapsed);
    if (w <= 0) return -1;

    this.camera.updateMatrixWorld();
    this.camera.getWorldQuaternion(qCam);
    t.set(GRAB_TARGET.x, GRAB_TARGET.y, GRAB_TARGET.z).applyMatrix4(this.camera.matrixWorld);

    upper.updateWorldMatrix(true, true);
    upper.getWorldPosition(a);
    lower.getWorldPosition(b);
    hand.getWorldPosition(c);
    const l1 = a.distanceTo(b);
    const l2 = b.distanceTo(c);

    dir.subVectors(t, a);
    const dist = Math.min(Math.max(dir.length(), Math.abs(l1 - l2) + 1e-4), (l1 + l2) * 0.999);
    dir.normalize();

    // Fixed bend plane: the camera-space pole, made perpendicular to the reach.
    pole.set(POLE.x, POLE.y, POLE.z).applyQuaternion(qCam);
    pole.addScaledVector(dir, -pole.dot(dir));
    if (pole.lengthSq() < 1e-8) pole.set(0, -1, 0).addScaledVector(dir, -dir.y);
    pole.normalize();

    const cosA = Math.min(Math.max((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1), 1);
    const sinA = Math.sqrt(1 - cosA * cosA);
    elbow.copy(a).addScaledVector(dir, l1 * cosA).addScaledVector(pole, l1 * sinA);

    aim(upper, from.subVectors(b, a), to.subVectors(elbow, a), w);

    lower.getWorldPosition(b);
    hand.getWorldPosition(c);
    reach.copy(a).addScaledVector(dir, dist);
    aim(lower, from.subVectors(c, b), to.subVectors(reach, b), w);

    // Hold the fist's angle to the lens from the moment the grab lands.
    if (w >= 1) {
      if (!this.held) {
        hand.getWorldQuaternion(qHand);
        this.held = qCam.clone().invert().multiply(qHand);
      }
      qWant.copy(qCam).multiply(this.held);
      lower.getWorldQuaternion(qParent);
      hand.quaternion.copy(qParent.invert().multiply(qWant));
      hand.updateWorldMatrix(false, true);
    }

    hand.getWorldPosition(c);
    return c.distanceTo(t);
  }
}
