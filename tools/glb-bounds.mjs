/**
 * The world-space bounding box of a .glb, in the file's own units.
 *
 * Placement in this house is written as "fit it to this height, put it here", so the first number a new
 * import needs is its own extent. POSITION accessors carry `min`/`max` in the glTF, and a node's
 * transform composes onto them, so the box can be built by walking the node tree and applying each
 * node's TRS to its mesh's accessor bounds. No three.js, no WebGL, no GPU.
 *
 * Usage: node tools/glb-bounds.mjs public/assets/models/hidden-room.glb
 */

import { readFileSync } from 'node:fs';

function readGlbJson(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
  const total = buf.readUInt32LE(8);
  let off = 12;
  while (off < Math.min(total, buf.length)) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) return JSON.parse(data.toString('utf8'));
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  throw new Error('no JSON chunk');
}

/** Column-major 4x4, the glTF convention, so `m[col * 4 + row]`. */
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

function fromTRS(t = [0, 0, 0], r = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

function apply(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

const path = process.argv[2];
const g = readGlbJson(path);
const nodes = g.nodes ?? [];
const accessors = g.accessors ?? [];

const box = {
  min: [Infinity, Infinity, Infinity],
  max: [-Infinity, -Infinity, -Infinity],
};
let meshesCounted = 0;

function walk(idx, parent) {
  const n = nodes[idx];
  if (!n) return;
  const local = n.matrix ?? fromTRS(n.translation, n.rotation, n.scale);
  const world = multiply(parent, local);

  if (n.mesh !== undefined) {
    const mesh = g.meshes?.[n.mesh];
    for (const prim of mesh?.primitives ?? []) {
      const acc = accessors[prim.attributes?.POSITION];
      if (!acc?.min || !acc?.max) continue;
      meshesCounted++;
      const [a, b, c] = acc.min;
      const [d, e, f] = acc.max;
      // All eight corners, because a rotation can put any of them on the extreme.
      for (const corner of [
        [a, b, c], [d, b, c], [a, e, c], [a, b, f],
        [d, e, c], [d, b, f], [a, e, f], [d, e, f],
      ]) {
        const p = apply(world, corner);
        for (let i = 0; i < 3; i++) {
          if (p[i] < box.min[i]) box.min[i] = p[i];
          if (p[i] > box.max[i]) box.max[i] = p[i];
        }
      }
    }
  }
  for (const c of n.children ?? []) walk(c, world);
}

for (const scene of g.scenes ?? []) {
  for (const r of scene.nodes ?? []) walk(r, IDENTITY);
}
if (meshesCounted === 0) for (let i = 0; i < nodes.length; i++) walk(i, IDENTITY);

const size = [0, 1, 2].map((i) => box.max[i] - box.min[i]);
const longest = Math.max(...size);
const longestAxis = ['x', 'y', 'z'][size.indexOf(longest)];

console.log(`=== ${path} ===`);
console.log(`primitives measured: ${meshesCounted}`);
console.log(`min   ${box.min.map((v) => v.toFixed(3)).join(', ')}`);
console.log(`max   ${box.max.map((v) => v.toFixed(3)).join(', ')}`);
console.log(`size  ${size.map((v) => v.toFixed(3)).join(', ')}`);
console.log(`longest axis: ${longestAxis} (${longest.toFixed(3)})`);
console.log(
  `normalised (longest = 1): ${size.map((v) => (v / longest).toFixed(4)).join(' : ')}`,
);
