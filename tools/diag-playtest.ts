/**
 * Diagnostics for the three playtest reports: sticky search, upper-storey patrol, and the maxed
 * noise bar not pulling her.
 */

import './dom-shim.js';
import { buildHouse } from '../src/world/HouseBuilder.js';
import { DaayanAI } from '../src/ai/DaayanAI.js';
import { NavGrid } from '../src/ai/NavGrid.js';
import type { AABB, FPController } from '../src/player/FPController.js';
import type { Vec3 } from '../src/core/types.js';
import { globalBus } from '../src/core/EventBus.js';

const h = buildHouse(1);
const aabbs = h.aabbs as AABB[];
const CELLAR_Y = -3;
const EYE = 1.62;

// --- 1. Reachability: can she even path to the upper storey from the cellar? ---
const grid = NavGrid.bake(h.floors, aabbs);
const fromCellar = { x: -28.4, y: CELLAR_Y, z: 4.3, cell: 0, key: '' };
console.log('=== REACHABILITY FROM THE RITUAL ROOM ===');

for (const target of [
  { name: 'ground floor hall', x: 6, y: 0, z: 0 },
  { name: 'upper storey', x: 12, y: 2.5, z: 1.0 },
  { name: 'upper room', x: 20, y: 2.5, z: 0 },
  { name: 'basement', x: -18, y: -3, z: 2 },
]) {
  const p = grid.findPath(fromCellar as never, { ...target, cell: 0, key: '' } as never, 0);
  console.log(`  cellar -> ${target.name}: ${p ? `${p.length} pts, ${p[p.length - 1]?.y.toFixed(1)} y` : 'NO PATH'}`);
}

// --- What storeys exist in the grid at all? ---
console.log(`  walkable cells: ${grid.walkableCount()}`);

console.log('\n=== PATROL WAYPOINT RESOLUTION (which storey each lands on) ===');
// The upper-storey waypoints are authored at ground-floor-adjacent x/z. If `nearestWalkable` is
// called without a y hint it takes whichever storey is topmost at that column, so they can silently
// resolve to the wrong floor — and then "upstairs" is patrolled by walking around downstairs.
for (const a of [
  { id: 'upshaft-top', x: 13.8, z: 1.3, want: 2.5 },
  { id: 'upper-west', x: 15.4, z: 3.6, want: 2.5 },
  { id: 'upper-centre', x: 19.0, z: 3.6, want: 2.5 },
  { id: 'upper-east', x: 22.6, z: 3.6, want: 2.5 },
  { id: 'upper-north', x: 19.0, z: 7.6, want: 2.5 },
  { id: 'hall-centre (control)', x: 0, z: -3.2, want: 0 },
]) {
  const noHint = grid.nearestWalkable(a.x, a.z, 4);
  const withHint = grid.nearestWalkable(a.x, a.z, 4, a.want);
  console.log(
    `  ${a.id.padEnd(22)} want y=${a.want}  no-hint y=${noHint ? noHint.y.toFixed(1) : 'null'}  with-hint y=${withHint ? withHint.y.toFixed(1) : 'null'}`,
  );
}

console.log('\n=== PATROL WAYPOINT STOREYS ===');
// Reach the patrol system through the AI's own plan: sample which storey she actually visits.
const player = {
  pos: { x: -28.4, y: CELLAR_Y + EYE, z: 4.3 } as Vec3,
  getPosition() { return this.pos; },
  velocity: { x: 0, y: 0, z: 0 } as Vec3,
  isRunning() { return false; },
  isCrouching() { return false; },
  getRadius() { return 0.32; },
};

const ai = new DaayanAI({
  getRoot: () => null,
  getClips: () => [],
  player: player as unknown as FPController,
  obstacles: aabbs,
  floors: h.floors,
  hidingSpots: [],
  start: { position: { x: -28.4, y: CELLAR_Y, z: 4.3 } as Vec3, yaw: 2.41 },
  difficulty: 'normal',
  overrides: { wakeOnTrigger: true, debug: false },
  canRoam: () => true,
});

