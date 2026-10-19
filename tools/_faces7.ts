/**
 * _faces7.ts — every NEAR-HORIZONTAL TRIANGLE the procedural house draws in a y band, in world space.
 *
 * Why not audit-coplanar.ts: that tool rejects any mesh whose bounding box is more than FLAT = 0.03 m
 * tall, which throws away every *box* in the house. makeCasing merges five boxes into one ~2.5 m mesh,
 * so a door sill's top face — a horizontal surface at a threshold, which is exactly where the reported
 * artefact lives — is invisible to it. Its "0 coplanar overlaps" is therefore a statement about planes
 * only.
 *
 * This walks triangles instead of bounding boxes, so an L-shaped or perforated footprint is measured as
 * what it is, and overlap between two surfaces is computed by clipping triangle against triangle rather
 * than by intersecting AABBs.
 *
 * Scope, stated because it bounds the conclusion: buildHouse(1) plus HouseScene's casings array. The
 * imported .glb rows in ModelProps are NOT here — no loader runs under dom-shim — so the flat's own
 * floor slab (measured elsewhere at 2.371..2.397) and door.glb's frame are absent.
 *
 *     npx tsx tools/_faces7.ts
 */

import './dom-shim';
import { Matrix4, Vector3, type BufferAttribute, type Material, type Mesh, type Object3D } from 'three';
import { buildHouse } from '@/world/HouseBuilder';
import { makeCasing, makeFixtureMats, type CasingSpec } from '@/world/Fixtures';
import { WALL_T } from '@/world/HouseLayout';
import {
  ARCH,
  BACK_DOOR_E,
  BACK_DOOR_W,
  BASEMENT_DOOR,
  BEDROOM_DOOR,
  CELLAR_DOOR,
  GATE,
  KITCHEN_DOOR,
  LIVING_DOOR,
  POOJA_DOOR,
  RITUAL_DOOR,
  STORE_DOOR,
  UPPER_INNER,
  UP_BACK_DOOR,
  UP_CHILD_DOOR,
  UP_SHRINE_DOOR,
  UP_Y,
} from '@/world/HouseRooms';

/** |normal.y| above this is horizontal for depth-tie purposes. */
const FLAT_N = 0.99;
/** Two horizontal surfaces closer than this in y are a candidate depth tie. */
const DY = 0.02;
/** Below this the shared xz area is an edge or a corner, not a surface. */
const MIN_AREA = 0.05;

const house = buildHouse(1);
house.group.updateMatrixWorld(true);

