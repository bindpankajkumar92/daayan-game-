/**
 * Coffin — the animated lid of the ritual room's coffin.
 *
 * It replaces the drop-front of the plinth `makeAltar` used to build out of boxes. The coffin body is
 * coffin.glb, placed by ModelProps; this module owns only the one thing the scene needs from it — the
 * lid swinging open when the symbol sequence is solved — and hands back the two closures HouseScene
 * wires: a per-frame mixer tick, and an `open` that releases the lid.
 *
 * **The clip is the animation, not a lerp of its endpoints.** `coffin_top|open.001` is 1.208 s of keys
 * that carry the lid from closed to open, and the spacing is an ease baked into the file: 0.3°, 11.9°,
 * 51.9° of the 173° swing in the first three sampled frames, then 130°, 163°, 173° across the last.
 * HouseScene's `tween` cannot drive it — that runner applies its own easeOut to `k`, and easing an
 * eased clip makes the last third crawl. So this returns a mixer tick, exactly like RitualDoors does
 * for the sliding screen.
 *
 * **The lid hinges on a vertical axis, not a horizontal one.** Both clips rotate the `coffin_top` node
 * about its local Y, so the lid does not lift off or drop down — it swings sideways, ~173°, and comes
 * to rest lying flat on the ground on the coffin's *west* side (its open footprint reaches 1.60 m west
 * of centre against a body only 0.55 m wide, while its z-span never leaves the body's). That is why the
 * symbols and candles stand on the floor to the *east* rather than on the lid: a lid that sweeps west
 * would take anything resting on it into the wall. It is also why the key is revealed *inside* the
 * opened coffin rather than on a panel that drops out of it — the interior is what the swing exposes.
 *
 * **No blocker here.** The coffin does not hold a way shut; the body's own collider comes from the
 * placement row's `collide`, measured off the closed fit. This module animates and nothing else.
 */

import { AnimationMixer, LoopOnce, type AnimationClip, type Object3D } from 'three';

/** The clip that opens the lid, by name rather than index, so a re-export cannot silently swap it. */
const CLIP_NAME = 'coffin_top|open.001';

export interface CoffinHandles {
  /** Per-frame mixer advance; call it every frame from the scene loop. */
  tick: (dt: number) => void;
  /** Release the lid: unpause the action so the next tick plays the swing. Idempotent. */
  open: () => void;
}

/**
 * Arm the coffin's lid. Returns the tick and the release, or null when the file arrived without its
 * clip — in which case the puzzle still solves and the key still appears, because a ritual that cannot
 * finish is worse than a lid that opens without ceremony.
 *
 * Called from the placement hook: the fit's scale is on the root by then, and the mixer binds to the
 * `coffin_top` node beneath it.
 */
export function armRitualCoffin(
  root: Object3D,
  clips: AnimationClip[],
  onError: (err: unknown, where: string) => void,
): CoffinHandles | null {
  const clip = clips.find((c) => c.name === CLIP_NAME);
  if (!clip) {
    onError(new Error(`coffin arrived without "${CLIP_NAME}"`), 'coffin:clip');
    return null;
  }
  const mixer = new AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.setLoop(LoopOnce, 1);
  // Hold the last frame rather than snapping shut again. clampWhenFinished also parks the action
  // paused when it ends, so the tick below costs nothing for the rest of the game.
  action.clampWhenFinished = true;
  action.play();
  // Hold it shut: park at the first keyframe and freeze, so the coffin reads closed until solved. A
  // paused action has an effective timeScale of 0, so mixer.update keeps evaluating this pose and never
  // advances past it until `open` un-pauses it.
  action.time = 0;
  action.paused = true;
  mixer.update(0);
  let released = false;
  return {
    tick: (dt) => mixer.update(dt),
    open: () => {
      if (released) return;
      released = true;
      action.paused = false;
    },
  };
}
