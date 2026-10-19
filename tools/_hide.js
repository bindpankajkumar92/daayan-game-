/**
 * How near the eye may come to a door leaf before the leaf has to stop being drawn.
 *
 * The colliders worked for the eye (0.000-0.003 m -> 0.350-0.442 m on every leaf) and sealed the
 * kitchen and the store, 21.2 m2 each, because a 0.9 m opening with a leaf ajar in it does not hold a
 * 0.70 m body. So the twelve static leaves keep no collider and stop drawing instead. That swaps the
 * question: not "can the eye reach the slab" — it can, it always could — but "is the slab still being
 * drawn when it does". LEAF_HIDE is the answer and this measures it.
 *
 * For each leaf, over every collision-legal eye position on a 5 cm grid, standing and crouched, at each
 * floor height under it: count the positions where a leaf triangle is inside the 0.10 m near plane
 * while the hide test would still have the row visible. Zero is the pass. Swept over candidate
 * thresholds, so the shipped value is a measurement and not a guess.
 *
 *   CDP_PORT=9223 CDP_MATCH=5199 node tools/cdp.mjs --file tools/_hide.js
 */
(() => {
  const d = window.__daayan;
  const p = d.player;
  const scene = d.engine.scene;
  const EYE = p.opts.eyeHeight;
  const CROUCH = p.opts.crouchEyeHeight;
  const RAD = p.opts.radius;
  const CELL = 0.05;
  const NEAR = 0.1;
  const THRESHOLDS = [0.1, 0.12, 0.15, 0.18, 0.2, 0.25];
  scene.updateMatrixWorld(true);

  /** FPController.collidesAabb, with the eye height the player would have in that stance. */
  const blocked = (list, x, y, z, eyeH) => {
    const minY = y - eyeH, maxY = y;
    for (const q of list) {
      if (q.maxY <= minY + 0.05) continue;
      if (q.minY >= maxY + 0.05) continue;
      if (x + RAD > q.minX && x - RAD < q.maxX && maxY > q.minY && minY < q.maxY && z + RAD > q.minZ && z - RAD < q.maxZ) return true;
    }
    return false;
  };

  /** Fixtures.leafBoxes, ported vertex for vertex so the boxes are the ones the build ships. */
  const leafBoxes = (parts, segs) => {
    const pts = [];
    for (const part of parts) {
      part.updateWorldMatrix(true, true);
      part.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        const pos = o.geometry.getAttribute('position'), el = o.matrixWorld.elements;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
          pts.push(el[0] * x + el[4] * y + el[8] * z + el[12], el[1] * x + el[5] * y + el[9] * z + el[13], el[2] * x + el[6] * y + el[10] * z + el[14]);
        }
      });
    }
    const n = pts.length / 3;
    if (n < 3) return [];
    const at = (i, k) => pts[i * 3 + k];
    let yLo = Infinity, yHi = -Infinity, cx = 0, cz = 0;
    for (let i = 0; i < n; i++) {
      cx += at(i, 0);
      cz += at(i, 2);
      const y = at(i, 1);
      if (y < yLo) yLo = y;
      if (y > yHi) yHi = y;
    }
    cx /= n;
    cz /= n;
    const far = (fx, fz) => {
      let best = -1, hit = 0;
      for (let i = 0; i < n; i++) {
        const dx = at(i, 0) - fx, dz = at(i, 2) - fz, d2 = dx * dx + dz * dz;
        if (d2 > best) { best = d2; hit = i; }
      }
      return hit;
    };
    const a = far(cx, cz), ax = at(a, 0), az = at(a, 2);
    const b = far(ax, az), bx = at(b, 0), bz = at(b, 2);
    const len = Math.hypot(bx - ax, bz - az);
    if (!(len > 1e-4)) return [];
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    const step = len / segs, pad = step * 0.2, out = [];
    for (let k = 0; k < segs; k++) {
      const t0 = k * step - pad, t1 = (k + 1) * step + pad;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < n; i++) {
        const px = at(i, 0), pz = at(i, 2), t = (px - ax) * ux + (pz - az) * uz;
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

  /** ModelProps.insideAny — the shipped hide test, boxes grown by m, Chebyshev not Euclidean. */
  const insideAny = (boxes, x, y, z, m) => boxes.some((b) =>
    x > b.minX - m && x < b.maxX + m && y > b.minY - m && y < b.maxY + m && z > b.minZ - m && z < b.maxZ + m);

  const worldTris = (parts) => {
    const out = [];
    for (const part of parts) {
      part.updateWorldMatrix(true, true);
      part.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        const g = o.geometry, pos = g.getAttribute('position'), idx = g.getIndex(), el = o.matrixWorld.elements;
        const w = (i) => {
          const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
          return [el[0] * x + el[4] * y + el[8] * z + el[12], el[1] * x + el[5] * y + el[9] * z + el[13], el[2] * x + el[6] * y + el[10] * z + el[14]];
        };
        const count = idx ? idx.count : pos.count;
        for (let i = 0; i + 2 < count; i += 3) {
          const A = w(idx ? idx.getX(i) : i), B = w(idx ? idx.getX(i + 1) : i + 1), C = w(idx ? idx.getX(i + 2) : i + 2);
          out.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
        }
      });
    }
    return out;
  };

  /** Squared point-triangle distance, clamped barycentric — Ericson, Real-Time Collision Detection. */
  const d2Tri = (t, o, px, py, pz) => {
    const ax = t[o], ay = t[o + 1], az = t[o + 2];
    const bx = t[o + 3], by = t[o + 4], bz = t[o + 5];
    const cx = t[o + 6], cy = t[o + 7], cz = t[o + 8];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    let cxp, cyp, czp;
    if (d1 <= 0 && d2 <= 0) { cxp = ax; cyp = ay; czp = az; } else {
      const bpx = px - bx, bpy = py - by, bpz = pz - bz;
      const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
      if (d3 >= 0 && d4 <= d3) { cxp = bx; cyp = by; czp = bz; } else {
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) {
          const v = d1 / (d1 - d3);
          cxp = ax + v * abx; cyp = ay + v * aby; czp = az + v * abz;
        } else {
          const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
          const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
          if (d6 >= 0 && d5 <= d6) { cxp = cx; cyp = cy; czp = cz; } else {
            const vb = d5 * d2 - d1 * d6;
            if (vb <= 0 && d2 >= 0 && d6 <= 0) {
              const w = d2 / (d2 - d6);
              cxp = ax + w * acx; cyp = ay + w * acy; czp = az + w * acz;
            } else {
              const va = d3 * d6 - d5 * d4;
              if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
                const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
                cxp = bx + w * (cx - bx); cyp = by + w * (cy - by); czp = bz + w * (cz - bz);
              } else {
                const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
                cxp = ax + abx * v + acx * w; cyp = ay + aby * v + acy * w; czp = az + abz * v + acz * w;
              }
            }
          }
        }
      }
    }
    const dx = px - cxp, dy = py - cyp, dz = pz - czp;
    return dx * dx + dy * dy + dz * dz;
  };

  // The twelve rows that carry `leaf`. The other two roots are the armed pair — they keep colliders,
  // and a root carrying a dead `inner-door.pivot` clone is not evidence of arming, so this is by id.
  const STATIC = new Set(['door-bedroom', 'door-living', 'door-back-w', 'door-back-e', 'door-kitchen',
    'door-pooja', 'door-store', 'door-cellar', 'door-basement', 'door-up-back', 'door-up-child', 'door-up-shrine']);
  const roots = [];
  scene.traverse((o) => { if (/^door[-.]/.test(o.name || '')) roots.push(o); });
  const out = [];
  out.push(`roots ${roots.length}   colliders ${p.aabbs.length}   names ${roots.map((r) => r.name).join(' ')}`);

  const rows = roots.map((root) => {
    // The armed pair keeps its frame in the file, and a frame's reveal stands proud of the wall
    // collider by a millimetre or two — measure those two over their leaf parts only, as trackLeaf
    // does, or the frame answers for the leaf. The twelve static rows are all leaf already.
    const parts = [];
    root.traverse((o) => {
      if (o !== root && /door_|handle/.test((o.name || '').toLowerCase())) parts.push(o);
    });
    const hide = STATIC.has(root.name);
    return { root, name: root.name, hide, parts: hide || parts.length === 0 ? [root] : parts };
  });
  out.push(`hide rows ${rows.filter((r) => r.hide).length}   armed rows ${rows.filter((r) => !r.hide).length}`);
  out.push('');

  const heightsAt = (x, z) => {
    const ys = [];
    for (const r of p.floors) if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1 && !ys.includes(r.y)) ys.push(r.y);
    return ys;
  };

  const head = `${'leaf'.padEnd(15)} ${'boxes'.padStart(5)} ${'tris'.padStart(5)} ${'legal'.padStart(6)} ${'min d'.padStart(6)} ${'<0.10'.padStart(6)}  ` +
    THRESHOLDS.map((t) => `T${t.toFixed(2)}`.padStart(7)).join('');
  out.push(head);
  const totals = THRESHOLDS.map(() => 0);
  for (const r of rows) {
    const boxes = leafBoxes(r.parts, 4);
    const tris = worldTris(r.parts);
    const nTri = tris.length / 9;
    // Per-triangle bounds, for a lower bound on the distance that costs six compares. Without it this
    // is 8k eye positions x every triangle x fourteen leaves and the page sits there for a minute.
    const tb = new Float64Array(nTri * 6);
    for (let k = 0; k < nTri; k++) {
      const o = k * 9;
      for (let m = 0; m < 3; m++) {
        tb[k * 6 + m] = Math.min(tris[o + m], tris[o + 3 + m], tris[o + 6 + m]);
        tb[k * 6 + 3 + m] = Math.max(tris[o + m], tris[o + 3 + m], tris[o + 6 + m]);
      }
    }
    let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    for (const b of boxes) {
      if (b.minX < bx0) bx0 = b.minX;
      if (b.maxX > bx1) bx1 = b.maxX;
      if (b.minZ < bz0) bz0 = b.minZ;
      if (b.maxZ > bz1) bz1 = b.maxZ;
    }
    const M = 0.5;
    let legal = 0, minD = Infinity, under = 0;
    const bad = THRESHOLDS.map(() => 0);
    for (let x = bx0 - M; x <= bx1 + M; x += CELL) {
      for (let z = bz0 - M; z <= bz1 + M; z += CELL) {
        for (const fy of heightsAt(x, z)) {
          for (const eyeH of [EYE, CROUCH]) {
            const y = fy + eyeH;
            if (blocked(p.aabbs, x, y, z, eyeH)) continue;
            legal++;
            let best = Infinity;
            for (let k = 0; k < nTri; k++) {
              const t = k * 6;
              const gx = x < tb[t] ? tb[t] - x : x > tb[t + 3] ? x - tb[t + 3] : 0;
              const gy = y < tb[t + 1] ? tb[t + 1] - y : y > tb[t + 4] ? y - tb[t + 4] : 0;
              const gz = z < tb[t + 2] ? tb[t + 2] - z : z > tb[t + 5] ? z - tb[t + 5] : 0;
              if (gx * gx + gy * gy + gz * gz >= best) continue;
              const dd = d2Tri(tris, k * 9, x, y, z);
              if (dd < best) best = dd;
            }
            best = Math.sqrt(best);
            if (best < minD) minD = best;
            if (best >= NEAR) continue;
            under++;
            // Inside the near plane. Does the shipped test have the row hidden by then?
            THRESHOLDS.forEach((t, i) => { if (!r.hide || !insideAny(boxes, x, y, z, t)) bad[i]++; });
          }
        }
      }
    }
    bad.forEach((n, i) => { totals[i] += n; });
    out.push(`${r.name.padEnd(15)} ${String(boxes.length).padStart(5)} ${String(nTri).padStart(5)} ${String(legal).padStart(6)} ` +
      `${minD.toFixed(3).padStart(6)} ${String(under).padStart(6)}  ` + bad.map((n) => String(n).padStart(7)).join(''));
  }
  out.push(`${'TOTAL'.padEnd(15)} ${''.padStart(5)} ${''.padStart(5)} ${''.padStart(6)} ${''.padStart(6)} ${''.padStart(6)}  ` +
    totals.map((n) => String(n).padStart(7)).join(''));
  out.push('');
  const okAt = THRESHOLDS.filter((t, i) => totals[i] === 0);
  out.push(okAt.length ? `clean at T >= ${okAt[0].toFixed(2)} m` : 'NO threshold in the sweep is clean');
  return out.join('\n');
})()
