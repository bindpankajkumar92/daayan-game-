/**
 * Derive the tone LUT that makes one asset's colour atlas sit in the same tonal band as another's, and
 * write it where pass A of the model pipeline can find it.
 *
 *   node tools/tone-match.mjs "glb files/fps_arms.glb" "glb files/arms_throwing.glb" tools/tone-lut-arms.json
 *
 * **Why this exists.** fps_arms.glb replaced arms_throwing.glb as the viewmodel, and the two atlases have
 * almost the same mean luma (68.9 against 70.2) but nothing else in common. The old one is unimodal — its
 * glove and sleeve both sit in the 32-64 band, so every fold and stitch is a mid-tone detail. The new one
 * is bimodal: 27% of its texels are below luma 24 (a black leather glove and a black cloth sleeve) and
 * another 39% are bright peach skin, with a hole in the middle. Under this house's lighting that is fatal.
 * The lantern is a camera child sitting to the *right* of the arm, so the side of the forearm the player
 * actually sees is lit by ambient alone; multiply a near-black texel by ambient and then by ARMS_ALBEDO
 * and the result lands under the film grade's own black floor. The arm reads as a silhouette with two
 * bright fingers stuck on the end of it, which is exactly the "contrast is far too high, no texture at
 * all" complaint this addresses.
 *
 * **Why match a histogram instead of picking a curve.** The acceptance test is "same as the original arm",
 * and the original arm is still on disk. Matching the two luma CDFs lets the reference choose the curve:
 * it lifts the new atlas's black cloth into the band the old glove and sleeve occupied *and* pulls the new
 * atlas's blown highlights down, so the contrast closes from both ends at once. A hand-picked lift/gamma
 * can only do the first half — measured on the device, a lift of 110 moved the sleeve from luma 9.1 to
 * 13.3 and left the fingers as bright as they already were, which widens nothing and fixes nothing.
 *
 * Deriving this offline rather than in pass A keeps the reference asset out of the build: the LUT is 256
 * numbers of committed data with its provenance recorded beside it, so a build does not depend on an asset
 * it no longer ships, and the curve can be reviewed as a diff rather than re-inferred from two images.
 */
import { writeFileSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';

const [srcGlb, refGlb, outPath] = process.argv.slice(2);
if (!srcGlb || !refGlb || !outPath) {
  console.error('usage: node tools/tone-match.mjs <src.glb> <ref.glb> <out.json>');
  process.exit(2);
}

/**
 * The retired spec-gloss extension is where fps_arms.glb keeps its only colour image — the same reason
 * pass A has to run flattenSpecGloss() before anything else. Reading both slots here means this tool does
 * not care which era either file was authored in.
 */
const SPEC_GLOSS = 'KHR_materials_pbrSpecularGlossiness';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** The base-colour image of the first material that has one, decoded to raw RGB. */
async function colourAtlas(path) {
  const doc = await io.read(path);
  for (const mat of doc.getRoot().listMaterials()) {
    const tex = mat.getBaseColorTexture() ?? mat.getExtension(SPEC_GLOSS)?.getDiffuseTexture();
    if (!tex) continue;
    const img = Buffer.from(tex.getImage());
    const { data, info } = await sharp(img).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, channels: info.channels, width: info.width, height: info.height };
  }
  throw new Error(`${path}: no material carries a base-colour or spec-gloss diffuse texture`);
}

/** Luma histogram, its CDF, and the summary numbers the JSON records as provenance. */
function distribution({ data, channels }) {
  const h = new Float64Array(256);
  let n = 0;
  let sum = 0;
  let dark = 0;
  for (let p = 0; p < data.length; p += channels) {
    const y = luma(data[p], data[p + 1], data[p + 2]);
    h[Math.round(y)]++;
    n++;
    sum += y;
    if (y < 24) dark++;
  }
  const cdf = new Float64Array(256);
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += h[i];
    cdf[i] = acc / n;
  }
  // Eight coarse buckets, as percentages — enough to see bimodality in a commit message, and the same
  // shape the investigation was argued from.
  const buckets = new Array(8).fill(0);
  for (let i = 0; i < 256; i++) buckets[Math.min(7, i >> 5)] += h[i];
  return {
    cdf,
    mean: +(sum / n).toFixed(1),
    nearBlackPct: +((dark / n) * 100).toFixed(1),
    buckets: buckets.map((c) => Math.round((c / n) * 100)),
  };
}

/**
 * Radius of the box blur applied to the matched curve, in input levels.
 *
 * A CDF match against a bimodal source is a staircase: the 47% of texels crowded below luma 24 all want
 * to spread across the reference's 32-64 band, so dozens of input levels collapse onto one output and the
 * curve then jumps. A jump in a tone curve is a visible contour band across any smooth surface, and a
 * forearm at 35 cm is the smoothest, largest surface on screen. Blurring the mapping keeps its shape and
 * removes the cliffs; the monotone pass afterwards is what stops the blur from inverting the curve
 * anywhere, which would darken a highlight relative to the tone just below it.
 */
const SMOOTH = 12;

const [src, ref] = await Promise.all([colourAtlas(srcGlb), colourAtlas(refGlb)]);
const dSrc = distribution(src);
const dRef = distribution(ref);

const raw = new Uint8Array(256);
for (let v = 0, w = 0; v < 256; v++) {
  while (w < 255 && dRef.cdf[w] < dSrc.cdf[v]) w++;
  raw[v] = w;
}

const lut = new Uint8Array(256);
for (let v = 0; v < 256; v++) {
  let s = 0;
  let n = 0;
  for (let k = -SMOOTH; k <= SMOOTH; k++) {
    const i = v + k;
    if (i < 0 || i > 255) continue;
    s += raw[i];
    n++;
  }
  lut[v] = Math.round(s / n);
}
for (let v = 1; v < 256; v++) if (lut[v] < lut[v - 1]) lut[v] = lut[v - 1];

writeFileSync(
  outPath,
  `${JSON.stringify(
    {
      _: 'Generated by tools/tone-match.mjs — do not hand-edit. Rerun the command in `from` to regenerate.',
      from: `node tools/tone-match.mjs ${JSON.stringify(srcGlb)} ${JSON.stringify(refGlb)} ${JSON.stringify(outPath)}`,
      source: { file: srcGlb, mean: dSrc.mean, nearBlackPct: dSrc.nearBlackPct, buckets: dSrc.buckets },
      reference: { file: refGlb, mean: dRef.mean, nearBlackPct: dRef.nearBlackPct, buckets: dRef.buckets },
      smooth: SMOOTH,
      lut: [...lut],
    },
    null,
    2,
  )}\n`,
);

console.log(`source    ${srcGlb}`);
console.log(`          mean ${dSrc.mean}  <24 ${dSrc.nearBlackPct}%  buckets ${dSrc.buckets.join(' ')}`);
console.log(`reference ${refGlb}`);
console.log(`          mean ${dRef.mean}  <24 ${dRef.nearBlackPct}%  buckets ${dRef.buckets.join(' ')}`);
console.log(`lut       ${[0, 16, 32, 64, 96, 128, 160, 192, 224, 255].map((v) => `${v}->${lut[v]}`).join('  ')}`);
console.log(`wrote     ${outPath}`);
