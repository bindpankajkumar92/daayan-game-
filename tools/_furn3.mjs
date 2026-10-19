/**
 * _furn3.mjs — textured software previews of the nine new furniture GLBs, at game scale.
 *
 * _furn1.mjs prints node boxes and _furn2.mjs composes world transforms, but neither says what
 * these assets actually *look* like, and every distribution decision downstream (which room wants
 * a fireplace, whether the cafe set reads as garden furniture, whether key.glb at 0.2 m is a key
 * or a skeleton key) is a look judgement rather than a number. This walks each scene with full
 * node transforms and per-triangle UV sampling into the file's own base-colour maps — a plain
 * rasterizer like _test_render.mjs's, plus texture lookup, plus three cameras per file (front,
 * three-quarter, top) so nothing is judged from one side only.
 *
 * Output: tools/_furn/<slug>-{0,1,2}.png at 640x480. Nothing written into the game.
 */
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';

import { existsSync } from 'node:fs';
const resolveGlb = (f) => (existsSync(join('public/assets/models', f)) ? join('public/assets/models', f) : join('glb files', f));
const OUT = 'tools/_furn';
const FILES = process.argv.slice(2).length > 0 ? process.argv.slice(2) : [
  'furniture_chateau_de_la_foret.glb',
  'furniture_for_bedroom.glb',
  'furniture_pack_for_summer_caffe_free.glb',
  'key.glb',
  'low_poly_abandoned_brick_room.glb',
  'low_poly_animated_furniture_-_game_ready.glb',
  'low_poly_kitchen_furniture_-_game_ready.glb',
  'mechanical_table.glb',
  'antique_table.glb',
];

await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

// --- tiny texture cache: base-color map per material, decoded through sharp to raw RGBA -------------
async function decodeTexture(tex) {
  const bytes = tex.getImage();
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const img = tex.getImage().mimeType?.includes('png')
    ? await sharp(raw).raw().toBuffer({ resolveWithObject: true })
    : await sharp(raw).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: img.data, width: img.info.width, height: img.info.height, channels: img.info.channels };
}

/** sRGB byte -> linear -> back is overkill for a preview: sample bytes, tint by factor. */
function sample(tex, u, v) {
  if (!tex) return [200, 200, 200];
  let uu = u - Math.floor(u);
  let vv = v - Math.floor(v);
  const x = Math.min(tex.width - 1, Math.max(0, Math.floor(uu * tex.width)));
  const y = Math.min(tex.height - 1, Math.max(0, Math.floor((1 - vv) * tex.height)));
  const o = (y * tex.width + x) * tex.channels;
  return [tex.data[o], tex.data[o + 1], tex.data[o + 2]];
}

mkdirSync(OUT, { recursive: true });

