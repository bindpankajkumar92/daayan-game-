import { readdirSync, statSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

const targets = [
  { file: 'wardrobe-chateau.glb', room: 'Living Room', expectedAnims: 3 },
  { file: 'dresser-bedroom.glb', room: 'Bedroom', expectedAnims: 1 },
  { file: 'caffe-set.glb', room: 'Back Corridor', expectedAnims: 0 },
  { file: 'kitchen-counter.glb', room: 'Kitchen', expectedAnims: 0 },
  { file: 'table-antique.glb', room: 'Prayer Room', expectedAnims: 0 },
  { file: 'table-mechanical.glb', room: 'Basement', expectedAnims: 0 },
  { file: 'cabinet-animated.glb', room: "Child's Room", expectedAnims: 1 },
  { file: 'key-iron.glb', room: 'Attic Store', expectedAnims: 0 },
  { file: 'room-brick.glb', room: 'Shrine Room', expectedAnims: 0 },
];

console.log('=== VERIFYING OPTIMIZED ASSETS IN public/assets/models/ ===');
let allOk = true;

for (const t of targets) {
  const path = `public/assets/models/${t.file}`;
  const size = (statSync(path).size / 1024).toFixed(1);
  const doc = await io.read(path);
  const root = doc.getRoot();
  const anims = root.listAnimations().map((a) => a.getName());
  const meshes = root.listMeshes();
  let tris = 0;
  for (const m of meshes) {
    for (const p of m.listPrimitives()) {
      tris += (p.getIndices()?.getCount() ?? p.getAttribute('POSITION')?.getCount() ?? 0) / 3;
    }
  }
  const hasTextures = root.listTextures().length;
  const pass = anims.length === t.expectedAnims;
  if (!pass) allOk = false;
  console.log(
    `${pass ? '✓' : '✗'} ${t.file.padEnd(23)} | Room: ${t.room.padEnd(14)} | ${size.padStart(6)} KB | Tris: ${Math.round(tris).toString().padStart(6)} | Textures: ${hasTextures} | Anims: [${anims.join(', ')}]`,
  );
}

if (!allOk) {
  console.error('FAIL: Animation count mismatch!');
  process.exit(1);
} else {
  console.log('\nALL 9 ASSETS VERIFIED SUCCESSFULLY!');
}
