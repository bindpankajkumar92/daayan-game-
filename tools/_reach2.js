/**
 * Reachability, done right: the correct pivot, and every leaf in the house.
 *
 * _pivot.js found the flaw in the three probes before it. There are four objects named `inner-door.pivot` —
 * the armed one under `door-inner.glb`, and a dead copy under each of `door-up-back`, `door-up-child` and
 * `door-up-shrine`, because those rows are `clone: true` of the already-armed door. Every one of those probes
 * did `scene.traverse((o) => { if (o.name === 'inner-door.pivot') pivot = o; })`, which keeps the *last*
 * match, so they were all turning door-up-shrine's dead pivot and reporting that the leaf never moved. With
 * the right pivot a 90 deg turn moves the leaf from (19.817, 1.750) to (20.392, 1.251), as designed.
 *
 * That invalidates _legal.js's "door open" row: its 0.003 m came from dropping the blocker while the leaf
 * still stood shut in the opening, not from the swing. _legalflip.js's numbers survive as what they are — the
 * eye inside a shut leaf flips up to 295 px and hiding the leaf takes it to 0 — but the question of whether a
 * *properly opened* door leaves a reachable overlap is still open, and it is the question that decides the fix.
 *
 * The clones also mean the earlier leaf finder was wrong: /door-inner/ matches only the armed root, so the
 * seven other leaves in the house were never measured. Here a leaf is any mesh under a root named `door-*`,
 * grouped by that root.
 *
 * For each leaf: its world box, the yaw its box implies against the yaw its placement asked for, and the
 * nearest a collision-legal eye can get to one of its triangles. Then the armed door again with its pivot
 * actually turned and its blocker actually dropped.
 *
 *   node tools/cdp.mjs --file tools/_reach2.js
 */
(() => {
  const d = window.__daayan;
  const p = d.player;
  const scene = d.engine.scene;
  const EYE = p.opts.eyeHeight;
  const RAD = p.opts.radius;
  scene.updateMatrixWorld(true);

  const blocked = (x, y, z) => {
    const minY = y - EYE, maxY = y;
    for (const q of p.aabbs) {
      if (q.maxY <= minY + 0.05) continue;
      if (q.minY >= maxY + 0.05) continue;
      if (x + RAD > q.minX && x - RAD < q.maxX && maxY > q.minY && minY < q.maxY && z + RAD > q.minZ && z - RAD < q.maxZ) return true;
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

  // A leaf is any mesh under a placement root named door-*, grouped by that root. This is what the earlier
  // /door-inner/ finder missed: seven of the eight leaves are clones under their own ids.
  const groups = new Map();
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    let root = null;
    for (let q = o; q; q = q.parent) if (/^door[-.]/.test(q.name || '')) root = q;
    if (!root) return;
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(o);
  });

  /** World triangles and world box of one leaf, recomputed after any pivot move. */
  const geom = (meshes) => {
    scene.updateMatrixWorld(true);
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
    return { T, lo, hi };
  };

  /** Nearest a collision-legal eye gets to a leaf triangle, on a 5 cm grid over the leaf's own footprint. */
  const nearest = (T, lo, hi) => {
    const eyeY = lo[1] + EYE;
    let best = Infinity, at = null, u10 = 0, u35 = 0, legal = 0;
    for (let x = lo[0] - 1.5; x <= hi[0] + 1.5; x += 0.05) {
      for (let z = lo[2] - 1.5; z <= hi[2] + 1.5; z += 0.05) {
        if (blocked(x, eyeY, z)) continue;
        legal++;
        let m = Infinity;
        for (const t of T) { const dd = distTri([x, eyeY, z], t); if (dd < m) m = dd; if (m < 1e-4) break; }
        if (m < 0.1) u10++;
        if (m < 0.35) u35++;
        if (m < best) { best = m; at = [x, z]; }
      }
    }
    return { best, at, u10, u35, legal, eyeY };
  };

  const out = [];
  out.push(`radius ${RAD} m, eye ${EYE} m, near plane ${d.engine.camera.near} m, ${p.aabbs.length} colliders, ${groups.size} leaves`);
  out.push('');
  out.push('leaf              box x             box z           tri  eye y  nearest  <0.10  <0.35');
  const rows = [];
  for (const [root, meshes] of groups) {
    const { T, lo, hi } = geom(meshes);
    const r = nearest(T, lo, hi);
    rows.push({ name: root.name || '(unnamed)', lo, hi, tris: T.length, ...r });
  }
  rows.sort((a, b) => a.best - b.best);
  for (const r of rows) {
    out.push(
      `${r.name.slice(0, 17).padEnd(17)} ${r.lo[0].toFixed(2)}..${r.hi[0].toFixed(2)}`.padEnd(35) +
        `${r.lo[2].toFixed(2)}..${r.hi[2].toFixed(2)}`.padEnd(16) +
        `${String(r.tris).padStart(4)} ${r.eyeY.toFixed(2).padStart(6)} ${r.best.toFixed(3).padStart(8)} ${String(r.u10).padStart(6)} ${String(r.u35).padStart(6)}`,
    );
  }

  // Now the armed door, opened for real: the pivot that is an ancestor of its own leaf, and the blocker
  // dropped the way onUse drops it.
  const armedRoot = [...groups.keys()].find((r) => /^door-inner/.test(r.name || ''));
  const armedMeshes = groups.get(armedRoot) || [];
  let pivot = null;
  armedRoot.traverse((o) => { if (!pivot && o.name === 'inner-door.pivot') pivot = o; });
  const blocker = p.aabbs.find(
    (q) => Math.abs((q.minX + q.maxX) / 2 - 19.855) < 0.02 && Math.abs((q.minZ + q.maxZ) / 2 - 1.75) < 0.05 && q.maxX - q.minX < 0.4,
  );
  out.push('');
  if (!pivot || !blocker) {
    out.push(`armed door: pivot ${pivot ? 'found' : 'MISSING'}, blocker ${blocker ? 'found' : 'MISSING'} — open case not testable`);
  } else {
    const shut = pivot.rotation.y;
    const kept = { minY: blocker.minY, maxY: blocker.maxY };
    for (const [label, ang, drop] of [['shut', 0, false], ['open 100 deg', (100 * Math.PI) / 180, true]]) {
      pivot.rotation.y = shut + ang;
      if (drop) { blocker.minY = -60; blocker.maxY = -59.8; }
      const { T, lo, hi } = geom(armedMeshes);
      const r = nearest(T, lo, hi);
      out.push(
        `armed door ${label.padEnd(13)} box x ${lo[0].toFixed(2)}..${hi[0].toFixed(2)}  z ${lo[2].toFixed(2)}..${hi[2].toFixed(2)}   ` +
          `nearest legal eye ${r.best.toFixed(3)} m at (${r.at ? r.at[0].toFixed(2) : '-'}, ${r.at ? r.at[1].toFixed(2) : '-'})   ` +
          `<0.10 ${r.u10}   <0.35 ${r.u35}   legal ${r.legal}`,
      );
      blocker.minY = kept.minY;
      blocker.maxY = kept.maxY;
    }
    pivot.rotation.y = shut;
    scene.updateMatrixWorld(true);
  }
  return out.join('\n');
})()
