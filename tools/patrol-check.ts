/**
 * Patrol + memory check — do the waypoints bake, and does memory decay the way §10 asks?
 *
 * The waypoint half is a data test: every authored point must resolve to walkable floor, or the room
 * it was supposed to cover silently drops out of patrol. Since the points are hand-placed against the
 * room constants, a layout edit that moves a wall is exactly what would break them — and this is the
 * only thing that would notice.
 *
 * The memory half asserts the properties the rest of the AI leans on: a sighting beats a sound, belief
 * decays rather than persisting, and stale velocity expires instead of being extrapolated from.
 */

import './dom-shim.js';
import { buildHouse } from '../src/world/HouseBuilder.js';
import { NavGrid } from '../src/ai/NavGrid.js';
import { PatrolSystem } from '../src/ai/Patrol.js';
import { Memory } from '../src/ai/Memory.js';
import { daayanConfigFor } from '../src/ai/DaayanConfig.js';
import { ROOMS } from '../src/world/HouseRooms.js';
import type { AABB } from '../src/player/FPController.js';
import type { Vec3 } from '../src/core/types.js';

const h = buildHouse(1);
const grid = NavGrid.bake(h.floors, h.aabbs as AABB[]);
const cfg = daayanConfigFor('normal');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z } as Vec3);

console.log('=== PATROL ===');
const patrol = new PatrolSystem(cfg, grid);
const points = patrol.all();
console.log(`${points.length} waypoints baked`);

// Every authored point must survive. Compare against the source list by counting per room.
const EXPECTED_PER_ROOM: Record<string, number> = {
  hall: 5, hallway: 6, bedroom: 4, living: 4, backhall: 5,
  kitchen: 3, pooja: 2, store: 2, shaft: 2, basement: 4,
  upshaft: 1, upper: 4,
};
const totalExpected = Object.values(EXPECTED_PER_ROOM).reduce((a, b) => a + b, 0);
check('all waypoints baked', points.length === totalExpected,
  `${points.length} of ${totalExpected}`);

// Each room that was meant to be patrolled must still have its points.
const roomCounts = new Map<string, number>();
for (const p of points) roomCounts.set(p.room, (roomCounts.get(p.room) ?? 0) + 1);
for (const [room, want] of Object.entries(EXPECTED_PER_ROOM)) {
  const got = roomCounts.get(room) ?? 0;
  check(`room "${room}" fully covered`, got === want, `${got}/${want}`);
}

// The three storeys must all be represented, or patrol never leaves the ground floor.
const heights = points.map((p) => p.nav!.y);
const ys = new Set(heights.map((y) => Math.round(y * 2) / 2));
console.log(`      storey heights present: ${[...ys].sort((a, b) => a - b).join(', ')}`);
// The cellar stair contributes intermediate heights (-2.5), so this asserts coverage of each storey's
// floor rather than an exact set: something below -2, something near 0, something above 2.
const hasCellar = heights.some((y) => y < -2.5);
const hasGround = heights.some((y) => Math.abs(y) < 0.5);
const hasUpper = heights.some((y) => y > 2);
check('all three storeys patrolled', hasCellar && hasGround && hasUpper,
  `cellar=${hasCellar} ground=${hasGround} upper=${hasUpper}`);

// Selection must not return the same point twice in a row, over many draws (§5 anti-repeat).
let repeats = 0;
let t = 0;
let current = v(-7, 0, 9);
let lastPicked = '';
for (let i = 0; i < 300; i++) {
  const p = patrol.chooseNext(t, null, current);
  if (p.id === lastPicked) repeats++;
  lastPicked = p.id;
  patrol.arrive(t);
  current = v(p.nav!.x, p.nav!.y, p.nav!.z);
  t += p.dwell + 2;
}
check('never picks the same waypoint twice in a row', repeats === 0, `${repeats} repeats in 300 draws`);

// Over a long run, patrol must actually visit many distinct points, not pace between two.
const visited = new Set<string>();
let t2 = 0;
let cur2 = v(-7, 0, 9);
const patrol2 = new PatrolSystem(cfg, grid);
for (let i = 0; i < 400; i++) {
  const p = patrol2.chooseNext(t2, null, cur2);
  visited.add(p.id);
  patrol2.arrive(t2);
  cur2 = v(p.nav!.x, p.nav!.y, p.nav!.z);
  t2 += p.dwell + 3;
}
check('patrol spreads across the house', visited.size >= points.length * 0.85,
  `${visited.size} of ${points.length} distinct points visited`);

