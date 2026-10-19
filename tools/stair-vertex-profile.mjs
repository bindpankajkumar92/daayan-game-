import { readFileSync } from 'node:fs';

function readGlb(path) {
  const buf = readFileSync(path);
  const total = buf.readUInt32LE(8);
  let off = 12;
  let jsonChunk = null;
  let binChunk = null;
  while (off < Math.min(total, buf.length)) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) jsonChunk = JSON.parse(data.toString('utf8'));
    if (type === 0x004e4942) binChunk = data;
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  return { json: jsonChunk, bin: binChunk };
}

const { json: g, bin } = readGlb('public/assets/models/stair-hidden.glb');
const nodes = g.nodes ?? [];
const accessors = g.accessors ?? [];
const bufferViews = g.bufferViews ?? [];

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

const points = [];
function walk(idx, parent) {
  const n = nodes[idx];
  if (!n) return;
  // If node name matches dropped rail, skip it
  if (n.name && n.name.includes('rail')) return;
  const local = n.matrix ?? fromTRS(n.translation, n.rotation, n.scale);
  const world = multiply(parent, local);

  if (n.mesh !== undefined) {
    const mesh = g.meshes?.[n.mesh];
    if (mesh.name && mesh.name.includes('rail')) return;
    for (const prim of mesh?.primitives ?? []) {
      const acc = accessors[prim.attributes?.POSITION];
      if (!acc) continue;
      const bv = bufferViews[acc.bufferView];
      const byteOffset = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
      const count = acc.count;
      // componentType: 5126 = float, 5122 = int16
      const isFloat = acc.componentType === 5126;
      const isShort = acc.componentType === 5122;
      const isUShort = acc.componentType === 5123;
      for (let i = 0; i < count; i++) {
        let x, y, z;
        if (isFloat) {
          x = bin.readFloatLE(byteOffset + i * 12);
          y = bin.readFloatLE(byteOffset + i * 12 + 4);
          z = bin.readFloatLE(byteOffset + i * 12 + 8);
        } else if (isShort) {
          x = bin.readInt16LE(byteOffset + i * 6);
          y = bin.readInt16LE(byteOffset + i * 6 + 2);
          z = bin.readInt16LE(byteOffset + i * 6 + 4);
          if (acc.normalized) {
            x /= 32767; y /= 32767; z /= 32767;
          }
        }
        const wp = apply(world, [x, y, z]);
        points.push(wp);
      }
    }
  }
  for (const c of n.children ?? []) walk(c, world);
}

for (const scene of g.scenes ?? []) {
  for (const r of scene.nodes ?? []) walk(r, IDENTITY);
}

console.log(`Extracted ${points.length} vertices.`);
let min = [Infinity, Infinity, Infinity];
let max = [-Infinity, -Infinity, -Infinity];
for (const p of points) {
  for (let i = 0; i < 3; i++) {
    if (p[i] < min[i]) min[i] = p[i];
    if (p[i] > max[i]) max[i] = p[i];
  }
}
console.log('Local bounding box without rail:');
console.log('min:', min.map(v => v.toFixed(3)));
console.log('max:', max.map(v => v.toFixed(3)));
const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
console.log('size:', size.map(v => v.toFixed(3)));

// Check height profile along X (sample in buckets)
const N = 10;
const buckets = new Array(N).fill(null).map(() => ({ minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, count: 0 }));
for (const p of points) {
  const b = Math.min(N - 1, Math.max(0, Math.floor(((p[0] - min[0]) / size[0]) * N)));
  const bucket = buckets[b];
  bucket.count++;
  if (p[0] < bucket.minX) bucket.minX = p[0];
  if (p[0] > bucket.maxX) bucket.maxX = p[0];
  if (p[1] < bucket.minY) bucket.minY = p[1];
  if (p[1] > bucket.maxY) bucket.maxY = p[1];
}

console.log('\nHeight profile along local X (bucketed):');
for (let i = 0; i < N; i++) {
  const b = buckets[i];
  console.log(`Bucket ${i} [x: ${b.minX.toFixed(1)}..${b.maxX.toFixed(1)}]: Y range [${b.minY.toFixed(1)}..${b.maxY.toFixed(1)}]`);
}

const bucketsZ = new Array(N).fill(null).map(() => ({ minZ: Infinity, maxZ: -Infinity, minY: Infinity, maxY: -Infinity, count: 0 }));
for (const p of points) {
  const b = Math.min(N - 1, Math.max(0, Math.floor(((p[2] - min[2]) / size[2]) * N)));
  const bucket = bucketsZ[b];
  bucket.count++;
  if (p[2] < bucket.minZ) bucket.minZ = p[2];
  if (p[2] > bucket.maxZ) bucket.maxZ = p[2];
  if (p[1] < bucket.minY) bucket.minY = p[1];
  if (p[1] > bucket.maxY) bucket.maxY = p[1];
}

points.sort((a, b) => b[1] - a[1]);
console.log('\nTop 5 vertices by Y:');
for (let i = 0; i < 5; i++) console.log(`  [${points[i].map(v => v.toFixed(3)).join(', ')}]`);
console.log('\nBottom 5 vertices by Y:');
for (let i = points.length - 5; i < points.length; i++) console.log(`  [${points[i].map(v => v.toFixed(3)).join(', ')}]`);
