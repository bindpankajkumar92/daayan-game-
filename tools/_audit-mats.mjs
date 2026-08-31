/** TEMP audit probe — enumerate everything a shipped material carries that convert() might drop. */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const DIR = process.argv[2] ?? 'public/assets/models';
await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

for (const name of readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.glb'))) {
  const doc = await io.read(join(DIR, name));
  const root = doc.getRoot();
  const lines = [];
  // primitive-level: NORMAL / TANGENT / COLOR_0 / UV sets
  let noNormal = 0, withTangent = 0, withColor = 0, prims = 0, uv1 = 0;
  for (const mesh of root.listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      prims++;
      if (!p.getAttribute('NORMAL')) noNormal++;
      if (p.getAttribute('TANGENT')) withTangent++;
      if (p.getAttribute('COLOR_0')) withColor++;
      if (p.getAttribute('TEXCOORD_1')) uv1++;
    }
  }
  for (const m of root.listMaterials()) {
    const mode = m.getAlphaMode();
    const bc = m.getBaseColorFactor();
    const em = m.getEmissiveFactor();
    const bct = m.getBaseColorTexture();
    const nt = m.getNormalTexture();
    const flags = [];
    if (mode !== 'OPAQUE') flags.push(`alpha=${mode}${mode === 'MASK' ? `(cut ${m.getAlphaCutoff()})` : ''}`);
    if (bc[3] < 1) flags.push(`baseA=${bc[3].toFixed(3)}`);
    if (m.getDoubleSided()) flags.push('doubleSided');
    if (nt) flags.push(`normal(scale ${m.getNormalScale()})`);
    if (em[0] || em[1] || em[2]) flags.push(`emissive=[${em.map((v) => v.toFixed(2)).join(',')}]`);
    if (m.getEmissiveTexture()) flags.push('emissiveTex');
    if (m.getOcclusionTexture()) flags.push('AO!');
    if (m.getMetallicRoughnessTexture()) flags.push('MR!');
    const exts = m.listExtensions().map((e) => e.extensionName);
    if (exts.length) flags.push(`ext=${exts.join('+')}`);
    // KHR_texture_transform on the base colour?
    const info = bct ? m.getBaseColorTextureInfo() : null;
    if (info) {
      const tt = info.getExtension('KHR_texture_transform');
      if (tt) flags.push(`xform(o=${tt.getOffset()} s=${tt.getScale()} r=${tt.getRotation()})`);
      if (info.getTexCoord() !== 0) flags.push(`texCoord=${info.getTexCoord()}`);
      const w = [info.getWrapS(), info.getWrapT()];
      if (w[0] !== 10497 || w[1] !== 10497) flags.push(`wrap=${w}`);
    }
    // does the base colour image actually have an alpha channel?
    if (bct && mode !== 'OPAQUE') {
      const img = bct.getImage();
      flags.push(`bcImg=${img ? img.byteLength : 0}B mime=${bct.getMimeType()}`);
    }
    if (flags.length) lines.push(`    [${m.getName() || '(unnamed)'}] ${flags.join(' ')}`);
  }
  const geo = [];
  if (noNormal) geo.push(`${noNormal}/${prims} prims MISSING NORMAL`);
  if (withTangent) geo.push(`${withTangent}/${prims} have TANGENT`);
  if (withColor) geo.push(`${withColor}/${prims} have COLOR_0`);
  if (uv1) geo.push(`${uv1}/${prims} have UV1`);
  console.log(`\n== ${name}  (${root.listMaterials().length} mats, ${prims} prims)${geo.length ? ' — ' + geo.join(', ') : ''}`);
  for (const l of lines) console.log(l);
}
