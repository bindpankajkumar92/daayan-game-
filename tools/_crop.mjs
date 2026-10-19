/**
 * Throwaway: crop a region out of a device screenshot and upscale it, so the hand can be looked at.
 *
 *   node tools/_crop.mjs in.png out.png <left> <top> <w> <h> [scale]
 */
import sharp from 'sharp';

const [inp, out, l, t, w, h, s] = process.argv.slice(2);
const scale = +(s ?? 3);
await sharp(inp)
  .extract({ left: +l, top: +t, width: +w, height: +h })
  .resize({ width: Math.round(+w * scale), kernel: 'lanczos3' })
  .png()
  .toFile(out);
console.log(`${out}  ${+w}x${+h} @${scale}x`);
