/**
 * Is there actually floor under every doorway?
 *
 * The reported defect is a dark skewed patch on the boards at a door threshold whose shape changes with
 * the viewing angle. The live coplanar probe rules out the obvious cause: the whole scene holds 15
 * horizontal overlaps and 14 are separated by a polygonOffset or by depthWrite, the fifteenth being a
 * 0.06 m2 plate. A *missing* floor patch produces the same look for a different reason — you are seeing
 * through a slot into unlit backfaces, and what you see through it changes with the angle because it is
 * a cavity rather than a surface.
 *
 * The door's floor level is detected rather than declared: sample a square around the door, collect the
 * y of every slab that covers any sample, and take the most common one. That is what makes this run over
 * doors on four different storeys without a table of levels to keep in step with HouseRooms.
 *
 * Uncovered samples are printed as a map, because the *shape* of a hole says what made it — a strip along
 * one edge is a slab that stops short, an L is two slabs meeting at a corner, a rectangle is a patch
 * nobody drew.
 *
 *   node tools/cdp.mjs --file tools/_holes.js
 */
(() => {
  const d = window.__daayan;
  const scene = d.engine.scene;
  const FLAT = 0.03;
  const R = 0.6;
  const STEP = 0.06;

  const xf = (m, x, y, z) => {
    const e = m.elements;
    return [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]];
  };
  scene.updateMatrixWorld(true);
  const slabs = [];
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox;
    if (!b || !isFinite(b.min.x)) return;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < 8; i++) {
      const p = xf(o.matrixWorld, i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
      for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
    }
    if (hi[1] - lo[1] > FLAT) return;
    slabs.push({ name: o.name || '(unnamed)', y: (lo[1] + hi[1]) / 2, x0: lo[0], x1: hi[0], z0: lo[2], z1: hi[2] });
  });

  const DOORS = [
    ['GATE', 0, -7], ['ARCH', 0, 0], ['BEDROOM_DOOR', -5, 2.6], ['LIVING_DOOR', 5, 2.6],
    ['CELLAR_DOOR', -9, 1.3], ['BACK_DOOR_W', -5, 10.2], ['BACK_DOOR_E', 7, 10.2],
    ['KITCHEN_DOOR', -6, 12.2], ['POOJA_DOOR', 0, 12.2], ['STORE_DOOR', 6, 12.2],
    ['STAIR_DOOR', 9, 1.3], ['UPPER_DOOR', 14.4, 1.3], ['UPPER_INNER', 19.855, 1.75],
    ['UP_BACK_DOOR', 16.5, -0.99], ['UP_CHILD_DOOR', 18.6, -4.0], ['UP_SHRINE_DOOR', 16.5, -6.4],
    ['BASEMENT_DOOR', -13.8, 1.3], ['RITUAL_DOOR', -22, 2.3], ['BLACK_DOOR', -15.2, 12.2],
  ];

  const out = [];
  out.push(`${slabs.length} flat slabs; sampling ${(R * 2).toFixed(2)}m square per door at ${STEP}m`);
  out.push('');
  for (const [name, dx, dz] of DOORS) {
    const pts = [];
    for (let z = dz - R; z <= dz + R + 1e-9; z += STEP) for (let x = dx - R; x <= dx + R + 1e-9; x += STEP) pts.push([x, z]);
    const tally = new Map();
    for (const [x, z] of pts) {
      for (const s of slabs) {
        if (x < s.x0 - 1e-6 || x > s.x1 + 1e-6 || z < s.z0 - 1e-6 || z > s.z1 + 1e-6) continue;
        const key = s.y.toFixed(3);
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
    }
    if (tally.size === 0) { out.push(`${name.padEnd(15)} (${dx}, ${dz})  NO SLAB ANYWHERE NEAR`); continue; }
    const level = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const here = slabs.filter((s) => Math.abs(s.y - Number(level)) < 0.05);
    const covered = (x, z) => here.some((s) => x >= s.x0 - 1e-6 && x <= s.x1 + 1e-6 && z >= s.z0 - 1e-6 && z <= s.z1 + 1e-6);
    let miss = 0;
    const rows = [];
    for (let z = dz - R; z <= dz + R + 1e-9; z += STEP) {
      let row = '';
      for (let x = dx - R; x <= dx + R + 1e-9; x += STEP) { const c = covered(x, z); if (!c) miss++; row += c ? '.' : '#'; }
      rows.push(row);
    }
    const pct = ((miss / pts.length) * 100).toFixed(0);
    out.push(`${name.padEnd(15)} (${dx}, ${dz}) y=${level}  uncovered ${pct}%  slabs: ${here.map((s) => s.name).join(', ').slice(0, 90)}`);
    if (miss > 0) for (const r of rows) out.push(`    ${r}`);
  }
  return out.join('\n');
})()
