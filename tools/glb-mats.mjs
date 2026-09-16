/**
 * Dump every material in one .glb: which texture slots it fills, its base-colour factor, and how many
 * triangles wear it.
 *
 * Written to answer one question — did the optimize pass drop a base-colour texture, or did the source
 * never have one? Point it at `.models-backup-0.8/` and at `public/assets/models/` and diff the output.
 *
 *   node tools/glb-mats.mjs public/assets/models/room-upper.glb
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/glb-mats.mjs <file.glb>');
  process.exit(2);
}
await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(file);
const root = doc.getRoot();

const trisOf = new Map();
for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const n = prim.getIndices()?.getCount() ?? prim.getAttribute('POSITION')?.getCount() ?? 0;
    const m = prim.getMaterial();
    const key = m ? m.getName() || '(unnamed)' : '(none)';
    trisOf.set(key, (trisOf.get(key) ?? 0) + n / 3);
  }
}

console.log(`${file}`);
console.log(`  ${root.listMaterials().length} materials, ${root.listTextures().length} textures, ${root.listMeshes().length} meshes`);
for (const m of root.listMaterials()) {
  const name = m.getName() || '(unnamed)';
  const slots = [
    ['base', m.getBaseColorTexture()],
    ['mr', m.getMetallicRoughnessTexture()],
    ['norm', m.getNormalTexture()],
    ['emis', m.getEmissiveTexture()],
    ['occl', m.getOcclusionTexture()],
  ]
    .filter(([, t]) => t)
    .map(([k, t]) => `${k}=${t.getName() || t.getMimeType()}`);
  const c = m.getBaseColorFactor().slice(0, 3).map((v) => Math.round(v * 255));
  console.log(
    `  ${name.padEnd(22)} tris ${String(Math.round(trisOf.get(name) ?? 0)).padStart(6)}  ` +
      `factor #${c.map((v) => v.toString(16).padStart(2, '0')).join('')}  ` +
      `alpha=${m.getAlphaMode()} double=${m.getDoubleSided()}  ` +
      `${slots.length ? slots.join(' ') : 'NO TEXTURES'}`,
  );
}
for (const t of root.listTextures()) {
  const img = t.getImage();
  console.log(`  tex ${(t.getName() || '(unnamed)').padEnd(24)} ${t.getMimeType()} ${img ? `${(img.byteLength / 1024).toFixed(0)} KB` : 'NO IMAGE'}`);
}
