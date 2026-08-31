// Where are black-magic-room.glb's wall openings, exactly?
//
// Written because the live framebuffer and three.js's Box3 disagree about this file: Box3 reports the
// radiator against the north wall, the renderer draws it on the east, and a doorway shows up in a wall
// that Box3 says is solid. Both readings are downstream of the same skinning, so neither is a safe
// source for "where can the player walk in". This measures the geometry itself: skin every vertex the
// way the shader does, keep the two wall meshes, and rasterise each of the four wall planes into an
// occupancy grid. An opening is a hole in the grid, and its extent is read off directly.
//
// Usage: node wall-holes.mjs <glb> [cellSize]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(process.argv[2]);
const CELL = Number(process.argv[3] ?? 0.08);

const mul = (m, v) => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
];
const mm = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const trs = (node) => {
  const [tx, ty, tz] = node.getTranslation();
  const [qx, qy, qz, qw] = node.getRotation();
  const [sx, sy, sz] = node.getScale();
  return [
    (1 - 2 * (qy * qy + qz * qz)) * sx, 2 * (qx * qy + qz * qw) * sx, 2 * (qx * qz - qy * qw) * sx, 0,
    2 * (qx * qy - qz * qw) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy, 2 * (qy * qz + qx * qw) * sy, 0,
    2 * (qx * qz + qy * qw) * sz, 2 * (qy * qz - qx * qw) * sz, (1 - 2 * (qx * qx + qy * qy)) * sz, 0,
    tx, ty, tz, 1,
  ];
};
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const world = new Map();
const walk = (node, parent) => {
  const w = mm(parent, trs(node));
  world.set(node, w);
  for (const c of node.listChildren()) walk(c, w);
};
for (const scene of doc.getRoot().listScenes()) for (const node of scene.listChildren()) walk(node, I);

/** Skinned triangles, per mesh node name: [[ax,ay,az],[bx,..],[cx,..]][] */
const tris = new Map();
for (const [node, nodeWorld] of world) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const skin = node.getSkin();
  const joints = skin ? skin.listJoints() : [];
  const ibm = skin ? skin.getInverseBindMatrices() : null;
  const mats = joints.map((j, i) => mm(world.get(j) ?? I, ibm ? ibm.getElement(i, new Array(16)) : I));
  const out = [];
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    const jo = prim.getAttribute('JOINTS_0');
    const we = prim.getAttribute('WEIGHTS_0');
    const idx = prim.getIndices();
    const p = [0, 0, 0], jv = [0, 0, 0, 0], wv = [0, 0, 0, 0];
    const skinned = [];
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, p);
      let o = mul(nodeWorld, p);
      if (jo && we && mats.length > 0) {
        jo.getElement(i, jv); we.getElement(i, wv);
        o = [0, 0, 0];
        for (let k = 0; k < 4; k++) {
          if (wv[k] === 0) continue;
          const t = mul(mats[jv[k]] ?? I, p);
          for (let a = 0; a < 3; a++) o[a] += t[a] * wv[k];
        }
      }
      skinned.push(o);
    }
    const n = idx ? idx.getCount() : skinned.length;
    for (let i = 0; i + 2 < n; i += 3) {
      const a = idx ? idx.getScalar(i) : i, b = idx ? idx.getScalar(i + 1) : i + 1, c = idx ? idx.getScalar(i + 2) : i + 2;
      out.push([skinned[a], skinned[b], skinned[c]]);
    }
  }
  tris.set(node.getName() || '?', out);
}
console.log('meshes:', [...tris].map(([n, t]) => `${n}:${t.length}tri`).join(' '));

