/**
 * Coplanar-overlap audit, run against the LIVE scene.
 *
 * This exists because tools/audit-coplanar.ts cannot find this class of defect and structurally never
 * could. Two blind spots, both fatal:
 *
 *   1. `if (box.max.y - box.min.y > FLAT) return;` — it only considers meshes flatter than 3 cm, so no
 *      box's top face is ever tested. mergeStaticChildren turns each door casing into one ~2.5 m mesh,
 *      and the casing sill's top face was exactly the surface at fault.
 *   2. It calls buildHouse(1) under a document stub, where no GLTF loader ever fires. Every imported
 *      mesh — the stair the player climbs, the apartment shell they walk through — is simply absent.
 *
 * So it reported "OK - 0 coplanar overlap(s), all separated" while three upward faces sat at 2.40000
 * with 0 um between them across two upper doorways. This walks real triangles in world space instead,
 * and it measures overlap by rasterising both triangle sets onto a 2 cm grid rather than by comparing
 * bounding boxes — neighbouring room floors share an edge by design and a bbox test calls that a 27 m2
 * collision, which is how a real 0.5 m2 problem hides inside a page of false positives.
 *
 * Supersedes tools/_coplanar-live.js (round 3), which had the right scope — the whole live graph — but
 * compared world bounding boxes. That is the test that flagged Object_10 against Object_15 as a 27.26 m2
 * overlap at 0 mm; their real overlap is under 0.02 m2 and they do not appear here at all.
 *
 * Needs the game running with a debug handle. Warp the player to the storey being audited first, since
 * ModelProps hides rows by eye height:
 *
 *   node tools/cdp.mjs "window.__daayan.player.position.set(15.2, 4.10, 1.3)"
 *   CDP_PORT=9223 node tools/cdp.mjs --file tools/coplanar-live.js
 *
 * Reports every pair of same-facing surfaces within 20 mm of each other whose triangles actually
 * overlap by more than 0.02 m2, worst separation first. Anything at 0 um is a guaranteed artefact: no
 * depth buffer can order coincident planes, so which one draws is decided by round-off and changes as
 * the camera moves.
 */
