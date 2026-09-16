/**
 * Connectivity check — is every room actually walkable *into*, from the spawn?
 *
 * reach.ts answers a different question. It asks whether each interactable has a standable point in
 * range, and it stands in for the wall colliders with a flat WALL_INSET, so it cannot see a doorway at
 * all: a room sealed by solid plaster and a room with a door in it look identical to it.
 *
 * This floods the real thing. It builds the house headless, takes the wall colliders buildHouse
 * actually produces, and breadth-firsts a 10 cm grid out of SPAWN using FPController's own collision
 * test and its own step-up limit. A room that comes back with 0 reached cells has no way in; a room
 * whose reached count is far under its standable count is cut in half by something.
 *
 *     npx tsx tools/connect.ts
 *
 * Not in tsconfig's `include`, exactly like reach.ts, so `npm run typecheck` will not catch it rotting.
 * Run it after adding a room, moving a doorway, or changing WALL_MIN_RUN.
 */

import './dom-shim';
import { ROOMS, SPAWN, houseFloors } from '@/world/HouseRooms';
import { expandRun, segmentBox } from '@/world/HouseLayout';
import type { AABB } from '@/player/FPController';

/** FPController's shipped defaults. A wrong radius here silently changes every doorway's clear width. */
const RADIUS = 0.35;
const EYE = 1.7;
const STEP_UP = 0.35;
const STEP = 0.1;

/**
 * The wall colliders, re-derived rather than taken from buildHouse — which cannot run here, because it
 * generates the procedural textures and the dom-shim's 2d context has no bezierCurveTo. Faithful all
 * the same: this is HouseBuilder's own loop, the same expandRun and segmentBox over the same ROOMS,
 * with its one skip rule (`modelCollision`, where an imported model already collides).
 */
const aabbs: AABB[] = [];
for (const room of ROOMS) {
  for (const run of room.walls) {
    if (run.modelCollision === true) continue;
    for (const s of expandRun(run, room.floorY, room.floorY + room.height)) {
      const b = segmentBox(s);
      aabbs.push({
        minX: b.cx - b.w / 2, maxX: b.cx + b.w / 2,
        minY: b.cy - b.h / 2, maxY: b.cy + b.h / 2,
        minZ: b.cz - b.d / 2, maxZ: b.cz + b.d / 2,
      });
    }
  }
}

/** FPController.collidesAabb, transcribed: feet at `floorY`, eye 1.7 above, colliders outside the band skipped. */
function blocked(x: number, z: number, floorY: number): boolean {
  const minY = floorY;
  const maxY = floorY + EYE;
  for (const a of aabbs) {
    if (a.maxY <= minY + 0.05) continue;
    if (a.minY >= maxY + 0.05) continue;
    if (
      x + RADIUS > a.minX &&
      x - RADIUS < a.maxX &&
      maxY > a.minY &&
      minY < a.maxY &&
      z + RADIUS > a.minZ &&
      z - RADIUS < a.maxZ
    ) {
      return true;
    }
  }
  return false;
}

const key = (xi: number, zi: number, y: number): string => `${xi},${zi},${Math.round(y * 100)}`;

/**
 * Every standable cell in the house, keyed by grid index and floor height. Floor rects come from
 * houseFloors(), which is room floors plus both stairs' treads — the treads are what make the three
 * levels one graph rather than three.
 */
const cells = new Map<string, { x: number; z: number; y: number }>();
for (const r of houseFloors()) {
  for (let xi = Math.ceil(r.x0 / STEP); xi <= Math.floor(r.x1 / STEP); xi++) {
    for (let zi = Math.ceil(r.z0 / STEP); zi <= Math.floor(r.z1 / STEP); zi++) {
      const x = xi * STEP;
      const z = zi * STEP;
      const k = key(xi, zi, r.y);
      if (cells.has(k)) continue;
      if (!blocked(x, z, r.y)) cells.set(k, { x, z, y: r.y });
    }
  }
}

/** Grid indices of every cell sharing a column, so a step up or down can find its landing. */
const byColumn = new Map<string, string[]>();
for (const [k, c] of cells) {
  const col = `${Math.round(c.x / STEP)},${Math.round(c.z / STEP)}`;
  const list = byColumn.get(col);
  if (list === undefined) byColumn.set(col, [k]);
  else list.push(k);
}

// Flood out of the spawn. SPAWN.y is an eye height on a mattress, so the seed is the nearest standable
// cell in plan rather than a cell at that exact height.
let seed: string | undefined;
let bestD = Infinity;
for (const [k, c] of cells) {
  const d = (c.x - SPAWN.x) ** 2 + (c.z - SPAWN.z) ** 2;
  if (d < bestD) {
    bestD = d;
    seed = k;
  }
}
if (seed === undefined) throw new Error('no standable cell anywhere');

const seen = new Set<string>([seed]);
const queue: string[] = [seed];
while (queue.length > 0) {
  const cur = cells.get(queue.pop() as string);
  if (cur === undefined) continue;
  const xi = Math.round(cur.x / STEP);
  const zi = Math.round(cur.z / STEP);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    for (const k of byColumn.get(`${xi + dx},${zi + dz}`) ?? []) {
      if (seen.has(k)) continue;
      const n = cells.get(k);
      if (n === undefined) continue;
      if (Math.abs(n.y - cur.y) > STEP_UP) continue;
      seen.add(k);
      queue.push(k);
    }
  }
}

// Report per room, against the room's own floor rect and floor height.
const rows: string[] = [];
let sealed = 0;
for (const room of ROOMS) {
  let total = 0;
  let reached = 0;
  for (let xi = Math.ceil(room.floor.x0 / STEP); xi <= Math.floor(room.floor.x1 / STEP); xi++) {
    for (let zi = Math.ceil(room.floor.z0 / STEP); zi <= Math.floor(room.floor.z1 / STEP); zi++) {
      const k = key(xi, zi, room.floorY);
      if (!cells.has(k)) continue;
      total++;
      if (seen.has(k)) reached++;
    }
  }
  const pct = total === 0 ? 0 : Math.round((reached / total) * 100);
  const flag = reached === 0 ? 'SEALED' : pct < 90 ? 'PARTIAL' : 'ok';
  if (reached === 0) sealed++;
  rows.push(`${flag.padEnd(8)} ${String(reached).padStart(5)} / ${String(total).padEnd(5)} (${String(pct).padStart(3)}%)  ${room.id}`);
}

console.log(`${cells.size} standable cells, ${seen.size} reached from spawn (${aabbs.length} colliders)\n`);
console.log(rows.join('\n'));
console.log(`\n${sealed} sealed rooms`);
