/**
 * _imported7.ts — what do the IMPORTED .glb files put near y 2.400, in world space?
 *
 * The headless buildHouse(1) audits cannot see any of this: they never load a GLB. So this reproduces
 * ModelProps' placement arithmetic exactly — prune, then fitToHeight (three's *non-precise* Box3, i.e.
 * the union of each mesh's local AABB transformed by its matrixWorld) or fitToBox (precise, vertex
 * walk) — and then measures the real vertices in world space.
 *
 * Reports per primitive: world y range, xz footprint, and every near-horizontal triangle in the band
 * y 2.25..2.55 bucketed to the millimetre with its projected area, plus the base colour actually
 * sampled from the material's map at those triangles' UVs and pushed through the row's albedo/curve.
 *
 *   npx tsx tools/_imported7.ts            # the upper storey (default)
 *   npx tsx tools/_imported7.ts --all      # every row, no region filter
 */

// First, and it has to be: the `document` stub the world modules' texture generators reach for.
import './dom-shim';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { join } from 'node:path';
import { MODEL_PLACEMENTS, type ModelPlacement } from '@/world/ModelProps';
import { UPPER, UPPER_PATCH, UP_Y } from '@/world/HouseRooms';

const MODELS = 'public/assets/models';
/** The y band a floor-level artefact could live in. */
const BAND = { y0: 2.25, y1: 2.55 };
/** |ny| over this is "flat enough to be a floor or a threshold". */
const FLAT_N = 0.85;
/** Region of interest: the upper flat's plan, generously padded. */
const ROI = { x0: UPPER.x0 - 1.6, x1: UPPER.x1 + 0.6, z0: -11.6, z1: UPPER.z1 + 0.6 };

type M4 = number[];
const I4: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major (glTF / three order) 4x4 product. */
function mul(a: M4, b: M4): M4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) out[c * 4 + r] += (a[k * 4 + r] as number) * (b[c * 4 + k] as number);
  return out;
}

function xf(m: M4, x: number, y: number, z: number): [number, number, number] {
  return [
    (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number),
    (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number),
    (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number),
  ];
}
function trans(x: number, y: number, z: number): M4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}
function scale3(x: number, y: number, z: number): M4 {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}
/** three's Euler order XYZ composes as Rx * Ry * Rz; only x and y are ever used here. */
function rotXY(px: number, yaw: number): M4 {
  const a = Math.cos(px), b = Math.sin(px), c = Math.cos(yaw), d = Math.sin(yaw);
  const rx: M4 = [1, 0, 0, 0, 0, a, b, 0, 0, -b, a, 0, 0, 0, 0, 1];
  const ry: M4 = [c, 0, -d, 0, 0, 1, 0, 0, d, 0, c, 0, 0, 0, 0, 1];
  return mul(rx, ry);
}

interface Prim {
  /** node/mesh label, as three would name it. */
  label: string;
  node: string;
  /** local vertex positions, xyz triples. */
  pos: Float32Array;
  uv: Float32Array | null;
  idx: Uint32Array;
  /** node-chain matrix, model root -> this mesh's local space. */
  chain: M4;
  /** local-space AABB, what three's geometry.boundingBox holds. */
  lo: [number, number, number];
  hi: [number, number, number];
  mat: MatInfo;
}

interface MatInfo {
  name: string;
  base: [number, number, number, number];
  hasMap: boolean;
  hasNormal: boolean;
  alphaMode: string;
  doubleSided: boolean;
  /** decoded map pixels, for sampling at a triangle's UVs. */
  img: { w: number; h: number; px: Buffer } | null;
}
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

const fileCache = new Map<string, Prim[]>();

