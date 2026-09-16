/**
 * Wall-tone audit — does every room on a storey agree about what its plaster is made of?
 *
 * HouseBuilder picks a room's wall material from one flag: `tone`. 'plaster' gets wallWarm, anything
 * else gets wallCool, which is the cool plaster map under a 0x9aa0a8 tint — and the same flag gates
 * the skirting, so a cool room is also a room with no skirting board. Both are right for the cellar
 * and wrong anywhere else, and the failure is not subtle when it happens: the upper flat shipped as
 * 'cellar' for a while, so the two walls of it the model leaves for us to draw came out as large
 * smooth blue-grey panels, bare at the floor, set against the warm brick-patched plaster of every
 * room they abut. On a phone that reads as a dark patch that comes and goes with the camera, i.e. as
 * a render glitch, which is what it was reported as twice.
 *
 * A mismatch is only a bug when it is *within* a storey — the cellar being cool while the ground
 * floor is warm is the whole point. So this groups by floorY and complains when one storey holds
 * more than one tone.
 *
 * Not in tsconfig's `include`, like reach.ts, so typecheck never sees it. Run it after touching any
 * room's tone:
 *
 *     npx tsx tools/audit-tones.ts
 */

// First, and it has to be: the `document` stub the world modules' texture generators reach for.
import './dom-shim';
import type { Mesh, MeshLambertMaterial } from 'three';
import { ROOMS } from '@/world/HouseRooms';
import { buildHouse } from '@/world/HouseBuilder';

const house = buildHouse(1);

/** floorY -> tones seen on it, and which rooms carried each. */
const byFloor = new Map<number, Map<string, string[]>>();
for (const r of ROOMS) {
  const tones = byFloor.get(r.floorY) ?? new Map<string, string[]>();
  tones.set(r.tone, [...(tones.get(r.tone) ?? []), r.id]);
  byFloor.set(r.floorY, tones);
}

let bad = 0;
console.log('storey       tone      rooms');
for (const [floorY, tones] of [...byFloor].sort((a, b) => a[0] - b[0])) {
  const split = tones.size > 1;
  if (split) bad++;
  for (const [tone, ids] of tones) {
    console.log(`y=${floorY.toFixed(2).padStart(6)}  ${tone.padEnd(8)}  ${ids.join(' ')}${split ? '   <-- MIXED' : ''}`);
  }
}

// The materials that actually landed, straight off the built meshes, so this cannot pass on data
// while the builder does something else.
console.log('\nwall mesh                material');
for (const child of house.group.children) {
  if (!/-walls$/.test(child.name)) continue;
  const mat = (child as Mesh).material;
  const which =
    mat === house.mats.wallWarm ? 'wallWarm' : mat === house.mats.wallCool ? 'wallCool' : 'other';
  console.log(`  ${child.name.padEnd(22)} ${which}`);
}

const skirts = house.group.children.filter((c) => /-skirt$/.test(c.name)).map((c) => c.name);
console.log(`\nskirted rooms (${skirts.length}): ${skirts.join(' ')}`);

/**
 * The upper landing's floor and ceiling patches, which are the one place the storey's tone is applied
 * outside the room loop. Reported by tint, since BuiltHouse only exports four of the shared materials:
 * 9a9a9a is floorWood, 8f9096 floorStone, ffffff the timber ceiling, 9aa0a8 wallCool.
 */
const TINTS: Record<string, string> = {
  '9a9a9a': 'floorWood',
  '8f9096': 'floorStone (cellar)',
  ffffff: 'ceil (timber boards)',
  '9aa0a8': 'wallCool (cellar)',
};
console.log('\nupper landing patch       material');
for (const child of house.group.children) {
  if (!/^upper-patch-/.test(child.name)) continue;
  const mat = (child as Mesh).material as MeshLambertMaterial;
  const hex = mat.color.getHexString();
  console.log(`  ${child.name.padEnd(23)} ${TINTS[hex] ?? `#${hex}`}`);
}

console.log(bad === 0 ? '\nOK — every storey is one tone.' : `\nFAIL — ${bad} storey(s) mix tones.`);
process.exit(bad === 0 ? 0 : 1);
