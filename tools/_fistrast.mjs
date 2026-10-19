/**
 * Throwaway: software-rasterise fist-left.glb from several directions so the scan's shape can actually
 * be *looked at* before it is pinned into the viewmodel.
 *
 * There is no headless WebGL in this tree (three ships SVG/CSS renderers only), and every question
 * that matters here is a picture question: which end is the fist, where the thumb sits (left hand or
 * right), which way the forearm recedes, how wide the knuckle span is in the file's own units. So an
 * orthographic rasteriser: project every triangle onto an axis basis, z-buffer it, flat-shade from
 * the scan's own NORMAL attribute (double-sided, matching the material), and write PNGs via sharp.
 *
 *   node tools/_fistrast.mjs public/assets/models/fist-left.glb out-prefix
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';

const file = process.argv[2] ?? 'public/assets/models/fist-left.glb';
const prefix = process.argv[3] ?? 'fist';
await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(file);
const root = doc.getRoot();

// World-space triangles: [ax,ay,az, bx,by,bz, cx,cy,cz, nx,ny,nz] — normal = mean of the scan's own
// vertex normals through the node's linear part (uniform scale, no rotation in this file's nodes).
const tris = [];
const p = [0, 0, 0];
const n = [0, 0, 0];
const scene = root.listScenes()[0];
const walk = (node) => {
  const mesh = node.getMesh();
  if (mesh) {
    const m = node.getWorldMatrix();
    // Uniform scale per node in this file, so the normal matrix is the rotation part alone
    // (identity) — vertex normals can be used as-is after normalising.
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const nor = prim.getAttribute('NORMAL');
      const idx = prim.getIndices();
      if (!pos) continue;
      const count = idx ? idx.getCount() : pos.getCount();
      const vert = (i) => {
        pos.getElement(i, p);
        return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
      };
      const norm = (i) => {
        nor.getElement(i, n);
        const l = Math.hypot(...n) || 1;
        return [n[0] / l, n[1] / l, n[2] / l];
      };
      for (let t = 0; t + 2 < count; t += 3) {
        const a = idx ? idx.getScalar(t) : t;
        const b = idx ? idx.getScalar(t + 1) : t + 1;
        const c = idx ? idx.getScalar(t + 2) : t + 2;
        const va = vert(a), vb = vert(b), vc = vert(c);
        const na = norm(a), nb = norm(b), nc = norm(c);
        tris.push([...va, ...vb, ...vc,
          na[0] + nb[0] + nc[0], na[1] + nb[1] + nc[1], na[2] + nb[2] + nc[2]]);
      }
    }
  }
  for (const child of node.listChildren()) walk(child);
};
for (const node of scene.listChildren()) walk(node);

// Scene-space bounds (the loaded root's own frame — the same frame HeldLantern will pin in).
const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
for (const t of tris) for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) {
  const c = t[v * 3 + k];
  mn[k] = Math.min(mn[k], c); mx[k] = Math.max(mx[k], c);
}
console.log('tris', tris.length, 'box', mn.map((v) => v.toFixed(1)), '->', mx.map((v) => v.toFixed(1)));

const W = 560, H = 560;
/** Orthographic render along basis {right, up, toward-camera}, written to <prefix>_<name>.png. */
async function render(name, right, up, toward) {
  const cx = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
  // span on screen axes
  let wLo = Infinity, wHi = -Infinity, hLo = Infinity, hHi = -Infinity, dLo = Infinity, dHi = -Infinity;
  for (const t of tris) for (let v = 0; v < 3; v++) {
    const q = [t[v * 3], t[v * 3 + 1], t[v * 3 + 2]];
    const sx = (q[0] - cx[0]) * right[0] + (q[1] - cx[1]) * right[1] + (q[2] - cx[2]) * right[2];
    const sy = (q[0] - cx[0]) * up[0] + (q[1] - cx[1]) * up[1] + (q[2] - cx[2]) * up[2];
    const sd = (q[0] - cx[0]) * toward[0] + (q[1] - cx[1]) * toward[1] + (q[2] - cx[2]) * toward[2];
    wLo = Math.min(wLo, sx); wHi = Math.max(wHi, sx);
    hLo = Math.min(hLo, sy); hHi = Math.max(hHi, sy);
    dLo = Math.min(dLo, sd); dHi = Math.max(dHi, sd);
  }
  const spanW = Math.max(wHi - wLo, 1e-6), spanH = Math.max(hHi - hLo, 1e-6);
  const scale = Math.min((W - 8) / spanW, (H - 8) / spanH);
  const px = (sx) => Math.round((sx - (wLo + wHi) / 2) * scale + W / 2);
  const py = (sy) => Math.round(H / 2 - (sy - (hLo + hHi) / 2) * scale);
  const pd = (sd) => (sd - dLo) / (dHi - dLo || 1); // 0 far, 1 near

  const zbuf = new Float32Array(W * H).fill(-1);
  const img = Buffer.alloc(W * H * 4);
  // Headlight-plus-offset so folds have form without any winding assumption: abs() because the
  // material is doubleSided and a scan shell faces both ways.
  const L = [(toward[0] * 2 + right[0] * -0.5 + up[0] * 0.8), (toward[1] * 2 + right[1] * -0.5 + up[1] * 0.8), (toward[2] * 2 + right[2] * -0.5 + up[2] * 0.8)];
  const lLen = Math.hypot(...L);
  L[0] /= lLen; L[1] /= lLen; L[2] /= lLen;

  const proj = new Float32Array(9); // 3 verts × (sx, sy, depth)
  for (const t of tris) {
    let offW = 0, offH = 0, offD = 0;
    for (let v = 0; v < 3; v++) {
      const q = [t[v * 3] - cx[0], t[v * 3 + 1] - cx[1], t[v * 3 + 2] - cx[2]];
      const sx = q[0] * right[0] + q[1] * right[1] + q[2] * right[2];
      const sy = q[0] * up[0] + q[1] * up[1] + q[2] * up[2];
      const sd = q[0] * toward[0] + q[1] * toward[1] + q[2] * toward[2];
      proj[v * 3] = (sx - (wLo + wHi) / 2) * scale + W / 2;
      proj[v * 3 + 1] = H / 2 - (sy - (hLo + hHi) / 2) * scale;
      proj[v * 3 + 2] = pd(sd);
      offW += sx; offH += sy; offD += sd;
    }
    const nx = t[9], ny = t[10], nz = t[11];
    const nl = Math.hypot(nx, ny, nz) || 1;
    const shade = Math.abs((nx / nl) * L[0] + (ny / nl) * L[1] + (nz / nl) * L[2]);
    const lit = 0.18 + 0.82 * shade;
    const r = Math.min(255, Math.round(lit * 232));
    const g = Math.min(255, Math.round(lit * 196));
    const b = Math.min(255, Math.round(lit * 172));
    // bbox over the projected triangle
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let v = 0; v < 3; v++) {
      x0 = Math.min(x0, proj[v * 3]); x1 = Math.max(x1, proj[v * 3]);
      y0 = Math.min(y0, proj[v * 3 + 1]); y1 = Math.max(y1, proj[v * 3 + 1]);
    }
    x0 = Math.max(0, Math.floor(x0)); x1 = Math.min(W - 1, Math.ceil(x1));
    y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(H - 1, Math.ceil(y1));
    if (x1 < x0 || y1 < y0) continue;
    const area = (proj[3] - proj[0]) * (proj[7] - proj[1]) - (proj[6] - proj[0]) * (proj[4] - proj[1]);
    if (Math.abs(area) < 1e-9) continue;
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const w1 = ((xx - proj[0]) * (proj[7] - proj[1]) - (yy - proj[1]) * (proj[6] - proj[0])) / area;
        const w2 = ((yy - proj[1]) * (proj[3] - proj[0]) - (xx - proj[0]) * (proj[4] - proj[1])) / area;
        const w0 = 1 - w1 - w2;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const d = w0 * proj[2] + w1 * proj[5] + w2 * proj[8];
        const o = yy * W + xx;
        if (d <= zbuf[o]) continue;
        zbuf[o] = d;
        const base = o * 4;
        img[base] = r; img[base + 1] = g; img[base + 2] = b; img[base + 3] = 255;
      }
    }
  }
  const out = `${prefix}_${name}.png`;
  await sharp(img, { raw: { width: W, height: H, channels: 4 } }).png().toFile(out);
  console.log(`${out}: screen ${spanW.toFixed(1)} x ${spanH.toFixed(1)} units, depth ${(dHi - dLo).toFixed(1)}`);
}

const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const nX = [-1, 0, 0], nY = [0, -1, 0], nZ = [0, 0, -1];

// Each view: camera sits on the `toward` axis looking at the object centre. `right` and `up` are the
// screen axes; `up` is the world axis that keeps the picture natural (y up wherever possible).
await render('look_px', nZ, Y, X);   // camera at +x looking -x: right is -z, up +y
await render('look_nx', Z, Y, nX);   // camera at -x: right +z, up +y
await render('look_pz', X, Y, Z);    // camera at +z: right +x, up +y
await render('look_nz', nX, Y, nZ);  // camera at -z: right -x, up +y
await render('look_py', X, Z, Y);    // camera above: right +x, up +z
await render('look_ny', X, nZ, nY); // camera below: right +x, up -z
