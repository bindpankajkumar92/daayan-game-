/**
 * Degenerate triangles and non-finite vertex data, per geometry, over the whole scene.
 *
 * The live coplanar probe rules out two horizontal surfaces fighting, and the hole probe rules out a
 * missing floor patch at every doorway. What is left, and what the reported symptom actually describes
 * — a shape that *changes* when the camera angle changes — is a triangle the rasteriser cannot resolve:
 * three collinear vertices have a zero-length cross product, so the face normal is undefined and any
 * lighting term built from it is garbage that reprojects differently from every angle. Round 1 bounded
 * long edges, which subdivides; it does not delete slivers, and a sliver is what the round-1 pass leaves
 * behind when its two long edges are already short.
 *
 * The first pass of the coplanar probe already found two of these by accident, as meshes whose world box
 * collapses in two axes (room-upper.glb Object_16 and Object_17, one triangle each). This counts them
 * properly: per geometry, triangles by area in world units, plus any non-finite position or normal, which
 * is the other way to get a shape that moves with the camera.
 *
 * Geometries are visited once by uuid — the house shares geometry between meshes, and counting a shared
 * sliver twice would overstate how much there is to fix.
 *
 *   node tools/cdp.mjs --file tools/_slivers.js
 */
(() => {
  const d = window.__daayan;
  const scene = d.engine.scene;
  scene.updateMatrixWorld(true);

  const seen = new Set();
  const rows = [];
  let totalTris = 0;
  let totalZero = 0;
  let totalTiny = 0;
  let totalNaN = 0;

  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    if (seen.has(g.uuid)) return;
    seen.add(g.uuid);
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    if (!pos) return;
    const e = o.matrixWorld.elements;
    // Uniform-ish scale is enough for an area figure: take the largest column length so a sliver is not
    // excused by a small scale factor.
    const sx = Math.hypot(e[0], e[1], e[2]);
    const sy = Math.hypot(e[4], e[5], e[6]);
    const sz = Math.hypot(e[8], e[9], e[10]);
    const s = Math.max(sx, sy, sz);
    const idx = g.index;
    const n = idx ? idx.count : pos.count;
    let zero = 0, tiny = 0, nan = 0;
    for (let i = 0; i + 2 < n; i += 3) {
      const a = idx ? idx.getX(i) : i;
      const b = idx ? idx.getX(i + 1) : i + 1;
      const c = idx ? idx.getX(i + 2) : i + 2;
      const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
      const bx = pos.getX(b), by = pos.getY(b), bz = pos.getZ(b);
      const cx = pos.getX(c), cy = pos.getY(c), cz = pos.getZ(c);
      if (!Number.isFinite(ax + ay + az + bx + by + bz + cx + cy + cz)) { nan++; continue; }
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const area = 0.5 * Math.hypot(nx, ny, nz) * s * s;
      if (area <= 0) zero++;
      else if (area < 1e-6) tiny++;
    }
    if (nor) {
      for (let i = 0; i < nor.count; i++) {
        const v = nor.getX(i) + nor.getY(i) + nor.getZ(i);
        if (!Number.isFinite(v)) nan++;
      }
    }
    totalTris += n / 3;
    totalZero += zero;
    totalTiny += tiny;
    totalNaN += nan;
    if (zero || tiny || nan) {
      const path = [];
      for (let p = o; p && p !== scene; p = p.parent) path.push(p.name || p.type);
      rows.push({
        name: o.name || '(unnamed)',
        src: path.reverse().join('/').split('/').slice(0, 2).join('/'),
        tris: n / 3,
        zero, tiny, nan,
      });
    }
  });

  const out = [];
  out.push(`${seen.size} distinct geometries, ${totalTris.toFixed(0)} triangles`);
  out.push(`zero-area ${totalZero}   under 1e-6 m2 ${totalTiny}   non-finite ${totalNaN}`);
  out.push('');
  rows.sort((a, b) => b.zero + b.nan - (a.zero + a.nan) || b.tiny - a.tiny);
  for (const r of rows.slice(0, 30)) {
    out.push(`  ${r.name.padEnd(16)} ${String(r.tris).padStart(7)} tris  zero ${String(r.zero).padStart(5)}  tiny ${String(r.tiny).padStart(5)}  nan ${String(r.nan).padStart(4)}  ${r.src}`);
  }
  if (rows.length > 30) out.push(`  ... and ${rows.length - 30} more`);
  return out.join('\n');
})()
