/**
 * Where a rig's joints and its skinned vertices actually end up, in scene space, in its stored rest
 * pose. `glb-nodes.mjs` prints the node tree, but a joint's local translation says nothing about where
 * it lands once the chain above it is composed — and the POSITION accessor's min/max is the *bind*
 * pose, which is not what gets drawn. Both matter for hanging a viewmodel off a hand: the grip has to
 * sit where the fingers are, and the fit has to be computed from the box the player will see.
 *
 * Run it on the source GLB, not the shipped one: the pipeline writes EXT_meshopt_compression and this
 * reads accessors directly.
 *
 *   node tools/glb-pose.mjs "glb files/arms_throwing.glb" [jointNameSubstring ...]
 */
import { readFileSync } from 'node:fs';

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

function parseGlb(buf) {
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a GLB');
  let json = null;
  let bin = null;
  let p = 12;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32LE(p);
    const type = buf.readUInt32LE(p + 4);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (type === CHUNK_JSON) json = JSON.parse(body.toString('utf8'));
    if (type === CHUNK_BIN) bin = body;
    p += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error('no JSON chunk');
  return { json, bin };
}

const COMPS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const READERS = {
  5120: [1, (b, o) => b.readInt8(o)],
  5121: [1, (b, o) => b.readUInt8(o)],
  5122: [2, (b, o) => b.readInt16LE(o)],
  5123: [2, (b, o) => b.readUInt16LE(o)],
  5125: [4, (b, o) => b.readUInt32LE(o)],
  5126: [4, (b, o) => b.readFloatLE(o)],
};

/** Read accessor `i` as a flat array of numbers, honouring byteStride. Sparse is not supported. */
function accessor(j, bin, i) {
  const a = j.accessors[i];
  if (a.sparse) throw new Error('sparse accessor not supported');
  const n = COMPS[a.type];
  const [sz, read] = READERS[a.componentType];
  const out = new Float64Array(a.count * n);
  if (a.bufferView === undefined) return out; // all zeros, per spec
  const bv = j.bufferViews[a.bufferView];
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const stride = bv.byteStride ?? n * sz;
  for (let e = 0; e < a.count; e++) {
    for (let c = 0; c < n; c++) out[e * n + c] = read(bin, base + e * stride + c * sz);
  }
  return out;
}

