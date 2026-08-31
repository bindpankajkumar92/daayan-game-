/**
 * Report which shipped models actually carry a normal map, and how big their images are.
 *
 * The point is to check a claim before writing runtime code against it: the texture pass was changed
 * to stop stripping normals, but a normal map the source never had cannot come back, and teaching
 * ModelLoader to sample normals is only worth the fragment cost on files that have some.
 *
 *   node tools/inspect-maps.mjs [dir]
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const DIR = process.argv[2] ?? 'public/assets/models';
// The shipped files carry EXT_meshopt_compression, so reading one without the decoder throws before
// a single material is visible.
await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

const rows = [];
let totalMB = 0;
let withNormals = 0;
for (const name of readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.glb'))) {
  const doc = await io.read(join(DIR, name));
  const mats = doc.getRoot().listMaterials();
  const normals = new Map();
  for (const mat of mats) {
    const n = mat.getNormalTexture();
    if (!n) continue;
    const img = n.getImage();
    normals.set(n, (img?.byteLength ?? 0) / 1024);
  }
  let texKB = 0;
  for (const tex of doc.getRoot().listTextures()) texKB += (tex.getImage()?.byteLength ?? 0) / 1024;
  const mb = statSync(join(DIR, name)).size / 1048576;
  totalMB += mb;
  if (normals.size > 0) withNormals++;
  rows.push({
    asset: name,
    MB: +mb.toFixed(2),
    mats: mats.length,
    withN: mats.filter((m) => m.getNormalTexture()).length,
    normals: normals.size,
    normalKB: +[...normals.values()].reduce((a, b) => a + b, 0).toFixed(0),
    texKB: +texKB.toFixed(0),
  });
}
rows.sort((a, b) => b.MB - a.MB);
console.table(rows);
console.log(`${rows.length} models, ${totalMB.toFixed(2)} MB total, ${withNormals} carry a normal map`);