// Per-mesh model-space boxes. The live scene's Box3 is transposed against these (three.js reads
// SkinnedMesh.boundingBox and then multiplies by matrixWorld, so the root yaw lands twice), so this
// table is the only trustworthy statement of where each part sits inside the room.
for (const [n, t] of tris) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const tri of t) for (const v of tri) for (let a = 0; a < 3; a++) { b[a] = Math.min(b[a], v[a]); b[a + 3] = Math.max(b[a + 3], v[a]); }
  const f = (v) => v.toFixed(4).padStart(9);
  console.log(`  ${n.padEnd(11)} x${f(b[0])}..${f(b[3])}  y${f(b[1])}..${f(b[4])}  z${f(b[2])}..${f(b[5])}`);
}

// The room shell. Object_5/6/8/9/14 are pruned at install time; 9 is the door leaves, so a hole that
// only exists because a leaf was dropped is still a hole the player walks through.
const SHELL = (process.env.SHELL_MESHES ?? 'Object_11,Object_16').split(',');
const shell = SHELL.flatMap((n) => tris.get(n) ?? []);
const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
for (const t of shell) for (const v of t) {
  for (let a = 0; a < 3; a++) { box[a] = Math.min(box[a], v[a]); box[a + 3] = Math.max(box[a + 3], v[a]); }
}
console.log(`shell ${SHELL.join('+')}  ${shell.length} tri`);
console.log(`model box  x ${box[0].toFixed(4)}..${box[3].toFixed(4)}  y ${box[1].toFixed(4)}..${box[4].toFixed(4)}  z ${box[2].toFixed(4)}..${box[5].toFixed(4)}`);

