/**
 * Coplanar-overlap audit — are two floor (or ceiling) surfaces fighting for the same pixels?
 *
 * A depth buffer cannot separate two horizontal planes that sit within a fraction of a millimetre of
 * each other. Which one wins is then decided per fragment by whatever the interpolated depth rounds
 * to, so the loser shows through in patches that swim and band as the camera moves — a dark quad on a
 * wooden floor that is not painted by any material and not a shadow. It reads exactly like the
 * "view glitch" this project has now been chasing through two different real causes, and it is the one
 * failure mode neither of them covers: round 1 bounded triangle edges (a w -> 0 problem, a wedge that
 * punches through walls), round 2 fixed a wall *material* (a flat panel of the wrong colour). Overlap
 * is a third thing, and where you would expect it is a threshold, because a threshold is where a
 * room's own floor meets a landing patch drawn by different code.
 *
 * The test needs no GPU: it is a statement about geometry. Any two near-horizontal meshes whose planes
 * are within COPLANAR of each other and whose footprints overlap are a bug unless something separates
 * them — a polygonOffset, or a different renderOrder with depthWrite off.
 *
 * TWO BLIND SPOTS, and round 7 fell through both — this file reported "OK — 0 coplanar overlap(s), all
 * separated" while three upward faces sat at 2.40000 with 0 um between them across two upper doorways:
 *
 *   1. `FLAT` discards any mesh over 3 cm tall, so no *box's top face* is ever tested. The offender was a
 *      door casing's sill, and mergeStaticChildren makes each casing one ~2.5 m mesh.
 *   2. `buildHouse(1)` under the dom-shim never fires a GLTF loader, so every imported mesh — the stair
 *      the player climbs, the shell they walk through — is absent from the scene it audits.
 *
 * It is also a bounding-box test, which cannot tell a shared surface from a shared edge: two room floors
 * meeting at a wall read as a 27 m2 collision. Believe a FAIL here, never an OK. For the real answer run
 * `tools/coplanar-live.js` against the running game — real triangles, imported geometry included, overlap
 * measured by rasterising cell centres.
 *
 * Not in tsconfig's `include`, like audit-tones.ts. Run it after moving any floor or landing patch:
 *
 *     npx tsx tools/audit-coplanar.ts
 */

// First, and it has to be: the `document` stub the world modules' texture generators reach for.
import './dom-shim';
import { Box3, type Material, type Mesh } from 'three';
import { buildHouse } from '@/world/HouseBuilder';

/** Planes closer than this in y cannot be told apart by the depth buffer at house scale. */
const COPLANAR = 0.02;
/** A mesh this thin in y is a plane, not a box: only planes can be exactly coplanar. */
const FLAT = 0.03;
/** Below this the overlap is a shared edge, not a shared surface. */
const MIN_AREA = 0.05;

const house = buildHouse(1);
house.group.updateMatrixWorld(true);

type Slab = {
  name: string;
  y: number;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  offset: number;
  units: number;
  order: number;
  writes: boolean;
};

const slabs: Slab[] = [];
const box = new Box3();
/** Meshes the FLAT filter throws away. Reported, because their top faces are exactly what it misses. */
let thick = 0;
house.group.traverse((o) => {
  const mesh = o as Mesh;
  if (!mesh.isMesh || !mesh.geometry) return;
  box.setFromObject(mesh, true);
  if (!Number.isFinite(box.min.y)) return;
  if (box.max.y - box.min.y > FLAT) {
    thick++;
    return;
  }
  const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as Material;
  slabs.push({
    name: mesh.name || '(unnamed)',
    y: (box.min.y + box.max.y) / 2,
    x0: box.min.x,
    x1: box.max.x,
    z0: box.min.z,
    z1: box.max.z,
    offset: mat?.polygonOffset ? (mat.polygonOffsetFactor ?? 0) : 0,
    units: mat?.polygonOffset ? (mat.polygonOffsetUnits ?? 0) : 0,
    order: mesh.renderOrder,
    writes: mat?.depthWrite !== false,
  });
});

slabs.sort((a, b) => a.y - b.y || a.name.localeCompare(b.name));

const overlap = (a: Slab, b: Slab) => {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const d = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
  return w > 0 && d > 0 ? w * d : 0;
};

const hits: { a: Slab; b: Slab; area: number }[] = [];
for (let i = 0; i < slabs.length; i++) {
  for (let j = i + 1; j < slabs.length; j++) {
    if (slabs[j].y - slabs[i].y > COPLANAR) break; // sorted by y, so nothing further can be close
    const area = overlap(slabs[i], slabs[j]);
    if (area < MIN_AREA) continue;
    hits.push({ a: slabs[i], b: slabs[j], area });
  }
}

console.log(`${slabs.length} flat surfaces in the house group\n`);
console.log('pair                                            dy(mm)  overlap   separation');
let bad = 0;
for (const h of hits.sort((p, q) => q.area - p.area)) {
  // Either a polygonOffset gap or one of them not writing depth is a deliberate decal; equal offsets
  // on both sides of a real overlap is not.
  const separated = h.a.units !== h.b.units || h.a.offset !== h.b.offset || !h.a.writes || !h.b.writes;
  if (!separated) bad++;
  const how = separated
    ? `units ${h.a.units}/${h.b.units} order ${h.a.order}/${h.b.order}${h.a.writes && h.b.writes ? '' : ' depthWrite off'}`
    : `NONE — units both ${h.a.units}, depthWrite both on`;
  console.log(
    `${`${h.a.name} + ${h.b.name}`.slice(0, 46).padEnd(46)} ` +
      `${((h.b.y - h.a.y) * 1000).toFixed(2).padStart(6)}  ${h.area.toFixed(2).padStart(6)} m2  ${how}`,
  );
}

// Never print a bare OK: the two blind spots in the header mean silence here is not evidence. Say what
// was not looked at, and where the answer actually lives.
console.log(
  bad === 0
    ? `\n${hits.length} coplanar overlap(s), all separated — nothing found IN WHAT THIS CAN SEE.\n` +
        `Not tested: ${thick} mesh(es) over ${FLAT * 100} cm tall (their top faces), and every imported\n` +
        `GLB (no loader runs headless). Overlap here is bounding-box, so a shared edge reads as a shared\n` +
        `surface. For a real answer run tools/coplanar-live.js against the running game.`
    : `\nFAIL — ${bad} of ${hits.length} coplanar overlap(s) have nothing separating them.`,
);
process.exit(bad === 0 ? 0 : 1);
