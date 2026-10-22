/**
 * RitualDoors — the sliding screen that hides the ritual room's doorway.
 *
 * It replaces a procedural shelf that was pushed aside, and it keeps that scene's two jobs: hold the
 * doorway shut until the player touches it, and tell CatRoamer the moment it is open. What it does not
 * keep is the collider that slid — see the blocker below.
 *
 * Nothing marks the screen, because §8 rules out marking it. What gives it away is the same thing that
 * gave the shelf away: the basement's west side is a metre short of where the room's own dimensions say
 * it should end, and this is the only thing standing against that wall. A paper screen in a coal cellar
 * is a louder tell than a shelf of jars ever was, which is the one thing this swap changes about §8.
 *
 * **The fixed panel has to go.** doors-sliding.glb is three parts, not two: a full-width shoji wall
 * (`Plane011`, its own frame plus a paper plane at the back) and two leaves that slide across the front
 * of it. Fitted whole, opening the leaves reveals *more fixed paper*, not a hole, and the player walks
 * into a wall that just animated at them. `drop: ['Plane011']` in the placement row leaves the two
 * leaves alone against the house's own wall, which is the frame. That prune is also what makes the
 * numbers below work: it lifts the clear opening from 36.7% of the fitted width to 60.4%.
 *
 * **The clip is the animation, not a lerp of its endpoints.** `Take 001` is 2.833 s of LINEAR keys, and
 * the leaves hold still for the first 1.5 s of it. The 41 keys over the remaining 1.333 s are not evenly
 * spaced — 0.4%, 1.4%, 3.0% of the travel in the first three, 98.1%, 99.5%, 100% in the last three — so
 * the timing is an eased slide baked into the keyframes. HouseScene's `tween` cannot drive it: that
 * runner applies its own easeOut to `k`, and easing an eased clip makes the last 20 cm crawl. So this
 * returns a per-frame mixer tick instead, exactly like MainGate returns its own hinge.
 *
 * Measured, so the placement row's three fit numbers can be read against something. After the prune the
 * source box is 9.565 x 202.603 x 161.173 of its own units — thickness on x, height on y, width on z,
 * which is why `fit` reads width 0.10 / height 2.10 / depth 2.00 with no yaw. At that fit z scales by
 * 0.0124090, and the clip's two translations scale with it:
 *
 *   leaf         closed            travel     open
 *   Object001    z 1.300..2.338    -0.6685    z 0.632..1.669
 *   Object002    z 2.314..3.300    +0.5626    z 2.877..3.863
 *
 * Closed, the pair covers 1.300..3.300 against a clear opening of 1.400..3.200, so there is 10 cm of
 * overlap at each jamb and no daylight. Open, the gap is 1.669..2.877 — 1.208 m, centred within 3 cm of
 * RITUAL_DOOR.z. The player collides as a 0.70 m square (FPController radius 0.35, box against box, no
 * depenetration), so that is half a metre of lateral freedom rather than a squeeze.
 *
 * `Box041` is kept on purpose. It is a 5 x 8 x 73 mm stick at the top rail that rides the right-hand
 * leaf and tips upright as it goes — the catch, and the only part of the clip that moves during that
 * first 1.5 s. Dropping it would leave two animation channels bound to nothing and three.js logging a
 * missing-node warning for each; keeping it costs 92 vertices and is what "intact" means here.
 */

import {
  AnimationMixer,
  LoopOnce,
  Vector3,
  type AnimationAction,
  type AnimationClip,
  type Object3D,
} from 'three';
import { RITUAL_DOOR } from '@/world/HouseRooms';
import type { AABB } from '@/player/FPController';
import type { InteractionSystem } from '@/game/Interaction';
import { aabbOf } from '@/world/Fixtures';

/** The clip the file ships, by name rather than by index, so a re-export that adds one cannot silently swap it. */
const CLIP_NAME = 'Take 001';

/** Where the leaves start moving. Before this the clip animates only the catch. */
const SLIDE_START = 1.5;

/** The two sliding leaves, for the fallback that has to hide them. */
const LEAF_NAMES = ['Object001', 'Object002'];

export interface RitualDoorsDeps {
  aabbs: AABB[];
  interact: InteractionSystem;
  toast: (msg: string) => void;
  onError: (err: unknown, where: string) => void;
  /** Raise the tension and let the cat through. Owned by HouseScene, which owns both. */
  onOpen: () => void;
}

export interface RitualDoorsHandle {
  /** The per-frame mixer tick the slide needs, null when the file arrived without its clip. */
  tick: ((dt: number) => void) | null;
  /**
   * Slide the screen aside exactly as the player's own interaction would — blocker dropped,
   * animation released, onOpen fired — idempotently, from anywhere.
   *
   * Exists for HouseScene's `noise:alert` path: a noise bar at maximum breaks the ritual seal even
   * though the player is nowhere near the screen, and the opening has to look and behave the same
   * as if they had stood there and slid it.
   */
  open: (toastMessage?: string) => void;
}

