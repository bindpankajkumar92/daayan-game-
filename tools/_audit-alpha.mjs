/** TEMP audit probe — alpha-channel stats of every base-colour image on a non-OPAQUE material. */
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';

const DIR = process.argv[2] ?? 'public/assets/models';
await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

const CUT = 0.35 * 255; // three's alphaTest 0.35 on an 8-bit alpha channel

for (const name of readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.glb'))) {
  const doc = await io.read(join(DIR, name));
  for (const m of doc.getRoot().listMaterials()) {
    if (m.getAlphaMode() === 'OPAQUE') continue;
    const bct = m.getBaseColorTexture();
    const baseA = m.getBaseColorFactor()[3];
    if (!bct) {
      console.log(`${name} [${m.getName()}]  NO baseColorTexture, baseA=${baseA.toFixed(3)}  -> BLEND branch`);
      continue;
    }
    const img = bct.getImage();
    if (!img) continue;
    const pipe = sharp(Buffer.from(img));
    const md = await pipe.metadata();
    if (!md.hasAlpha) {
      console.log(`${name} [${m.getName()}]  ${md.width}x${md.height} NO ALPHA CHANNEL, baseA=${baseA.toFixed(3)}` +
        `  -> alphaTest 0.35 vs a=${baseA.toFixed(3)} => ${baseA < 0.35 ? 'ENTIRELY DISCARDED' : 'fully opaque'}`);
      continue;
    }
    const { data, info } = await pipe.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = info.width * info.height;
    let below = 0, zero = 0, full = 0, min = 255, max = 0;
    for (let i = 3; i < data.length; i += 4) {
      const a = data[i] * baseA;
      if (a < min) min = a;
      if (a > max) max = a;
      if (a < CUT) below++;
      if (data[i] === 0) zero++;
      if (data[i] === 255) full++;
    }
    console.log(
      `${name} [${m.getName()}]  ${info.width}x${info.height} baseA=${baseA.toFixed(3)}  ` +
      `a(min..max after baseA)=${min.toFixed(0)}..${max.toFixed(0)}  ` +
      `discarded@0.35=${((below / px) * 100).toFixed(1)}%  a==0:${((zero / px) * 100).toFixed(1)}%  a==255:${((full / px) * 100).toFixed(1)}%`,
    );
  }
}
