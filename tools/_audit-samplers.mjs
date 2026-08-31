/** TEMP audit probe — sampler filters (do mipmaps/anisotropy apply?) + the NORMAL-less primitive. */
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

const F = { 9728: 'NEAREST', 9729: 'LINEAR', 9984: 'N_MIP_N', 9985: 'L_MIP_N', 9986: 'N_MIP_L', 9987: 'L_MIP_L' };
const pot = (n) => n > 0 && (n & (n - 1)) === 0;

for (const name of readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.glb'))) {
  const doc = await io.read(join(DIR, name));
  const root = doc.getRoot();
  const filters = new Map();
  const npot = [];
  for (const m of root.listMaterials()) {
    for (const [slot, get] of [['base', 'getBaseColorTextureInfo'], ['norm', 'getNormalTextureInfo'], ['emis', 'getEmissiveTextureInfo']]) {
      const info = m[get]?.();
      if (!info) continue;
      const k = `${F[info.getMinFilter()] ?? info.getMinFilter()}/${F[info.getMagFilter()] ?? info.getMagFilter()}`;
      filters.set(k, (filters.get(k) ?? 0) + 1);
      void slot;
    }
  }
  for (const t of root.listTextures()) {
    const s = t.getSize();
    if (s && (!pot(s[0]) || !pot(s[1]))) npot.push(`${t.getName() || '?'} ${s[0]}x${s[1]}`);
  }
  // NORMAL-less primitives, by mesh + material name
  const bad = [];
  for (const mesh of root.listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      if (!p.getAttribute('NORMAL')) {
        const idx = p.getIndices();
        bad.push(`${mesh.getName() || '(unnamed mesh)'} / mat=${p.getMaterial()?.getName() ?? 'none'} / tris=${Math.floor((idx ?? p.getAttribute('POSITION')).getCount() / 3)}`);
      }
    }
  }
  const parts = [];
  if (filters.size) parts.push(`filters ${[...filters].map(([k, n]) => `${n}x ${k}`).join(', ')}`);
  if (npot.length) parts.push(`NPOT: ${npot.join('; ')}`);
  if (bad.length) parts.push(`NO NORMAL: ${bad.join(' | ')}`);
  if (parts.length) console.log(`${name}: ${parts.join('  ||  ')}`);
}
