/**
 * GLB inspector. Reports per-file texture resolutions, mesh/triangle counts and animations so an
 * asset budget can be argued from numbers instead of guessed at.
 *
 *   node tools/glb-report.mjs "glb files"/*.glb
 *
 * Parses the container directly rather than going through a glTF library: a GLB is a 12-byte header
 * followed by length-prefixed chunks, and image dimensions live in the embedded PNG/JPEG headers,
 * which is all we need. Keeping it dependency-free means it also runs against the optimised output
 * before any loader exists in the game.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** Split a GLB into its JSON manifest and the binary chunk the manifest points into. */
function parseGlb(buf) {
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a GLB');
  let json = null;
  let bin = null;
  let p = 12;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32LE(p);
    const type = buf.readUInt32LE(p + 4);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === CHUNK_JSON) json = JSON.parse(data.toString('utf8'));
    else if (type === CHUNK_BIN) bin = data;
    p += 8 + len + ((4 - (len % 4)) % 4); // chunks are 4-byte aligned
  }
  if (!json) throw new Error('no JSON chunk');
  return { json, bin };
}

/** Width/height straight out of the image's own header. Returns null for formats we do not parse. */
function imageSize(b) {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) {
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), fmt: 'png' }; // IHDR
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk the segment chain to the first SOF marker; its payload carries the dimensions.
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) {
        p++;
        continue;
      }
      const m = b[p + 1];
      const isSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
      if (isSof) return { h: b.readUInt16BE(p + 5), w: b.readUInt16BE(p + 7), fmt: 'jpeg' };
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd9)) {
        p += 2;
        continue;
      }
      p += 2 + b.readUInt16BE(p + 2);
    }
  }
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const tag = b.toString('ascii', 12, 16);
    if (tag === 'VP8X') return { w: (b.readUIntLE(24, 3) & 0xffffff) + 1, h: (b.readUIntLE(27, 3) & 0xffffff) + 1, fmt: 'webp' };
    if (tag === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff, fmt: 'webp' };
  }
  if (b.length > 44 && b.toString('ascii', 1, 7) === 'KTX 20') {
    return { w: b.readUInt32LE(20), h: b.readUInt32LE(24), fmt: 'ktx2' };
  }
  return null;
}

/** Triangles the file would draw once, summed over every primitive. */
function triangleCount(json) {
  let tris = 0;
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const mode = prim.mode ?? 4; // 4 = TRIANGLES
      if (mode !== 4) continue;
      const acc = prim.indices !== undefined ? json.accessors?.[prim.indices] : json.accessors?.[prim.attributes?.POSITION];
      tris += Math.floor((acc?.count ?? 0) / 3);
    }
  }
  return tris;
}

function report(file) {
  const buf = readFileSync(file);
  const { json, bin } = parseGlb(buf);
  const images = [];
  for (const [i, img] of (json.images ?? []).entries()) {
    let bytes = 0;
    let size = null;
    if (img.bufferView !== undefined && bin) {
      const bv = json.bufferViews[img.bufferView];
      const data = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
      bytes = bv.byteLength;
      size = imageSize(data);
    }
    images.push({ i, name: img.name ?? '', mime: img.mimeType ?? size?.fmt ?? '?', px: size ? `${size.w}x${size.h}` : '?', kb: Math.round(bytes / 1024) });
  }
  const prims = (json.meshes ?? []).reduce((n, m) => n + (m.primitives?.length ?? 0), 0);
  return {
    file: basename(file),
    mb: +(buf.length / 1048576).toFixed(2),
    meshes: (json.meshes ?? []).length,
    primitives: prims,
    triangles: triangleCount(json),
    materials: (json.materials ?? []).length,
    animations: (json.animations ?? []).length,
    skins: (json.skins ?? []).length,
    textureMB: +(images.reduce((n, im) => n + im.kb, 0) / 1024).toFixed(2),
    images,
  };
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node tools/glb-report.mjs <file.glb> [...]');
  process.exit(1);
}

const rows = [];
for (const f of files) {
  try {
    rows.push(report(f));
  } catch (err) {
    rows.push({ file: basename(f), error: String(err.message ?? err) });
  }
}
console.log(JSON.stringify(rows, null, 1));
