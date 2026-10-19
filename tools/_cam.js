/**
 * What the wedge detector needs to know before it can run: the camera it must A/B, and the real world
 * scale room-upper.glb is instanced at.
 *
 * The scale matters because optimize-models.mjs turns a world bound into a local one with
 * `maxEdge * docHeight / (placedHeight * nodeScale)`, so a wrong placedHeight is a bound that looks
 * enforced and is not. glb-edges.mjs reports room-upper.glb's longest edge as 33.10 m at the 5.604 I
 * guessed, while the live scene measures the same primitive at 5.91 m — a factor of exactly 5.604, which
 * says the live scale is 1.0 and the guess was wrong. Read it off matrixWorld rather than inferring it
 * again from MODEL_PLACEMENTS.height, which fits the largest axis here (11.2077 against a bbox depth of
 * 11.208) and not the y the name suggests.
 *
 *   node tools/cdp.mjs --file tools/_cam.js
 */
(() => {
  const d = window.__daayan;
  const e = d.engine;
  const scene = e.scene;
  scene.updateMatrixWorld(true);

  const out = [];
  out.push(`engine keys: ${Object.keys(e).join(' ')}`);
  out.push(`loop keys:   ${Object.keys(d.loop || {}).join(' ')}`);

  // The camera is whatever the renderer was last handed; find it by name rather than by guessing a field.
  const cams = [];
  scene.traverse((o) => { if (o.isCamera) cams.push(o); });
  const named = Object.keys(e).filter((k) => e[k] && e[k].isCamera);
  for (const k of named) {
    const c = e[k];
    out.push(`engine.${k}: ${c.type} near ${c.near} far ${c.far} fov ${c.fov} aspect ${c.aspect.toFixed(3)}`);
  }
  out.push(`cameras in graph: ${cams.length}${cams.length ? ` (${cams.map((c) => c.type).join(', ')})` : ''}`);

  let root = null;
  scene.traverse((o) => { if (!root && /room-upper/.test(o.name || '')) root = o; });
  if (!root) {
    scene.traverse((o) => {
      if (root || !o.isMesh) return;
      for (let p = o; p; p = p.parent) if (/room-upper/.test(p.name || '')) { root = p; return; }
    });
  }
  if (root) {
    const m = root.matrixWorld.elements;
    const sx = Math.hypot(m[0], m[1], m[2]);
    const sy = Math.hypot(m[4], m[5], m[6]);
    const sz = Math.hypot(m[8], m[9], m[10]);
    out.push(`room-upper root "${root.name}" world scale ${sx.toFixed(4)} ${sy.toFixed(4)} ${sz.toFixed(4)} at (${m[12].toFixed(3)}, ${m[13].toFixed(3)}, ${m[14].toFixed(3)})`);
    // And the scale on a leaf mesh, since the .glb's own nodes carry scale too and it is the product that
    // the local edge bound has to be divided by.
    let leaf = null;
    root.traverse((o) => { if (!leaf && o.isMesh) leaf = o; });
    if (leaf) {
      const l = leaf.matrixWorld.elements;
      out.push(`leaf "${leaf.name}" world scale ${Math.hypot(l[0], l[1], l[2]).toFixed(4)} ${Math.hypot(l[4], l[5], l[6]).toFixed(4)} ${Math.hypot(l[8], l[9], l[10]).toFixed(4)}`);
    }
  } else {
    out.push('room-upper root NOT FOUND by name');
  }

  // Long edges near the two doorways the report survives at, so the detector knows where to point.
  const SPOTS = [['UPPER_INNER', 19.855, 1.75], ['UP_BACK_DOOR', 16.5, -0.99]];
  for (const [name, dx, dz] of SPOTS) {
    const near = [];
    scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const g = o.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      const pos = g.attributes.position;
      if (!pos) return;
      const el = o.matrixWorld.elements;
      const wx = (x, y, z) => el[0] * x + el[4] * y + el[8] * z + el[12];
      const wy = (x, y, z) => el[1] * x + el[5] * y + el[9] * z + el[13];
      const wz = (x, y, z) => el[2] * x + el[6] * y + el[10] * z + el[14];
      const idx = g.index;
      const n = idx ? idx.count : pos.count;
      let worst = 0, count = 0;
      for (let i = 0; i + 2 < n; i += 3) {
        const t = [0, 1, 2].map((k) => {
          const j = idx ? idx.getX(i + k) : i + k;
          return [wx(pos.getX(j), pos.getY(j), pos.getZ(j)), wy(pos.getX(j), pos.getY(j), pos.getZ(j)), wz(pos.getX(j), pos.getY(j), pos.getZ(j))];
        });
        // Only triangles that actually reach the doorway, within 2 m in plan and on the flat's storey.
        const cx = (t[0][0] + t[1][0] + t[2][0]) / 3;
        const cy = (t[0][1] + t[1][1] + t[2][1]) / 3;
        const cz = (t[0][2] + t[1][2] + t[2][2]) / 3;
        if (Math.hypot(cx - dx, cz - dz) > 2.0 || cy < 2.0 || cy > 5.4) continue;
        let longest = 0;
        for (let k = 0; k < 3; k++) {
          const a = t[k], b = t[(k + 1) % 3];
          longest = Math.max(longest, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
        }
        if (longest > 1.0) count++;
        if (longest > worst) worst = longest;
      }
      if (count > 0) {
        const path = [];
        for (let p = o; p && p !== scene; p = p.parent) path.push(p.name || p.type);
        near.push({ name: o.name || '(unnamed)', src: path.reverse().join('/').split('/').slice(0, 2).join('/'), worst, count });
      }
    });
    near.sort((a, b) => b.worst - a.worst);
    out.push('');
    out.push(`${name} (${dx}, ${dz}): ${near.length} meshes with a triangle over 1 m within 2 m of the doorway`);
    for (const r of near.slice(0, 10)) out.push(`   ${r.name.padEnd(16)} worst ${r.worst.toFixed(2)}m  over1m ${String(r.count).padStart(4)}  ${r.src}`);
  }
  return out.join('\n');
})()
