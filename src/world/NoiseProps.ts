/**
 * NoiseProps — the four bottles and plates lying about the house, which clatter when the player walks
 * into them.
 *
 * Four things are worth knowing before changing this:
 *
 * - **There is deliberately no prompt.** These were never a puzzle and were never meant to be tapped:
 *   they are there so a player picking through a dark room in a hurry kicks something and gives
 *   themselves away. An earlier version registered them with InteractionSystem, which put "Knock the
 *   bottle" on the HUD and turned four pieces of floor dressing into four things the player has to walk
 *   up to and rule out. Both the prompt and the InteractionSystem dependency are gone; the trigger is a
 *   proximity test, run from the scene's frame loop.
 *
 * - **This module places nothing.** The four models are ordinary MODEL_PLACEMENTS rows, because they
 *   want everything a placement already does: the fit, the floor seating, the cull radius, and in the
 *   ceramic plate's case `on:` reading the side table's measured top. So the only moment a placed root
 *   exists is `installModels`' `onPlaced` hook, and what this file exports is that hook plus the update
 *   that watches the player. Ownership stays where the other imported props are.
 *
 * - **The bump is a proximity test, not a physics contact.** None of the four is in the collision list,
 *   so the player walks straight through them. What counts as a hit is the player's own capsule radius
 *   overlapping the prop's footprint circle *and* the prop's height sitting inside the band between the
 *   player's feet and their eye. The band is what keeps a bottle in the basement quiet while the player
 *   crosses the hallway three metres above it, and it is why this needs the controller rather than just
 *   the camera: getGroundY() is the only honest source for where the feet are.
 *
 * - **A hit has to be visible as well as audible.** A noise with nothing attached to it reads as a bug.
 *   So a bump also skids the thing away from the boot and rattles it — a damped swivel, a 2 cm hop and a
 *   small permanent drift — all on the scene's own tween list rather than a new update path. The drift
 *   is capped, because a hundred small nudges over a long session should not end up inside a wall.
 */

import { Box3, Quaternion, Vector3, type Object3D, type PositionalAudio } from 'three';
import type { GameAudio, SoundTune } from '@/audio/AudioManager';
import { globalBus } from '@/core/EventBus';
import type { FPController } from '@/player/FPController';

/**
 * Closer and quieter than the house default (ref 1.5, max 12). A bottle nudged with a foot is a small
 * sound in a big house: at the default it carried the length of the hallway, which made four pieces of
 * floor dressing sound like four events.
 */
const NOISE_TUNE: Partial<SoundTune> = { ref: 0.8, max: 6, rolloff: 1.6, volume: 0.85 };

/** Seconds of rattle. Long enough to read as a settle, short enough not to queue up under a re-entry. */
const KNOCK_TIME = 0.5;
/** Radians of swivel at the first swing, and metres of hop. Both decay to nothing over KNOCK_TIME. */
const KNOCK_YAW = 0.22;
const KNOCK_HOP = 0.02;

/**
 * Metres the prop skids away from the boot, and the furthest it may ever end up from where the placement
 * put it. The skid is what makes the sound legible — something moved — and the cap is what stops a
 * hundred small nudges from walking a bottle through a wall or off the porch.
 */
const SKID = 0.075;
const DRIFT_CAP = 0.24;

/** A standing bottle falls almost flat; the last two degrees avoid a perfectly coplanar settle. */
const TOPPLE_ANGLE = (88 * Math.PI) / 180;

/**
 * Slack on the sum of the two radii before a pass counts as a bump, and how far back out the player has
 * to get before the same prop may sound again. The re-arm gap is the whole of the anti-machine-gun
 * logic: without it, standing on top of a bottle fires on every frame the player shuffles.
 */
const PAD = 0.05;
const REARM = 0.14;

/** Metres per second below which nothing is a bump. Standing beside a bottle is not kicking it. */
const MOVING = 0.4;

/** Slack on the foot end of the height band, for a prop the fit seated a millimetre into the floor. */
const BAND = 0.06;

