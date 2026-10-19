/**
 * Downscale a screenshot so it can be looked at in one piece.
 *
 * Usage: node tools/_small.mjs <in.png> <out.jpg> [width=900] [quality=72]
 *
 * The full-size grabs are 1272x630 PNGs of a dark scene; a whole-frame read is what answers "is the
 * shaft covered", and the reader has a size cap, so every look goes through here first.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const [src, out, W = '900', Q = '72'] = process.argv.slice(2);
if (!out) {
  console.error('usage: node tools/_small.mjs <in.png> <out.jpg> [width] [quality]');
  process.exit(2);
}
const buf = await sharp(readFileSync(src)).resize({ width: Number(W) }).jpeg({ quality: Number(Q) }).toBuffer();
writeFileSync(out, buf);
console.log(`${src} -> ${out} (${(buf.length / 1024).toFixed(0)}KB)`);
