/**
 * Pass A of the model pipeline: texture work only. Run via `node tools/optimize-models.mjs`, which
 * spawns this first — it is a separate process on purpose.
 *
 * There are two sharp installs in this tree, and they cannot share a process:
 *   node_modules/sharp                          0.34.5  (via @gltf-transform/cli) — works
 *   node_modules/ndarray-pixels/node_modules/   0.35.4  (via @gltf-transform/functions) — its
 *                                                       native binary fails ERR_DLOPEN_FAILED
 * Loading both puts two libvips builds in one process, and every encode then dies with
 * `colourspace: parameter space not set` (libvips rejecting an interpretation enum from the other
 * build). @gltf-transform/core and /extensions have no sharp dependency, so this pass imports only
 * those and the working top-level sharp; the geometry pass keeps /functions to itself.
 */
import { readdirSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';

const SRC = process.argv[2] ?? 'glb files';
const DST = process.argv[3] ?? '.tmp-glb';
/**
 * Fraction of each image's *own* dimensions to keep — a relative reduction, not a cap.
 *
 * This used to be an absolute longest edge (256 by default, overridden to 512 or 1024 per asset) and
 * that is what over-degraded the house: every source map here is authored at 1024 or below (measured:
 * 1024 on 20 of the 26 files, 512 on room_scene, a few 256 and smaller inside basement_scene), so a
 * 256 clamp threw away 16/17ths of the texels on nearly everything and walls a metre from the eye came
 * out as smears. A scale keeps each map's authored detail in proportion to itself instead.
 *
 * Now 1.0: authored resolution, untouched. The reduction was bought for a frame budget that turned out
 * not to be spent — the target phone (Adreno 613, 90 Hz panel) renders the finished house in 13.2 ms of
 * a 33.3 ms budget, and texture resolution costs bandwidth on a cache miss rather than shader time.
 * 0.8 was saving 36% of the texels for 25% less linear detail on every wall the player stands next to.
 * The images are still re-encoded to WebP, which is where the real saving always was.
 */
const SCALE = Number(process.argv[4] ?? 1.0);
/**
 * Optional comma-separated list of file names to encode, so one asset can be re-done without touching
 * the rest. Pass B hands over the names in its plan.
 */
const ONLY = process.argv[5] ? new Set(process.argv[5].split(',')) : null;

/**
 * Texture slots the runtime material will never sample.
 *
 * **Normal maps used to be in this list and are the reason the imported art looked painted rather
 * than moulded.** They were dropped because ModelLoader forced MeshLambertMaterial, which has no
 * normal slot at all. It no longer does: a material that arrives with a normal map now becomes
 * MeshPhongMaterial and samples it. In a house whose only real light is a point light swinging in
 * the player's hand, a normal map is the single highest-value texture in the file — it is what makes
 * the plaster, the bed frames and the gate mouldings move as the lantern moves, and no amount of
 * base-colour resolution substitutes for it.
 *
 * Occlusion and metallic-roughness still go. AO needs a second UV set to be correct and Phong's
 * ambient term is a constant anyway, and nothing in this house is metal or glossy enough to want a
 * roughness map — the one specular surface, the brass, is a hand-authored material in Fixtures.
 */
function stripUnusedMaps(doc) {
  let dropped = 0;
  for (const mat of doc.getRoot().listMaterials()) {
    for (const set of ['setOcclusionTexture', 'setMetallicRoughnessTexture']) {
      if (mat[set.replace('set', 'get')]()) {
        mat[set](null);
        dropped++;
      }
    }
    // Clearcoat, sheen and friends carry their own textures and Lambert ignores every one.
    // KHR_texture_transform stays: it remaps UVs, so removing it would misplace the base colour.
    for (const ext of mat.listExtensions()) {
      const name = ext.extensionName;
      if (name !== 'KHR_texture_transform' && name !== 'KHR_materials_unlit') mat.setExtension(name, null);
    }
  }
  return dropped;
}

/** Drop textures no material references any more, so stripped maps do not ride along in the file. */
function pruneOrphanTextures(doc) {
  const used = new Set();
  for (const mat of doc.getRoot().listMaterials()) {
    for (const get of ['getBaseColorTexture', 'getEmissiveTexture', 'getNormalTexture', 'getOcclusionTexture', 'getMetallicRoughnessTexture']) {
      const t = mat[get]?.();
      if (t) used.add(t);
    }
  }
  let removed = 0;
  for (const tex of doc.getRoot().listTextures()) {
    if (!used.has(tex)) {
      tex.dispose();
      removed++;
    }
  }
  return removed;
}

/**
 * Re-encode every image at SCALE of its own size.
 *
 * The dimensions have to be read per image rather than handed to `fit: 'inside'`, because a relative
 * reduction has no single target box: the same call has to take a 1024x1024 wall to 819 and a 256x128
 * decal to 205x102, and it must not round either axis to zero. At SCALE 1.0 the resize is a no-op and
 * this is purely the WebP re-encode, which is where most of the saving always came from.
 *
 * **Normal maps get their own quality.** A lossy codec's error in a colour map is a slightly wrong
 * colour; in a normal map it is a wrong *surface direction*, and a lantern sweeping across it turns
 * blocking artefacts into visible shimmering facets. They encode at 95 against 88 for everything else.
 */
async function shrink(doc) {
  let before = 0;
  let after = 0;
  let failed = 0;
  const dims = new Map();
  // Roles are a property of the material, not the texture, so they have to be collected up front.
  const normals = new Set();
  for (const mat of doc.getRoot().listMaterials()) {
    const n = mat.getNormalTexture();
    if (n) normals.add(n);
  }
  for (const tex of doc.getRoot().listTextures()) {
    const img = tex.getImage();
    if (!img) continue;
    before += img.byteLength;
    try {
      const pipe = sharp(Buffer.from(img));
      const md = await pipe.metadata();
      const w = Math.max(1, Math.round((md.width ?? 1) * SCALE));
      const h = Math.max(1, Math.round((md.height ?? 1) * SCALE));
      const out = await pipe
        .resize(w, h, { fit: 'fill', withoutEnlargement: true })
        .webp({ quality: normals.has(tex) ? 95 : 88, effort: 5 })
        .toBuffer();
      tex.setImage(new Uint8Array(out)).setMimeType('image/webp');
      const uri = tex.getURI();
      if (uri) tex.setURI(uri.replace(/\.(png|jpe?g)$/i, '.webp'));
      after += out.length;
      const key = `${md.width}x${md.height}->${w}x${h}`;
      dims.set(key, (dims.get(key) ?? 0) + 1);
    } catch (err) {
      // Reported rather than swallowed: a texture left at its authored size is exactly what this pass
      // exists to trim, and silently shipping one would show up later as unexplained memory.
      console.error(`  ! ${tex.getName() || '(unnamed)'} left as-is: ${err.message.split('\n')[0]}`);
      after += img.byteLength;
      failed++;
    }
  }
  return { before, after, failed, dims };
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
mkdirSync(DST, { recursive: true });

let totalFailed = 0;
const summary = [];
for (const name of readdirSync(SRC).filter((f) => f.toLowerCase().endsWith('.glb') && (!ONLY || ONLY.has(f)))) {
  const doc = await io.read(join(SRC, name));
  const dropped = stripUnusedMaps(doc);
  const orphans = pruneOrphanTextures(doc);
  const tex = await shrink(doc);
  await io.write(join(DST, name), doc);
  totalFailed += tex.failed;
  summary.push({
    asset: name,
    mapsDropped: dropped,
    texturesRemoved: orphans,
    // What each surviving image actually became, so a run proves the scale rather than asserting it.
    resized: [...tex.dims.entries()].sort().map(([k, n]) => `${n}x ${k}`).join('  '),
    texMB: `${(tex.before / 1048576).toFixed(2)} -> ${(tex.after / 1048576).toFixed(2)}`,
    MB: `${(statSync(join(SRC, name)).size / 1048576).toFixed(1)} -> ${(statSync(join(DST, name)).size / 1048576).toFixed(2)}`,
  });
}
console.table(summary);
if (totalFailed > 0) {
  console.error(`${totalFailed} texture(s) could not be re-encoded — see messages above.`);
  process.exit(2);
}