// --- 4x4 column-major, glTF order ---
const mIdent = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mMul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}
function mFromTrs(t, r, s) {
  const [x, y, z, w] = r ?? [0, 0, 0, 1];
  const [sx, sy, sz] = s ?? [1, 1, 1];
  const [tx, ty, tz] = t ?? [0, 0, 0];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
const mPoint = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

const file = process.argv[2];
const args = process.argv.slice(3);
/** Print a vertical silhouette as well — the only cheap way to see where a hanging model's handle ends. */
const PROFILE = args.includes('--profile');
const want = args.filter((a) => !a.startsWith('--'));
const { json: j, bin } = parseGlb(readFileSync(file));

// World matrix per node, composing down every scene root.
const world = new Array(j.nodes.length).fill(null);
const walk = (i, parent) => {
  const n = j.nodes[i];
  const local = n.matrix ?? mFromTrs(n.translation, n.rotation, n.scale);
  world[i] = mMul(parent, local);
  for (const c of n.children ?? []) walk(c, world[i]);
};
for (const s of j.scenes ?? []) for (const r of s.nodes ?? []) walk(r, mIdent());

const f3 = (p) => `[${p.map((v) => +v.toFixed(3)).join(', ')}]`;

console.log(`=== ${file} ===`);

// Every skinned primitive, posed.
for (const [ni, n] of j.nodes.entries()) {
  if (n.mesh === undefined) continue;
  const mesh = j.meshes[n.mesh];
  const skin = n.skin !== undefined ? j.skins[n.skin] : null;
  const ibm = skin?.inverseBindMatrices !== undefined ? accessor(j, bin, skin.inverseBindMatrices) : null;

  // glTF: skinning is in the *skin's* space, and the mesh node's own transform is ignored for skinned
  // meshes (it is defined to be the identity in practice); joint matrices already carry the chain.
  const jointMat = skin
    ? skin.joints.map((jn, k) => {
        const inv = ibm ? Array.from(ibm.slice(k * 16, k * 16 + 16)) : mIdent();
        return mMul(world[jn], inv);
      })
    : null;

  for (const [pi, prim] of mesh.primitives.entries()) {
    const pos = accessor(j, bin, prim.attributes.POSITION);
    const count = pos.length / 3;
    const bindBox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    const posedBox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    const grow = (bx, p) => {
      for (let c = 0; c < 3; c++) {
        if (p[c] < bx.min[c]) bx.min[c] = p[c];
        if (p[c] > bx.max[c]) bx.max[c] = p[c];
      }
    };
    const jn = prim.attributes.JOINTS_0 !== undefined ? accessor(j, bin, prim.attributes.JOINTS_0) : null;
    const wt = prim.attributes.WEIGHTS_0 !== undefined ? accessor(j, bin, prim.attributes.WEIGHTS_0) : null;
    /** Sum of weights and weighted centroid per joint — where each bone's flesh actually is. */
    const perJoint = skin ? skin.joints.map(() => ({ w: 0, c: [0, 0, 0] })) : [];
    const pts = PROFILE ? [] : null;

    for (let v = 0; v < count; v++) {
      const p = [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
      grow(bindBox, mPoint(world[ni], p));
      if (!jointMat || !jn || !wt) {
        const q = mPoint(world[ni], p);
        grow(posedBox, q);
        pts?.push(q);
        continue;
      }
      const acc = [0, 0, 0];
      for (let k = 0; k < 4; k++) {
        const w = wt[v * 4 + k];
        if (w === 0) continue;
        const b = jn[v * 4 + k];
        const q = mPoint(jointMat[b], p);
        for (let c = 0; c < 3; c++) acc[c] += q[c] * w;
      }
      grow(posedBox, acc);
      pts?.push(acc);
      for (let k = 0; k < 4; k++) {
        const w = wt[v * 4 + k];
        if (w === 0) continue;
        const e = perJoint[jn[v * 4 + k]];
        e.w += w;
        for (let c = 0; c < 3; c++) e.c[c] += acc[c] * w;
      }
    }

    const sz = (bx) => bx.max.map((v, c) => v - bx.min[c]);
    console.log(
      `\nnode #${ni} ${n.name ?? ''} mesh ${n.mesh}/${mesh.name ?? ''} prim ${pi} verts=${count} skin=${n.skin ?? '-'}`,
    );
    console.log(`  bind  min=${f3(bindBox.min)} max=${f3(bindBox.max)} size=${f3(sz(bindBox))}`);
    console.log(`  posed min=${f3(posedBox.min)} max=${f3(posedBox.max)} size=${f3(sz(posedBox))}`);
    const longest = Math.max(...sz(posedBox));
    console.log(`  posed longest axis = ${longest.toFixed(3)} (${['x', 'y', 'z'][sz(posedBox).indexOf(longest)]})`);

    if (pts) {
      // 28 slabs from the top down, each showing the slab's own x-extent centred on the box centre —
      // i.e. the silhouette. A hanging model's handle shows up as the narrow rows at the top.
      const ROWS = 28;
      const COLS = 56;
      const y0 = posedBox.min[1];
      const h = posedBox.max[1] - y0 || 1;
      const halfX = Math.max(Math.abs(posedBox.min[0]), Math.abs(posedBox.max[0])) || 1;
      const slabs = Array.from({ length: ROWS }, () => ({ n: 0, lo: Infinity, hi: -Infinity }));
      for (const q of pts) {
        const s = Math.min(ROWS - 1, Math.floor(((q[1] - y0) / h) * ROWS));
        const t = slabs[s];
        t.n++;
        if (q[0] < t.lo) t.lo = q[0];
        if (q[0] > t.hi) t.hi = q[0];
      }
      console.log('  silhouette (x-extent per y slab, top row first):');
      for (let s = ROWS - 1; s >= 0; s--) {
        const t = slabs[s];
        const yMid = y0 + ((s + 0.5) / ROWS) * h;
        const cell = (x) => Math.round(((x / halfX) * 0.5 + 0.5) * (COLS - 1));
        const bar = Array(COLS).fill(' ');
        if (t.n > 0) for (let c = cell(t.lo); c <= cell(t.hi); c++) bar[c] = '#';
        console.log(
          `    y=${yMid.toFixed(3).padStart(8)} n=${String(t.n).padStart(5)} |${bar.join('')}|` +
            (t.n ? ` x ${t.lo.toFixed(3)}..${t.hi.toFixed(3)}` : ''),
        );
      }
    }

    if (skin) {
      const rows = skin.joints
        .map((node, k) => ({
          k,
          name: j.nodes[node].name ?? `#${node}`,
          origin: mPoint(world[node], [0, 0, 0]),
          weight: +perJoint[k].w.toFixed(1),
          centroid: perJoint[k].w > 0 ? perJoint[k].c.map((v) => v / perJoint[k].w) : null,
        }))
        .filter((r) => want.length === 0 || want.some((s) => r.name.toLowerCase().includes(s.toLowerCase())));
      console.log(`  joints (${rows.length}${want.length ? ' matching' : ''}):`);
      for (const r of rows) {
        console.log(
          `    ${String(r.k).padStart(2)} ${r.name.padEnd(16)} origin=${f3(r.origin)}` +
            ` w=${String(r.weight).padStart(7)} centroid=${r.centroid ? f3(r.centroid) : '-'}`,
        );
      }
    }
  }
}