// The player-activity term must actually bias patrol toward the last known position.
{
  const nearby = v(-5, 0, 6.6); // the bedroom
  let bedroomHits = 0;
  const p3 = new PatrolSystem(cfg, grid);
  let t3 = 0;
  let cur3 = v(-28, -3, 4);
  for (let i = 0; i < 500; i++) {
    const p = p3.chooseNext(t3, nearby, cur3);
    if (p.room === 'bedroom') bedroomHits++;
    p3.arrive(t3);
    cur3 = v(p.nav!.x, p.nav!.y, p.nav!.z);
    t3 += p.dwell + 3;
  }
  const baseline = (roomCounts.get('bedroom') ?? 0) / points.length;
  const share = bedroomHits / 500;
  check('player hint biases patrol toward that room', share > baseline,
    `bedroom ${(share * 100).toFixed(0)}% of picks vs ${(baseline * 100).toFixed(0)}% of the network`);
}

// Room lookup.
check('roomAt resolves a known position', patrol.roomAt(v(-5, 0, 6.6)) === 'bedroom',
  String(patrol.roomAt(v(-5, 0, 6.6))));
check('roomAt rejects a wild position', patrol.roomAt(v(999, 0, 999)) === null, '');

console.log('\n=== MEMORY ===');
{
  const mem = new Memory(cfg);
  check('empty memory has nothing', !mem.hasAnything() && mem.getConfidence() === 0);

  mem.noteSeen(v(5, 0, 5), 0, v(1, 0, 0), 0.9);
  check('sighting is remembered', mem.hasAnything() && mem.getConfidence() > 0.5,
    `confidence ${mem.getConfidence().toFixed(2)}`);
  const pos = mem.getPosition()!;
  check('estimate matches the sighting', Math.hypot(pos.x - 5, pos.z - 5) < 0.01,
    `(${pos.x.toFixed(1)}, ${pos.z.toFixed(1)})`);

  // Decay: after the sighting is old, confidence must fall and the estimate eventually drop.
  const before = mem.getConfidence();
  mem.decay(1, 20);
  const after = mem.getConfidence();
  check('belief decays with age', after < before, `${before.toFixed(2)} -> ${after.toFixed(2)}`);
  mem.decay(1, 200);
  check('belief eventually expires completely', !mem.hasAnything(),
    `hasAnything=${mem.hasAnything()}`);

  // A sighting must outrank a sound at the same recency.
  const m2 = new Memory(cfg);
  m2.noteHeard(v(10, 0, 10), 0, 0.3);
  const heardConf = m2.getConfidence();
  const m3 = new Memory(cfg);
  m3.noteSeen(v(10, 0, 10), 0, v(0, 0, 0), 0.9);
  const seenConf = m3.getConfidence();
  check('a sighting is worth more than a sound', seenConf > heardConf,
    `seen ${seenConf.toFixed(2)} > heard ${heardConf.toFixed(2)}`);

  // A weak sound must not overwrite a fresh sighting.
  const m4 = new Memory(cfg);
  m4.noteSeen(v(0, 0, 0), 0, v(0, 0, 0), 0.9);
  const p0 = m4.getPosition()!;
  m4.noteHeard(v(30, 0, 30), 0.2, 0.3);
  const p1 = m4.getPosition()!;
  check('a quiet sound does not degrade a fresh sighting',
    Math.hypot(p1.x - p0.x, p1.z - p0.z) < 0.01,
    `moved ${Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(3)} m`);

  // Stale velocity must expire (§15 needs this to not extrapolate nonsense).
  const m5 = new Memory(cfg);
  m5.noteSeen(v(0, 0, 0), 0, v(2, 0, 3), 1.0);
  check('recent velocity is available', m5.getRecentVelocity(0.5) !== null);
  check('stale velocity expires', m5.getRecentVelocity(10) === null,
    `escapeVelocityMemory = ${cfg.escapeVelocityMemory} s`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
