import { fistTris, renderCamView } from './_test_render.mjs';

function makeRot(rx, ry, rz) {
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  const m00 = cz * cy;
  const m10 = sz * cy;
  const m20 = -sy;
  const m01 = cz * sy * sx - sz * cx;
  const m11 = sz * sy * sx + cz * cx;
  const m21 = cy * sx;
  const m02 = cz * sy * cx + sz * sx;
  const m12 = sz * sy * cx - cz * sx;
  const m22 = cy * cx;
  return (v) => [
    m00 * v[0] + m01 * v[1] + m02 * v[2],
    m10 * v[0] + m11 * v[1] + m12 * v[2],
    m20 * v[0] + m21 * v[1] + m22 * v[2],
  ];
}

const DEG = Math.PI / 180;

async function test(name, rx, ry, rz, gripOffset, holdPos = [-0.185, -0.065, -0.27], scale = 0.00095) {
  const rot = makeRot(rx * DEG, ry * DEG, rz * DEG);
  const gx = gripOffset[0], gy = gripOffset[1], gz = gripOffset[2];

  const fistInHold = fistTris.map(t => {
    const res = new Float64Array(12);
    for (let v = 0; v < 3; v++) {
      const p = [
        (t[v * 3] - gx) * scale,
        (t[v * 3 + 1] - gy) * scale,
        (t[v * 3 + 2] - gz) * scale,
      ];
      const r = rot(p);
      res[v * 3] = r[0];
      res[v * 3 + 1] = r[1];
      res[v * 3 + 2] = r[2];
    }
    const n = rot([t[9], t[10], t[11]]);
    res[9] = n[0]; res[10] = n[1]; res[12] = n[2];
    return res;
  });

  await renderCamView(`refine_${name}.png`, fistInHold, holdPos);
}

// Fine tune around rx=5, ry=72, rz=-12:
// Test gripOffset:
// Raw fist center is [-205, 65, 24]. Let's vary y and z slightly so the handle sits perfectly in the palm curl.
await test('r1', 5, 72, -12, [-205, 65, 24]);
await test('r2', 5, 72, -12, [-205, 70, 22]);
await test('r3', 5, 72, -12, [-205, 60, 26]);
await test('r4', 2, 68, -8,  [-205, 66, 24]);
await test('r5', 8, 75, -15, [-205, 65, 24]);
