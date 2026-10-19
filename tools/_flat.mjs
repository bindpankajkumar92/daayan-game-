/**
 * How much of a device frame is *featureless*, which is the thing the player actually reported.
 *
 * Mean brightness was the wrong measure for this defect: the sealed shell already sat at the same 31-35
 * mean as its textured neighbours and still stood out, because what marks it out is that it has no grain
 * — a smooth painted panel among plaster. A plain local-standard-deviation threshold is wrong too, and
 * measurably so: at `sd < 2/255` this frame comes back 81% flat *everywhere*, floorboards included,
 * because a house lit by one lantern has almost no absolute contrast anywhere. So the measure is local
 * standard deviation over the local mean — relative contrast, which a mapped surface keeps as it darkens
 * and an untextured one never has at any brightness.
 *
 * Reported as a distribution rather than one threshold, so a before/after comparison does not depend on
 * a number picked to make it look good. The 4x4 grid is there because a whole-frame figure hides where
 * the panel is: a third of the frame changing shows up as one quadrant moving, not as a shifted average.
 *
 * `--rect=l,t,w,h` measures one region instead of the frame. That is how the shell itself gets measured:
 * hiding it for one shot and diffing looked cleaner, but this game swings a lit lantern in the player's
 * hand and grades every frame, so two shots of the same pose differ by up to 166/255 on their own and the
 * diff is mostly arm. A rectangle read off the image is crude and it is honest — it contains only the
 * surface in question, in both the before and the after shot, at the same pose.
 *
 * The grid's cut defaults to the one that actually separates the two states, measured rather than picked:
 * an undressed shell panel came back 87.0% below rc<0.01 and the same panel wearing the house plaster
 * 23.2%, while at rc<0.02 the two are 99.3% and 83.7% — nearly the same number, because plaster is a
 * low-contrast map. So 0.01 finds a bare surface in a frame and 0.02 does not.
 *
 *   node tools/_flat.mjs .thresh/30-user-pose.png [more.png ...]
 *   node tools/_flat.mjs --rect=1168,130,582,240 .thresh/40-before-b.png
 *   node tools/_flat.mjs --gridcut=0.02 .thresh/50-inner-w.png
 */
import sharp from 'sharp';

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const rectArg = process.argv.find((a) => a.startsWith('--rect='));
const RECT = rectArg ? rectArg.slice(7).split(',').map(Number) : null;
const cutArg = process.argv.find((a) => a.startsWith('--gridcut='));
const CUTS = [0.01, 0.02, 0.04, 0.08];
const GRID_CUT = cutArg ? Number(cutArg.slice(10)) : 0.01;

for (const file of files) {
  let img = sharp(file).greyscale();
  if (RECT) img = img.extract({ left: RECT[0], top: RECT[1], width: RECT[2], height: RECT[3] });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  let sum = 0;
  const below = new Float64Array(CUTS.length);
  const GX = 4, GY = 4;
  const gFlat = new Float64Array(GX * GY);
  const gSum = new Float64Array(GX * GY);
  const gN = new Float64Array(GX * GY);
  for (let y = 1; y < h - 1; y++) {
    const gy = Math.min(GY - 1, Math.floor((y / h) * GY));
    for (let x = 1; x < w - 1; x++) {
      const c = data[y * w + x];
      sum += c;
      let s = 0, s2 = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const v = data[(y + dy) * w + (x + dx)];
          s += v; s2 += v * v;
        }
      }
      const mu = s / 9;
      const sd = Math.sqrt(Math.max(0, s2 / 9 - mu * mu));
      const rc = sd / Math.max(1, mu);
      for (let k = 0; k < CUTS.length; k++) if (rc < CUTS[k]) below[k]++;
      const gi = gy * GX + Math.min(GX - 1, Math.floor((x / w) * GX));
      gN[gi]++; gSum[gi] += c;
      if (rc < GRID_CUT) gFlat[gi]++;
    }
  }
  const n = (w - 2) * (h - 2);
  console.log(
    `${file}  ${w}x${h}  mean ${(sum / n).toFixed(1)}  ` +
      CUTS.map((c, k) => `rc<${c}: ${((below[k] / n) * 100).toFixed(1)}%`).join('  '),
  );
  console.log(`    grid: mean / % below rc<${GRID_CUT}`);
  for (let gy = 0; gy < GY; gy++) {
    const cells = [];
    for (let gx = 0; gx < GX; gx++) {
      const gi = gy * GX + gx;
      cells.push(`${(gSum[gi] / gN[gi]).toFixed(0).padStart(3)}/${((gFlat[gi] / gN[gi]) * 100).toFixed(0).padStart(3)}%`);
    }
    console.log(`    ${cells.join('  ')}`);
  }
}
