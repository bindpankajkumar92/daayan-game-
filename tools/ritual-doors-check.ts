import { Object3D } from 'three';
import { armRitualDoors } from '@/world/RitualDoors';
import { RITUAL_DOOR } from '@/world/HouseRooms';
import type { Interactable } from '@/game/Interaction';

const root = new Object3D();
const leafA = new Object3D();
leafA.name = 'Object001';
const leafB = new Object3D();
leafB.name = 'Object002';
root.add(leafA, leafB);

const aabbs: Array<{ minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }> = [];
let item: Interactable | null = null;
let opened = 0;

const handle = armRitualDoors(root, [], {
  aabbs: aabbs as never,
  interact: { add: (i: Interactable) => (item = i) } as never,
  toast: () => {},
  onError: () => {},
  onOpen: () => opened++,
});

if (!item) throw new Error('ritual screen never registered an interaction');
if (item.label() !== 'Slide the screen aside') {
  throw new Error(`closed screen prompt is ${JSON.stringify(item.label())}`);
}
item.onUse();
if (item.label() !== 'Slide the screen shut') {
  throw new Error(`open screen cannot be closed; prompt is ${JSON.stringify(item.label())}`);
}
if (aabbs[0]?.minY !== -60) throw new Error('opening did not drop the doorway blocker');
item.onUse();
if (item.label() !== 'Slide the screen aside') {
  throw new Error(`closed screen prompt did not return; got ${JSON.stringify(item.label())}`);
}
if (aabbs[0]?.minY !== RITUAL_DOOR.bottom) throw new Error('closing did not restore the doorway blocker');
if (!leafA.visible || !leafB.visible) throw new Error('closing did not show the leaves');
if (opened !== 1) throw new Error(`onOpen fired ${opened} times, expected once`);
if (handle.tick !== null) throw new Error('clip-less screen unexpectedly returned a mixer tick');

console.log('PASS ritual screen toggles open and shut');
