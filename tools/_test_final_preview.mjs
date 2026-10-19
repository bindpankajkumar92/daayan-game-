import { fistTris, renderCamView } from './_test_render.mjs';
import sharp from 'sharp';

function makeRot(rx, ry, rz) {
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  const m00 = cz * cy;
  const m10 = sz * cy;
  const m20 = -sy;
  const m01 = cz * sy * sx - sz * cx;
  const m11 = sz * sy * sx + cz * cx;
  const m21 = cy * sx;
  const m02 = cz * sy * cx + sz * sx;
  const m12 = sz * sy * cx - cz * sx;
  const m22 = cy * cx;
  return (v) => [
    m00 * v[0] + m01 * v[1] + m02 * v[2],
    m10 * v[0] + m11 * v[1] + m12 * v[2],
    m20 * v[0] + m21 * v[1] + m22 * v[2],
  ];
}

const DEG = Math.PI / 180;
const rot = makeRot(5 * DEG, 72 * DEG, -12 * DEG);
const gripOffset = [-205, 65, 24];
const scale = 0.00095;
const holdPos = [-0.185, -0.065, -0.27];

// Load lantern hold triangles
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

const lanDoc = await io.read('public/assets/models/lantern.glb');
const lanScene = lanDoc.getRoot().listScenes()[0];

const lanTris = [];
const p = [0, 0, 0];
const n = [0, 0, 0];
const walkLan = (node) => {
  const mesh = node.getMesh();
  if (mesh) {
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const nor = prim.getAttribute('NORMAL');
      const idx = prim.getIndices();
      if (!pos) continue;
      const count = idx ? idx.getCount() : pos.getCount();
      const vert = (i) => {
        pos.getElement(i, p);
        return [
          m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
          m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
          m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
        ];
      };
      const norm = (i) => {
        if (!nor) return [0, 1, 0];
        nor.getElement(i, n);
        const l = Math.hypot(...n) || 1;
        return [n[0] / l, n[1] / l, n[2] / l];
      };
      for (let t = 0; t + 2 < count; t += 3) {
        const a = idx ? idx.getScalar(t) : t;
        const b = idx ? idx.getScalar(t + 1) : t + 1;
        const c = idx ? idx.getScalar(t + 2) : t + 2;
        lanTris.push([...vert(a), ...vert(b), ...vert(c), ...norm(a)]);
      }
    }
  }
  for (const child of node.listChildren()) walkLan(child);
};
for (const child of lanScene.listChildren()) walkLan(child);

let lmn = [Infinity, Infinity, Infinity], lmx = [-Infinity, -Infinity, -Infinity];
for (const t of lanTris) {
  for (let v = 0; v < 3; v++) {
    for (let k = 0; k < 3; k++) {
      lmn[k] = Math.min(lmn[k], t[v * 3 + k]);
      lmx[k] = Math.max(lmx[k], t[v * 3 + k]);
    }
  }
}
const lDims = [0, 1, 2].map(k => lmx[k] - lmn[k]);
const LANTERN_SIZE = 0.17;
const PIVOT_FRAC = 0.95;
const lScale = LANTERN_SIZE / Math.max(...lDims);
const lCenter = [(lmn[0] + lmx[0]) / 2, (lmn[1] + lmx[1]) / 2, (lmn[2] + lmx[2]) / 2];

const holdLanTris = lanTris.map(t => {
  const res = new Float64Array(12);
  for (let v = 0; v < 3; v++) {
    res[v * 3] = (t[v * 3] - lCenter[0]) * lScale;
    res[v * 3 + 1] = (t[v * 3 + 1] - lmn[1]) * lScale - lDims[1] * lScale * PIVOT_FRAC;
    res[v * 3 + 2] = (t[v * 3 + 2] - lCenter[2]) * lScale;
  }
  res[9] = t[9]; res[10] = t[10]; res[11] = t[11];
  return res;
});

const fistInHold = fistTris.map(t => {
  const res = new Float64Array(12);
  for (let v = 0; v < 3; v++) {
    const pt = [
      (t[v * 3] - gripOffset[0]) * scale,
      (t[v * 3 + 1] - gripOffset[1]) * scale,
      (t[v * 3 + 2] - gripOffset[2]) * scale,
    ];
    const r = rot(pt);
    res[v * 3] = r[0]; res[v * 3 + 1] = r[1]; res[v * 3 + 2] = r[2];
  }
  const nr = rot([t[9], t[10], t[11]]);
  res[9] = nr[0]; res[10] = nr[1]; res[11] = nr[2];
  return res;
});

// Render with full lighting
const W = 960, H = 540;
const fovY = 70 * Math.PI / 180;
const tanFov2 = Math.tan(fovY / 2);
const aspect = W / H;

const allTris = [];
for (const t of holdLanTris) {
  allTris.push({
    pts: [
      [t[0] + holdPos[0], t[1] + holdPos[1], t[2] + holdPos[2]],
      [t[3] + holdPos[0], t[4] + holdPos[1], t[5] + holdPos[2]],
      [t[6] + holdPos[0], t[7] + holdPos[1], t[8] + holdPos[2]],
    ],
    nor: [t[9], t[10], t[11]],
    isFist: false,
  });
}
for (const t of fistInHold) {
  allTris.push({
    pts: [
      [t[0] + holdPos[0], t[1] + holdPos[1], t[2] + holdPos[2]],
      [t[3] + holdPos[0], t[4] + holdPos[1], t[5] + holdPos[2]],
      [t[6] + holdPos[0], t[7] + holdPos[1], t[8] + holdPos[2]],
    ],
    nor: [t[9], t[10], t[11]],
    isFist: true,
  });
}