const qMul = (a, b) => [
  a[0] * b[3] + a[3] * b[0] + a[1] * b[2] - a[2] * b[1],
  a[1] * b[3] + a[3] * b[1] + a[2] * b[0] - a[0] * b[2],
  a[2] * b[3] + a[3] * b[2] + a[0] * b[1] - a[1] * b[0],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qMulV = (q, v) => {
  const [x, y, z] = v;
  const [qx, qy, qz, qw] = q;
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
};
const compose = (pt, pr, ps, t, r, s) => ({
  p: [
    pt[0] + ps[0] * qMulV(pr, t)[0],
    pt[1] + ps[1] * qMulV(pr, t)[1],
    pt[2] + ps[2] * qMulV(pr, t)[2],
  ],
  q: qMul(pr, r),
  s: [ps[0] * s[0], ps[1] * s[1], ps[2] * s[2]],
});

for (const name of FILES) {
  const doc = await io.read(resolveGlb(name));
  const root = doc.getRoot();

  // material -> decoded map
  const matTex = new Map();
  for (const m of root.listMaterials()) {
    const tex = m.getBaseColorTexture();
    if (tex) {
      try {
        matTex.set(m, await decodeTexture(tex));
      } catch (e) {
        console.warn(`  (map decode failed for ${m.getName()}: ${e.message})`);
      }
    }
  }

  // gather triangles in world space, with UVs and a material pointer
  const tris = [];
  const walk = (node, W, depth) => {
    const t = [...node.getTranslation()];
    const r = [...node.getRotation()];
    const s = [...node.getScale()];
    const Wn = compose(W.p, W.q, W.s, t, r, s);
    const mesh = node.getMesh();
    if (mesh) {
      const mat = mesh.listPrimitives()[0]?.getMaterial() ?? null;
      const tex = mat ? matTex.get(mat) : null;
      const factor = mat ? [...mat.getBaseColorFactor()] : [1, 1, 1, 1];
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMode() !== 4) continue;
        const pos = prim.getAttribute('POSITION');
        const uv = prim.getAttribute('TEXCOORD_0');
        const idx = prim.getIndices();
        if (!pos) continue;
        const pTex = prim.getMaterial() ? matTex.get(prim.getMaterial()) : tex;
        const f = prim.getMaterial() ? [...prim.getMaterial().getBaseColorFactor()] : factor;
        const count = idx ? idx.getCount() : pos.getCount();
        const P = [0, 0, 0], U = [0, 0];
        const vert = (i) => {
          pos.getElement(i, P);
          const sv = [Wn.s[0] * P[0], Wn.s[1] * P[1], Wn.s[2] * P[2]];
          const wv = qMulV(Wn.q, sv);
          return [Wn.p[0] + wv[0], Wn.p[1] + wv[1], Wn.p[2] + wv[2]];
        };
        for (let i = 0; i + 2 < count; i += 3) {
          const a = idx ? idx.getScalar(i) : i;
          const b = idx ? idx.getScalar(i + 1) : i + 1;
          const c = idx ? idx.getScalar(i + 2) : i + 2;
          const va = vert(a), vb = vert(b), vc = vert(c);
          const uvA = uv ? (uv.getElement(a, U), [...U]) : null;
          const uvB = uv ? (uv.getElement(b, U), [...U]) : null;
          const uvC = uv ? (uv.getElement(c, U), [...U]) : null;
          tris.push({ v: [va, vb, vc], uv: [uvA, uvB, uvC], tex: pTex, f });
        }
      }
    }
    for (const ch of node.listChildren()) walk(ch, Wn, depth + 1);
  };
  for (const scene of root.listScenes()) {
    for (const c of scene.listChildren()) walk(c, { p: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] }, 0);
  }

  // world bbox
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (const v of t.v) for (let k = 0; k < 3; k++) {
    if (v[k] < mn[k]) mn[k] = v[k];
    if (v[k] > mx[k]) mx[k] = v[k];
  }
  const size = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
  const centre = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
  console.log(`\n${name}: ${tris.length} tris, world box ${size.map(x => x.toFixed(2)).join(' x ')}`);

  // Three cameras: 3/4 from +x+z, front from +z, and an elevated 3/4 from -x+z.
  const CAMS = [
    { az: 40 * Math.PI / 180, el: 18 * Math.PI / 180 },
    { az: 0, el: 6 * Math.PI / 180 },
    { az: 130 * Math.PI / 180, el: 30 * Math.PI / 180 },
  ];
  const W = 640, H = 480;

  for (let ci = 0; ci < CAMS.length; ci++) {
    const { az, el } = CAMS[ci];
    // camera position at distance d, looking at centre
    const radius = Math.max(size[0], size[1], size[2]) * 1.9 + 0.01;
    const cp = [
      centre[0] + radius * Math.cos(el) * Math.sin(az),
      centre[1] + radius * Math.sin(el),
      centre[2] + radius * Math.cos(el) * Math.cos(az),
    ];
    // basis: forward to centre, up +y-ish
    const fwd = [centre[0] - cp[0], centre[1] - cp[1], centre[2] - cp[2]];
    const fl = Math.hypot(...fwd) || 1;
    fwd[0] /= fl; fwd[1] /= fl; fwd[2] /= fl;
    let up = [0, 1, 0];
    // right = fwd x up (then re-orthogonalise)
    let right = [
      fwd[2] * up[0] - fwd[0] * up[2],
      fwd[0] * up[1] - fwd[1] * up[0],
      fwd[1] * up[2] - fwd[2] * up[1],
    ];
    // cross(fwd, up) = (fwd.y*up.z - fwd.z*up.y, fwd.z*up.x - fwd.x*up.z, fwd.x*up.y - fwd.y*up.x)
    right = [
      fwd[1] * up[2] - fwd[2] * up[1],
      fwd[2] * up[0] - fwd[0] * up[2],
      fwd[0] * up[1] - fwd[1] * up[0],
    ];
    const rl = Math.hypot(...right) || 1;
    right = right.map(x => x / rl);
    up = [
      right[1] * fwd[2] - right[2] * fwd[1],
      right[2] * fwd[0] - right[0] * fwd[2],
      right[0] * fwd[1] - right[1] * fwd[0],
    ];
    // to-camera space
    const toCam = (p) => [
      (p[0] - cp[0]) * right[0] + (p[1] - cp[1]) * right[1] + (p[2] - cp[2]) * right[2],
      (p[0] - cp[0]) * up[0] + (p[1] - cp[1]) * up[1] + (p[2] - cp[2]) * up[2],
      -(p[0] - cp[0]) * fwd[0] - (p[1] - cp[1]) * fwd[1] - (p[2] - cp[2]) * fwd[2],
    ];

    const tanF = Math.tan(30 * Math.PI / 180);
    const aspect = W / H;
    const zbuf = new Float32Array(W * H).fill(-Infinity);
    const img = Buffer.alloc(W * H * 4, 0);
    for (let i = 0; i < W * H; i++) { img[i * 4] = 24; img[i * 4 + 1] = 20; img[i * 4 + 2] = 28; img[i * 4 + 3] = 255; }
    const lightPos = [cp[0] + 0.3 * radius, cp[1] + 0.5 * radius, cp[2] + 0.3 * radius];

    for (const tri of tris) {
      const cam = tri.v.map(toCam);
      const behind = cam.some(p => p[2] >= -0.001);
      if (behind) continue;
      const proj = cam.map((p) => {
        const depth = -p[2];
        return [
          (p[0] / (depth * tanF * aspect)) * (W / 2) + W / 2,
          (-p[1] / (depth * tanF)) * (H / 2) + H / 2,
          1 / depth,
        ];
      });
      let minX = Math.floor(Math.min(proj[0][0], proj[1][0], proj[2][0]));
      let maxX = Math.ceil(Math.max(proj[0][0], proj[1][0], proj[2][0]));
      let minY = Math.floor(Math.min(proj[0][1], proj[1][1], proj[2][1]));
      let maxY = Math.ceil(Math.max(proj[0][1], proj[1][1], proj[2][1]));
      minX = Math.max(0, minX); maxX = Math.min(W - 1, maxX);
      minY = Math.max(0, minY); maxY = Math.min(H - 1, maxY);
      if (maxX < minX || maxY < minY) continue;

      const area = (proj[1][0] - proj[0][0]) * (proj[2][1] - proj[0][1]) -
                   (proj[2][0] - proj[0][0]) * (proj[1][1] - proj[0][1]);
      if (Math.abs(area) < 1e-9) continue;

      // face normal in world space
      const [A, B, C] = tri.v;
      const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
      const e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      let n = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      const nl = Math.hypot(...n) || 1;
      n = n.map(x => x / nl);
      const mid = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3, (A[2] + B[2] + C[2]) / 3];
      const lx = lightPos[0] - mid[0], ly = lightPos[1] - mid[1], lz = lightPos[2] - mid[2];
      const ll = Math.hypot(lx, ly, lz) || 1;
      const dot = Math.abs(n[0] * (lx / ll) + n[1] * (ly / ll) + n[2] * (lz / ll));
      const lit = 0.35 + 0.65 * dot;

      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const w1 = ((x - proj[0][0]) * (proj[2][1] - proj[0][1]) - (y - proj[0][1]) * (proj[2][0] - proj[0][0])) / area;
          const w2 = ((y - proj[0][1]) * (proj[1][0] - proj[0][0]) - (x - proj[0][0]) * (proj[1][1] - proj[0][1])) / area;
          const w0 = 1 - w1 - w2;
          if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
          const idx = y * W + x;
          const invZ = w0 * proj[0][2] + w1 * proj[1][2] + w2 * proj[2][2];
          if (invZ > zbuf[idx]) {
            zbuf[idx] = invZ;
            let rgb;
            if (tri.tex && tri.uv[0] && tri.uv[1] && tri.uv[2]) {
              const u = w0 * tri.uv[0][0] + w1 * tri.uv[1][0] + w2 * tri.uv[2][0];
              const v = w0 * tri.uv[0][1] + w1 * tri.uv[1][1] + w2 * tri.uv[2][1];
              rgb = sample(tri.tex, u, v);
              rgb = [
                rgb[0] * tri.f[0] * lit,
                rgb[1] * tri.f[1] * lit,
                rgb[2] * tri.f[2] * lit,
              ];
            } else {
              rgb = [180 * tri.f[0] * lit, 180 * tri.f[1] * lit, 180 * tri.f[2] * lit];
            }
            const off = idx * 4;
            img[off] = Math.min(255, Math.round(rgb[0]));
            img[off + 1] = Math.min(255, Math.round(rgb[1]));
            img[off + 2] = Math.min(255, Math.round(rgb[2]));
          }
        }
      }
    }
    const slug = name.replace(/\.glb$/, '').replace(/[^a-z0-9]+/gi, '_');
    const outFile = join(OUT, `${slug}-${ci}.png`);
    await sharp(img, { raw: { width: W, height: H, channels: 4 } }).png().toFile(outFile);
    console.log(`  ${outFile}`);
  }
}
console.log('\ndone');