// --- Offline raycast, in live world coordinates ---------------------------------------------------
// The live scene cannot answer "what is at this pixel": SkinnedMesh raycasting and Box3 both read the
// cached boundingBox, which for this file already carries the root yaw, so they answer for a room rotated
// twice. Ray against the skinned triangles instead, mapped through the transform the renderer actually
// uses (bones only, one yaw): world = P + s * Ry(-90) * model.
if (process.env.RAYS) {
  const P = (process.env.ROOT_POS ?? '-16.74443,-2.98933,8.82645').split(',').map(Number);
  const s = Number(process.env.ROOT_SCALE ?? 0.882910209);
  const toWorld = (v) => [P[0] - s * v[2], P[1] + s * v[1], P[2] + s * v[0]];
  const worldTris = [];
  for (const [n, list] of tris) {
    if (['Object_5', 'Object_6', 'Object_8', 'Object_9', 'Object_14'].includes(n)) continue; // pruned at install
    for (const t of list) worldTris.push([n, t.map(toWorld)]);
  }
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const hit = (o, d, [a, b, c]) => {
    const e1 = sub(b, a), e2 = sub(c, a), h = cross(d, e2), det = dot(e1, h);
    if (Math.abs(det) < 1e-12) return null;
    const inv = 1 / det, sv = sub(o, a), u = inv * dot(sv, h);
    if (u < 0 || u > 1) return null;
    const q = cross(sv, e1), v = inv * dot(d, q);
    if (v < 0 || u + v > 1) return null;
    const t = inv * dot(e2, q);
    return t > 1e-4 ? t : null;
  };
  const ORIGIN = (process.env.RAY_FROM ?? '-16.66,-1.3,8.87').split(',').map(Number);
  for (const spec of process.env.RAYS.split(';')) {
    const [label, dirs] = spec.split('=');
    const d = dirs.split(',').map(Number);
    const found = [];
    for (const [n, t] of worldTris) { const h = hit(ORIGIN, d, t); if (h !== null) found.push([h, n]); }
    found.sort((a, b) => a[0] - b[0]);
    const at = (t) => ORIGIN.map((o, i) => +(o + d[i] * t).toFixed(3)).join(',');
    console.log(`\nray ${label.padEnd(6)} dir ${d.map((v) => v.toFixed(3)).join(',')}  ${found.length} hits`);
    for (const [t, n] of found.slice(0, 4)) console.log(`   ${t.toFixed(3)}m  ${n.padEnd(11)} at ${at(t)}`);
    if (!found.length) console.log('   nothing — the ray leaves the room through a hole in the shell');
  }
}
const inTri = (px, py, a, b, c) => {
  const d1 = (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (py - b[1]);
  const d2 = (px - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (py - c[1]);
  const d3 = (px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1]);
  return !((d1 > 0 || d2 > 0 || d3 > 0) && (d1 < 0 || d2 < 0 || d3 < 0));
};

// Each wall: which axis is constant, at which extreme, and which axis runs along the wall.
const WALLS = [
  { label: 'x-min wall (model west)', axis: 0, at: box[0], u: 2 },
  { label: 'x-max wall (model east)', axis: 0, at: box[3], u: 2 },
  { label: 'z-min wall (model north)', axis: 2, at: box[2], u: 0 },
  { label: 'z-max wall (model south)', axis: 2, at: box[5], u: 0 },
];
const BAND = Number(process.env.BAND ?? 0.4);

for (const w of WALLS) {
  const keep = shell.filter((t) => t.every((v) => Math.abs(v[w.axis] - w.at) <= BAND));
  const u0 = box[w.u], u1 = box[w.u + 3], y0 = box[1], y1 = box[4];
  const nu = Math.ceil((u1 - u0) / CELL), ny = Math.ceil((y1 - y0) / CELL);
  const grid = new Uint8Array(nu * ny);
  for (const t of keep) {
    const p = t.map((v) => [v[w.u], v[1]]);
    const bu0 = Math.min(p[0][0], p[1][0], p[2][0]), bu1 = Math.max(p[0][0], p[1][0], p[2][0]);
    const by0 = Math.min(p[0][1], p[1][1], p[2][1]), by1 = Math.max(p[0][1], p[1][1], p[2][1]);
    for (let iu = Math.max(0, Math.floor((bu0 - u0) / CELL)); iu < Math.min(nu, Math.ceil((bu1 - u0) / CELL) + 1); iu++) {
      for (let iy = Math.max(0, Math.floor((by0 - y0) / CELL)); iy < Math.min(ny, Math.ceil((by1 - y0) / CELL) + 1); iy++) {
        if (grid[iy * nu + iu]) continue;
        if (inTri(u0 + (iu + 0.5) * CELL, y0 + (iy + 0.5) * CELL, p[0], p[1], p[2])) grid[iy * nu + iu] = 1;
      }
    }
  }
  console.log(`\n=== ${w.label}  ${['x', 'y', 'z'][w.axis]}=${w.at.toFixed(4)}  ${keep.length} tri  ${nu}x${ny} cells of ${CELL}m`);
  console.log(`    across: ${['x', 'y', 'z'][w.u]} ${u0.toFixed(3)}..${u1.toFixed(3)}   up: y ${y0.toFixed(3)}..${y1.toFixed(3)}`);
  for (let iy = ny - 1; iy >= 0; iy--) {
    let line = '';
    for (let iu = 0; iu < nu; iu++) line += grid[iy * nu + iu] ? '#' : '.';
    console.log(`y${(y0 + (iy + 0.5) * CELL).toFixed(2).padStart(7)} ${line}`);
  }
  // A doorway is a run of columns with no wall anywhere in the lower 1.9 m.
  const doorTop = Math.min(ny, Math.ceil(1.9 / CELL));
  const open = [];
  for (let iu = 0; iu < nu; iu++) {
    let solid = false;
    for (let iy = 0; iy < doorTop; iy++) if (grid[iy * nu + iu]) { solid = true; break; }
    if (!solid) { if (open.length && open.at(-1)[1] === iu - 1) open.at(-1)[1] = iu; else open.push([iu, iu]); }
  }
  const runs = open.filter(([a, b]) => (b - a + 1) * CELL >= 0.5)
    .map(([a, b]) => `${(u0 + a * CELL).toFixed(3)}..${(u0 + (b + 1) * CELL).toFixed(3)} (${((b - a + 1) * CELL).toFixed(2)}m)`);
  console.log(`    walk-through gaps in ${['x', 'y', 'z'][w.u]} (nothing below y+1.9): ${runs.length ? runs.join('  ') : 'none'}`);
}