/**
 * Arm the screen and hold the doorway shut. Returns the per-frame tick the slide needs — null when
 * the file arrived without its clip, in which case the doorway still opens, because a dead end in
 * front of the ritual room is worse than a screen that vanishes — plus the `open` that lets
 * something other than the player's hand slide it.
 *
 * Called from the placement hook: the fit's scale is on the root by then, and every number above is in
 * fitted units.
 */
export function armRitualDoors(
  root: Object3D,
  clips: AnimationClip[],
  deps: RitualDoorsDeps,
): RitualDoorsHandle {
  // One box filling the opening, held by reference and dropped below the world when the screen slides,
  // exactly as the flat's inner door does it. The shelf's collider used to *slide* 2.1 m instead, which
  // worked because a shelf is one solid; two leaves parting in opposite directions are not, and two
  // boxes chasing an eased clip would only be a second copy of the animation that could disagree with it.
  const block = aabbOf(RITUAL_DOOR.x, RITUAL_DOOR.bottom, RITUAL_DOOR.z, 0.14, RITUAL_DOOR.half, RITUAL_DOOR.top);
  deps.aabbs.push(block);

  const clip = clips.find((c) => c.name === CLIP_NAME) ?? clips[0];
  let mixer: AnimationMixer | null = null;
  let action: AnimationAction | null = null;
  /** True while the close runs backwards; cleared when it reaches the closed keyframe. */
  let closing = false;
  if (clip === undefined) {
    deps.onError(new Error(`${CLIP_NAME} missing from doors-sliding.glb`), 'ritual-doors:clip');
  } else {
    mixer = new AnimationMixer(root);
    action = mixer.clipAction(clip);
    action.setLoop(LoopOnce, 1);
    // Hold the last frame rather than snapping shut again. clampWhenFinished also parks the action
    // paused when it ends, so the tick below costs nothing for the rest of the game.
    action.clampWhenFinished = true;
    action.play();
    // Skip the run-up and hold there. A paused action has an effective timeScale of 0, so mixer.update
    // keeps evaluating this pose and never advances past it until onUse un-pauses it.
    action.time = SLIDE_START;
    action.paused = true;
    mixer.update(0);
  }

  let open = false;
  /** The hunt starts on the first opening only; closing the screen does not undo that. */
  let everOpened = false;

  const setLeavesVisible = (visible: boolean): void => {
    for (const name of LEAF_NAMES) {
      const leaf = root.getObjectByName(name);
      if (leaf) leaf.visible = visible;
    }
  };

  /**
   * Open the doorway, whether the hand on the screen is the player's or the noise's. Everything that
   * has to happen together lives here so the two callers cannot drift.
   */
  const openScreen = (toastMessage?: string): void => {
    if (open) return;
    open = true;
    closing = false;
    // Dropped below the world rather than spliced out: FPController ignores boxes that end under the
    // player's feet, and the array it holds is shared.
    block.minY = -60;
    block.maxY = -59.8;
    if (action === null) {
      setLeavesVisible(false);
    } else {
      action.timeScale = 1;
      action.paused = false;
    }
    if (!everOpened) {
      everOpened = true;
      deps.onOpen();
    }
    if (toastMessage !== undefined) deps.toast(toastMessage);
  };

  /** Slide the leaves back and put the doorway's blocker back. Reopening stays available. */
  const closeScreen = (toastMessage?: string): void => {
    if (!open) return;
    open = false;
    block.minY = RITUAL_DOOR.bottom;
    block.maxY = RITUAL_DOOR.top;
    if (action === null) {
      setLeavesVisible(true);
    } else {
      // Play the same baked clip backwards from its open end. The first 1.5 s of the clip is the
      // catch moving while the leaves stand still, so the close stops at that keyframe instead of
      // grinding through it.
      closing = true;
      action.timeScale = -1;
      action.paused = false;
    }
    if (toastMessage !== undefined) deps.toast(toastMessage);
  };

  deps.interact.add({
    id: 'basement.doors',
    // Just off the leaves' own face, at chest height, so the prompt belongs to the screen and not to
    // the wall behind it.
    pos: new Vector3(-21.6, RITUAL_DOOR.bottom + 1.1, RITUAL_DOOR.z),
    reach: 2.0,
    label: () => (open ? 'Slide the screen shut' : 'Slide the screen aside'),
    onUse: () => {
      if (open) closeScreen('The screen slides shut.');
      else openScreen('Cold air. There is a doorway behind it.');
    },
  });

  return {
    tick:
      mixer === null || action === null
        ? null
        : (dt) => {
            mixer.update(dt);
            if (closing && action.time <= SLIDE_START) {
              action.time = SLIDE_START;
              action.paused = true;
              closing = false;
            }
          },
    open: openScreen,
  };
}
