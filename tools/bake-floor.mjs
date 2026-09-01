/**
 * Pass A2 of the model pipeline: bakes a floor asset's top surface into one tiling albedo image.
 *
 *   node tools/bake-floor.mjs "glb files/wooden_flooring.glb" public/assets/textures/floor-wood.webp 1024
 *
 * Why a bake and not the model. wooden_flooring.glb is 187,716 triangles for a 2.89 x 1.94 m patch of
 * reclaimed planks. The house has ~470 m2 of procedural floor, which is 84 copies of that patch, or
 * 15.7 M triangles against a whole-house budget of 35k — and simplifying it to fit would take the
 * plank edges with it, which is the only thing anybody looks at on a floor. A floor is flat: all of
 * its detail is in the map, so the map is the part worth shipping.
 *
 * Why a bake and not the map straight out of the file. That map is a UV *atlas* — one island per
 * plank, packed, with dilation bleed between them — so tiling it directly wallpapers the house with
 * the cream-coloured padding between islands. Baking resolves the packing: every up-facing triangle
 * is rasterised into an orthographic top-down grid over the patch's own XZ bounds, sampling the atlas
 * through its UVs, so the output is what the floor looks like from above at a known metres-per-pixel.
 * The result tiles at exactly the patch's size, which HouseBuilder feeds to anchorUv.
 *
 * Runs in its own process for the same reason pass A does: sharp 0.34.5 at the top level works and the
 * 0.35.4 nested under @gltf-transform/functions does not, and loading both libvips builds in one
 * process breaks every encode. This file imports /core and /extensions only — no /functions.
 */
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';

const [SRC, DST, PX] = [process.argv[2], process.argv[3], Number(process.argv[4] ?? 1024)];

/** A node's local matrix, column-major, from its TRS. */
function trs(t, r, s) {
  const [x, y, z, w] = r;
  const [x2, y2, z2] = [x + x, y + y, z + z];
  const [xx, xy, xz] = [x * x2, x * y2, x * z2];
  const [yy, yz, zz] = [y * y2, y * z2, z * z2];
  const [wx, wy, wz] = [w * x2, w * y2, w * z2];
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}

function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = v;
    }
  }
  return o;
}

const apply = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

/**
 * Every triangle in the file, in world space, paired with its UVs and the material it came from.
 * Nodes are walked rather than meshes: a Sketchfab export puts the scale and the axis flip on
 * ancestors, so a mesh read on its own is in nobody's units.
 */
function worldTriangles(doc) {
  const tris = [];
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const walk = (node, parent) => {
    const world = mul(parent, trs(node.getTranslation(), node.getRotation(), node.getScale()));
    const mesh = node.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        const uvAttr = prim.getAttribute('TEXCOORD_0');
        if (!pos || !uvAttr) continue;
        const idx = prim.getIndices();
        const count = idx ? idx.getCount() : pos.getCount();
        const at = (i) => (idx ? idx.getScalar(i) : i);
        const p = [0, 0, 0];
        const uv = [0, 0];
        const read = (v) => {
          pos.getElement(v, p);
          uvAttr.getElement(v, uv);
          return { p: apply(world, p), uv: [uv[0], uv[1]] };
        };
        for (let i = 0; i + 2 < count; i += 3) {
          tris.push({ v: [read(at(i)), read(at(i + 1)), read(at(i + 2))], mat: prim.getMaterial() });
        }
      }
    }
    for (const child of node.listChildren()) walk(child, world);
  };
  for (const scene of doc.getRoot().listScenes()) for (const n of scene.listChildren()) walk(n, identity);
  return tris;
}

/** Upward-facing only: the underside and the bevelled edges are not what a floor shows. */
function upFacing(tris) {
  return tris.filter(({ v }) => {
    const [a, b, c] = v.map((x) => x.p);
    const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const len = Math.hypot(nx, ny, nz);
    return len > 0 && Math.abs(ny) / len > 0.5;
  });
}

