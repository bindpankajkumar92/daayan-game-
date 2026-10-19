/**
 * Throwaway: crop a region out of a screenshot and upscale it, as a JPEG so it fits a read.
 *
 *   node tools/_cropz.mjs in.png out.jpg <left> <top> <w> <h> [scale=2] [quality=82]
 */
import sharp from 'sharp';

const [inp, out, l, t, w, h, s, q] = process.argv.slice(2);
const scale = +(s ?? 2);
const buf = await sharp(inp)
  .extract({ left: +l, top: +t, width: +w, height: +h })
  .resize({ width: Math.round(+w * scale), kernel: 'lanczos3' })
  .jpeg({ quality: +(q ?? 82) })
  .toBuffer();
const { writeFileSync } = await import('node:fs');
writeFileSync(out, buf);
console.log(`${out}  ${+w}x${+h} @${scale}x  ${(buf.length / 1024).toFixed(0)}KB`);