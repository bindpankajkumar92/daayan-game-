/**
 * Throwaway: pixel size of one or more images, so a crop window can be expressed in real pixels.
 *
 *   node tools/_dims.mjs <image> [image...]
 */
import sharp from 'sharp';

for (const p of process.argv.slice(2)) {
  const m = await sharp(p).metadata();
  console.log(`${m.width}x${m.height}  ${p}`);
}