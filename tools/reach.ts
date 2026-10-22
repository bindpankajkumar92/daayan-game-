/**
 * Reachability check — can the player actually stand somewhere that each interactable is in range?
 *
 * Runs headless (no WebGL, no DOM): every module it touches only builds geometry and Vector3s.
 * It samples standable floor on a 10 cm grid, rejects samples that a prop collider occupies, and
 * reports the closest standable point to every prompt anchor in the house. Anything whose closest
 * standable point is further away than its own reach can never be used, which is a bug that
 * otherwise costs a full manual lap of the house per room to find.
 *
 * This file is NOT in tsconfig's `include`, so `npm run typecheck` never looks at it and it can rot
 * silently — it had, twice over, against a `makeShelf` and a `PLACE.shelf` that no longer exist and a
 * `makeGate` that lost two parameters. Run it after moving anything a prompt hangs off:
 *
 *     npx tsx tools/reach.ts
 *
 * Two things it deliberately does not model, and both make it pessimistic rather than optimistic:
 * imported-model colliders (ModelProps pushes those at load time, so a sample here may be inside a
 * table that exists at runtime), and wall facings (WALL_INSET stands in for the wall, and a facing only
 * ever moves the wall 6 cm further into the room). A pass here is necessary, not sufficient; a fail is
 * real.
 */

// First, and it has to be: it installs the `document` stub the world modules' textures reach for.
import './dom-shim';
import { MeshLambertMaterial, Vector3 } from 'three';
import { PLACE, buildProps } from '@/world/HouseProps';
import { BASE_Y } from '@/world/HouseLayout';
import { GATE, ROOMS, houseFloors } from '@/world/HouseRooms';
import {
  aabbOf,
  makeAltar,
  makeBreakerPanel,
  makeCodeBox,
  makeFixtureMats,
  makeGate,
} from '@/world/Fixtures';
import { ALTAR_DISPLAY, CLUES } from '@/game/Clues';
import type { AABB } from '@/player/FPController';

const RADIUS = 0.3;
const EYE = 1.7;
/** Keep samples this far inside a room's floor rect, standing in for the wall colliders. */
const WALL_INSET = 0.42;
const STEP = 0.1;

const mats = makeFixtureMats(new MeshLambertMaterial(), new MeshLambertMaterial(), () => undefined);

const props = buildProps(mats);
const altar = makeAltar(mats, PLACE.altar.x, PLACE.altar.z, BASE_Y, ALTAR_DISPLAY);
const box = makeCodeBox(mats, PLACE.codeBox.x, PLACE.codeBox.y, PLACE.codeBox.z);
const panel = makeBreakerPanel(mats, PLACE.breaker.x, PLACE.breaker.y, PLACE.breaker.z);
const gate = makeGate(mats, GATE.x, GATE.z);

// makeShelf and its `basement.shelf` probe stood here. The procedural basement shelving is gone —
// basement.glb brings its own — and with it went PLACE.shelf and the clue that sat on it. There is no
// `basement.shelf` key in CLUES to check any more.
const aabbs: AABB[] = [...props.aabbs, ...altar.aabbs, ...box.aabbs];

interface Probe {
  id: string;
  pos: Vector3;
  reach: number;
}
const probes: Probe[] = [];
for (const [id, spec] of Object.entries(CLUES)) {
  const at = props.anchors[id];
  if (at) probes.push({ id: `clue ${id}  (${spec.prompt})`, pos: at, reach: 2.0 });
}
altar.symbolAnchors.forEach((p, i) => probes.push({ id: `altar.${ALTAR_DISPLAY[i]}`, pos: p, reach: 1.9 }));
probes.push({ id: 'altar.key', pos: altar.keyAnchor, reach: 2.4 });
probes.push({ id: 'box.dial', pos: box.anchor, reach: 2.0 }); // mirrors HouseScene: the box is on the floor
probes.push({ id: 'box.key', pos: box.keyAnchor, reach: 2.4 });
probes.push({ id: 'panel.rockers', pos: panel.anchor, reach: 1.7 });
probes.push({ id: 'panel.key', pos: panel.keyAnchor, reach: 2.4 });
gate.lockAnchors.forEach((p, i) => probes.push({ id: `gate.lock${i}`, pos: p, reach: 1.9 }));

/** True if a collider overlaps the cylinder a player standing at (x, floorY, z) occupies. */
function blocked(x: number, z: number, floorY: number): boolean {
  for (const a of aabbs) {
    if (a.maxY <= floorY + 0.05) continue;
    if (a.minY >= floorY + EYE + 0.05) continue;
    if (x + RADIUS > a.minX && x - RADIUS < a.maxX && z + RADIUS > a.minZ && z - RADIUS < a.maxZ) {
      return true;
    }
  }
  return false;
}

// Standable samples, taken from the room rects rather than houseFloors() so each sample knows the
// wall line it has to stay clear of. The stair treads are left out: nothing is reachable only from
// a stair.
const stand: Array<[number, number, number]> = [];
for (const r of ROOMS) {
  for (let x = r.floor.x0 + WALL_INSET; x <= r.floor.x1 - WALL_INSET; x += STEP) {
    for (let z = r.floor.z0 + WALL_INSET; z <= r.floor.z1 - WALL_INSET; z += STEP) {
      if (!blocked(x, z, r.floorY)) stand.push([x, r.floorY, z]);
    }
  }
}
// The porch, which is not a room.
for (let x = GATE.x - 1.2; x <= GATE.x + 1.2; x += STEP) {
  for (let z = GATE.z - 1.5; z <= GATE.z - 0.1; z += STEP) stand.push([x, 0, z]);
}
void houseFloors();
void aabbOf;

let bad = 0;
let tight = 0;
const rows: string[] = [];
for (const p of probes) {
  let best = Infinity;
  for (const [sx, sy, sz] of stand) {
    const dx = p.pos.x - sx;
    const dy = p.pos.y - (sy + EYE);
    const dz = p.pos.z - sz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < best) best = d;
  }
  const slack = p.reach - best;
  const flag = best > p.reach ? 'UNREACHABLE' : slack < 0.35 ? 'tight' : 'ok';
  if (flag === 'UNREACHABLE') bad++;
  if (flag === 'tight') tight++;
  rows.push(`${flag.padEnd(12)} closest ${best.toFixed(2)}m / reach ${p.reach.toFixed(2)}m  ${p.id}`);
}

// eslint-disable-next-line no-console
console.log(`${stand.length} standable samples, ${probes.length} anchors\n${rows.join('\n')}`);
// eslint-disable-next-line no-console
console.log(`\n${bad} unreachable, ${tight} tight`);
