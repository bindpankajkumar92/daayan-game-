/**
 * Draw the named world boxes on top of a screenshot, from the pose the HUD printed.
 *
 * The point is to end the guessing. A hand-drawn blue outline on a screenshot names nothing; the camera
 * knows exactly where every collider lands in the frame, so drawing them back onto the *same* picture
 * says which box the outline is on. Aspect comes from the image's own pixels, because the FOV is
 * vertical and a window with a different shape maps the same pose to different columns.
 *
 * Usage:
 *   node tools/_overlay.mjs <in.png> <out.jpg> <eyeX> <eyeY> <eyeZ> <hudYaw> <pitch> [fov=70] [outW=1150]
 *
 * `hudYaw` is the readout's `yaw(...)` = atan2(dir.x, dir.z); the controller's `facing.y` is that minus
 * pi. Colours are listed on stdout so the picture can be read without a legend drawn into it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const [inp, out, X = '16.84', Y = '4.1', Z = '1.29', HY = '3.11', P = '-0.15', FOV = '70', OUTW = '1150'] =
  process.argv.slice(2);

/**
 * Every line the stairwell work put in, plus the neighbours it has to agree with. Extents are the real
 * ones: the kerbs' y1 is 2.85 (UP_Y + 0.45) and the well's sides stop on 2.40.
 */
const BOXES = [
  ['kerb-north  (z 0.16..0.36, y1 2.85)', [15.6, 18.61, 2.39, 2.85, 0.16, 0.36], '#ff3030'],
  ['kerb-west   (x 15.6..15.8, y1 2.85)', [15.6, 15.8, 2.39, 2.85, -1.93, 0.16], '#ff8000'],
  ['kerb-south  (z -2.13..-1.93, y1 2.85)', [15.7, 18.71, 2.39, 2.85, -2.13, -1.93], '#ffe000'],
  ['cheek-south (z -1.18..-1.08, y1 2.40)', [16.21, 18.61, 0.2, 2.4, -1.18, -1.08], '#40ff40'],
  ['well        (x16.21..18.61) opening', [16.21, 18.61, 0.2, 2.4, -1.08, 0.16], '#00ffff'],
  ['room-north  (z -6.2..-6.0)', [15.6, 21.6, 0.2, 2.4, -6.2, -6.0], '#ff40ff'],
  ['room-west   (x 15.6..15.8)', [15.6, 15.8, 0.2, 2.4, -6.2, 0.61], '#8080ff'],
  ['room-east   (x 21.4..21.6)', [21.4, 21.6, 0.2, 2.4, -6.2, 0.61], '#ffffff'],
  ['room-south  (z 0.41..0.61)', [15.6, 21.6, 0.2, 2.4, 0.41, 0.61], '#00ff80'],
  ['flat-south wall (z -0.99..-0.79)', [15.7, 21.6, 2.4, 5.29, -0.99, -0.79], '#a05000'],
  ['nook-west/doors (x 18.61)', [18.46, 18.76, 2.4, 4.45, -1.08, 0.16], '#0080ff'],
];

const meta = await sharp(inp).metadata();
const W = meta.width;
const H = meta.height;
const eye = [Number(X), Number(Y), Number(Z)];
const yaw = Number(HY) - Math.PI;
const pitch = Number(P);
const tanV = Math.tan((Number(FOV) * Math.PI) / 360);
const tanH = tanV * (W / H);

const cos = Math.cos;
const sin = Math.sin;
function project(p) {
  const v = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
  const a = [v[0] * cos(yaw) - v[2] * sin(yaw), v[1], v[0] * sin(yaw) + v[2] * cos(yaw)];
  const b = [a[0], a[1] * cos(pitch) + a[2] * sin(pitch), -a[1] * sin(pitch) + a[2] * cos(pitch)];
  if (b[2] >= -1e-6) return null;
  const ndcX = b[0] / -b[2] / tanH;
  const ndcY = b[1] / -b[2] / tanV;
  return [((ndcX + 1) / 2) * W, ((1 - ndcY) / 2) * H];
}