/** Every primitive of one file, flattened with its node-chain matrix — the shape three ends up with. */
async function primsOf(name: string): Promise<Prim[]> {
  const hit = fileCache.get(name);
  if (hit) return hit;
  const doc = await io.read(join(MODELS, name));
  const out: Prim[] = [];
  const mats = new Map<unknown, MatInfo>();
  for (const scene of doc.getRoot().listScenes()) {
    const walk = async (node: any, parent: M4): Promise<void> => {
      const world = mul(parent, node.getMatrix() as M4);
      const mesh = node.getMesh();
      if (mesh) {
        for (const prim of mesh.listPrimitives()) {
          const pa = prim.getAttribute('POSITION');
          if (!pa) continue;
          const n = pa.getCount();
          const pos = new Float32Array(n * 3);
          const el = [0, 0, 0];
          for (let i = 0; i < n; i++) {
            pa.getElement(i, el);
            pos[i * 3] = el[0] as number;
            pos[i * 3 + 1] = el[1] as number;
            pos[i * 3 + 2] = el[2] as number;
          }
          const ua = prim.getAttribute('TEXCOORD_0');
          let uv: Float32Array | null = null;
          if (ua) {
            uv = new Float32Array(n * 2);
            const e2 = [0, 0];
            for (let i = 0; i < n; i++) {
              ua.getElement(i, e2);
              uv[i * 2] = e2[0] as number;
              uv[i * 2 + 1] = e2[1] as number;
            }
          }
          const ia = prim.getIndices();
          const idx = new Uint32Array(ia ? ia.getCount() : n);
          for (let i = 0; i < idx.length; i++) idx[i] = ia ? ia.getScalar(i) : i;
          const lo: [number, number, number] = [Infinity, Infinity, Infinity];
          const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
          for (let i = 0; i < n; i++)
            for (let k = 0; k < 3; k++) {
              const v = pos[i * 3 + k] as number;
              if (v < (lo[k] as number)) lo[k] = v;
              if (v > (hi[k] as number)) hi[k] = v;
            }
          out.push({
            label: `${node.getName() || '(unnamed)'}/${mesh.getName() || 'mesh'}`,
            node: node.getName() || '(unnamed)',
            pos, uv, idx, chain: world, lo, hi,
            mat: await matInfo(prim.getMaterial(), mats),
          });
        }
      }
      for (const child of node.listChildren()) await walk(child, world);
    };
    for (const node of scene.listChildren()) await walk(node, I4);
  }
  fileCache.set(name, out);
  return out;
}
async function matInfo(m: any, cache: Map<unknown, MatInfo>): Promise<MatInfo> {
  const hit = cache.get(m);
  if (hit) return hit;
  const base = (m?.getBaseColorFactor?.() ?? [1, 1, 1, 1]) as [number, number, number, number];
  const tex = m?.getBaseColorTexture?.() ?? null;
  let img: MatInfo['img'] = null;
  if (tex) {
    const bytes = tex.getImage();
    if (bytes) {
      const raw = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      img = { w: raw.info.width, h: raw.info.height, px: raw.data };
    }
  }
  const info: MatInfo = {
    name: m?.getName?.() ?? '(none)',
    base,
    hasMap: tex !== null,
    hasNormal: (m?.getNormalTexture?.() ?? null) !== null,
    alphaMode: m?.getAlphaMode?.() ?? 'OPAQUE',
    doubleSided: m?.getDoubleSided?.() === true,
    img,
  };
  cache.set(m, info);
  return info;
}

/** Nearest-texel sample. glTF UV origin is top-left, so v runs down the image. */
function sampleMap(mat: MatInfo, u: number, v: number): [number, number, number] | null {
  if (!mat.img) return null;
  const { w, h, px } = mat.img;
  const cx = Math.min(w - 1, Math.max(0, Math.floor(((u % 1) + 1) % 1 * w)));
  const cy = Math.min(h - 1, Math.max(0, Math.floor(((v % 1) + 1) % 1 * h)));
  const o = (cy * w + cx) * 4;
  return [px[o] as number, px[o + 1] as number, px[o + 2] as number];
}

