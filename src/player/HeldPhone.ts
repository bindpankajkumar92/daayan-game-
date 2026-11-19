/**
 * HeldPhone — after the burn, the same left fist that carried the lantern holds the player's phone,
 * upright, with the flashlight on.
 *
 * There is no second hand. The phone is parented to HeldLantern's own fist group (`held.arms`), so it
 * rides exactly the sway, bob and crouch the lantern hand already has, and the player sees the hand
 * they have been looking at all game simply holding something else. The lantern itself is hidden.
 *
 * `phone.glb` is the phone half of the Sketchfab model "Hand holding phone" by Poliko (CC Attribution);
 * the scanned hand was stripped out by `tools/strip-phone-hand.mjs`. Its frame: metres, centred, +y up
 * the long side, screen on +z (toward the eye), flash LED and lens on -z near the top.
 *
 * **Seating.** The fist's grip tunnel is vertical in camera space — measured, its free axis is
 * (0.00, 1.00, 0.01) — because it was posed round a lantern handle. A phone held in a fist sits in that
 * same tunnel: the lower third inside the curled fingers, the rest standing above them. So the phone
 * stands on the tunnel's axis, dropped until about a third of it is inside the fist.
 *
 * **Why a spot light, and why it is dimmer than the lantern.** The lantern was a 3.0 point light with
 * a 0.8 decay that lit the whole room. A phone torch is a narrow, cold cone that shows what it points at
 * and leaves the rest dark, which is what makes the last walk to the gate frightening. So the camera's
 * point light drops to a faint fill (PHONE_FILL) and the beam is a spot at the phone's own flash.
 *
 * The spot is created on activation, not at load. A light that exists, even at intensity 0, is a term
 * in every fragment shader for the whole game, and the phone is only used for the final stretch.
 */

import { Group, MathUtils, Object3D, SpotLight, type Camera, type Mesh, type MeshLambertMaterial, type MeshPhongMaterial } from 'three';
import type { ModelLoader } from '@/world/ModelLoader';

/**
 * Phone centre relative to the fist's grip centre, in the fist group's frame (which is camera-aligned).
 * y: up the tunnel so ~5 cm of the 17 cm phone is inside the fingers. z: a touch toward the eye, the
 * side the screen is on, so the fingers wrap the back rather than the glass.
 */
const SEAT = { x: 0.004, y: 0.052, z: 0.006 };
/** Upright, leaning a few degrees back at the top and turned slightly toward the middle of the frame. */
const TILT = { x: -8, y: 14, z: 4 };
/** The full-size phone reads as a tablet at 0.3 m; the fist itself is a slightly small scan. */
const SCALE = 0.86;

/** Flash LED, in the phone's own frame (from the GLB): back face, upper corner. */
const FLASH_AT = { x: -0.026, y: 0.0536, z: -0.012 };

/** Cold LED white. The lantern is 0xffc27a; the contrast in temperature is half the effect. */
const FLASH_HEX = 0xe6edff;
const SPOT = { intensity: 3.4, distance: 16, angle: 0.36, penumbra: 0.6, decay: 1.25 };
/** What the camera's own point light becomes: a faint cool fill, not a light source. */
export const PHONE_FILL = 0.55;
/** Where the beam lands, in camera space: just under the crosshair, a few metres out. */
const AIM = { x: 0.02, y: -0.32, z: -4 };

export interface HeldPhoneHandles {
  /** Put the phone in the fist and switch the torch on (or put it away). */
  setActive: (on: boolean) => void;
  isActive: () => boolean;
  dispose: () => void;
}

export function installHeldPhone(
  loader: ModelLoader,
  camera: Camera,
  hand: Object3D,
  onError: (err: unknown, where: string) => void,
): HeldPhoneHandles {
  const seat = new Group();
  seat.name = 'held.phone';
  seat.position.set(SEAT.x, SEAT.y, SEAT.z);
  seat.rotation.set(TILT.x * MathUtils.DEG2RAD, TILT.y * MathUtils.DEG2RAD, TILT.z * MathUtils.DEG2RAD);
  seat.scale.setScalar(SCALE);
  seat.visible = false;
  hand.add(seat);

  /** The beam's target. A camera child, so the beam points where the player looks. */
  const aim = new Object3D();
  aim.position.set(AIM.x, AIM.y, AIM.z);
  camera.add(aim);

  let spot: SpotLight | null = null;
  let active = false;

  void loader
    .load('phone.glb')
    .then(({ root }) => {
      root.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        mesh.frustumCulled = false;
        const m = mesh.material as MeshLambertMaterial | MeshPhongMaterial;
        // The screen faces the eye 0.3 m from the fill light; at full albedo it reads as a grey card.
        // Dark glass with a faint lock-screen glow is what a phone in a dark house looks like.
        if (m.name === 'phone_screen') {
          m.color.setHex(0x05070a);
          m.emissive.setHex(0x1a2433);
          m.emissiveIntensity = 1;
        }
      });
      seat.add(root);
    })
    .catch((err) => onError(err, 'held:phone.glb'));

  return {
    setActive: (on) => {
      active = on;
      seat.visible = on;
      if (on && !spot) {
        // A child of the phone, at its flash: the beam leaves the phone and moves with the hand's sway.
        spot = new SpotLight(FLASH_HEX, SPOT.intensity, SPOT.distance, SPOT.angle, SPOT.penumbra, SPOT.decay);
        spot.name = 'held.phone.flash';
        spot.castShadow = false;
        spot.position.set(FLASH_AT.x, FLASH_AT.y, FLASH_AT.z);
        spot.target = aim;
        seat.add(spot);
      }
      if (spot) spot.intensity = on ? SPOT.intensity : 0;
    },
    isActive: () => active,
    dispose: () => {
      hand.remove(seat);
      camera.remove(aim);
      spot?.dispose();
      seat.clear();
    },
  };
}
