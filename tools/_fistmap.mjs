/**
 * Throwaway: where the fist-left scan's geometry actually is, in file units, so HeldLantern can pin
 * it without bones.
 *
 * The scan is 24 unskinned primitives under one node each, with per-node translation+scale, so the
 * *accessor* min/max printed by glTF tools is the bind box of every mesh in its own local frame and
 * says nothing. This composes each node's chain, transforms every vertex, and slices the cloud on
 * each axis, so the fist end, the wrist, and the forearm can be told apart by density and extent.
 *
 * Reads through gltf-transform (registered with the meshopt decoder) because the shipped file is
 * EXT_meshopt_compressed; the previous revision of this throwaway read the accessors raw and
 * overflowed the buffer.
 *
 *   node tools/_fistmap.mjs public/assets/models/fist-left.glb
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const file = process.argv[2];
if (!file) process.exit(2);
await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(file);
const root = doc.getRoot();

const scene = root.listScenes()[0];
const pts = [];
const p = [0, 0, 0];
const walk = (node) => {
  const mesh = node.getMesh();
  if (mesh) {
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, p);
        pts.push([
          m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
          m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
          m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
        ]);
      }
    }
  }
  for (const child of node.listChildren()) walk(child);
};
for (const n of scene.listChildren()) walk(n);

const mn = [Infinity, Infinity, Infinity];
const mx = [-Infinity, -Infinity, -Infinity];
for (const q of pts) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], q[k]); mx[k] = Math.max(mx[k], q[k]); }
const dim = [0, 1, 2].map((k) => mx[k] - mn[k]);
console.log('verts', pts.length, 'box', mn.map((v) => v.toFixed(2)), '->', mx.map((v) => v.toFixed(2)), 'dims', dim.map((v) => v.toFixed(2)));
const centroid = [0, 0, 0];
for (const q of pts) for (let k = 0; k < 3; k++) centroid[k] += q[k] / pts.length;
console.log('centroid', centroid.map((v) => v.toFixed(2)));

// Slab the cloud along each axis — 24 bins, count
for (const axis of [0, 1, 2]) {
  const bins = 24;
  const counts = new Array(bins).fill(0);
  for (const q of pts) {
    const t = (q[axis] - mn[axis]) / (mx[axis] - mn[axis] || 1);
    counts[Math.min(bins - 1, Math.floor(t * bins))]++;
  }
  const peak = Math.max(...counts);
  const names = ['x', 'y', 'z'];
  const rows = [];
  for (let b = 0; b < bins; b++) {
    const bar = Math.round((counts[b] / peak) * 36);
    rows.push(`  ${names[axis]} ${(mn[axis] + (dim[axis] * b) / bins).toFixed(1).padStart(7)}: ${'#'.repeat(bar)}${' '.repeat(Math.max(0, 36 - bar))} ${counts[b]}`);
  }
  console.log(rows.join('\n'));
}

// PCA: principal axis = forearm direction
const mean = centroid;
const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
for (const q of pts) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += (q[i] - mean[i]) * (q[j] - mean[j]);
for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] /= pts.length;
let v = [1, 0, 0];
for (let it = 0; it < 60; it++) {
  const nv = [
    cov[0][0] * v[0] + cov[0][1] * v[1] + cov[0][2] * v[2],
    cov[1][0] * v[0] + cov[1][1] * v[1] + cov[1][2] * v[2],
    cov[2][0] * v[0] + cov[2][1] * v[1] + cov[2][2] * v[2],
  ];
  const len = Math.hypot(...nv) || 1;
  v = nv.map((c) => c / len);
}
console.log('principal axis (forearm direction):', v.map((c) => c.toFixed(4)));
let lo = Infinity, hi = -Infinity;
for (const q of pts) { const d = q[0] * v[0] + q[1] * v[1] + q[2] * v[2]; lo = Math.min(lo, d); hi = Math.max(hi, d); }
console.log('extent along principal:', lo.toFixed(2), '..', hi.toFixed(2), 'len', (hi - lo).toFixed(2));
// radial extent per band along the principal axis — wrist is the pinch, fist the bulge
const bands = 16;
const rMax = new Array(bands).fill(0);
const yMn = new Array(bands).fill(Infinity);
const yMx = new Array(bands).fill(-Infinity);
const cnt = new Array(bands).fill(0);
for (const q of pts) {
  const d = q[0] * v[0] + q[1] * v[1] + q[2] * v[2];
  const b = Math.min(bands - 1, Math.floor(((d - lo) / (hi - lo)) * bands));
  const perp = [q[0] - d * v[0], q[1] - d * v[1], q[2] - d * v[2]];
  rMax[b] = Math.max(rMax[b], Math.hypot(...perp));
  yMn[b] = Math.min(yMn[b], q[1]);
  yMx[b] = Math.max(yMx[b], q[1]);
  cnt[b]++;
}
for (let b = 0; b < bands; b++) {
  const dLo = lo + ((hi - lo) * b) / bands;
  console.log(`band ${String(b).padStart(2)} d=${dLo.toFixed(1).padStart(7)} rMax=${rMax[b].toFixed(2).padStart(6)} y=${yMn[b] === Infinity ? 0 : yMn[b].toFixed(1)}..${yMx[b] === -Infinity ? 0 : yMx[b].toFixed(1)} n=${cnt[b]}`);
}
