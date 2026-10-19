/**
 * Does the leaf keep-out actually work, and does the house still walk?
 *
 * _reach2.js named the cause: 13 of 14 door leaves let a collision-legal eye reach 0.000-0.003 m of a
 * triangle, 53 to 76 grid points each inside the 0.1 m near plane, because the house gives a leaf no
 * collider — "ajar, no blocker, no interaction" for the interior ones, "a swinging leaf has no collider
 * of its own" for the two that move. The fix just written measures each leaf's own world vertices and
 * lays 4 boxes along its width.
 *
 * This runs that measurement against the *installed* build, adds the boxes to the live collider array,
 * and asks the two questions that decide whether it ships:
 *
 *   1. Does the nearest a collision-legal eye can get to a leaf triangle go from 0.000 m to past the
 *      0.1 m near plane, on every leaf, with the armed doors both shut and open?
 *   2. Is every doorway still walkable? A leaf stands about 57 degrees across its opening, so a box
 *      round it claims floor. Counted as connected components of legal cells in a 5 m window centred on
 *      each doorway: if a door seals, its window's component count goes up and its largest component
 *      shrinks. That is the check the "0.08 m of slack" worry needs, and reasoning cannot answer it.
 *
 *   node tools/cdp.mjs --file tools/_leafcheck.js
 */