/** Metres the clatter carries as a noise event. Louder than a walking step (2.5), quieter than a run. */
const NOISE_RADIUS = 3.5;

interface NoiseProp {
  /** Placement id from MODEL_PLACEMENTS — the file name, for rows that do not set `id`. */
  placed: string;
  /** The clatter. Two glass and two ceramic, and the beer bottle rolls rather than knocking. */
  sound: string;
  /** Bottles may fall permanently on the first moving contact; plates only skid and rattle. */
  bottle?: true;
}

const NOISE_PROPS: NoiseProp[] = [
  { placed: 'bottle.glb', sound: 'bottle-knock.mp3', bottle: true },
  { placed: 'bottle-beer.glb', sound: 'bottle-roll.mp3', bottle: true },
  { placed: 'plate.glb', sound: 'plate-rattle.mp3' },
  { placed: 'plate-ceramic.glb', sound: 'plate-rattle.mp3' },
];

/** One armed prop. Everything here is measured once, at placement, in world units. */
interface Live {
  root: Object3D;
  /**
   * Where the prop's box centre sits relative to its root, in world axes. bottle.glb's origin is four
   * fifths of the way down its length, and a circle drawn round the origin would be reachable from one
   * end of the bottle and not the other.
   */
  ox: number;
  oz: number;
  /** World y span of the box. Absolute: the hop is 2 cm and transient, and the skid is horizontal. */
  yLo: number;
  yHi: number;
  /** Footprint radius plus the player's capsule, plus PAD. */
  trigger: number;
  /** The placement's own local transform, which the rattle returns to. */
  x0: number;
  y0: number;
  z0: number;
  /** Current resting y. It changes once when a bottle settles on its side. */
  restY: number;
  /** Box dimensions at placement; a bottle is upright when y is clearly its longest axis. */
  width: number;
  height: number;
  depth: number;
  bottle: boolean;
  toppled: boolean;
  /** Accumulated skid, capped at DRIFT_CAP. */
  driftX: number;
  driftZ: number;
  sound: PositionalAudio | null;
  /** False from the moment it sounds until the player has got clear of trigger + REARM. */
  armed: boolean;
  rattling: boolean;
}

export interface NoisePropDeps {
  audio: GameAudio;
  /** The player. `position` is the eye, `getGroundY()` the floor underfoot, `getRadius()` the capsule. */
  player: FPController;
  /** The scene's tween runner, so the rattle costs no second update path. `k` arrives eased, 0 to 1. */
  tween: (dur: number, apply: (k: number) => void) => void;
}

export interface NoisePropHandles {
  /** Hand every placed model to this. Anything that is not one of the four is ignored. */
  onPlaced: (placed: string, root: Object3D) => void;
  /** Call once a frame from the scene loop, after the player has moved. */
  update: (dt: number) => void;
}

