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
import { readdirSync, mkdirSync, statSync, readFileSync } from 'node:fs';
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
 * Optional `{"<asset>.glb": "<lut path>"}` map, applied to that asset's **base-colour** images only.
 *
 * This is how the viewmodel arm stops being a silhouette. Its atlas is bimodal — a quarter of it is
 * near-black glove and sleeve, most of the rest is bright skin — and the house's only real light is a
 * point light parented to the camera *beside* the arm, so the side of the forearm the player sees gets
 * ambient alone. Ambient times a near-black texel times ARMS_ALBEDO lands below the film grade's own
 * black floor, and the arm reads as a hole with two lit fingers on the end. Baking the tone match here
 * rather than dimming less in HeldLantern is the difference between compressing the contrast and merely
 * scaling it: ARMS_ALBEDO is one multiply on the material colour, and no multiply can pull a histogram's
 * two humps together. See tools/tone-match.mjs for where the curve comes from.
 */
const TONE = process.argv[6] ? JSON.parse(process.argv[6]) : {};

/**
 * Ceiling on the multiplicative half of the tone remap.
 *
 * The curve is defined on luma, and it is applied as a multiply so that a texel keeps its hue — a black
 * sleeve should come back as a dark *fabric* colour, not as grey. But the gain a near-black texel needs
 * to reach its target is unbounded, and at 30x it amplifies the atlas's own JPEG-era rounding noise into
 * coloured speckle. Past the cap the rest of the lift is added instead, which desaturates only the texels
 * that had almost no chroma left to lose.
 */
const TONE_GAIN_MAX = 6;

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Remap one decoded image in place through a 256-entry luma LUT, leaving any alpha channel alone. */
function applyToneLut(data, channels, lut) {
  for (let p = 0; p < data.length; p += channels) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const y = luma(r, g, b);
    const t = lut[Math.round(y)];
    const gain = Math.min(TONE_GAIN_MAX, t / Math.max(y, 1));
    const add = t - y * gain;
    data[p] = Math.max(0, Math.min(255, Math.round(r * gain + add)));
    data[p + 1] = Math.max(0, Math.min(255, Math.round(g * gain + add)));
    data[p + 2] = Math.max(0, Math.min(255, Math.round(b * gain + add)));
  }
}

/**
 * Move KHR_materials_pbrSpecularGlossiness's diffuse map into the core base-colour slot, before
 * stripUnusedMaps() below deletes the extension it lives in.
 *
 * Spec-gloss is the retired glTF 1.0-era PBR model, and three.js 0.169's GLTFLoader does not implement
 * it at all — a material that stores its colour only there arrives at the runtime with `map` unset and
 * renders as flat white. `fps_arms.glb` is exactly that file: it declares no `pbrMetallicRoughness`
 * block whatsoever, so its one diffuse image is reachable only through the extension. Left alone the
 * arm would ship untextured, and the viewmodel's own ARMS_ALBEDO dim would then turn it into a grey
 * paddle 0.35 m from the eye.
 *
 * Only the diffuse half is salvaged. The specular-glossiness image is the counterpart of the
 * metallic-roughness map that stripUnusedMaps() throws away on purpose, and for the same reason:
 * Phong's specular here is a constant set in ModelLoader, so a per-texel one has nothing to drive.
 *
 * Doing this in pass A rather than with `metalRough()` from @gltf-transform/functions is forced by the
 * two-sharp split described at the top of this file — that package is the one this process may not
 * import, and by the time pass B runs the extension has already been stripped.
 */
const SPEC_GLOSS = 'KHR_materials_pbrSpecularGlossiness';

