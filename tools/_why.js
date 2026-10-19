/**
 * The hide did not fire where it should have. Why?
 *
 * _leaf.js: `door-up-back`'s leaf occupies world x 15.743..16.471, y 2.451..4.497, z -1.912..-0.947, and
 * _band.js found that leaf *drawn* from an eye at (16.5, 4.04, -1.10) — 0.029 m outside its box in x and
 * inside it on the other two axes. LEAF_HIDE is 0.20 m and the row carries `leaf: 4`, so `insideAny`
 * should have been true and the row should have been hidden. One of three things is wrong: the boxes do
 * not cover the slab where the eye is, the margin is not being applied, or `eye` in the cull is not the
 * object this probe is moving.
 *
 * So: rebuild `leafBoxes` exactly as Fixtures.ts does, print every box, and for a line of eye positions
 * walking through the doorway report the true nearest leaf triangle, what `insideAny` says at each
 * threshold, and what the row's `visible` actually came out as after a real scene update. Whichever column
 * disagrees with the others is the bug.
 *
 *   CDP_PORT=9223 CDP_MATCH=5199 node tools/cdp.mjs --file tools/_why.js
 */
(() => {
  const d = window.__daayan;
  const scene = d.engine.scene;
  const cam = d.engine.camera;
  const p = d.player;
  scene.updateMatrixWorld(true);
  const out = [];

  /** Fixtures.leafBoxes, ported: two farthest-point passes for the planar diameter, then overlapping windows. */
  const leafBoxes = (parts, segs) => {
    const pts = [];
    for (const part of parts) {
      part.updateWorldMatrix(true, true);
      part.traverse((o) => {
        if (!o.isMesh) return;
        const pos = o.geometry.getAttribute('position');
        const el = o.matrixWorld.elements;
        for (let i = 0; i < pos.count; i++) {
          const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
          pts.push([
            el[0] * vx + el[4] * vy + el[8] * vz + el[12],
            el[1] * vx + el[5] * vy + el[9] * vz + el[13],
            el[2] * vx + el[6] * vy + el[10] * vz + el[14],
          ]);
        }
      });
    }
    if (pts.length === 0) return [];
    let minY = Infinity, maxY = -Infinity, cxx = 0, czz = 0;
    for (const q of pts) { if (q[1] < minY) minY = q[1]; if (q[1] > maxY) maxY = q[1]; cxx += q[0]; czz += q[2]; }
    cxx /= pts.length; czz /= pts.length;
    const far = (ax, az) => {
      let best = null, bd = -1;
      for (const q of pts) {
        const dd = (q[0] - ax) ** 2 + (q[2] - az) ** 2;
        if (dd > bd) { bd = dd; best = q; }
      }
      return best;
    };
    const a = far(cxx, czz);
    const b = far(a[0], a[2]);
    const boxes = [];
    const step = 1 / segs;
    const pad = step * 0.2;
    for (let i = 0; i < segs; i++) {
      const t0 = Math.max(0, i * step - pad), t1 = Math.min(1, (i + 1) * step + pad);
      const x0 = a[0] + (b[0] - a[0]) * t0, z0 = a[2] + (b[2] - a[2]) * t0;
      const x1 = a[0] + (b[0] - a[0]) * t1, z1 = a[2] + (b[2] - a[2]) * t1;
      boxes.push({
        minX: Math.min(x0, x1), maxX: Math.max(x0, x1),
        minY, maxY,
        minZ: Math.min(z0, z1), maxZ: Math.max(z0, z1),
      });
    }
    return boxes;
  };
  const insideAny = (boxes, q, m) => boxes.some((b) =>
    q.x > b.minX - m && q.x < b.maxX + m && q.y > b.minY - m && q.y < b.maxY + m && q.z > b.minZ - m && q.z < b.maxZ + m);

  let root = null;
  scene.traverse((o) => { if (o.name === 'door-up-back') root = o; });
  if (!root) return 'door-up-back not in the scene';
  const boxes = leafBoxes([root], 4);
  out.push(`door-up-back leafBoxes(4): ${boxes.length}`);
  for (const b of boxes) {
    out.push(`  x ${b.minX.toFixed(3)}..${b.maxX.toFixed(3)}  y ${b.minY.toFixed(3)}..${b.maxY.toFixed(3)}  z ${b.minZ.toFixed(3)}..${b.maxZ.toFixed(3)}`);
  }
  out.push('');

  // The straight-line walk through this doorway, at standing eye height and at the round-3 pitch-down eye.
  const home = p.position.clone();
  const camHome = cam.position.clone();
  out.push(`${'eye'.padEnd(26)} ${'in .20'.padStart(6)} ${'in .10'.padStart(6)} ${'visible'.padStart(7)}`);
  try {
    for (const eyeY of [4.1, 4.04, 3.5]) {
      for (let z = -0.7; z >= -2.3; z -= 0.2) {
        const q = { x: 16.5, y: eyeY, z };
        cam.position.set(q.x, q.y, q.z);
        p.position.set(q.x, q.y, q.z);
        p.velocity.set(0, 0, 0);
        d.scene.update(1 / 60);
        out.push(`${`16.5, ${eyeY}, ${z.toFixed(1)}`.padEnd(26)} ${String(insideAny(boxes, q, 0.2)).padStart(6)} ${String(insideAny(boxes, q, 0.1)).padStart(6)} ${String(root.visible).padStart(7)}`);
      }
      out.push('');
    }
  } finally {
    p.position.copy(home);
    cam.position.copy(camHome);
    p.velocity.set(0, 0, 0);
    d.scene.update(1 / 60);
  }
  return out.join('\n');
})()