(() => {
  const d = window.__daayan;
  const p = d.player;
  const scene = d.engine.scene;
  const EYE = p.opts.eyeHeight;
  const RAD = p.opts.radius;
  scene.updateMatrixWorld(true);

  /** FPController.collidesAabb, transcribed, over whatever collider array is passed. */
  const blocked = (list, x, y, z) => {
    const minY = y - EYE, maxY = y;
    for (const q of list) {
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

  /** Fixtures.leafBoxes, transcribed, so what is measured here is what will ship. */
  const leafBoxes = (parts, segs = 4) => {
    const pts = [];
    for (const part of parts) {
      part.updateWorldMatrix(true, true);
      part.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        const pos = o.geometry.attributes.position;
        const el = o.matrixWorld.elements;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
          pts.push(
            el[0] * x + el[4] * y + el[8] * z + el[12],
            el[1] * x + el[5] * y + el[9] * z + el[13],
            el[2] * x + el[6] * y + el[10] * z + el[14],
          );
        }
      });
    }
    const n = pts.length / 3;
    if (n < 3) return [];
    const at = (i, k) => pts[i * 3 + k] ?? 0;
    let yLo = Infinity, yHi = -Infinity, cx = 0, cz = 0;
    for (let i = 0; i < n; i++) {
      cx += at(i, 0); cz += at(i, 2);
      const y = at(i, 1);
      if (y < yLo) yLo = y;
      if (y > yHi) yHi = y;
    }
    cx /= n; cz /= n;
    const far = (fx, fz) => {
      let best = -1, hit = 0;
      for (let i = 0; i < n; i++) {
        const dx = at(i, 0) - fx, dz = at(i, 2) - fz;
        const d2 = dx * dx + dz * dz;
        if (d2 > best) { best = d2; hit = i; }
      }
      return hit;
    };
    const a = far(cx, cz);
    const ax = at(a, 0), az = at(a, 2);
    const b = far(ax, az);
    const bx = at(b, 0), bz = at(b, 2);
    const len = Math.hypot(bx - ax, bz - az);
    if (!(len > 1e-4)) return [];
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    const step = len / segs, pad = step * 0.2;
    const out = [];
    for (let k = 0; k < segs; k++) {
      const t0 = k * step - pad, t1 = (k + 1) * step + pad;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < n; i++) {
        const px = at(i, 0), pz = at(i, 2);
        const t = (px - ax) * ux + (pz - az) * uz;
        if (t < t0 || t > t1) continue;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (pz < z0) z0 = pz;
        if (pz > z1) z1 = pz;
      }
      if (x0 > x1) continue;
      out.push({ minX: x0, maxX: x1, minY: yLo, maxY: yHi, minZ: z0, maxZ: z1 });
    }
    return out;
  };

  // Leaves by placement root, as _reach2.js found them: eight of the fourteen are clones under their
  // own ids, so /door-inner/ alone finds one of them.
  const groups = new Map();
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    let root = null;
    for (let q = o; q; q = q.parent) if (/^door[-.]/.test(q.name || '')) root = q;
    if (!root) return;
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(o);
  });

  /** UpperDoor.LEAF_PARTS: door.glb ships a frame too, and a keep-out round a frame seals the opening. */
  const isLeafMesh = (o) => {
    for (let q = o; q; q = q.parent) {
      const nm = (q.name || '').toLowerCase();
      if (nm.includes('door_') || nm.includes('handle')) return true;
      if (/^door[-.]/.test(q.name || '')) break;
    }
    return false;
  };

  const worldTris = (meshes) => {
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

  /** Nearest a collision-legal eye gets to a leaf triangle, on a 5 cm grid over the leaf's footprint. */
  const nearest = (list, T, lo, hi) => {
    const eyeY = lo[1] + EYE;
    let best = Infinity, at = null, u10 = 0, legal = 0;
    for (let x = lo[0] - 1.5; x <= hi[0] + 1.5; x += 0.05) {
      for (let z = lo[2] - 1.5; z <= hi[2] + 1.5; z += 0.05) {
        if (blocked(list, x, eyeY, z)) continue;
        legal++;
        let m = Infinity;
        for (const t of T) { const dd = distTri([x, eyeY, z], t); if (dd < m) m = dd; if (m < 1e-4) break; }
        if (m < 0.1) u10++;
        if (m < best) { best = m; at = [x, z]; }
      }
    }
    return { best, at, u10, legal, eyeY };
  };

  /**
   * Connected components of legal cells in a 5 m window on a 10 cm grid, and the largest one's size.
   * A doorway that seals splits its window in two and loses most of its largest component; furniture
   * already makes islands, which is why the number that matters is the change, not the count itself.
   */
  const window5 = (list, cx, cz, eyeY, half = 2.5, cell = 0.1) => {
    const w = Math.round((half * 2) / cell) + 1;
    const ok = new Uint8Array(w * w);
    let legal = 0;
    for (let i = 0; i < w; i++) {
      for (let j = 0; j < w; j++) {
        const x = cx - half + i * cell, z = cz - half + j * cell;
        if (!blocked(list, x, eyeY, z)) { ok[i * w + j] = 1; legal++; }
      }
    }
    const seen = new Uint8Array(w * w);
    let comps = 0, biggest = 0;
    const stack = [];
    for (let s = 0; s < w * w; s++) {
      if (!ok[s] || seen[s]) continue;
      comps++;
      let size = 0;
      stack.push(s);
      seen[s] = 1;
      while (stack.length) {
        const c = stack.pop();
        size++;
        const ci = (c / w) | 0, cj = c % w;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = ci + di, nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= w || nj >= w) continue;
          const nk = ni * w + nj;
          if (!ok[nk] || seen[nk]) continue;
          seen[nk] = 1;
          stack.push(nk);
        }
      }
      if (size > biggest) biggest = size;
    }
    return { legal, comps, biggest };
  };

  const out = [];
  const f = (v, n = 3) => (v === Infinity ? '  inf' : v.toFixed(n));

  // The two that swing are armed in code and keep a blocker in the opening; the rest are the static
  // rows now carrying `leaf: 4`. Told apart by the pivot the arm functions add.
  const rows = [];
  for (const [root, meshes] of groups) {
    let pivot = null;
    for (const m of meshes) for (let q = m; q && q !== root.parent; q = q.parent) if (/\.pivot$/.test(q.name || '')) pivot = q;
    const armed = pivot !== null;
    // UpperDoor measures over LEAF_PARTS only; InnerDoor's file is all leaf, so the filter keeps
    // everything there. A static row measures over its whole root, frame included, because those rows
    // are leaf-only files — that is what `leaf: 4`'s doc restricts it to.
    const keep = armed ? meshes.filter(isLeafMesh) : meshes;
    rows.push({ root, meshes, keep: keep.length > 0 ? keep : meshes, armed, pivot });
  }
  rows.sort((a, b) => (a.root.name < b.root.name ? -1 : 1));

  // The build under test already pushed its keep-outs, so `fixed` is the real array and `base` is it
  // with those boxes taken back out. Recomputing them here and matching by value is the stronger test:
  // if the shipped `leafBoxes` and this transcription of it disagree, `matched` says so.
  const fixed = p.aabbs;
  const same = (a, b) =>
    Math.abs(a.minX - b.minX) < 1e-6 && Math.abs(a.maxX - b.maxX) < 1e-6 &&
    Math.abs(a.minY - b.minY) < 1e-6 && Math.abs(a.maxY - b.maxY) < 1e-6 &&
    Math.abs(a.minZ - b.minZ) < 1e-6 && Math.abs(a.maxZ - b.maxZ) < 1e-6;
  const taken = new Set();
  let expected = 0, matched = 0;
  for (const r of rows) {
    r.boxes = leafBoxes(r.armed ? r.keep : [r.root], 4);
    r.hit = 0;
    expected += r.boxes.length;
    for (const b of r.boxes) {
      for (let i = 0; i < fixed.length; i++) {
        if (taken.has(i) || !same(b, fixed[i])) continue;
        taken.add(i);
        r.hit++;
        matched++;
        break;
      }
    }
  }
  const base = fixed.filter((_, i) => !taken.has(i));
  out.push(`colliders  live ${fixed.length}   leaf boxes expected ${expected}  matched in live array ${matched}   base without them ${base.length}`);
  out.push(`leaves ${rows.length}   zero-box ${rows.filter((r) => r.boxes.length === 0).map((r) => r.root.name).join(',') || 'none'}`);
  out.push('');

  out.push('name                       boxes hit  widest  eyeY   before: near  <0.10   after: near  <0.10   legal');
  for (const r of rows) {
    const { T, lo, hi } = worldTris(r.keep);
    const b0 = nearest(base, T, lo, hi);
    const b1 = nearest(fixed, T, lo, hi);
    let wide = 0;
    for (const b of r.boxes) wide = Math.max(wide, b.maxX - b.minX, b.maxZ - b.minZ);
    r.before = b0;
    r.after = b1;
    r.centre = [(lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2];
    r.eyeY = b0.eyeY;
    out.push(
      `${(r.root.name + (r.armed ? ' *' : '')).padEnd(26)} ${String(r.boxes.length).padStart(5)} ${String(r.hit).padStart(3)}  ${f(wide, 2)}   ${f(b0.eyeY, 2)}` +
      `        ${f(b0.best)}  ${String(b0.u10).padStart(5)}         ${f(b1.best)}  ${String(b1.u10).padStart(5)}   ${String(b1.legal).padStart(5)}`,
    );
  }
  out.push('');
  // Question 2. Same window, same grid, before and after. `comps` rising or `biggest` collapsing is a
  // sealed doorway; both holding is a doorway that still walks.
  out.push('name                       legal before/after   comps before/after   biggest before/after   verdict');
  for (const r of rows) {
    const w0 = window5(base, r.centre[0], r.centre[1], r.eyeY);
    const w1 = window5(fixed, r.centre[0], r.centre[1], r.eyeY);
    const lost = w0.biggest > 0 ? 1 - w1.biggest / w0.biggest : 0;
    const bad = w1.comps > w0.comps || lost > 0.35;
    r.win = [w0, w1];
    out.push(
      `${r.root.name.padEnd(26)} ${String(w0.legal).padStart(5)} ${String(w1.legal).padStart(5)}` +
      `        ${String(w0.comps).padStart(5)} ${String(w1.comps).padStart(5)}` +
      `           ${String(w0.biggest).padStart(6)} ${String(w1.biggest).padStart(6)}` +
      `        ${bad ? 'SEALED?' : 'walks'}  -${(lost * 100).toFixed(0)}%`,
    );
  }
  out.push('');
  // The armed pair, opened. This is the state the bug was reported in: the blocker filling the opening
  // is dropped below the world, and until this fix the swung leaf stood in the walk path with nothing
  // round it. trackLeaf re-measures at every tween step, so what is measured here is the end state.
  const OPEN = (100 * Math.PI) / 180;
  for (const r of rows.filter((q) => q.armed)) {
    const el = r.root.matrixWorld.elements;
    const rx = el[12], rz = el[14];
    // The blocker: aabbOf(x, UP_Y, z, 0.14, half, top) — 0.28 m across the opening, 1.2 to 1.4 m along
    // it. Wall colliders are thin too, so the length has to be part of what picks it out.
    let block = null, bd = Infinity;
    for (const b of base) {
      if (Math.abs(b.minY - 2.4) > 0.25) continue;
      const dx = b.maxX - b.minX, dz = b.maxZ - b.minZ;
      const thin = Math.min(dx, dz), long = Math.max(dx, dz);
      if (thin < 0.2 || thin > 0.36 || long < 1.0 || long > 1.6) continue;
      const dist = Math.hypot((b.minX + b.maxX) / 2 - rx, (b.minZ + b.maxZ) / 2 - rz);
      if (dist < bd) { bd = dist; block = b; }
    }
    const others = [];
    for (const q of rows) if (q !== r) for (const b of q.boxes) others.push(b);

    const was = r.pivot.rotation.y;
    r.pivot.rotation.y = was + OPEN;
    scene.updateMatrixWorld(true);
    const open = leafBoxes(r.keep, 4);
    const noBlock = base.filter((b) => b !== block);
    const listA = noBlock.concat(others, open);
    const { T, lo, hi } = worldTris(r.keep);
    const o0 = nearest(noBlock, T, lo, hi);
    const o1 = nearest(listA, T, lo, hi);
    const wo0 = window5(noBlock, r.centre[0], r.centre[1], r.eyeY);
    const wo1 = window5(listA, r.centre[0], r.centre[1], r.eyeY);
    r.pivot.rotation.y = was;
    scene.updateMatrixWorld(true);

    out.push(`${r.root.name} open 100deg   pivot ${r.pivot.name}   blocker ${block ? `x ${f(block.minX, 2)}..${f(block.maxX, 2)} z ${f(block.minZ, 2)}..${f(block.maxZ, 2)} (${f(bd, 2)} m off root)` : 'NOT FOUND'}`);
    out.push(`  leaf now x ${f(lo[0], 2)}..${f(hi[0], 2)}  z ${f(lo[2], 2)}..${f(hi[2], 2)}   boxes ${open.length}`);
    out.push(`  nearest legal eye   before ${f(o0.best)} (<0.10 ${o0.u10})   after ${f(o1.best)} (<0.10 ${o1.u10})   legal ${o1.legal}`);
    out.push(`  window  legal ${wo0.legal} -> ${wo1.legal}   comps ${wo0.comps} -> ${wo1.comps}   biggest ${wo0.biggest} -> ${wo1.biggest}`);
  }
  out.push('');
  /* LEAFCHECK_TAIL */
  return out.join('\n');
})()