function flattenSpecGloss(doc) {
  let moved = 0;
  for (const mat of doc.getRoot().listMaterials()) {
    const sg = mat.getExtension(SPEC_GLOSS);
    if (!sg) continue;
    const tex = sg.getDiffuseTexture();
    // An explicit core base colour wins: if a file bothered to author both, the modern one is the one
    // its author expected a current renderer to use.
    if (tex && !mat.getBaseColorTexture()) {
      mat.setBaseColorTexture(tex);
      const from = sg.getDiffuseTextureInfo();
      const to = mat.getBaseColorTextureInfo();
      // Carry the sampler across, not just the UV set. A wrap mode lost here shows up as a seam or a
      // clamped smear along one edge of the map, which is far harder to trace back than a missing texture.
      if (from && to) {
        to.setTexCoord(from.getTexCoord());
        to.setWrapS(from.getWrapS());
        to.setWrapT(from.getWrapT());
        const mag = from.getMagFilter();
        const min = from.getMinFilter();
        if (mag !== null) to.setMagFilter(mag);
        if (min !== null) to.setMinFilter(min);
      }
      moved++;
    }
    const factor = sg.getDiffuseFactor();
    if (factor) mat.setBaseColorFactor(factor);
    // A diffuse-only material is by definition not metal. Nothing downstream reads these — ModelLoader
    // copies colour and maps and drops the rest of the BRDF — but leaving glTF's metallicFactor at its
    // default of 1 would make the intermediate file read as solid chrome in any viewer used to debug it.
    mat.setMetallicFactor(0).setRoughnessFactor(1);
  }
  return moved;
}

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
    // Anything a stripped extension was the only owner of has already been rescued by
    // flattenSpecGloss() above; this line is why that has to run first.
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
 *
 * A tone LUT, when the plan supplies one, is applied here to base-colour images only — never to a normal
 * map, whose texels are a unit vector rather than a colour, and never to whatever else a file happens to
 * ship. Doing it inside this loop means the remap happens on the decoded pixels that are about to be
 * encoded anyway, so it costs one extra pass over the buffer rather than a second decode.
 */
async function shrink(doc, lut) {
  let before = 0;
  let after = 0;
  let failed = 0;
  let toned = 0;
  const dims = new Map();
  // Roles are a property of the material, not the texture, so they have to be collected up front.
  const normals = new Set();
  const baseColour = new Set();
  for (const mat of doc.getRoot().listMaterials()) {
    const n = mat.getNormalTexture();
    if (n) normals.add(n);
    const c = mat.getBaseColorTexture();
    if (c) baseColour.add(c);
  }
  for (const tex of doc.getRoot().listTextures()) {
    const img = tex.getImage();
    if (!img) continue;
    before += img.byteLength;
    try {
      // A texture in both sets would be a broken file; refusing to tone it keeps the normal map correct,
      // which is the failure that would be harder to see.
      const tone = lut && baseColour.has(tex) && !normals.has(tex);
      let pipe = sharp(Buffer.from(img));
      const md = await pipe.metadata();
      if (tone) {
        const { data, info } = await pipe.raw().toBuffer({ resolveWithObject: true });
        applyToneLut(data, info.channels, lut);
        pipe = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
        toned++;
      }
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
  return { before, after, failed, toned, dims };
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
mkdirSync(DST, { recursive: true });

let totalFailed = 0;
const summary = [];
for (const name of readdirSync(SRC).filter((f) => f.toLowerCase().endsWith('.glb') && (!ONLY || ONLY.has(f)))) {
  const doc = await io.read(join(SRC, name));
  const salvaged = flattenSpecGloss(doc);
  const dropped = stripUnusedMaps(doc);
  const orphans = pruneOrphanTextures(doc);
  // Read after flattenSpecGloss() has run, since on this asset the image being toned only reaches the
  // base-colour slot because that function put it there.
  const lut = TONE[name] ? JSON.parse(readFileSync(TONE[name], 'utf8')).lut : null;
  if (TONE[name] && (!Array.isArray(lut) || lut.length !== 256)) {
    console.error(`  ! ${name}: ${TONE[name]} has no 256-entry "lut" array — not toning`);
  }
  const tex = await shrink(doc, Array.isArray(lut) && lut.length === 256 ? lut : null);
  await io.write(join(DST, name), doc);
  totalFailed += tex.failed;
  summary.push({
    asset: name,
    specGlossFlattened: salvaged,
    mapsDropped: dropped,
    texturesRemoved: orphans,
    toneMatched: tex.toned,
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