ai.wake();
const DT = 1 / 60;
const storeyHits = new Map<number, number>();
let lastStorey = -99;
for (let i = 0; i < 60 * 240; i++) {
  // Move the player to a place she cannot reach, so patrol is observed without her catching them.
  player.pos = { x: 19, y: 2.4 + EYE, z: 3.6 } as Vec3;
  ai.update(DT);
  const p = ai.getPosition();
  const s = Math.round(p.y);
  if (s !== lastStorey) {
    lastStorey = s;
    storeyHits.set(s, (storeyHits.get(s) ?? 0) + 1);
  }
}
console.log('  storey changes over 240 s of patrol:');
for (const [y, n] of [...storeyHits].sort((a, b) => a[0] - b[0])) {
  console.log(`    y=${y}: entered ${n} times`);
}
console.log(`  final state: ${ai.getState()}  pos y=${ai.getPosition().y.toFixed(1)}`);

// Where is she actually going? Sample her target over time.
ai.wake();
const targets = new Map<string, number>();
let still = 0;
for (let i = 0; i < 60 * 120; i++) {
  player.pos = { x: 19, y: 2.4 + EYE, z: 3.6 } as Vec3;
  const before = ai.getPosition();
  ai.update(DT);
  const after = ai.getPosition();
  if (Math.hypot(after.x - before.x, after.z - before.z) < 0.001) still++;
  const t = ai.getDebugInfo().target;
  if (t) {
    const k = `${t.x.toFixed(0)},${t.z.toFixed(0)} y${t.y.toFixed(1)}`;
    targets.set(k, (targets.get(k) ?? 0) + 1);
  } else {
    targets.set('(null target)', (targets.get('(null target)') ?? 0) + 1);
  }
}
console.log('\n  targets over 120 s (top 10 by time spent):');
for (const [k, n] of [...targets].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`    ${k.padEnd(22)} ${(n / 60).toFixed(1)} s`);
}
console.log(`  ticks standing still: ${still} / ${60 * 120} (${((still / (60 * 120)) * 100).toFixed(1)}%)`);

console.log('\n=== WHY THE TARGET IS NULL ===');
console.log(`  her pos: (${ai.getPosition().x.toFixed(1)}, ${ai.getPosition().y.toFixed(1)}, ${ai.getPosition().z.toFixed(1)})`);
console.log(`  state: ${ai.getState()}   reason: ${ai.getDebugInfo().reason}`);

// Watch the state machine from a clean wake, tick by tick for the first few seconds.
const ai2 = new DaayanAI({
  getRoot: () => null,
  getClips: () => [],
  player: player as unknown as FPController,
  obstacles: aabbs,
  floors: h.floors,
  hidingSpots: [],
  start: { position: { x: -28.4, y: CELLAR_Y, z: 4.3 } as Vec3, yaw: 2.41 },
  difficulty: 'normal',
  overrides: { wakeOnTrigger: true, debug: false },
  canRoam: () => true,
});
player.pos = { x: 19, y: 2.4 + EYE, z: 3.6 } as Vec3;
ai2.wake();
console.log('\n  first 3 s after waking (state every 0.5 s):');
for (let i = 0; i < 180; i++) {
  player.pos = { x: 19, y: 2.4 + EYE, z: 3.6 } as Vec3;
  ai2.update(DT);
  if (i % 30 === 0) {
    const d = ai2.getDebugInfo();
    console.log(
      `    t=${(i * DT).toFixed(1)}s  ${d.state.padEnd(18)} reason=${d.reason.padEnd(18)} target=${d.target ? `${d.target.x.toFixed(1)},${d.target.z.toFixed(1)} y${d.target.y.toFixed(1)}` : 'null'}  path=${d.path.length}  speed=${d.speed.toFixed(2)}`,
    );
  }
}

// --- Full-house patrol coverage over a long run. ---
console.log('\n=== PATROL COVERAGE OVER 5 MINUTES ===');
const seenRooms = new Map<string, number>();
const seenStoreys = new Set<number>();
let prevY = -99;
let stuckTicks = 0;
let prevP = ai2.getPosition();
for (let i = 0; i < 60 * 300; i++) {
  // Keep the player somewhere she can path to but never reach in time: the far side of the upper
  // storey. Inside `aiLodDistance`, so the AI is fully awake.
  player.pos = { x: 22.6, y: 2.4 + EYE, z: 7.6 } as Vec3;
  ai2.update(DT);
  const cur = ai2.getPosition();
  if (Math.hypot(cur.x - prevP.x, cur.z - prevP.z) < 0.0005) stuckTicks++;
  prevP = cur;
  const y = Math.round(cur.y * 2) / 2;
  if (y !== prevY) { prevY = y; seenStoreys.add(y); }
  const d = ai2.getDebugInfo();
  if (d.target) {
    const k = `y${d.target.y.toFixed(1)}`;
    seenRooms.set(k, (seenRooms.get(k) ?? 0) + 1);
  }
}
console.log(`  storeys visited: ${[...seenStoreys].sort((a, b) => a - b).join(', ')}`);
console.log('  time spent targeting each storey:');
for (const [k, n] of [...seenRooms].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`    ${k}: ${(n / 60).toFixed(0)} s`);
}
console.log(`  standing-still ticks: ${stuckTicks} / ${60 * 300} (${((stuckTicks / (60 * 300)) * 100).toFixed(1)}%)`);