// --- HouseScene's casings, verbatim from src/scenes/HouseScene.ts:244-278 -------------------------
// Built here because they are added to HouseScene's own `fixtures` group, not to buildHouse's, so no
// audit that only reads buildHouse has ever seen one.
const fx = makeFixtureMats(house.mats.trim, house.mats.door, (x) => x);
const casings: Array<CasingSpec & { label: string }> = [
  { label: 'GATE', x: GATE.x, z: GATE.z, axis: 'x', half: GATE.half, y0: 0, y1: GATE.top, thickness: WALL_T },
  { label: 'ARCH', x: ARCH.x, z: 0, axis: 'x', half: ARCH.half, y0: 0, y1: ARCH.top, thickness: WALL_T },
  { label: 'BEDROOM_DOOR', x: BEDROOM_DOOR.x, z: BEDROOM_DOOR.z, axis: 'x', half: BEDROOM_DOOR.half, y0: 0, y1: BEDROOM_DOOR.top, thickness: WALL_T },
  { label: 'LIVING_DOOR', x: LIVING_DOOR.x, z: LIVING_DOOR.z, axis: 'x', half: LIVING_DOOR.half, y0: 0, y1: LIVING_DOOR.top, thickness: WALL_T },
  { label: 'CELLAR_DOOR', x: CELLAR_DOOR.x, z: CELLAR_DOOR.z, axis: 'z', half: CELLAR_DOOR.half, y0: 0, y1: CELLAR_DOOR.top, thickness: WALL_T },
  { label: 'BASEMENT_DOOR', x: BASEMENT_DOOR.x, z: BASEMENT_DOOR.z, axis: 'z', half: BASEMENT_DOOR.half, y0: BASEMENT_DOOR.bottom, y1: BASEMENT_DOOR.top, thickness: WALL_T },
  { label: 'RITUAL_DOOR', x: RITUAL_DOOR.x, z: RITUAL_DOOR.z, axis: 'z', half: RITUAL_DOOR.half, y0: RITUAL_DOOR.bottom, y1: RITUAL_DOOR.top, thickness: WALL_T },
  { label: 'UPPER_INNER', x: UPPER_INNER.x, z: UPPER_INNER.z, axis: 'z', half: UPPER_INNER.half, y0: UPPER_INNER.bottom - 0.1, y1: UPPER_INNER.top, thickness: 0.16 },
  { label: 'BACK_DOOR_W', x: BACK_DOOR_W.x, z: BACK_DOOR_W.z, axis: 'x', half: BACK_DOOR_W.half, y0: 0, y1: BACK_DOOR_W.top, thickness: WALL_T },
  { label: 'BACK_DOOR_E', x: BACK_DOOR_E.x, z: BACK_DOOR_E.z, axis: 'x', half: BACK_DOOR_E.half, y0: 0, y1: BACK_DOOR_E.top, thickness: WALL_T },
  { label: 'KITCHEN_DOOR', x: KITCHEN_DOOR.x, z: KITCHEN_DOOR.z, axis: 'x', half: KITCHEN_DOOR.half, y0: 0, y1: KITCHEN_DOOR.top, thickness: WALL_T },
  { label: 'POOJA_DOOR', x: POOJA_DOOR.x, z: POOJA_DOOR.z, axis: 'x', half: POOJA_DOOR.half, y0: 0, y1: POOJA_DOOR.top, thickness: WALL_T },
  { label: 'STORE_DOOR', x: STORE_DOOR.x, z: STORE_DOOR.z, axis: 'x', half: STORE_DOOR.half, y0: 0, y1: STORE_DOOR.top, thickness: WALL_T },
  { label: 'UP_BACK_DOOR', x: UP_BACK_DOOR.x, z: UP_BACK_DOOR.z, axis: 'x', half: UP_BACK_DOOR.half, y0: UP_Y - 0.1, y1: UP_BACK_DOOR.top, thickness: WALL_T },
  { label: 'UP_CHILD_DOOR', x: UP_CHILD_DOOR.x, z: UP_CHILD_DOOR.z, axis: 'z', half: UP_CHILD_DOOR.half, y0: UP_Y - 0.1, y1: UP_CHILD_DOOR.top, thickness: WALL_T },
  { label: 'UP_SHRINE_DOOR', x: UP_SHRINE_DOOR.x, z: UP_SHRINE_DOOR.z, axis: 'x', half: UP_SHRINE_DOOR.half, y0: UP_Y - 0.1, y1: UP_SHRINE_DOOR.top, thickness: WALL_T },
  { label: 'WINDOW_W', x: -9, z: 6.0, axis: 'z', half: 0.8, y0: 1.0, y1: 2.2, thickness: WALL_T },
  { label: 'WINDOW_S', x: 4.0, z: 10.2, axis: 'x', half: 1.1, y0: 0.9, y1: 2.3, thickness: WALL_T },
];
const roots: Object3D[] = [house.group];
for (const c of casings) {
  const g = makeCasing(fx, c);
  g.name = `casing:${c.label}`;
  for (const [i, ch] of g.children.entries()) ch.name = `casing:${c.label}#${i}`;
  g.updateMatrixWorld(true);
  roots.push(g);
}

// --- Triangle walk -------------------------------------------------------------------------------
type P2 = { x: number; z: number };
type Face = {
  name: string;
  y: number;
  up: boolean;
  tris: P2[][];
  area: number;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  offset: number;
  order: number;
  writes: boolean;
  side: number;
};

