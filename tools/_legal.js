/**
 * How close can the player's eye actually get to the leaf?
 *
 * This is the question _fix.js left open. It proved the flip is the leaf and that raising the near plane
 * past it removes 97% of it, but the pose it proved that at — (19.855, 2.3) — is inside the closed slab
 * (world box x 19.74..19.89, z 1.21..2.29), and while the door is shut a blocker AABB fills the opening.
 * An artefact at a pose the player cannot occupy is not the bug the user is reporting.
 *
 * So: sweep every eye position on a 5 cm grid around the doorway, keep only the ones FPController would
 * allow — its own test, `collidesAabb`, transcribed rather than approximated, at the real 0.35 m radius and
 * the real vertical band — and report the nearest the eye can get to a leaf *triangle*, not to its box.
 * Done twice: with the door shut, and with it open the way `onUse` opens it (pivot to shut + 100 deg, and
 * the blocker dropped to y -60, which is exactly what makes the open case dangerous).
 *
 * No rendering here. If the closest legal approach is under the 0.1 m near plane the artefact is reachable
 * and the fix is to keep the eye out; if it is comfortably past it, the flip _fix.js measured is an
 * artefact of my sweep grid and the real defect is elsewhere.
 *
 *   node tools/cdp.mjs --file tools/_legal.js
 */
(() => {
  const d = window.__daayan;
  const p = d.player;
  const scene = d.engine.scene;
  const EYE = p.opts.eyeHeight;
  const R = p.opts.radius;
  const out = [];
  out.push(`radius ${R} m, eyeHeight ${EYE} m, ${p.aabbs.length} colliders`);

  /** FPController.collidesAabb, verbatim: p.y is the eye, the band is [eye - eyeHeight, eye]. */
  const blocked = (x, y, z) => {
    const minY = y - EYE, maxY = y;
    for (const a of p.aabbs) {
      if (a.maxY <= minY + 0.05) continue;
      if (a.minY >= maxY + 0.05) continue;
      if (x + R > a.minX && x - R < a.maxX && maxY > a.minY && minY < a.maxY && z + R > a.minZ && z - R < a.maxZ) return true;
    }
    return false;
  };

  let pivot = null;
  scene.traverse((o) => { if (o.name === 'inner-door.pivot') pivot = o; });
  const shut = pivot ? pivot.rotation.y : 0;
  // The blocker: aabbOf(UPPER_INNER.x, UP_Y, UPPER_INNER.z, 0.14, 0.6, top) — find it by its footprint
  // rather than by index, then drop it the way onUse does.
  const blocker = p.aabbs.find(
    (a) => Math.abs((a.minX + a.maxX) / 2 - 19.855) < 0.02 && Math.abs((a.minZ + a.maxZ) / 2 - 1.75) < 0.05 && a.maxX - a.minX < 0.4,
  );
  out.push(
    blocker
      ? `blocker found: x ${blocker.minX.toFixed(2)}..${blocker.maxX.toFixed(2)} y ${blocker.minY.toFixed(2)}..${blocker.maxY.toFixed(2)} z ${blocker.minZ.toFixed(2)}..${blocker.maxZ.toFixed(2)}`
      : 'blocker NOT FOUND by footprint — the open case below is then not a fair test',
  );

  const leaves = [];
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    for (let q = o; q; q = q.parent) if (/door-inner/.test(q.name || '')) { leaves.push(o); return; }
  });

  /** Every leaf triangle in world space, rebuilt after the pivot moves. */
  const tris = () => {
    scene.updateMatrixWorld(true);
    const acc = [];
    for (const o of leaves) {
      const g = o.geometry, pos = g.attributes.position, idx = g.index;
      const el = o.matrixWorld.elements;
      const n = idx ? idx.count : pos.count;
      for (let i = 0; i + 2 < n; i += 3) {
        const t = [];
        for (let k = 0; k < 3; k++) {
          const j = idx ? idx.getX(i + k) : i + k;
          const x = pos.getX(j), y = pos.getY(j), z = pos.getZ(j);
          t.push([el[0] * x + el[4] * y + el[8] * z + el[12], el[1] * x + el[5] * y + el[9] * z + el[13], el[2] * x + el[6] * y + el[10] * z + el[14]]);
        }
        acc.push(t);
      }
    }
    return acc;
  };

  /** Point-to-triangle distance, clamped barycentric — the real thing, not centroid distance. */
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
    const sq = a * s * s + 2 * b * s * tt + c * tt * tt + 2 * dd * s + 2 * ee * tt + f;
    return Math.sqrt(Math.max(0, sq));
  };

  const sweep = (label) => {
    const T = tris();
    let best = Infinity, bestAt = null, legal = 0, tested = 0, under10 = 0, under35 = 0;
    for (let x = 18.6; x <= 21.2; x += 0.05) {
      for (let z = 0.6; z <= 3.4; z += 0.05) {
        tested++;
        if (blocked(x, 4.1, z)) continue;
        legal++;
        // The eye, not the capsule: the near plane is about the camera point.
        const q = [x, 4.1, z];
        let m = Infinity;
        for (const t of T) { const dd = distTri(q, t); if (dd < m) m = dd; if (m < 1e-4) break; }
        if (m < 0.1) under10++;
        if (m < 0.35) under35++;
        if (m < best) { best = m; bestAt = [x, z]; }
      }
    }
    out.push(
      `${label.padEnd(12)} ${legal}/${tested} grid points legal   nearest eye-to-leaf ${best.toFixed(3)} m at ` +
        `(${bestAt ? bestAt[0].toFixed(2) : '-'}, ${bestAt ? bestAt[1].toFixed(2) : '-'})   under 0.10 m: ${under10}   under 0.35 m: ${under35}`,
    );
    return { best, bestAt };
  };

  const shutR = sweep('door shut');

  let openR = null;
  if (pivot && blocker) {
    const kept = { minY: blocker.minY, maxY: blocker.maxY };
    pivot.rotation.y = shut + (100 * Math.PI) / 180;
    blocker.minY = -60;
    blocker.maxY = -59.8;
    openR = sweep('door open');
    pivot.rotation.y = shut;
    blocker.minY = kept.minY;
    blocker.maxY = kept.maxY;
    scene.updateMatrixWorld(true);
  }

  out.push('');
  out.push(`near plane is ${d.engine.camera.near} m — anything the eye can reach closer than that produces the w -> 0 flip _fix.js measured`);
  if (openR && openR.best < 0.1) out.push(`REACHABLE with the door open: the eye gets to ${openR.best.toFixed(3)} m of the leaf at (${openR.bestAt[0].toFixed(2)}, ${openR.bestAt[1].toFixed(2)}), inside the near plane`);
  else if (openR) out.push(`open case closest approach ${openR.best.toFixed(3)} m — outside the near plane`);
  if (shutR.best < 0.1) out.push(`REACHABLE with the door shut at ${shutR.best.toFixed(3)} m`);
  return out.join('\n');
})()
