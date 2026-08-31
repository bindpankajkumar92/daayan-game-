/** Ad-hoc check: print each texture's real pixel dimensions for the GLBs named on argv. */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

// Shipped models are EXT_meshopt_compression'd, so the decoder has to be registered to read them.
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
for (const f of process.argv.slice(2)) {
  const doc = await io.read(f);
  const out = [];
  for (const t of doc.getRoot().listTextures()) {
    const img = t.getImage();
    if (!img) continue;
    const md = await sharp(Buffer.from(img)).metadata();
    out.push(`${md.width}x${md.height}/${md.format}`);
  }
  console.log(String(f.split(/[\\/]/).pop()).padEnd(28), out.join(' ') || '(no textures)');
}