function collect(band: [number, number]): Face[] {
  const byKey = new Map<string, Face>();
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const ab = new Vector3();
  const ac = new Vector3();
  const n = new Vector3();
  for (const root of roots) {
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const pos = mesh.geometry.getAttribute('position') as BufferAttribute | undefined;
      if (!pos) return;
      const idx = mesh.geometry.index;
      const count = idx ? idx.count : pos.count;
      const m: Matrix4 = mesh.matrixWorld;
      const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as Material;
      for (let t = 0; t < count; t += 3) {
        const i0 = idx ? idx.getX(t) : t;
        const i1 = idx ? idx.getX(t + 1) : t + 1;
        const i2 = idx ? idx.getX(t + 2) : t + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(m);
        b.fromBufferAttribute(pos, i1).applyMatrix4(m);
        c.fromBufferAttribute(pos, i2).applyMatrix4(m);
        const ymin = Math.min(a.y, b.y, c.y);
        const ymax = Math.max(a.y, b.y, c.y);
        if (ymax < band[0] || ymin > band[1]) continue;
        ab.subVectors(b, a);
        ac.subVectors(c, a);
        n.crossVectors(ab, ac);
        const len = n.length();
        if (len === 0) continue;
        if (Math.abs(n.y) / len <= FLAT_N) continue;
        const y = (a.y + b.y + c.y) / 3;
        if (y < band[0] || y > band[1]) continue;
        const up = n.y > 0;
        const key = `${mesh.name || '(unnamed)'}|${Math.round(y * 1e4)}|${up ? 'up' : 'dn'}`;
        let f = byKey.get(key);
        if (!f) {
          f = {
            name: mesh.name || '(unnamed)',
            y: Math.round(y * 1e4) / 1e4,
            up,
            tris: [],
            area: 0,
            x0: Infinity,
            x1: -Infinity,
            z0: Infinity,
            z1: -Infinity,
            offset: mat?.polygonOffset ? (mat.polygonOffsetUnits ?? 0) : 0,
            order: mesh.renderOrder,
            writes: mat?.depthWrite !== false,
            side: mat?.side ?? 0,
          };
          byKey.set(key, f);
        }
        f.tris.push([
          { x: a.x, z: a.z },
          { x: b.x, z: b.z },
          { x: c.x, z: c.z },
        ]);
        f.area += Math.abs(n.y) / 2;
        f.x0 = Math.min(f.x0, a.x, b.x, c.x);
        f.x1 = Math.max(f.x1, a.x, b.x, c.x);
        f.z0 = Math.min(f.z0, a.z, b.z, c.z);
        f.z1 = Math.max(f.z1, a.z, b.z, c.z);
      }
    });
  }
  return [...byKey.values()].sort((p, q) => p.y - q.y || p.name.localeCompare(q.name));
}

// --- Exact xz overlap by triangle clipping -------------------------------------------------------
const area2 = (poly: P2[]): number => {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    s += p.x * q.z - q.x * p.z;
  }
  return s / 2;
};

const clip = (poly: P2[], e0: P2, e1: P2): P2[] => {
  const out: P2[] = [];
  const side = (p: P2): number => (e1.x - e0.x) * (p.z - e0.z) - (e1.z - e0.z) * (p.x - e0.x);
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % poly.length];
    const sc = side(cur);
    const sn = side(nxt);
    if (sc >= 0) out.push(cur);
    if ((sc > 0 && sn < 0) || (sc < 0 && sn > 0)) {
      const k = sc / (sc - sn);
      out.push({ x: cur.x + (nxt.x - cur.x) * k, z: cur.z + (nxt.z - cur.z) * k });
    }
  }
  return out;
};

const triOverlap = (p: P2[], q: P2[]): number => {
  let poly: P2[] = p;
  const cw = area2(q) < 0 ? [q[2], q[1], q[0]] : q;
  for (let i = 0; i < 3 && poly.length >= 3; i++) poly = clip(poly, cw[i], cw[(i + 1) % 3]);
  return poly.length < 3 ? 0 : Math.abs(area2(poly));
};

const bbox = (t: P2[]): [number, number, number, number] => [
  Math.min(t[0].x, t[1].x, t[2].x),
  Math.max(t[0].x, t[1].x, t[2].x),
  Math.min(t[0].z, t[1].z, t[2].z),
  Math.max(t[0].z, t[1].z, t[2].z),
];