export function armNoiseProps(deps: NoisePropDeps): NoisePropHandles {
  const { audio, player, tween } = deps;
  const box = new Box3();
  const vC = new Vector3();
  const vS = new Vector3();
  const vW = new Vector3();
  const up = new Vector3(0, 1, 0);
  const heard = new Vector3();
  const live: Live[] = [];

  /**
   * Previous eye position, for the speed gate. The speed has to come from this delta: FPController keeps
   * only a vertical `velocity` and writes its horizontal move straight into `position` — and the delta
   * also reports a player pressed into a wall as standing still, which is the answer we want.
   */
  let prevX = 0;
  let prevZ = 0;
  let begun = false;

  const onPlaced = (placed: string, root: Object3D): void => {
    const prop = NOISE_PROPS.find((p) => p.placed === placed);
    if (prop === undefined) return;

    // Captured after placement, so these are the values the fit wrote rather than the file's own.
    root.updateWorldMatrix(true, true);
    box.setFromObject(root);
    box.getCenter(vC);
    box.getSize(vS);
    root.getWorldPosition(vW);

    const e: Live = {
      root,
      ox: vC.x - vW.x,
      oz: vC.z - vW.z,
      yLo: box.min.y,
      yHi: box.max.y,
      // Half the wider horizontal side of the box, so a bottle lying on its side is caught along its
      // length and not only around its neck.
      trigger: Math.max(vS.x, vS.z) * 0.5 + player.getRadius() + PAD,
      x0: root.position.x,
      y0: root.position.y,
      z0: root.position.z,
      restY: root.position.y,
      width: vS.x,
      height: vS.y,
      depth: vS.z,
      bottle: prop.bottle === true,
      toppled: false,
      driftX: 0,
      driftZ: 0,
      sound: null,
      armed: true,
      rattling: false,
    };
    live.push(e);

    // Hung on the prop itself, so the pan is the prop's position and not the room's.
    void audio.attach(root, prop.sound, NOISE_TUNE).then((snd) => {
      e.sound = snd;
    });
  };

  /** Sound, skid and rattle. `dx`/`dz` point from the prop to the player, `d` is their length. */
  const bump = (e: Live, dx: number, dz: number, d: number): void => {
    if (e.sound?.buffer) {
      // Retriggerable: play() warns and no-ops on a source that is already sounding, so a second bump
      // has to stop the first. A little detune, because the same 3 kB of glass twice in a row is a loop.
      if (e.sound.isPlaying) e.sound.stop();
      e.sound.setPlaybackRate(0.92 + Math.random() * 0.16);
      e.sound.play();
    }
    // 'object' rather than 'impact': this is something knocked over, which is exactly what the daayan
    // should be able to hear once there is something on the other end. Nothing consumes it today.
    e.root.getWorldPosition(vW);
    globalBus.emit('noise:emitted', { pos: heard.copy(vW), radius: NOISE_RADIUS, kind: 'object' });

    // A bump landing inside an unfinished rattle keeps the sound and drops the movement. Two tweens on
    // one rotation both end at yaw0, so nothing drifts out of place, but they fight over the frames in
    // between and the prop reads as jittering rather than as settling.
    if (e.rattling) return;
    e.rattling = true;

    // Away from the boot, and capped. `d` can be zero, if the player stands exactly on the centre.
    const inv = d > 1e-4 ? SKID / d : 0;
    const fromX = e.driftX;
    const fromZ = e.driftZ;
    const nx = fromX - dx * inv;
    const nz = fromZ - dz * inv;
    const mag = Math.hypot(nx, nz);
    const cap = mag > DRIFT_CAP ? DRIFT_CAP / mag : 1;
    e.driftX = nx * cap;
    e.driftZ = nz * cap;

    // Only a genuinely upright bottle gets the one-way fall. A bottle already authored on its side —
    // or one this system has already toppled — uses the ordinary swivel below, as do both plates.
    const topple =
      e.bottle && !e.toppled && e.height > Math.max(e.width, e.depth) * 1.35;

    if (topple) {
      e.toppled = true;

      // Fall away from the boot. Rotating world-up around (up × fall) carries the bottle's local up
      // toward that horizontal direction while preserving whatever yaw the placement started with.
      const fx = d > 1e-4 ? -dx / d : 1;
      const fz = d > 1e-4 ? -dz / d : 0;
      const axis = new Vector3(fz, 0, -fx).normalize();
      const qStart = e.root.quaternion.clone();
      const qFall = new Quaternion().setFromAxisAngle(axis, TOPPLE_ANGLE);
      const qEnd = qFall.multiply(qStart.clone()).normalize();

      // Rotating about an imported model's origin does not guarantee the new side lands on the same
      // floor: origins are commonly at the centre, the base, or somewhere arbitrary. Measure the final
      // box once at the future x/z, then offset y so its minimum returns exactly to the original floor.
      const px = e.x0 + e.driftX;
      const pz = e.z0 + e.driftZ;
      e.root.quaternion.copy(qEnd);
      e.root.position.set(px, e.y0, pz);
      e.root.updateWorldMatrix(true, true);
      box.setFromObject(e.root);
      const settleY = e.y0 + (e.yLo - box.min.y);
      e.root.quaternion.copy(qStart);
      e.root.position.set(e.x0 + fromX, e.y0, e.z0 + fromZ);

      tween(KNOCK_TIME * 1.35, (k) => {
        e.root.quaternion.slerpQuaternions(qStart, qEnd, k);
        e.root.position.x = e.x0 + fromX + (e.driftX - fromX) * k;
        e.root.position.z = e.z0 + fromZ + (e.driftZ - fromZ) * k;
        // A small early lift clears the base before the long side meets the floor; the settle offset
        // handles models whose origin is not at their base.
        e.root.position.y = e.y0 + (settleY - e.y0) * k + Math.sin(k * Math.PI) * KNOCK_HOP;
        if (k >= 1) {
          e.root.quaternion.copy(qEnd);
          e.root.position.y = settleY;
          e.restY = settleY;
          e.rattling = false;
          // Subsequent contacts need the fallen bottle's wider footprint and new vertical band.
          e.root.updateWorldMatrix(true, true);
          box.setFromObject(e.root);
          box.getCenter(vC);
          box.getSize(vS);
          e.root.getWorldPosition(vW);
          e.ox = vC.x - vW.x;
          e.oz = vC.z - vW.z;
          e.yLo = box.min.y;
          e.yHi = box.max.y;
          e.trigger = Math.max(vS.x, vS.z) * 0.5 + player.getRadius() + PAD;
        }
      });
      return;
    }

    // Current resting orientation is the base. That matters after a bottle has fallen: resetting just
    // rotation.y would decompose the quaternion and slowly stand the bottle back up on the next kick.
    const restQ = e.root.quaternion.clone();
    const yawQ = new Quaternion();
    tween(KNOCK_TIME, (k) => {
      // Damped: three half-swings whose amplitude reaches zero at k = 1. Compose a world-y swivel onto
      // the resting quaternion rather than assigning Euler.y, so a fallen bottle stays fallen.
      yawQ.setFromAxisAngle(
        up,
        Math.sin(k * Math.PI * 3) * (1 - k) * KNOCK_YAW,
      );
      e.root.quaternion.copy(yawQ).multiply(restQ);
      e.root.position.y = e.restY + Math.sin(k * Math.PI) * (1 - k) * KNOCK_HOP;
      // The skid is the one part that stays: it eases from wherever the prop already was to its new
      // resting offset and stops there.
      e.root.position.x = e.x0 + fromX + (e.driftX - fromX) * k;
      e.root.position.z = e.z0 + fromZ + (e.driftZ - fromZ) * k;
      if (k >= 1) {
        e.root.quaternion.copy(restQ);
        e.root.position.y = e.restY;
        e.rattling = false;
      }
    });
  };

  const update = (dt: number): void => {
    if (live.length === 0) return;
    const p = player.position;
    if (!begun) {
      begun = true;
      prevX = p.x;
      prevZ = p.z;
    }
    const speed = Math.hypot(p.x - prevX, p.z - prevZ) / Math.max(dt, 1e-4);
    prevX = p.x;
    prevZ = p.z;

    const feet = player.getGroundY();
    for (const e of live) {
      e.root.getWorldPosition(vW);
      const dx = p.x - (vW.x + e.ox);
      const dz = p.z - (vW.z + e.oz);
      const d = Math.hypot(dx, dz);
      if (!e.armed) {
        // Hysteresis, not a cooldown. The player has to get clear before this can sound again, which is
        // what makes brushing past a bottle one event and standing on top of one none.
        if (d > e.trigger + REARM) e.armed = true;
        continue;
      }
      if (d > e.trigger) continue;
      // Between the boot and the eye. Without this, a bottle on the basement floor sounds when the player
      // walks over the hallway above it, since everything above is a circle in plan.
      if (e.yHi < feet - BAND || e.yLo > p.y) continue;
      // Left until last, deliberately: a player who stops inside the circle stays armed and sounds the
      // moment they set off again. A bump is a bump whether they walked into it or shuffled into it.
      if (speed < MOVING) continue;
      e.armed = false;
      bump(e, dx, dz, d);
    }
  };

  return { onPlaced, update };
}
