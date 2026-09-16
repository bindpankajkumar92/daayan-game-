/**
 * Nav bake check — does the grid Daayan will walk on actually describe this house?
 *
 * Run: npx tsx tools/nav-check.ts   (or node --loader tsx)
 *
 * This is the §31 step-1 independent test. Nothing here needs a GPU or a browser: the grid is baked
 * from `buildHouse()`'s own AABB list and `houseFloors()`, both of which are pure data. So the whole
 * question — "can Daayan get from the ritual room to the upstairs shrine, and are the doorways wide
 * enough after inflation?" — is answerable in a few hundred milliseconds of Node.
 *
 * What it asserts, and why each one is a real failure rather than a nicety:
 *
 *   1. A grid bakes at all, at a plausible size.
 *   2. A path exists ritual room -> hall -> bedroom -> kitchen, and hall -> cellar stair -> basement,
 *      and hallway -> upper stair -> upper flat. If any of these fail, Daayan is trapped, and a
 *      trapped AI reads to the player as an AI that has given up.
 *   3. Every path is *legal*: no point sits in a blocked cell, and no consecutive pair steps further
 *      than MAX_STEP vertically. That is §16's "walk through walls / impossible shortcuts" clause,
 *      tested rather than assumed.
 *   4. Inflation left the doorways connected. A grid can be walkable on both sides of a jamb and
 *      still have no route through it, which is the single most likely way this bake goes wrong.
 */

import './dom-shim.js';
import { buildHouse } from '../src/world/HouseBuilder.js';
import { NavGrid, MAX_STEP, CELL } from '../src/ai/NavGrid.js';
import { ROOMS, SPAWN } from '../src/world/HouseRooms.js';
import type { AABB } from '../src/player/FPController.js';

const house = buildHouse(1);
const floors = house.floors;
const aabbs = house.aabbs as AABB[];

console.log(`floors: ${floors.length}   aabbs: ${aabbs.length}`);

const t0 = Date.now();
const grid = NavGrid.bake(floors, aabbs);
const bakeMs = Date.now() - t0;

const walkable = grid.walkableCount();
console.log(`grid: ${grid.cols} x ${grid.rows} = ${grid.cols * grid.rows} cells`);
console.log(`walkable: ${walkable} (${((walkable / (grid.cols * grid.rows)) * 100).toFixed(1)}%)`);
console.log(`bake: ${bakeMs} ms   cell=${CELL} m`);

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

check('grid bipoints nonzero', grid.cols > 50 && grid.rows > 50);
check('walkable fraction plausible', walkable > 2000 && walkable / (grid.cols * grid.rows) < 0.75,
  `${walkable} cells`);

// Helper: find a room's centre and resolve it to a standable point.
function roomCentre(id: string): { x: number; y: number; z: number } | null {
  const r = ROOMS.find((rr) => rr.id === id);
  if (!r) return null;
  const x = (r.floor.x0 + r.floor.x1) / 2;
  const z = (r.floor.z0 + r.floor.z1) / 2;
  return grid.nearestWalkable(x, z, 8, r.floorY);
}

function describe(p: { x: number; y: number; z: number } | null): string {
  if (!p) return 'unresolved';
  return `(${p.x.toFixed(1)}, ${p.y.toFixed(2)}, ${p.z.toFixed(1)})`;
}

// Independently validate a path: no blocked cell, no illegal vertical step.
function validatePath(path: { x: number; y: number; z: number }[], label: string): boolean {
  for (let i = 0; i < path.length; i++) {
    const p = path[i]!;
    if (!Number.isFinite(grid.heightAtWorld(p.x, p.z))) {
      console.log(`      ${label}: point ${i} ${describe(p)} is in a blocked cell`);
      return false;
    }
  }
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    if (Math.abs(b.y - a.y) > MAX_STEP + 0.01) {
      // A simplified straight run may span a stair, so only flag a real jump in a single grid step
      // distance, which is what an impossible shortcut looks like.
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d <= CELL * 1.5) {
        console.log(`      ${label}: step ${i - 1}->${i} rises ${(b.y - a.y).toFixed(2)} m over ${d.toFixed(2)} m`);
        return false;
      }
    }
  }
  return true;
}

const hall = roomCentre('hall');
const bedroom = roomCentre('bedroom');
const kitchen = roomCentre('kitchen');
const cellar = roomCentre('cellar') ?? grid.nearestWalkable(-17.9, 2.3, 8);
const ritual = grid.nearestWalkable(-28.4, 4.3, 10);
const upper = roomCentre('upper') ?? grid.nearestWalkable(19.4, 3.6, 12);

console.log('\n--- anchors ---');
console.log(`hall      ${describe(hall)}`);
console.log(`bedroom   ${describe(bedroom)}`);
console.log(`kitchen   ${describe(kitchen)}`);
console.log(`cellar    ${describe(cellar)}`);
console.log(`ritual    ${describe(ritual)}`);
console.log(`upper     ${describe(upper)}`);

check('spawn resolves', !!grid.nearestWalkable(SPAWN.x, SPAWN.z, 6, SPAWN.y),
  describe(grid.nearestWalkable(SPAWN.x, SPAWN.z, 6, SPAWN.y)));

console.log('\n--- routes ---');
const routes: [string, typeof hall, typeof bedroom][] = [
  ['ritual -> hall', ritual, hall],
  ['hall -> bedroom', hall, bedroom],
  ['bedroom -> kitchen', bedroom, kitchen],
  ['hall -> cellar stair', hall, cellar],
  ['kitchen -> upper flat', kitchen, upper],
];

for (const [label, a, b] of routes) {
  if (!a || !b) {
    check(label, false, 'anchor unresolved');
    continue;
  }
  const t = Date.now();
  const path = grid.findPath(a, b);
  const ms = Date.now() - t;
  if (!path) {
    check(label, false, 'NO PATH');
    continue;
  }
  const len = path.reduce((acc, p, i) => {
    if (i === 0) return 0;
    const q = path[i - 1]!;
    return acc + Math.hypot(p.x - q.x, p.z - q.z);
  }, 0);
  const legal = validatePath(path, label);
  check(label, legal, `${path.length} pts, ${len.toFixed(1)} m, ${ms} ms`);
}

// The doorway test proper: both sides of each interior door must reach each other.
console.log('\n--- doorway connectivity ---');
const pairs: [string, [number, number], [number, number]][] = [
  ['bedroom door', [-5, 1.6], [-5, 3.6]],
  ['living door', [5, 1.6], [5, 3.6]],
  ['cellar door', [-8.4, 1.3], [-9.6, 1.3]],
  ['upper door', [8.4, 1.3], [9.6, 1.3]],
  ['kitchen door', [-6, 11.6], [-6, 12.8]],
  ['pooja door', [0, 11.6], [0, 12.8]],
  ['store door', [6, 11.6], [6, 12.8]],
];
for (const [label, [ax, az], [bx, bz]] of pairs) {
  const a = grid.nearestWalkable(ax, az, 2.5);
  const b = grid.nearestWalkable(bx, bz, 2.5);
  if (!a || !b) {
    check(label, false, 'one side unresolved');
    continue;
  }
  const p = grid.findPath(a, b);
  // A doorway this short should be a couple of metres at most, not a tour of the house.
  const len = p
    ? p.reduce((acc, q, i) => {
        if (i === 0) return 0;
        const r = p[i - 1]!;
        return acc + Math.hypot(q.x - r.x, q.z - r.z);
      }, 0)
    : Infinity;
  check(label, !!p && len < 9, p ? `${len.toFixed(1)} m` : 'NO PATH');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