const faceOverlap = (A: Face, B: Face): number => {
  if (A.x1 <= B.x0 || B.x1 <= A.x0 || A.z1 <= B.z0 || B.z1 <= A.z0) return 0;
  let sum = 0;
  const bb = B.tris.map(bbox);
  for (const p of A.tris) {
    const [ax0, ax1, az0, az1] = bbox(p);
    for (const [j, q] of B.tris.entries()) {
      const [bx0, bx1, bz0, bz1] = bb[j];
      if (ax1 <= bx0 || bx1 <= ax0 || az1 <= bz0 || bz1 <= az0) continue;
      sum += triOverlap(p, q);
    }
  }
  return sum;
};

// --- Report --------------------------------------------------------------------------------------
const mm = (v: number): string => (v * 1000).toFixed(2);

function report(title: string, band: [number, number]): void {
  const faces = collect(band);
  console.log(`\n${'='.repeat(110)}\n${title}  —  y ${band[0]} .. ${band[1]}\n${'='.repeat(110)}`);
  console.log(
    `${'mesh'.padEnd(30)} ${'y (m)'.padStart(8)} face ${'area m2'.padStart(8)}  ${'fill'.padStart(5)}  ` +
      `x0..x1              z0..z1              off ord side tris`,
  );
  for (const f of faces) {
    const bboxArea = (f.x1 - f.x0) * (f.z1 - f.z0);
    console.log(
      `${f.name.slice(0, 30).padEnd(30)} ${f.y.toFixed(4).padStart(8)} ${f.up ? ' up ' : ' dn '} ` +
        `${f.area.toFixed(3).padStart(8)}  ${(f.area / bboxArea).toFixed(2).padStart(5)}  ` +
        `${f.x0.toFixed(3).padStart(8)}..${f.x1.toFixed(3).padEnd(8)} ` +
        `${f.z0.toFixed(3).padStart(8)}..${f.z1.toFixed(3).padEnd(8)} ` +
        `${String(f.offset).padStart(3)} ${String(f.order).padStart(3)} ${String(f.side).padStart(4)} ${String(f.tris.length).padStart(4)}`,
    );
  }
  console.log(`\n${faces.length} horizontal surfaces, ${faces.reduce((s, f) => s + f.tris.length, 0)} triangles`);

  const hits: Array<{ a: Face; b: Face; area: number }> = [];
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      if (faces[j].y - faces[i].y > DY) break;
      const area = faceOverlap(faces[i], faces[j]);
      if (area < MIN_AREA) continue;
      hits.push({ a: faces[i], b: faces[j], area });
    }
  }
  console.log(`\n--- pairs within ${DY * 1000} mm in y and over ${MIN_AREA} m2 of shared xz, by area ---`);
  console.log(
    `${'pair'.padEnd(62)} ${'dy mm'.padStart(7)} ${'overlap'.padStart(8)}  facings  offsets  verdict`,
  );
  if (hits.length === 0) console.log('(none)');
  for (const h of hits.sort((p, q) => q.area - p.area)) {
    const dy = h.b.y - h.a.y;
    const facings = `${h.a.up ? 'up' : 'dn'}/${h.b.up ? 'up' : 'dn'}`;
    const offs = `${h.a.offset}/${h.b.offset}`;
    // Only a true tie is a tie: at this range a 24-bit buffer resolves far under a millimetre, so what
    // matters is whether dy is zero to the last digit. Where it is, the polygonOffset ladder or a
    // depthWrite:false is the only thing left to order them.
    const tie = Math.abs(dy) < 1e-5;
    const verdict = !tie
      ? `separated by ${mm(Math.abs(dy))} mm of geometry`
      : h.a.offset !== h.b.offset || !h.a.writes || !h.b.writes
        ? 'EXACT TIE, ordered by polygonOffset/depthWrite'
        : 'EXACT TIE, NOTHING SEPARATES THEM';
    console.log(
      `${`${h.a.name} + ${h.b.name}`.slice(0, 62).padEnd(62)} ${mm(dy).padStart(7)} ${h.area.toFixed(3).padStart(6)} m2  ${facings}    ${offs.padEnd(7)}  ${verdict}`,
    );
  }
}

report('FLOOR BAND', [2.25, 2.55]);
report('CEILING BAND', [5.25, 5.35]);

