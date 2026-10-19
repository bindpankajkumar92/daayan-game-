/**
 * Project world boxes onto the screenshot, from one pose.
 *
 * A hand-drawn annotation is a pixel region, and "which wall is that" is answerable exactly: the camera
 * knows where every box lands on screen. This prints each box's screen rectangle in the captured PNG's
 * own pixels, so an outline on a screenshot can be matched to a name instead of argued about.
 *
 * Usage:
 *   node tools/_proj.mjs <eyeX> <eyeY> <eyeZ> <hudYaw> <pitch> <imgW> <imgH> [fov=70]
 *
 * `hudYaw` is the readout's `yaw(...)` = atan2(dir.x, dir.z); the camera's own `facing.y` is that minus
 * pi, and the two are easy to confuse — the wrong one mirrors every result about the view axis.
 */
const [X = '16.84', Y = '4.1', Z = '1.29', HY = '3.11', P = '-0.2', W = '1272', H = '593', FOV = '70'] =
  process.argv.slice(2);

const eye = [Number(X), Number(Y), Number(Z)];
const yaw = Number(HY) - Math.PI;
const pitch = Number(P);
const tanV = Math.tan((Number(FOV) * Math.PI) / 360);
const tanH = tanV * (Number(W) / Number(H));

/** Name → [x0,x1, y0,y1, z0,z1]. Every line the stairwell work put in, plus the neighbours. */
const BOXES = {
  'kerb-north    (z 0.16..0.36)': [15.6, 18.61, 2.39, 2.85, 0.16, 0.36],
  'kerb-west     (x 15.6..15.8)': [15.6, 15.8, 2.39, 2.85, -1.93, 0.16],
  'kerb-south    (z -2.13..-1.93)': [15.7, 18.71, 2.39, 2.85, -2.13, -1.93],
  'cheek-south   (z -1.18..-1.08)': [16.21, 18.61, 0.2, 2.4, -1.18, -1.08],
  'room-north    (z -6.2..-6.0)': [15.6, 21.6, 0.2, 2.4, -6.2, -6.0],
  'room-west     (x 15.6..15.8)': [15.6, 15.8, 0.2, 2.4, -6.2, 0.61],
  'room-east     (x 21.4..21.6)': [21.4, 21.6, 0.2, 2.4, -6.2, 0.61],
  'room-south    (z 0.41..0.61)': [15.6, 21.6, 0.2, 2.4, 0.41, 0.61],
  'well-opening  (the stair)': [16.21, 18.61, 0.2, 2.4, -1.08, 0.16],
  'room-ceiling  (y 2.4 plane)': [15.6, 21.6, 2.36, 2.44, -6.2, 0.61],
};

const cos = Math.cos, sin = Math.sin;
function project(p) {
  const v = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
  // Euler 'YXZ': camera = Ry(yaw) * Rx(pitch); so camera-space = Rx(-pitch) * Ry(-yaw) * world-delta.
  const a = [v[0] * cos(yaw) - v[2] * sin(yaw), v[1], v[0] * sin(yaw) + v[2] * cos(yaw)];
  const b = [a[0], a[1] * cos(pitch) + a[2] * sin(pitch), -a[1] * sin(pitch) + a[2] * cos(pitch)];
  if (b[2] >= -1e-6) return null; // behind the camera
  const ndcX = b[0] / -b[2] / tanH;
  const ndcY = b[1] / -b[2] / tanV;
  return [((ndcX + 1) / 2) * Number(W), ((1 - ndcY) / 2) * Number(H), ndcX, ndcY];
}

console.log(`pose (${eye.join(', ')})  yaw ${Number(HY).toFixed(2)} (camera ${yaw.toFixed(3)})  pitch ${pitch}`);
console.log(`image ${W}x${H}  fov ${FOV}  tanH ${tanH.toFixed(3)}\n`);
for (const [name, b] of Object.entries(BOXES)) {
  const corners = [
    [b[0], b[2], b[4]], [b[1], b[2], b[4]], [b[0], b[3], b[4]], [b[1], b[3], b[4]],
    [b[0], b[2], b[5]], [b[1], b[2], b[5]], [b[0], b[3], b[5]], [b[1], b[3], b[5]],
  ].map(project).filter(Boolean);
  if (!corners.length) {
    console.log(`${name.padEnd(32)}  (all corners behind the camera)`);
    continue;
  }
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((n) => Math.round(n));
  const on = box[2] > 0 && box[0] < Number(W) && box[3] > 0 && box[1] < Number(H);
  console.log(`${name.padEnd(32)}  px x ${String(box[0]).padStart(5)}..${String(box[2]).padStart(5)}  y ${String(box[1]).padStart(4)}..${String(box[3]).padStart(4)}  ${on ? 'ON SCREEN' : 'off'}`);
}