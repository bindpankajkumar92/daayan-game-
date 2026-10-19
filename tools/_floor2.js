/**
 * The upper flat's floor, by exact downward ray rather than by bounding box.
 *
 * _floor.js used box containment and so cannot tell a floor from a trim run whose box happens to span
 * the room: `Object_10` reports y 2.371..2.397 over x 14.40..24.44, z -0.99..9.28, which is either the
 * flat's boards or a strip of skirting with a wide box. The difference decides the whole question,
 * because `upper-patch-floor-0` sits at 2.340 — UPPER_PATCH.floorY, deliberately 1 cm under what
 * HouseRooms records as the model's 2.35 slab so the two do not z-fight — and if the model's real
 * walkable surface is 2.397 then over the strip the model does *not* floor, the player is standing 5.7 cm
 * low on a patch with a hard edge along z -0.99. That edge is a band across the doorway approach.
 *
 * So: intersect a straight-down ray with every candidate triangle, in world space, and report the
 * topmost hit and its owner at each grid point. Also the controller's own `groundY`, since what the
 * player stands on and what the eye sees have to agree.
 *
 *   CDP_PORT=9223 CDP_MATCH=5199 node tools/cdp.mjs --file tools/_floor2.js
 */
(() => {
  const d = window.__daayan;
  const scene = d.engine.scene;
  const p = d.player;
  scene.updateMatrixWorld(true);
  const out = [];

  // Candidates: anything drawn with triangles anywhere near the storey's floor band.
  const cands = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    let q = o;
    for (; q; q = q.parent) if (!q.visible) return;
    const g = o.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox.clone().applyMatrix4(o.matrixWorld);
    if (b.min.y > 2.7 || b.max.y < 2.1) return;
    if (b.max.x < 13.5 || b.min.x > 25.5 || b.max.z < -12 || b.min.z > 5) return;
    cands.push({ o, b });
  });

  /**
   * Highest triangle under (x, z), by barycentric test on the xz projection. Exact, and slow enough to
   * matter only because the grid is small: the alternative is Raycaster, which cannot be imported into
   * an expression evaluated in the page.
   */
  const under = (x, z) => {
    let bestY = -Infinity, bestName = 'nothing';
    const el = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const { o, b } of cands) {
      if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue;
      const g = o.geometry;
      const pos = g.getAttribute('position');
      const idx = g.getIndex();
      const m = o.matrixWorld.elements;
      const n = idx ? idx.count : pos.count;
      for (let t = 0; t < n; t += 3) {
        for (let k = 0; k < 3; k++) {
          const i = idx ? idx.getX(t + k) : t + k;
          const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
          el[k * 3] = m[0] * vx + m[4] * vy + m[8] * vz + m[12];
          el[k * 3 + 1] = m[1] * vx + m[5] * vy + m[9] * vz + m[13];
          el[k * 3 + 2] = m[2] * vx + m[6] * vy + m[10] * vz + m[14];
        }
        const ax = el[0], ay = el[1], az = el[2];
        const bx = el[3], by = el[4], bz = el[5];
        const cx = el[6], cy = el[7], cz = el[8];
        // Signed areas in the xz plane. A vertical triangle has denom ~0 and cannot be stood on.
        const denom = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
        if (Math.abs(denom) < 1e-9) continue;
        const w1 = ((x - ax) * (cz - az) - (cx - ax) * (z - az)) / denom;
        const w2 = ((bx - ax) * (z - az) - (x - ax) * (bz - az)) / denom;
        if (w1 < -1e-6 || w2 < -1e-6 || w1 + w2 > 1 + 1e-6) continue;
        const y = ay + w1 * (by - ay) + w2 * (cy - ay);
        if (y > 2.7 || y < 2.1) continue;
        if (y > bestY) { bestY = y; bestName = o.name || o.type; }
      }
    }
    return { y: bestY, name: bestName };
  };

  const home = p.position.clone();
  const locked = p.movementLocked;
  out.push(`${'point'.padEnd(15)} ${'top surface'.padEnd(30)} groundY`);
  try {
    p.movementLocked = true;
    for (const z of [-2.2, -1.7, -1.4, -1.1, -0.9, -0.6, 0.0, 1.0, 2.5, 3.5]) {
      for (const x of [15.0, 16.5, 18.0, 19.5, 22.0]) {
        const h = under(x, z);
        p.position.set(x, 4.1, z);
        p.velocity.set(0, 0, 0);
        d.scene.update(1 / 60);
        const gy = p.groundY;
        out.push(`${`${x.toFixed(1)}, ${z.toFixed(1)}`.padEnd(15)} ${(h.y === -Infinity ? 'nothing in 2.1..2.7' : `${h.name} @ ${h.y.toFixed(3)}`).padEnd(30)} ${typeof gy === 'number' ? gy.toFixed(3) : String(gy)}`);
      }
      out.push('');
    }
  } finally {
    p.position.copy(home);
    p.velocity.set(0, 0, 0);
    p.movementLocked = locked;
    d.scene.update(1 / 60);
  }
  return out.join('\n');
})()
