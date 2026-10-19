/**
 * Whole-house reachability, before and after the leaf keep-outs — does any room go dark?
 *
 * _leafcheck.js answered the eye question (0.000-0.003 m -> 0.350-0.442 m on every one of 14 leaves,
 * 56/56 boxes matching what the build shipped) and then flagged eight of fourteen doorway windows as
 * split. A 5 m window is local, so a split there might still have a way round. This settles it: flood
 * fill the house from the player's own spawn on a 10 cm grid with the real collider test, before and
 * after, and list the blobs of floor the fix takes away.
 *
 * The graph is (cell, floor height), not (cell): floors stack three deep here and `groundYAt` is not a
 * function of (x, z) — it reads the player's own y to choose which floor it is standing on, so one
 * cached grid of it is one storey's answer smeared over all of them. A cell carries every rect height
 * that covers it; two nodes join when they are 4-neighbours and within stepUpHeight, which is what the
 * controller can walk, and that makes the stair treads the link between storeys rather than a merge.
 *
 *   CDP_PORT=9223 CDP_MATCH=5199 node tools/cdp.mjs --file tools/_walk.js
 */
(() => {
  const d = window.__daayan;
  const p = d.player;
  const scene = d.engine.scene;
  const EYE = p.opts.eyeHeight;
  const RAD = p.opts.radius;
  const STEP_UP = p.opts.stepUpHeight;
  const CELL = 0.1;
  const LAYERS = 6;
  scene.updateMatrixWorld(true);

  const blocked = (list, x, y, z) => {
    const minY = y - EYE, maxY = y;
    for (const q of list) {
      if (q.maxY <= minY + 0.05) continue;
      if (q.minY >= maxY + 0.05) continue;
      if (x + RAD > q.minX && x - RAD < q.maxX && maxY > q.minY && minY < q.maxY && z + RAD > q.minZ && z - RAD < q.maxZ) return true;
    }
    return false;
  };

  // The leaf keep-outs, picked back out of the live array so `base` is the pre-fix house. A keep-out
  // spans exactly its leaf's y range and sits inside its leaf's footprint. Two candidate ranges per
  // root: the whole root, and the leaf parts only — door.glb's keep-out is measured over the leaf
  // without its frame, so the frame's y would never match it.
  const yRange = (root, leafOnly) => {
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    root.updateWorldMatrix(true, true);
    root.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (leafOnly) {
        let leaf = false;
        for (let q = o; q; q = q.parent) {
          const nm = (q.name || '').toLowerCase();
          if (nm.includes('door_') || nm.includes('handle')) { leaf = true; break; }
          if (q === root) break;
        }
        if (!leaf) return;
      }
      const pos = o.geometry.attributes.position, el = o.matrixWorld.elements;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const w = [el[0] * x + el[4] * y + el[8] * z + el[12], el[1] * x + el[5] * y + el[9] * z + el[13], el[2] * x + el[6] * y + el[10] * z + el[14]];
        for (let m = 0; m < 3; m++) { if (w[m] < lo[m]) lo[m] = w[m]; if (w[m] > hi[m]) hi[m] = w[m]; }
      }
    });
    return lo[0] < hi[0] ? { lo, hi } : null;
  };
  const spans = [];
  const roots = [];
  scene.traverse((o) => { if (/^door[-.]/.test(o.name || '')) roots.push(o); });
  for (const root of roots) for (const leafOnly of [false, true]) {
    const s = yRange(root, leafOnly);
    if (s) spans.push(s);
  }
  const isLeafBox = (b) => spans.some((L) =>
    Math.abs(b.minY - L.lo[1]) < 1e-6 && Math.abs(b.maxY - L.hi[1]) < 1e-6 &&
    b.minX > L.lo[0] - 1e-6 && b.maxX < L.hi[0] + 1e-6 &&
    b.minZ > L.lo[2] - 1e-6 && b.maxZ < L.hi[2] + 1e-6);

  const fixed = p.aabbs;
  const base = fixed.filter((b) => !isLeafBox(b));
  const out = [];
  out.push(`roots ${roots.length}   live ${fixed.length}   base ${base.length}   removed ${fixed.length - base.length} (expect 56)`);

  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const r of p.floors) {
    if (r.x0 < x0) x0 = r.x0;
    if (r.x1 > x1) x1 = r.x1;
    if (r.z0 < z0) z0 = r.z0;
    if (r.z1 > z1) z1 = r.z1;
  }
  x0 -= 0.5; z0 -= 0.5; x1 += 0.5; z1 += 0.5;
  const W = Math.ceil((x1 - x0) / CELL) + 1, H = Math.ceil((z1 - z0) / CELL) + 1;
  const gx = (i) => x0 + i * CELL, gz = (j) => z0 + j * CELL;
  out.push(`grid ${W}x${H} @ ${CELL} m   x ${x0.toFixed(1)}..${x1.toFixed(1)}   z ${z0.toFixed(1)}..${z1.toFixed(1)}   layers ${LAYERS}`);

  // Every floor height covering each cell, low to high, capped at LAYERS. NaN marks an unused layer.
  const layerY = new Float64Array(W * H * LAYERS).fill(NaN);
  const nLayer = new Uint8Array(W * H);
  for (const r of p.floors) {
    const i0 = Math.max(0, Math.ceil((r.x0 - x0) / CELL)), i1 = Math.min(W - 1, Math.floor((r.x1 - x0) / CELL));
    const j0 = Math.max(0, Math.ceil((r.z0 - z0) / CELL)), j1 = Math.min(H - 1, Math.floor((r.z1 - z0) / CELL));
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const c = i * H + j;
        let dup = false;
        for (let L = 0; L < nLayer[c]; L++) if (Math.abs(layerY[c * LAYERS + L] - r.y) < 1e-9) { dup = true; break; }
        if (dup || nLayer[c] >= LAYERS) continue;
        layerY[c * LAYERS + nLayer[c]] = r.y;
        nLayer[c]++;
      }
    }
  }
  let nodes = 0;
  for (let c = 0; c < W * H; c++) nodes += nLayer[c];
  out.push(`floor rects ${p.floors.length}   heights ${[...new Set(p.floors.map((r) => r.y))].length}   nodes ${nodes}`);

  const legalOf = (list) => {
    const ok = new Uint8Array(W * H * LAYERS);
    let n = 0;
    for (let c = 0; c < W * H; c++) {
      const i = (c / H) | 0, j = c % H;
      for (let L = 0; L < nLayer[c]; L++) {
        const y = layerY[c * LAYERS + L];
        if (!blocked(list, gx(i), y + EYE, gz(j))) { ok[c * LAYERS + L] = 1; n++; }
      }
    }
    return { ok, n };
  };
  const walk = (ok, seed) => {
    const seen = new Uint8Array(W * H * LAYERS);
    if (!ok[seed]) return { seen, n: 0 };
    const stack = [seed];
    seen[seed] = 1;
    let n = 0;
    while (stack.length) {
      const s = stack.pop();
      n++;
      const c = (s / LAYERS) | 0, y = layerY[s];
      const ci = (c / H) | 0, cj = c % H;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        const nc = ni * H + nj;
        for (let L = 0; L < nLayer[nc]; L++) {
          const nk = nc * LAYERS + L;
          if (!ok[nk] || seen[nk]) continue;
          // Directed: a step up is capped, a drop is not. Gravity does the rest, and modelling a 0.47 m
          // riser as impassable in both directions is what left the spawn tread an island of 1.9 m2.
          if (layerY[nk] - y > STEP_UP + 1e-9) continue;
          seen[nk] = 1;
          stack.push(nk);
        }
      }
    }
    return { seen, n };
  };
  const L0 = legalOf(base), L1 = legalOf(fixed);
  const m2 = (n) => (n * CELL * CELL).toFixed(1);

  // Where to start. Not the live spawn: this page has been sitting headless and the player has settled
  // into a 1.9 m2 pocket, so seeding there measures the pocket. The biggest region of the pre-fix house
  // is the house, and the seed is taken from inside it — on a node the fix leaves alone, since seeding
  // on a node the fix blocks would report the whole house as lost.
  const walkU = (ok, seed) => {
    const seen = new Uint8Array(W * H * LAYERS);
    const stack = [seed];
    seen[seed] = 1;
    let n = 0;
    while (stack.length) {
      const s = stack.pop();
      n++;
      const c = (s / LAYERS) | 0, y = layerY[s], ci = (c / H) | 0, cj = c % H;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        const nc = ni * H + nj;
        for (let L = 0; L < nLayer[nc]; L++) {
          const nk = nc * LAYERS + L;
          if (!ok[nk] || seen[nk] || Math.abs(layerY[nk] - y) > STEP_UP + 1e-9) continue;
          seen[nk] = 1;
          stack.push(nk);
        }
      }
    }
    return { seen, n };
  };
  const done = new Uint8Array(W * H * LAYERS);
  let big = null, bigN = 0, comps = 0;
  for (let k = 0; k < W * H * LAYERS; k++) {
    if (!L0.ok[k] || done[k]) continue;
    const r = walkU(L0.ok, k);
    comps++;
    for (let m = 0; m < W * H * LAYERS; m++) if (r.seen[m]) done[m] = 1;
    if (r.n > bigN) { bigN = r.n; big = r; }
  }
  const clear = (k) => {
    if (!L1.ok[k]) return false;
    const c = (k / LAYERS) | 0, ci = (c / H) | 0, cj = c % H;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = (ci + di) * H + (cj + dj);
      let any = false;
      for (let L = 0; L < nLayer[nc]; L++) if (L1.ok[nc * LAYERS + L]) any = true;
      if (!any) return false;
    }
    return true;
  };
  let seed = -1;
  for (let k = 0; k < W * H * LAYERS && seed < 0; k++) if (big && big.seen[k] && clear(k)) seed = k;
  const sc = Math.round((p.position.x - x0) / CELL) * H + Math.round((p.position.z - z0) / CELL);
  out.push(`legal nodes ${L0.n} -> ${L1.n}   (${m2(L0.n)} -> ${m2(L1.n)} m2 of standing room)   regions before ${comps}, biggest ${m2(bigN)} m2`);
  out.push(`seed (${gx((((seed / LAYERS) | 0) / H) | 0).toFixed(1)}, ${gz(((seed / LAYERS) | 0) % H).toFixed(1)}) y ${layerY[seed].toFixed(2)}   [live player sits at (${p.position.x.toFixed(2)}, ${p.position.z.toFixed(2)}) on ${nLayer[sc]} layer(s)]`);
  const A = walk(L0.ok, seed), B = walk(L1.ok, seed);
  out.push(`reachable   ${A.n} -> ${B.n}   (${m2(A.n)} -> ${m2(B.n)} m2)   lost ${m2(A.n - B.n)} m2`);
  out.push('');

  const lost = new Uint8Array(W * H * LAYERS);
  let lostN = 0;
  for (let k = 0; k < W * H * LAYERS; k++) if (A.seen[k] && !B.seen[k]) { lost[k] = 1; lostN++; }
  const seen2 = new Uint8Array(W * H * LAYERS);
  const blobs = [];
  for (let s = 0; s < W * H * LAYERS; s++) {
    if (!lost[s] || seen2[s]) continue;
    const stack = [s];
    seen2[s] = 1;
    let n = 0, bi0 = W, bi1 = -1, bj0 = H, bj1 = -1, sy = 0;
    while (stack.length) {
      const k = stack.pop();
      n++;
      sy += layerY[k];
      const c = (k / LAYERS) | 0, ci = (c / H) | 0, cj = c % H;
      if (ci < bi0) bi0 = ci;
      if (ci > bi1) bi1 = ci;
      if (cj < bj0) bj0 = cj;
      if (cj > bj1) bj1 = cj;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]]) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        const nc = ni * H + nj;
        for (let L = 0; L < nLayer[nc]; L++) {
          const nk = nc * LAYERS + L;
          if (!lost[nk] || seen2[nk] || Math.abs(layerY[nk] - layerY[k]) > STEP_UP + 1e-9) continue;
          seen2[nk] = 1;
          stack.push(nk);
        }
      }
    }
    blobs.push({ n, x: [gx(bi0), gx(bi1)], z: [gz(bj0), gz(bj1)], y: sy / n });
  }
  blobs.sort((a, b) => b.n - a.n);
  out.push(`shut out: ${m2(lostN)} m2 in ${blobs.length} blob(s); over 0.5 m2 listed`);
  for (const b of blobs) {
    if (b.n * CELL * CELL < 0.5) break;
    out.push(`  ${m2(b.n).padStart(7)} m2   x ${b.x[0].toFixed(1)}..${b.x[1].toFixed(1)}   z ${b.z[0].toFixed(1)}..${b.z[1].toFixed(1)}   floor y ${b.y.toFixed(2)}`);
  }

  return out.join('\n');
})()