// --- How far does she actually travel, and at what LOD tier? ---
console.log('\n=== DISTANCE TRAVELLED OVER 5 MINUTES ===');
{
  const aiT = new DaayanAI({
    getRoot: () => null,
    getClips: () => [],
    player: player as unknown as FPController,
    obstacles: aabbs,
    floors: h.floors,
    hidingSpots: [],
    start: { position: { x: -28.4, y: CELLAR_Y, z: 4.3 } as Vec3, yaw: 2.41 },
    difficulty: 'normal',
    overrides: { wakeOnTrigger: true, debug: false },
    canRoam: () => true,
  });
  aiT.wake();
  let dist = 0;
  let p = aiT.getPosition();
  const counts = new Map<string, number>();
  for (let i = 0; i < 60 * 300; i++) {
    // Player on the upper storey: ~47 m away in 2D, so the far tier is active.
    player.pos = { x: 22.6, y: 2.4 + EYE, z: 7.6 } as Vec3;
    aiT.update(DT);
    const c = aiT.getPosition();
    dist += Math.hypot(c.x - p.x, c.z - p.z);
    counts.set(aiT.getState(), (counts.get(aiT.getState()) ?? 0) + 1);
    p = c;
  }
  console.log(`  travelled ${dist.toFixed(1)} m in 300 s (${(dist / 300).toFixed(2)} m/s average)`);
  console.log(`  final y=${aiT.getPosition().y.toFixed(1)}  state=${aiT.getState()}`);
  console.log('  time in each state:');
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k}: ${(n / 60).toFixed(0)} s`);
  }
}

// --- The noise bar at maximum. ---
console.log('\n=== NOISE BAR AT MAX ===');
const ai3 = new DaayanAI({
  getRoot: () => null,
  getClips: () => [],
  player: player as unknown as FPController,
  obstacles: aabbs,
  floors: h.floors,
  hidingSpots: [],
  start: { position: { x: -28.4, y: CELLAR_Y, z: 4.3 } as Vec3, yaw: 2.41 },
  difficulty: 'normal',
  overrides: { wakeOnTrigger: true, debug: false },
  canRoam: () => true,
});
ai3.wake();
// Let her get settled first.
for (let i = 0; i < 60 * 8; i++) {
  player.pos = { x: 19, y: 2.4 + EYE, z: 3.6 } as Vec3;
  ai3.update(DT);
}
const beforeState = ai3.getState();
const beforePos = ai3.getPosition();
console.log(`  before: state=${beforeState} at (${beforePos.x.toFixed(1)}, ${beforePos.y.toFixed(1)}, ${beforePos.z.toFixed(1)})`);

// The bar fills while the player is in the ground-floor hall — several rooms away and one storey up.
const NOISE = { x: 0, y: 0.5, z: -3.2 };
player.pos = { x: NOISE.x, y: NOISE.y + EYE, z: NOISE.z } as Vec3;
globalBus.emit('noise:alert', { pos: { ...NOISE } as Vec3, level: 1 });

let reached = false;
let closest = Infinity;
for (let i = 0; i < 60 * 30; i++) {
  player.pos = { x: NOISE.x, y: NOISE.y + EYE, z: NOISE.z } as Vec3;
  ai3.update(DT);
  const cur = ai3.getPosition();
  const d = Math.hypot(cur.x - NOISE.x, cur.z - NOISE.z);
  if (d < closest) closest = d;
  if (d < 2.5) reached = true;
}
const endPos = ai3.getPosition();
console.log(`  reached the noise source: ${reached}  closest ${closest.toFixed(1)} m  final y=${endPos.y.toFixed(1)}  state ${ai3.getState()}`);