const tag = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** three's Box3.setFromObject(root, precise=false): union of local AABBs transformed by matrixWorld. */
function looseBox(prims: Prim[], root: M4): { lo: number[]; hi: number[] } {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of prims) {
    const m = mul(root, p.chain);
    for (let c = 0; c < 8; c++) {
      const w = xf(m,
        (c & 1 ? p.hi[0] : p.lo[0]),
        (c & 2 ? p.hi[1] : p.lo[1]),
        (c & 4 ? p.hi[2] : p.lo[2]));
      for (let k = 0; k < 3; k++) {
        if (w[k] < (lo[k] as number)) lo[k] = w[k] as number;
        if (w[k] > (hi[k] as number)) hi[k] = w[k] as number;
      }
    }
  }
  return { lo, hi };
}
/** three's Box3.setFromObject(root, precise=true): the real vertices. */
function tightBox(prims: Prim[], root: M4): { lo: number[]; hi: number[] } {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of prims) {
    const m = mul(root, p.chain);
    for (let i = 0; i < p.pos.length; i += 3) {
      const w = xf(m, p.pos[i] as number, p.pos[i + 1] as number, p.pos[i + 2] as number);
      for (let k = 0; k < 3; k++) {
        if (w[k] < (lo[k] as number)) lo[k] = w[k] as number;
        if (w[k] > (hi[k] as number)) hi[k] = w[k] as number;
      }
    }
  }
  return { lo, hi };
}

/** Reproduce installModels' placement for one row. Returns the final root matrix. */
function place(p: ModelPlacement, prims: Prim[], floorY: number): { root: M4; k: number[]; box: number[] } {
  if (p.fit !== undefined) {
    // fitToBox: size in source axes first (precise), then yaw, then seat (precise).
    const b1 = tightBox(prims, I4);
    const sx = b1.hi[0]! - b1.lo[0]!, sy = b1.hi[1]! - b1.lo[1]!, sz = b1.hi[2]! - b1.lo[2]!;
    const kx = sx > 1e-6 ? p.fit.width / sx : 1;
    const ky = sy > 1e-6 ? p.fit.height / sy : 1;
    const kz = p.fit.depth !== undefined && sz > 1e-6 ? p.fit.depth / sz : 1;
    const rs = mul(rotXY(p.pitch ?? 0, p.yaw ?? 0), scale3(kx, ky, kz));
    const b2 = tightBox(prims, rs);
    const off = trans(p.x - (b2.lo[0]! + b2.hi[0]!) / 2, floorY - b2.lo[1]!, p.z - (b2.lo[2]! + b2.hi[2]!) / 2);
    return { root: mul(off, rs), k: [kx, ky, kz], box: [b2.hi[0]! - b2.lo[0]!, b2.hi[2]! - b2.lo[2]!, b2.hi[1]! - b2.lo[1]!] };
  }
  // fitToHeight: yaw and pitch first, then the loose box decides the uniform scale.
  const r = rotXY(p.pitch ?? 0, p.yaw ?? 0);
  const b1 = looseBox(prims, r);
  const tallest = Math.max(b1.hi[0]! - b1.lo[0]!, b1.hi[1]! - b1.lo[1]!, b1.hi[2]! - b1.lo[2]!);
  const k = tallest > 1e-6 ? p.height / tallest : 1;
  const rs = mul(r, scale3(k, k, k));
  const b2 = looseBox(prims, rs);
  const off = trans(p.x - (b2.lo[0]! + b2.hi[0]!) / 2, floorY - b2.lo[1]!, p.z - (b2.lo[2]! + b2.hi[2]!) / 2);
  return { root: mul(off, rs), k: [k, k, k], box: [b2.hi[0]! - b2.lo[0]!, b2.hi[2]! - b2.lo[2]!, b2.hi[1]! - b2.lo[1]!] };
}

/** Area of a polygon in the xz plane. */
function polyArea(poly: number[][]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
    a += (p[0] as number) * (q[1] as number) - (q[0] as number) * (p[1] as number);
  }
  return Math.abs(a) / 2;
}
// PLACEHOLDER_E