async function main() {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(SRC);

  const tris = upFacing(worldTriangles(doc));
  if (tris.length === 0) throw new Error(`${SRC}: no up-facing triangles with UVs`);

  // Source atlases, decoded once each and keyed by the material that reads them.
  const atlas = new Map();
  for (const { mat } of tris) {
    if (!mat || atlas.has(mat)) continue;
    const tex = mat.getBaseColorTexture();
    if (!tex) throw new Error(`${SRC}: material ${mat.getName()} has no base colour texture`);
    const img = sharp(Buffer.from(tex.getImage()));
    const meta = await img.metadata();
    const data = await img.ensureAlpha().raw().toBuffer();
    atlas.set(mat, { data, w: meta.width, h: meta.height });
  }

  // The patch's own footprint is the tile size: one repeat of the output covers exactly this.
  let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const { v } of tris) {
    for (const { p } of v) {
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
      z0 = Math.min(z0, p[2]);
      z1 = Math.max(z1, p[2]);
    }
  }
  const [spanX, spanZ] = [x1 - x0, z1 - z0];
  // Square pixels, so the planks keep their proportions however the patch is shaped.
  const W = PX;
  const H = Math.max(1, Math.round((PX * spanZ) / spanX));

  const out = new Uint8Array(W * H * 3);
  const filled = new Uint8Array(W * H);
  const topY = new Float32Array(W * H).fill(-Infinity);

  for (const { v, mat } of tris) {
    const src = atlas.get(mat);
    // Pixel-space triangle. +0.5 offsets cancel against the sample point below.
    const px = v.map(({ p }) => [((p[0] - x0) / spanX) * W, ((p[2] - z0) / spanZ) * H]);
    const minI = Math.max(0, Math.floor(Math.min(px[0][0], px[1][0], px[2][0])));
    const maxI = Math.min(W - 1, Math.ceil(Math.max(px[0][0], px[1][0], px[2][0])));
    const minJ = Math.max(0, Math.floor(Math.min(px[0][1], px[1][1], px[2][1])));
    const maxJ = Math.min(H - 1, Math.ceil(Math.max(px[0][1], px[1][1], px[2][1])));
    const area =
      (px[1][0] - px[0][0]) * (px[2][1] - px[0][1]) - (px[2][0] - px[0][0]) * (px[1][1] - px[0][1]);
    if (Math.abs(area) < 1e-12) continue;

    for (let j = minJ; j <= maxJ; j++) {
      for (let i = minI; i <= maxI; i++) {
        const [sx, sy] = [i + 0.5, j + 0.5];
        // Barycentrics, with a small negative tolerance so adjacent triangles leave no hairline gap.
        const w0 = ((px[1][0] - sx) * (px[2][1] - sy) - (px[2][0] - sx) * (px[1][1] - sy)) / area;
        const w1 = ((px[2][0] - sx) * (px[0][1] - sy) - (px[0][0] - sx) * (px[2][1] - sy)) / area;
        const w2 = 1 - w0 - w1;
        const eps = -1e-6;
        if (w0 < eps || w1 < eps || w2 < eps) continue;
        const y = w0 * v[0].p[1] + w1 * v[1].p[1] + w2 * v[2].p[1];
        const at = j * W + i;
        if (y <= topY[at]) continue; // a plank laid over another: the upper one is the surface
        topY[at] = y;

        // glTF UV origin is the image's top-left, so v maps straight to a row.
        const u = w0 * v[0].uv[0] + w1 * v[1].uv[0] + w2 * v[2].uv[0];
        const t = w0 * v[0].uv[1] + w1 * v[1].uv[1] + w2 * v[2].uv[1];
        const fx = u * src.w - 0.5;
        const fy = t * src.h - 0.5;
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const [ax, ay] = [fx - ix, fy - iy];
        const wrap = (n, m) => ((n % m) + m) % m;
        let [r, g, b] = [0, 0, 0];
        for (const [dx, dy, k] of [
          [0, 0, (1 - ax) * (1 - ay)],
          [1, 0, ax * (1 - ay)],
          [0, 1, (1 - ax) * ay],
          [1, 1, ax * ay],
        ]) {
          const o = (wrap(iy + dy, src.h) * src.w + wrap(ix + dx, src.w)) * 4;
          r += src.data[o] * k;
          g += src.data[o + 1] * k;
          b += src.data[o + 2] * k;
        }
        out[at * 3] = Math.round(r);
        out[at * 3 + 1] = Math.round(g);
        out[at * 3 + 2] = Math.round(b);
        filled[at] = 1;
      }
    }
  }

  // Any pixel the patch does not cover — its outline is not a perfect rectangle — takes its nearest
  // filled neighbour, spread outwards a ring at a time. A floor tile with holes in it is a floor with
  // holes in it once it wraps.
  let holes = filled.reduce((n, f) => n + (f ? 0 : 1), 0);
  const total = W * H;
  for (let pass = 0; holes > 0 && pass < 64; pass++) {
    const next = filled.slice();
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const at = j * W + i;
        if (filled[at]) continue;
        let [r, g, b, n] = [0, 0, 0, 0];
        for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const [ni, nj] = [i + di, j + dj];
          if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
          const o = nj * W + ni;
          if (!filled[o]) continue;
          r += out[o * 3];
          g += out[o * 3 + 1];
          b += out[o * 3 + 2];
          n++;
        }
        if (n === 0) continue;
        out[at * 3] = Math.round(r / n);
        out[at * 3 + 1] = Math.round(g / n);
        out[at * 3 + 2] = Math.round(b / n);
        next[at] = 1;
        holes--;
      }
    }
    filled.set(next);
  }

  let [sr, sg, sb] = [0, 0, 0];
  for (let i = 0; i < total; i++) {
    sr += out[i * 3];
    sg += out[i * 3 + 1];
    sb += out[i * 3 + 2];
  }
  const mean = [sr / total, sg / total, sb / total];

  mkdirSync(dirname(DST), { recursive: true });
  await sharp(Buffer.from(out), { raw: { width: W, height: H, channels: 3 } })
    .webp({ quality: 88 })
    .toFile(DST);

  console.log(
    `baked ${DST}  ${W}x${H}px  tile ${spanX.toFixed(3)} x ${spanZ.toFixed(3)} m` +
      `  (${(W / spanX).toFixed(0)} px/m)  ${(statSync(DST).size / 1024).toFixed(0)} kB` +
      `  from ${tris.length} up-facing triangles, ${holes} pixels unresolved`,
  );
  console.log(
    `  mean rgb ${mean.map((c) => c.toFixed(1)).join(', ')}` +
      `  luma ${(0.299 * mean[0] + 0.587 * mean[1] + 0.114 * mean[2]).toFixed(1)}` +
      `  — HouseBuilder tints against this; see FLOOR_TILE_* there.`,
  );
  console.log(`  TILE_X=${spanX.toFixed(4)} TILE_Z=${spanZ.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