/** Points a screenshot can be read against directly, rather than box corners. */
const POINTS = [
  ['well north lip  W', [16.21, 2.4, 0.16]],
  ['well north lip  E', [18.61, 2.4, 0.16]],
  ['well south lip  W', [16.21, 2.4, -1.08]],
  ['well south lip  E', [18.61, 2.4, -1.08]],
  ['kerb-north top  W', [15.6, 2.85, 0.26]],
  ['kerb-north top  E', [18.61, 2.85, 0.26]],
  ['kerb-west  top  N', [15.7, 2.85, 0.16]],
  ['kerb-west  top  S', [15.7, 2.85, -1.93]],
  ['kerb-south top  W', [15.7, 2.85, -2.03]],
  ['kerb-south top  E', [18.71, 2.85, -2.03]],
  ['store doorway  L', [14.4, 2.4, -0.99]],
  ['store doorway  R', [15.7, 2.4, -0.99]],
  ['store doorway top', [15.05, 4.5, -0.99]],
  ['room north base  W', [15.7, 0.2, -6.1]],
  ['room north base  E', [21.5, 0.2, -6.1]],
  ['room north top  W', [15.7, 2.4, -6.1]],
];

const rects = [];
console.log(`image ${W}x${H}  pose (${eye.join(', ')})  hudYaw ${Number(HY)}  camera yaw ${yaw.toFixed(4)}  pitch ${pitch}`);
for (const [name, b, colour] of BOXES) {
  const pts = [];
  for (const x of [b[0], b[1]]) for (const y of [b[2], b[3]]) for (const z of [b[4], b[5]]) {
    const q = project([x, y, z]);
    if (q) pts.push(q);
  }
  if (!pts.length) {
    console.log(`  ${colour}  off screen entirely  ${name}`);
    continue;
  }
  const xs = pts.map((q) => q[0]);
  const ys = pts.map((q) => q[1]);
  const raw = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const r = [Math.max(0, raw[0]), Math.max(0, raw[1]), Math.min(W - 1, raw[2]), Math.min(H - 1, raw[3])];
  const on = raw[2] > 0 && raw[0] < W && raw[3] > 0 && raw[1] < H;
  console.log(
    `  ${colour}  px x ${raw[0].toFixed(0).padStart(5)}..${raw[2].toFixed(0).padStart(5)}  y ${raw[1].toFixed(0).padStart(4)}..${raw[3].toFixed(0).padStart(4)}  ${on ? 'ON' : 'off'}  ${name}`,
  );
  if (on && r[2] > r[0] && r[3] > r[1]) rects.push({ r, colour });
}
console.log('');
for (const [name, p] of POINTS) {
  const q = project(p);
  console.log(
    q ? `  ${name.padEnd(20)} px (${q[0].toFixed(0).padStart(5)}, ${q[1].toFixed(0).padStart(4)})` : `  ${name.padEnd(20)} behind`,
  );
}

const outW = Number(OUTW);
const s = outW / W;
const outH = Math.round(H * s);

/** A legend, because a picture of coloured rectangles names nothing. */
const legend = rects.map(({ colour }, i) => ({ colour, key: BOXES[i]?.[0] ?? '' }));
const lines = BOXES.map(([name, , colour]) => ({ name, colour }));
const rowH = 15;
const legendW = Math.min(outW - 12, 330);
const legendH = 20 + lines.length * rowH;
const legendSvg = [
  `<rect x="6" y="${6}" width="${legendW}" height="${legendH}" fill="rgba(0,0,0,0.72)" stroke="#888" stroke-width="1"/>`,
  `<text x="12" y="${6 + 13}" fill="#fff" font-family="monospace" font-size="11">steel-blue = existing wall | colours = my new runs</text>`,
  ...lines.map(
    ({ name, colour }, i) =>
      `<rect x="12" y="${6 + 20 + i * rowH}" width="10" height="9" fill="${colour}"/>` +
      `<text x="27" y="${6 + 28 + i * rowH}" fill="#eee" font-family="monospace" font-size="10">${name.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`,
  ),
].join('');

const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}">`,
  ...rects.map(
    ({ r, colour }) =>
      `<rect x="${(r[0] * s).toFixed(1)}" y="${(r[1] * s).toFixed(1)}" width="${Math.max(1, (r[2] - r[0]) * s).toFixed(1)}" height="${Math.max(1, (r[3] - r[1]) * s).toFixed(1)}" fill="none" stroke="${colour}" stroke-width="2"/>`,
  ),
  legendSvg,
  `</svg>`,
].join('');

const overlayPng = await sharp(Buffer.from(svg)).png().toBuffer();
const buf = await sharp(inp)
  .resize({ width: outW })
  .composite([{ input: overlayPng, top: 0, left: 0 }])
  .jpeg({ quality: 82 })
  .toBuffer();
writeFileSync(out, buf);
console.log(`\nwrote ${out} (${(buf.length / 1024).toFixed(0)}KB)`);