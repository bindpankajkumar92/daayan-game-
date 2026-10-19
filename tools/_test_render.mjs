import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';

await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

const fistDoc = await io.read('public/assets/models/fist-left.glb');
const fistScene = fistDoc.getRoot().listScenes()[0];

const lanDoc = await io.read('public/assets/models/lantern.glb');
const lanScene = lanDoc.getRoot().listScenes()[0];

function extractTris(scene) {
  const tris = [];
  const p = [0, 0, 0];
  const n = [0, 0, 0];
  const walk = (node) => {
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
          const va = vert(a), vb = vert(b), vc = vert(c);
          const na = norm(a), nb = norm(b), nc = norm(c);
          tris.push([
            ...va, ...vb, ...vc,
            na[0] + nb[0] + nc[0], na[1] + nb[1] + nc[1], na[2] + nb[2] + nc[2],
          ]);
        }
      }
    }
    for (const child of node.listChildren()) walk(child);
  };
  for (const child of scene.listChildren()) walk(child);
  return tris;
}

const fistTris = extractTris(fistScene);
const lanTris = extractTris(lanScene);

console.log('fistTris:', fistTris.length, 'lanTris:', lanTris.length);

// Let's inspect raw lantern bounds:
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
const lTallest = Math.max(...lDims);
const lScale = LANTERN_SIZE / lTallest;
const lCenter = [(lmn[0] + lmx[0]) / 2, (lmn[1] + lmx[1]) / 2, (lmn[2] + lmx[2]) / 2];

// Transform lantern into hold space:
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

// Now we need to orient and position fistTris so:
// 1) The grip is at (0, 0, 0) of hold space.
// 2) The hand holds the lantern handle.
// 3) The forearm points down-left toward the bottom-left camera edge.
//
// Let's test a function to transform fistTris into hold space and rasterize perspective view!

const W = 800, H = 450; // 16:9 view
const fovY = 70 * Math.PI / 180;
const tanFov2 = Math.tan(fovY / 2);
const aspect = W / H;

// Render perspective camera view
async function renderCamView(outFile, fistInHold, holdPos) {
  // holdPos: [x, y, z] in camera space
  const allTris = [];

  // Add lantern in camera space
  for (const t of holdLanTris) {
    allTris.push({
      pts: [
        [t[0] + holdPos[0], t[1] + holdPos[1], t[2] + holdPos[2]],
        [t[3] + holdPos[0], t[4] + holdPos[1], t[5] + holdPos[2]],
        [t[6] + holdPos[0], t[7] + holdPos[1], t[8] + holdPos[2]],
      ],
      nor: [t[9], t[10], t[11]],
      color: [200, 160, 100], // lantern brass/metal
    });
  }

  // Add fist in camera space
  for (const t of fistInHold) {
    allTris.push({
      pts: [
        [t[0] + holdPos[0], t[1] + holdPos[1], t[2] + holdPos[2]],
        [t[3] + holdPos[0], t[4] + holdPos[1], t[5] + holdPos[2]],
        [t[6] + holdPos[0], t[7] + holdPos[1], t[8] + holdPos[2]],
      ],
      nor: [t[9], t[10], t[11]],
      color: [225, 185, 160], // skin
    });
  }

  const zbuf = new Float32Array(W * H).fill(-Infinity);
  const img = Buffer.alloc(W * H * 4);
  // Background: dark room
  for (let i = 0; i < W * H; i++) {
    img[i * 4] = 15;
    img[i * 4 + 1] = 12;
    img[i * 4 + 2] = 18;
    img[i * 4 + 3] = 255;
  }

  const lightPos = [holdPos[0] + 0.05, holdPos[1] - 0.08, holdPos[2] + 0.05];

  for (const tri of allTris) {
    // Project points: camera looks down -Z
    // Screen coords:
    // x_ndc = x / (-z * tanFov2 * aspect)
    // y_ndc = y / (-z * tanFov2)
    const proj = [];
    let behind = false;
    for (let v = 0; v < 3; v++) {
      const p = tri.pts[v];
      if (p[2] >= -0.05) { behind = true; break; } // clip near plane
      const depth = -p[2];
      const sx = (p[0] / (depth * tanFov2 * aspect)) * (W / 2) + (W / 2);
      const sy = (-p[1] / (depth * tanFov2)) * (H / 2) + (H / 2);
      proj.push([sx, sy, 1 / depth, p[0], p[1], p[2]]);
    }
    if (behind) continue;

    // Triangle raster
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

    // Normal & light
    const nl = Math.hypot(...tri.nor) || 1;
    const nx = tri.nor[0] / nl, ny = tri.nor[1] / nl, nz = tri.nor[2] / nl;
    const mid = [
      (tri.pts[0][0] + tri.pts[1][0] + tri.pts[2][0]) / 3,
      (tri.pts[0][1] + tri.pts[1][1] + tri.pts[2][1]) / 3,
      (tri.pts[0][2] + tri.pts[1][2] + tri.pts[2][2]) / 3,
    ];
    const lx = lightPos[0] - mid[0], ly = lightPos[1] - mid[1], lz = lightPos[2] - mid[2];
    const ll = Math.hypot(lx, ly, lz) || 1;
    const dot = Math.abs(nx * (lx / ll) + ny * (ly / ll) + nz * (lz / ll));
    const lit = 0.25 + 0.75 * dot;

    const r = Math.min(255, Math.round(tri.color[0] * lit));
    const g = Math.min(255, Math.round(tri.color[1] * lit));
    const b = Math.min(255, Math.round(tri.color[2] * lit));

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

  await sharp(img, { raw: { width: W, height: H, channels: 4 } }).png().toFile(outFile);
  console.log('Saved preview:', outFile);
}

export { fistTris, renderCamView };
