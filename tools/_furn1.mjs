/**
 * _furn1.mjs — one-shot inspection of the nine furniture GLBs in "glb files/".
 * Prints, per file: node tree with per-mesh local/world boxes and tri counts, clip names +
 * durations + channels, material albedo means, and the world-space bbox of the whole scene.
 * Throwaway measurement backing the placement rows; nothing written.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const SRC = 'glb files';
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

// Evaluate each animation channel list compactly: which node, which path, key count, and the
// first/last values so a "swing" vs "spin" can be told apart without opening a DCC tool.
const fmt = (v) => (Array.isArray(v) ? v.map((x) => +x.toFixed(3)).join(',') : v);

for (const name of FILES) {
  const doc = await io.read(join(SRC, name));
  const root = doc.getRoot();
  console.log(`\n================ ${name} (${(statSync(join(SRC, name)).size / 1048576).toFixed(1)} MB)`);
  for (const scene of root.listScenes()) {
    const walk = (node, depth) => {
      const t = node.getTranslation();
      const r = node.getRotation();
      const s = node.getScale();
      const mesh = node.getMesh();
      let meshInfo = '';
      if (mesh) {
        const parts = [];
        for (const prim of mesh.listPrimitives()) {
          const pos = prim.getAttribute('POSITION');
          const mn = pos.getMin([]);
          const mx = pos.getMax([]);
          let tris = 0;
          const idx = prim.getIndices();
          tris = idx ? idx.getCount() / 3 : pos.getCount() / 3;
          parts.push(`tris ${Math.round(tris)} box [${mn.map((x) => +x.toFixed(3))} .. ${mx.map((x) => +x.toFixed(3))}] mode ${prim.getMode()}`);
        }
        meshInfo = `  MESH ${mesh.getName() || '<noname>'} :: ${parts.join(' | ')}`;
      }
      console.log(`${'  '.repeat(depth)}- ${node.getName() || '<node>'} t=${fmt([...t])} q=${fmt([...r])} s=${fmt([...s])}${meshInfo}`);
      for (const c of node.listChildren()) walk(c, depth + 1);
    };
    for (const c of scene.listChildren()) walk(c, 0);
  }
  for (const anim of root.listAnimations()) {
    console.log(`  ANIM "${anim.getName()}"`);
    for (const ch of anim.listChannels()) {
      const sampler = ch.getSampler();
      const input = sampler.getInput();
      const out = sampler.getOutput();
      const n = input.getCount();
      const last = out.getElement(n - 1, []);
      const first = out.getElement(Math.max(0, Math.min(1, n - 2)), []);
      console.log(
        `    ch ${ch.getTargetNode()?.getName() ?? ch.getTargetNodePath?.() ?? '?'} .${ch.getTargetPath()} keys ${n} dur ${(input.getMax([])[0] - input.getMin([])[0]).toFixed(3)}s` +
        ` interp ${sampler.getInterpolation()} first→last ${fmt(first)} → ${fmt(last)}`,
      );
    }
  }
  const mats = root.listMaterials();
  for (const m of mats) {
    const bc = m.getBaseColorFactor();
    const tex = m.getBaseColorTexture();
    const nm = m.getNormalTexture();
    const size = tex?.getImage()?.byteLength ?? 0;
    console.log(`  MAT "${m.getName()}" base ${fmt([...bc])} ${tex ? `map ${(size / 1024).toFixed(0)}KB` : 'no map'} ${nm ? 'hasN' : ''} alpha ${m.getAlphaMode()}`);
  }
}
