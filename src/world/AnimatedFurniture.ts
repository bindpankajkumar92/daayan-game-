/**
 * AnimatedFurniture — interactive animated furniture pieces (wardrobes, dressers, cabinets).
 *
 * Provides proximity interaction via InteractionSystem and drives baked glTF animation clips
 * (opening/closing doors and sliding drawers) using Three.js AnimationMixer.
 */

import { AnimationMixer, LoopOnce, Vector3, type AnimationClip, type AnimationAction, type Object3D } from 'three';
import type { InteractionSystem } from '@/game/Interaction';

export interface AnimatedFurnitureDeps {
  id: string;
  root: Object3D;
  clips: AnimationClip[];
  interact: InteractionSystem;
  toast: (msg: string) => void;
  openLabel?: string;
  closeLabel?: string;
  openToast?: string;
  closeToast?: string;
  reach?: number;
  speed?: number;
  onError?: (err: unknown, where: string) => void;
}

export interface AnimatedFurnitureHandle {
  tick: (dt: number) => void;
  isOpen: () => boolean;
  toggle: () => void;
}

export function armAnimatedFurniture(deps: AnimatedFurnitureDeps): AnimatedFurnitureHandle | null {
  if (!deps.clips || deps.clips.length === 0) {
    deps.onError?.(new Error(`Furniture "${deps.id}" arrived with no animation clips`), 'furniture:clip');
    return null;
  }

  const mixer = new AnimationMixer(deps.root);
  const actions: AnimationAction[] = [];
  const speed = deps.speed ?? 1.2;

  for (const clip of deps.clips) {
    const action = mixer.clipAction(clip);
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    action.time = 0;
    action.paused = true;
    action.play();
    actions.push(action);
  }
  mixer.update(0);

  let opened = false;
  const toggle = (): void => {
    opened = !opened;
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      const clip = deps.clips[i];
      if (!a || !clip) continue;
      a.paused = false;
      if (opened) {
        a.timeScale = speed;
        if (a.time >= clip.duration - 0.01) a.time = 0;
      } else {
        a.timeScale = -speed;
        if (a.time <= 0.01) a.time = clip.duration;
      }
      a.play();
    }
    const msg = opened
      ? (deps.openToast ?? 'You opened the furniture.')
      : (deps.closeToast ?? 'You closed the furniture.');
    deps.toast(msg);
  };

  const pos = new Vector3();
  deps.root.getWorldPosition(pos);
  pos.y += 0.7; // Aim interaction at waist/mid-height

  deps.interact.add({
    id: `furniture.${deps.id}`,
    pos,
    reach: deps.reach ?? 2.4,
    label: () => (opened ? (deps.closeLabel ?? 'Close') : (deps.openLabel ?? 'Open')),
    verb: () => 'interact',
    onUse: toggle,
  });

  return {
    tick: (dt: number) => mixer.update(dt),
    isOpen: () => opened,
    toggle,
  };
}