// Flame position: LANTERN_SIZE * FLAME.y (-0.088m from holdPos)
const flamePos = [holdPos[0], holdPos[1] - 0.088, holdPos[2]];
const lightPos = [-0.25, -0.15, 0.1]; // PointLight from HouseScene

const zbuf = new Float32Array(W * H).fill(-Infinity);
const img = Buffer.alloc(W * H * 4);

// Background room simulation: dark wooden floor and wall
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const idx = (y * W + x) * 4;
    img[idx] = 12;
    img[idx + 1] = 10;
    img[idx + 2] = 14;
    img[idx + 3] = 255;
  }
}

for (const tri of allTris) {
  const proj = [];
  let behind = false;
  for (let v = 0; v < 3; v++) {
    const pt = tri.pts[v];
    if (pt[2] >= -0.05) { behind = true; break; }
    const depth = -pt[2];
    const sx = (pt[0] / (depth * tanFov2 * aspect)) * (W / 2) + (W / 2);
    const sy = (-pt[1] / (depth * tanFov2)) * (H / 2) + (H / 2);
    proj.push([sx, sy, 1 / depth]);
  }
  if (behind) continue;

  let minX = Math.floor(Math.min(proj[0][0], proj[1][0], proj[2][0]));
  let maxX = Math.ceil(Math.max(proj[0][0], proj[1][0], proj[2][0]));
  let minY = Math.floor(Math.min(proj[0][1], proj[1][1], proj[2][1]));
  let maxY = Math.ceil(Math.max(proj[0][1], proj[1][1], proj[2][1]));
  minX = Math.max(0, minX); maxX = Math.min(W - 1, maxX);
  minY = Math.max(0, minY); maxY = Math.min(H - 1, maxY);
  if (maxX < minX || maxY < minY) continue;

  const area = (proj[1][0] - proj[0][0]) * (proj[2][1] - proj[0][1]) - 
               (proj[2][0] - proj[0][0]) * (proj[1][1] - proj[0][1]);
  if (Math.abs(area) < 1e-6) continue;

  const nl = Math.hypot(...tri.nor) || 1;
  const nx = tri.nor[0] / nl, ny = tri.nor[1] / nl, nz = tri.nor[2] / nl;
  const mid = [
    (tri.pts[0][0] + tri.pts[1][0] + tri.pts[2][0]) / 3,
    (tri.pts[0][1] + tri.pts[1][1] + tri.pts[2][1]) / 3,
    (tri.pts[0][2] + tri.pts[1][2] + tri.pts[2][2]) / 3,
  ];

  // Light from flame/lantern
  const lx = flamePos[0] - mid[0], ly = flamePos[1] - mid[1], lz = flamePos[2] - mid[2];
  const dist = Math.hypot(lx, ly, lz) || 1;
  const lDot = Math.max(0, (nx * lx + ny * ly + nz * lz) / dist);
  const atten = 1 / Math.pow(dist * 4, 0.8);
  const diff = lDot * atten;

  // Ambient term
  const ambient = 0.22;
  const totalLit = ambient + diff * 0.75;

  let r, g, b;
  if (tri.isFist) {
    // Skin: 215, 170, 142
    // Warm flame tint
    r = Math.min(255, Math.round(220 * totalLit * 1.15));
    g = Math.min(255, Math.round(175 * totalLit * 0.98));
    b = Math.min(255, Math.round(145 * totalLit * 0.82));
  } else {
    // Lantern: aged brass/iron
    r = Math.min(255, Math.round(180 * totalLit * 1.2));
    g = Math.min(255, Math.round(150 * totalLit * 1.0));
    b = Math.min(255, Math.round(100 * totalLit * 0.7));
  }

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const w1 = ((x - proj[0][0]) * (proj[2][1] - proj[0][1]) - (y - proj[0][1]) * (proj[2][0] - proj[0][0])) / area;
      const w2 = ((y - proj[0][1]) * (proj[1][0] - proj[0][0]) - (x - proj[0][0]) * (proj[1][1] - proj[0][1])) / area;
      const w0 = 1 - w1 - w2;
      if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
      const invZ = w0 * proj[0][2] + w1 * proj[1][2] + w2 * proj[2][2];
      const idx = y * W + x;
      if (invZ > zbuf[idx]) {
        zbuf[idx] = invZ;
        const off = idx * 4;
        img[off] = r; img[off + 1] = g; img[off + 2] = b; img[off + 3] = 255;
      }
    }
  }
}

// Add simple flame glow in center of lantern
const flameScrX = Math.round((flamePos[0] / (-flamePos[2] * tanFov2 * aspect)) * (W / 2) + (W / 2));
const flameScrY = Math.round((-flamePos[1] / (-flamePos[2] * tanFov2)) * (H / 2) + (H / 2));
const fRad = 35;
for (let fy = flameScrY - fRad; fy <= flameScrY + fRad; fy++) {
  for (let fx = flameScrX - fRad; fx <= flameScrX + fRad; fx++) {
    if (fx < 0 || fx >= W || fy < 0 || fy >= H) continue;
    const d = Math.hypot(fx - flameScrX, fy - flameScrY) / fRad;
    if (d > 1) continue;
    const alpha = (1 - d) * (1 - d) * 0.85;
    const idx = (fy * W + fx) * 4;
    img[idx] = Math.min(255, img[idx] + Math.round(255 * alpha));
    img[idx + 1] = Math.min(255, img[idx + 1] + Math.round(200 * alpha));
    img[idx + 2] = Math.min(255, img[idx + 2] + Math.round(130 * alpha));
  }
}

await sharp(img, { raw: { width: W, height: H, channels: 4 } }).png().toFile('final_left_lantern_preview.png');
console.log('Saved final_left_lantern_preview.png');
