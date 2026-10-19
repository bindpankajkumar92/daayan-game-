/**
 * The same reachability test, over every leaf in the house rather than one.
 *
 * _legal.js settled UPPER_INNER: shut, the blocker keeps the eye 0.390 m off the leaf; open, the blocker is
 * dropped and the eye reaches 0.003 m — 41 legal grid points inside the 0.1 m near plane. The swinging leaf
 * has no collider of its own, so once it is open nothing keeps a head out of it.
 *
 * But UPPER_INNER is not the only leaf without a collider. ModelProps states the policy for the interior
 * ones outright — "Ajar, no blocker, no interaction: this house's policy for interior leaves" — so the five
 * rear-wing and three upper-wing leaves stand permanently in their doorways with nothing to stop the player
 * walking through them. If those are reachable too, the fix is a policy, not a patch to one door.
 *
 * Each leaf is found by its placement id, its own triangles are measured, and the grid is centred on its
 * own box. Same transcribed `collidesAabb`, same 0.35 m radius, same 5 cm grid, eye height off each leaf's
 * own storey so the upper wing is not tested at ground-floor eye level.
 *
 *   node tools/cdp.mjs --file tools/_legal-all.js
 */
(() => {
  const d = window.__daayan;
  const p = d.player;
  const scene = d.engine.scene;
  const EYE = p.opts.eyeHeight;
  const R = p.opts.radius;
  scene.updateMatrixWorld(true);

  const blocked = (x, y, z) => {
    const minY = y - EYE, maxY = y;
    for (const a of p.aabbs) {
      if (a.maxY <= minY + 0.05) continue;
      if (a.minY >= maxY + 0.05) continue;
      if (x + R > a.minX && x - R < a.maxX && maxY > a.minY && minY < a.maxY && z + R > a.minZ && z - R < a.maxZ) return true;
    }
    return false;
  };

  const distTri = (q, t) => {
    const [A, B, C] = t;
    const e0 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const e1 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const dv = [A[0] - q[0], A[1] - q[1], A[2] - q[2]];
    const a = e0[0] * e0[0] + e0[1] * e0[1] + e0[2] * e0[2];
    const b = e0[0] * e1[0] + e0[1] * e1[1] + e0[2] * e1[2];
    const c = e1[0] * e1[0] + e1[1] * e1[1] + e1[2] * e1[2];
    const dd = e0[0] * dv[0] + e0[1] * dv[1] + e0[2] * dv[2];
    const ee = e1[0] * dv[0] + e1[1] * dv[1] + e1[2] * dv[2];
    const f = dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2];
    let det = a * c - b * b, s = b * ee - c * dd, tt = b * dd - a * ee;
    if (s + tt <= det) {
      if (s < 0) { if (tt < 0) { if (dd < 0) { tt = 0; s = Math.min(1, Math.max(0, -dd / a)); } else { s = 0; tt = Math.min(1, Math.max(0, -ee / c)); } } else { s = 0; tt = Math.min(1, Math.max(0, -ee / c)); } }
      else if (tt < 0) { tt = 0; s = Math.min(1, Math.max(0, -dd / a)); }
      else { const inv = 1 / det; s *= inv; tt *= inv; }
    } else {
      if (s < 0) { const t0 = b + ee, t1 = c + dd; if (t1 > t0) { const n = t1 - t0, dn = a - 2 * b + c; s = Math.min(1, Math.max(0, n / dn)); tt = 1 - s; } else { s = 0; tt = Math.min(1, Math.max(0, -ee / c)); } }
      else if (tt < 0) { const t0 = b + dd, t1 = a + ee; if (t1 > t0) { const n = t1 - t0, dn = a - 2 * b + c; tt = Math.min(1, Math.max(0, n / dn)); s = 1 - tt; } else { tt = 0; s = Math.min(1, Math.max(0, -dd / a)); } }
      else { const n = c + ee - b - dd, dn = a - 2 * b + c; s = Math.min(1, Math.max(0, n / dn)); tt = 1 - s; }
    }
    return Math.sqrt(Math.max(0, a * s * s + 2 * b * s * tt + c * tt * tt + 2 * dd * s + 2 * ee * tt + f));
  };

  // Group the door-inner meshes by the placement root that owns them, so each leaf is measured on its own.
  const groups = new Map();
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    let root = null;
    for (let q = o; q; q = q.parent) if (/door-inner/.test(q.name || '')) root = q;
    if (!root) return;
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(o);
  });

  const out = [];
  out.push(`radius ${R} m, eyeHeight ${EYE} m, near plane ${d.engine.camera.near} m, ${p.aabbs.length} colliders`);
  out.push(`${groups.size} door-inner leaves placed`);
  out.push('');
  out.push('leaf                       centre            eye y   nearest  <0.10m  <0.35m  legal');

  const rows = [];
  for (const [root, meshes] of groups) {
    const T = [];
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const o of meshes) {
      const g = o.geometry, pos = g.attributes.position, idx = g.index;
      const el = o.matrixWorld.elements;
      const n = idx ? idx.count : pos.count;
      for (let i = 0; i + 2 < n; i += 3) {
        const t = [];
        for (let k = 0; k < 3; k++) {
          const j = idx ? idx.getX(i + k) : i + k;
          const x = pos.getX(j), y = pos.getY(j), z = pos.getZ(j);
          const w = [el[0] * x + el[4] * y + el[8] * z + el[12], el[1] * x + el[5] * y + el[9] * z + el[13], el[2] * x + el[6] * y + el[10] * z + el[14]];
          for (let m = 0; m < 3; m++) { if (w[m] < lo[m]) lo[m] = w[m]; if (w[m] > hi[m]) hi[m] = w[m]; }
          t.push(w);
        }
        T.push(t);
      }
    }
    const cx = (lo[0] + hi[0]) / 2, cz = (lo[2] + hi[2]) / 2;
    // Eye height on this leaf's own storey: its base plus the controller's eye height.
    const eyeY = lo[1] + EYE;
    let best = Infinity, bestAt = null, u10 = 0, u35 = 0, legal = 0;
    for (let x = cx - 1.6; x <= cx + 1.6; x += 0.05) {
      for (let z = cz - 1.6; z <= cz + 1.6; z += 0.05) {
        if (blocked(x, eyeY, z)) continue;
        legal++;
        let m = Infinity;
        for (const t of T) { const dd = distTri([x, eyeY, z], t); if (dd < m) m = dd; if (m < 1e-4) break; }
        if (m < 0.1) u10++;
        if (m < 0.35) u35++;
        if (m < best) { best = m; bestAt = [x, z]; }
      }
    }
    rows.push({ name: root.name || '(unnamed)', cx, cz, eyeY, best, bestAt, u10, u35, legal, tris: T.length });
  }
  rows.sort((a, b) => a.best - b.best);
  for (const r of rows) {
    out.push(
      `${r.name.slice(0, 26).padEnd(26)} (${r.cx.toFixed(2)}, ${r.cz.toFixed(2)})`.padEnd(45) +
        ` ${r.eyeY.toFixed(2).padStart(5)} ${r.best.toFixed(3).padStart(9)} ${String(r.u10).padStart(6)} ${String(r.u35).padStart(7)} ${String(r.legal).padStart(6)}`,
    );
  }
  out.push('');
  const bad = rows.filter((r) => r.u10 > 0);
  out.push(`${bad.length} of ${rows.length} leaves the eye can legally reach inside the near plane: ${bad.map((r) => r.name).join(', ') || 'none'}`);
  return out.join('\n');
})()
