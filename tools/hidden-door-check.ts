import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { armHiddenDoor } from '@/world/HiddenDoor';
import { HALF_T } from '@/world/HouseLayout';
import { HID_STAIR_WELL, ROOMS } from '@/world/HouseRooms';

const root = new Group();
const leaf = new Mesh(new BoxGeometry(1, 2, 0.1), new MeshBasicMaterial());
leaf.name = 'door_leaf';
root.add(leaf);
root.position.set(18.61, 2.4, -0.46);
root.rotation.y = Math.PI / 2;

const aabbs: Array<Record<string, number>> = [];
let entry: { label: () => string | null; onUse: () => void } | null = null;
let opened = 0;

armHiddenDoor(root, {
  aabbs: aabbs as never,
  player: { position: new Vector3(0, 0, 0), getRadius: () => 0.35 } as never,
  interact: { add: (o: never) => { entry = o as never; } } as never,
  state: { openHidden: () => true, hasRedKey: () => false } as never,
  tween: (_dur: number, apply: (k: number) => void) => apply(1),
  toast: () => {},
  onOpened: () => { opened++; },
  onError: (err) => { throw err; },
});

if (entry === null) throw new Error('hidden door published no interaction');
if (entry.label() !== 'Open the hidden door') throw new Error('hidden door prompt is wrong');

entry.onUse();

if (!leaf.visible) throw new Error('hidden door leaf vanished instead of swinging');
if (!aabbs.some((b) => b['minY'] === -60)) throw new Error('doorway blocker was not dropped on opening');
if (opened !== 1) throw new Error('hidden door did not fire onOpened');

let pivot: Group | null = null;
root.traverse((o) => {
  if (o.name === 'hidden-door.pivot') pivot = o as Group;
});
if (pivot === null) throw new Error('hidden door has no pivot to swing on');
if (Math.abs((pivot as Group).rotation.y - (-Math.PI / 2 + (100 * Math.PI) / 180)) > 1e-6) {
  throw new Error('hidden door leaf did not swing open');
}

const hidden = ROOMS.find((r) => r.id === 'up-hidden');
if (hidden === undefined) throw new Error('up-hidden room is missing');
const southCheek = HID_STAIR_WELL.z0 - HALF_T;
if (!hidden.walls.some((w) => w.z1 === southCheek && w.z2 === southCheek)) {
  throw new Error('stairwell south cheek is missing');
}
if (!hidden.walls.some((w) => w.z1 === HID_STAIR_WELL.z1 + HALF_T && w.z2 === HID_STAIR_WELL.z1 + HALF_T)) {
  throw new Error('stairwell north parapet is missing');
}

console.log('PASS hidden door swings and stairwell walls are intact');