(() => {
  const scene = window.__daayan.engine.scene;
  scene.updateMatrixWorld(true);

  const YMIN = -1.0, YMAX = 6.0;
  const HORIZ = 0.985;          // |ny| / len, i.e. how flat counts as flat
  const NEAR = 0.02;            // pairs closer than this in y are suspects
  const CELL = 0.02;            // rasterisation grid, 2 cm
  const MIN_OVERLAP = 0.02;     // m2 of real overlap worth reporting

  const px = (m, i, pos, out) => {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), e = m.elements;
    out[0] = e[0] * x + e[4] * y + e[8] * z + e[12];
    out[1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    out[2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  };

  const A = [0, 0, 0], B = [0, 0, 0], C = [0, 0, 0];
  const groups = new Map();
  let meshes = 0, kept = 0;

  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    for (let n = o; n; n = n.parent) if (!n.visible) return;
    const pos = o.geometry.attributes && o.geometry.attributes.position;
    if (!pos) return;
    meshes++;
    const idx = o.geometry.index;
    const count = idx ? idx.count : pos.count;
    const m = o.matrixWorld;
    let name = o.name || '(unnamed)';
    if (name.startsWith('Object_') && o.parent && o.parent.name) name = o.parent.name + '/' + name;
    for (let i = 0; i + 2 < count; i += 3) {
      const ia = idx ? idx.getX(i) : i, ib = idx ? idx.getX(i + 1) : i + 1, ic = idx ? idx.getX(i + 2) : i + 2;
      px(m, ia, pos, A);
      if (A[1] < YMIN || A[1] > YMAX) continue;
      px(m, ib, pos, B);
      px(m, ic, pos, C);
      // One plane per group, so a sloped tread never merges with the flat it crosses.
      if (Math.abs(B[1] - A[1]) > 0.004 || Math.abs(C[1] - A[1]) > 0.004) continue;
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
      const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-12 || Math.abs(ny) / len < HORIZ) continue;
      kept++;
      const y = (A[1] + B[1] + C[1]) / 3;
      const key = name + '|' + y.toFixed(4) + '|' + (ny > 0 ? 'up' : 'dn');
      let g = groups.get(key);
      if (!g) {
        g = { n: name, y: +y.toFixed(4), up: ny > 0, area: 0, tris: [], x0: 1e9, x1: -1e9, z0: 1e9, z1: -1e9 };
        groups.set(key, g);
      }
      g.area += len / 2;
      g.tris.push([A[0], A[2], B[0], B[2], C[0], C[2]]);
      g.x0 = Math.min(g.x0, A[0], B[0], C[0]); g.x1 = Math.max(g.x1, A[0], B[0], C[0]);
      g.z0 = Math.min(g.z0, A[2], B[2], C[2]); g.z1 = Math.max(g.z1, A[2], B[2], C[2]);
    }
  });

  const surf = [...groups.values()].filter((g) => g.area > 0.02);

  /** Cells of the CELL grid covered by a group's triangles, restricted to a window. */
  const cover = (g, x0, x1, z0, z1) => {
    const set = new Set();
    const nx = Math.ceil((x1 - x0) / CELL), nz = Math.ceil((z1 - z0) / CELL);
    if (nx <= 0 || nz <= 0 || nx * nz > 4e6) return set;
    for (const t of g.tris) {
      const tx0 = Math.min(t[0], t[2], t[4]), tx1 = Math.max(t[0], t[2], t[4]);
      const tz0 = Math.min(t[1], t[3], t[5]), tz1 = Math.max(t[1], t[3], t[5]);
      if (tx1 < x0 || tx0 > x1 || tz1 < z0 || tz0 > z1) continue;
      const i0 = Math.max(0, Math.floor((tx0 - x0) / CELL)), i1 = Math.min(nx - 1, Math.floor((tx1 - x0) / CELL));
      const j0 = Math.max(0, Math.floor((tz0 - z0) / CELL)), j1 = Math.min(nz - 1, Math.floor((tz1 - z0) / CELL));
      const d1x = t[2] - t[0], d1z = t[3] - t[1], d2x = t[4] - t[0], d2z = t[5] - t[1];
      const den = d1x * d2z - d2x * d1z;
      if (Math.abs(den) < 1e-14) continue;
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          // Cell centre inside the triangle. Sampling the centre means two quads sharing an edge
          // claim disjoint cells, which is the whole point of doing this rather than a bbox test.
          const cx = x0 + (i + 0.5) * CELL - t[0], cz = z0 + (j + 0.5) * CELL - t[1];
          const u = (cx * d2z - cz * d2x) / den;
          const v = (cz * d1x - cx * d1z) / den;
          if (u < 0 || v < 0 || u + v > 1) continue;
          set.add(i * nz + j);
        }
      }
    }
    return set;
  };

  const r2 = (v) => +v.toFixed(2);
  const fmt = (g) => `${g.n} @${g.y.toFixed(4)} ${g.up ? 'up' : 'dn'} ${r2(g.area)}m2 x[${r2(g.x0)},${r2(g.x1)}] z[${r2(g.z0)},${r2(g.z1)}]`;

  const hits = [];
  for (let i = 0; i < surf.length; i++) {
    for (let j = i + 1; j < surf.length; j++) {
      const a = surf[i], b = surf[j];
      if (a.up !== b.up) continue;                       // back-to-back faces never fight
      const dy = Math.abs(a.y - b.y);
      if (dy > NEAR) continue;
      const x0 = Math.max(a.x0, b.x0), x1 = Math.min(a.x1, b.x1);
      const z0 = Math.max(a.z0, b.z0), z1 = Math.min(a.z1, b.z1);
      if (x1 - x0 <= CELL || z1 - z0 <= CELL) continue;
      const ca = cover(a, x0, x1, z0, z1);
      if (!ca.size) continue;
      const cb = cover(b, x0, x1, z0, z1);
      let both = 0;
      for (const k of cb) if (ca.has(k)) both++;
      const overlap = both * CELL * CELL;
      if (overlap < MIN_OVERLAP) continue;
      hits.push({ sep_um: Math.round(dy * 1e6), overlap_m2: r2(overlap), a: fmt(a), b: fmt(b) });
    }
  }
  hits.sort((p, q) => p.sep_um - q.sep_um || q.overlap_m2 - p.overlap_m2);

  return JSON.stringify({
    meshes, flatTrisKept: kept, surfaceGroups: groups.size, surfacesConsidered: surf.length,
    verdict: hits.length ? `${hits.length} real coplanar overlap(s)` : 'OK - no same-facing surface pair overlaps within 20 mm',
    overlaps: hits.slice(0, 30),
  }, null, 1);
})()