// --- Named checks the brief asks for by name ----------------------------------------------------
console.log(`\n${'='.repeat(110)}\nNAMED SURFACES — computed from source constants, then found in the walk\n${'='.repeat(110)}`);
const t = (thick: number): number => thick + 0.06;
for (const c of casings.filter((k) => k.y0 > 1)) {
  const sill = c.y0 > 0.02;
  const ext = c.axis === 'x'
    ? { xw: c.half * 2, zw: t(c.thickness) + 0.16 }
    : { xw: t(c.thickness) + 0.16, zw: c.half * 2 };
  console.log(
    `${c.label.padEnd(16)} axis ${c.axis}  y0 ${c.y0.toFixed(4)}  sill ${sill ? 'YES' : 'no '}  ` +
      `top face y ${(c.y0 + 0.1).toFixed(4)}  footprint ${ext.xw.toFixed(3)} x ${ext.zw.toFixed(3)} = ${(ext.xw * ext.zw).toFixed(3)} m2  ` +
      `x ${(c.x - ext.xw / 2).toFixed(3)}..${(c.x + ext.xw / 2).toFixed(3)}  z ${(c.z - ext.zw / 2).toFixed(3)}..${(c.z + ext.zw / 2).toFixed(3)}`,
  );
}

// --- Risers, as shipped: read back off the merged risers-* meshes -------------------------------
console.log(`\n${'='.repeat(110)}\nRISERS as built (vertical quads recovered from the risers-* meshes)\n${'='.repeat(110)}`);
type Riser = { axis: string; at: number; y0: number; y1: number; a0: number; a1: number; area: number; name: string };
const risers = new Map<string, Riser>();
{
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const ab = new Vector3();
  const ac = new Vector3();
  const n = new Vector3();
  house.group.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || !mesh.name.startsWith('risers-')) return;
    const pos = mesh.geometry.getAttribute('position') as BufferAttribute;
    const idx = mesh.geometry.index;
    const count = idx ? idx.count : pos.count;
    for (let tt = 0; tt < count; tt += 3) {
      const i0 = idx ? idx.getX(tt) : tt;
      const i1 = idx ? idx.getX(tt + 1) : tt + 1;
      const i2 = idx ? idx.getX(tt + 2) : tt + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      n.crossVectors(ab, ac).normalize();
      const alongX = Math.abs(n.z) > Math.abs(n.x); // face looks down z => the line runs along x
      const at = alongX ? (a.z + b.z + c.z) / 3 : (a.x + b.x + c.x) / 3;
      const sign = alongX ? Math.sign(n.z) : Math.sign(n.x);
      const y0 = Math.min(a.y, b.y, c.y);
      const y1 = Math.max(a.y, b.y, c.y);
      const key = `${alongX ? 'x' : 'z'}${sign > 0 ? '+' : '-'}@${at.toFixed(4)}`;
      const free0 = alongX ? Math.min(a.x, b.x, c.x) : Math.min(a.z, b.z, c.z);
      const free1 = alongX ? Math.max(a.x, b.x, c.x) : Math.max(a.z, b.z, c.z);
      const area = ab.cross(ac).length() / 2;
      const cur = risers.get(key);
      if (cur) {
        cur.y0 = Math.min(cur.y0, y0);
        cur.y1 = Math.max(cur.y1, y1);
        cur.a0 = Math.min(cur.a0, free0);
        cur.a1 = Math.max(cur.a1, free1);
        cur.area += area;
      } else {
        risers.set(key, {
          axis: `${alongX ? 'along x, faces ' : 'along z, faces '}${alongX ? (sign > 0 ? '+z' : '-z') : sign > 0 ? '+x' : '-x'}`,
          at,
          y0,
          y1,
          a0: free0,
          a1: free1,
          area,
          name: mesh.name,
        });
      }
    }
  });
}
for (const r of [...risers.values()].sort((p, q) => p.y0 - q.y0)) {
  console.log(
    `${r.name.padEnd(10)} ${r.axis.padEnd(22)} at ${r.at.toFixed(4).padStart(9)}  ` +
      `y ${r.y0.toFixed(4)}..${r.y1.toFixed(4)}  h ${mm(r.y1 - r.y0).padStart(7)} mm  ` +
      `span ${r.a0.toFixed(3)}..${r.a1.toFixed(3)} = ${(r.a1 - r.a0).toFixed(3)} m  area ${r.area.toFixed(3)} m2`,
  );
}
