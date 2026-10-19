/**
 * Longest triangle edge per geometry, in world metres, with where the worst one is.
 *
 * The user's own diagnosis is that this is the defect round 1 fixed — a shape that changes as the angle
 * changes — and round 1's fix was to keep triangle edges short, because a long edge crossing the near
 * plane sends w towards zero and the interpolated result is a wedge whose outline moves with the camera.
 * That fix landed in three places: boxMesh segments, the HouseProps rail, and an edge pass over imported
 * .glb in tools/optimize-models.mjs.
 *
 * None of the three can reach a triangle that is created *after* load, and CarveBox does exactly that:
 * carveMesh cuts a doorway out of a wall at runtime and stitches the hole with new triangles. Doorways
 * are where the remaining reports are ("bas ye 2 door ke paas bache hai"), so the first thing to measure
 * is whether carved geometry still honours the bound the rest of the house is held to.
 *
 * Edges are measured after matrixWorld, since a .glb fitted at 5.604 turns a 0.3 m authored edge into
 * 1.7 m of world space and it is world space the projection sees.
 *
 *   node tools/cdp.mjs --file tools/_edges.js
 */
(() => {
  const d = window.__daayan;
  const scene = d.engine.scene;
  scene.updateMatrixWorld(true);

  const seen = new Set();
  const rows = [];
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    const key = `${g.uuid}|${o.matrixWorld.elements.join(',')}`;
    if (seen.has(key)) return;
    seen.add(key);
    const pos = g.attributes.position;
    if (!pos) return;
    const e = o.matrixWorld.elements;
    const wx = (x, y, z) => e[0] * x + e[4] * y + e[8] * z + e[12];
    const wy = (x, y, z) => e[1] * x + e[5] * y + e[9] * z + e[13];
    const wz = (x, y, z) => e[2] * x + e[6] * y + e[10] * z + e[14];
    const idx = g.index;
    const n = idx ? idx.count : pos.count;
    let max = 0, over1 = 0, over2 = 0, at = null;
    for (let i = 0; i + 2 < n; i += 3) {
      const t = [0, 1, 2].map((k) => {
        const j = idx ? idx.getX(i + k) : i + k;
        const x = pos.getX(j), y = pos.getY(j), z = pos.getZ(j);
        return [wx(x, y, z), wy(x, y, z), wz(x, y, z)];
      });
      for (let k = 0; k < 3; k++) {
        const a = t[k], b = t[(k + 1) % 3];
        const len = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        if (len > 1.0) over1++;
        if (len > 2.0) over2++;
        if (len > max) {
          max = len;
          at = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
        }
      }
    }
    const path = [];
    for (let p = o; p && p !== scene; p = p.parent) path.push(p.name || p.type);
    rows.push({
      name: o.name || '(unnamed)',
      src: path.reverse().join('/').split('/').slice(0, 2).join('/'),
      tris: n / 3, max, over1, over2, at,
      carved: g.userData && g.userData.carved === true,
      uv: g.userData && g.userData.worldUv === true,
    });
  });

  rows.sort((a, b) => b.max - a.max);
  const out = [];
  out.push(`${rows.length} mesh instances; edges measured in world metres`);
  out.push(`over 1m: ${rows.reduce((s, r) => s + r.over1, 0)} edges in ${rows.filter((r) => r.over1).length} meshes`);
  out.push(`over 2m: ${rows.reduce((s, r) => s + r.over2, 0)} edges in ${rows.filter((r) => r.over2).length} meshes`);
  out.push('');
  out.push('name              tris   maxEdge  >1m   >2m  worst edge midpoint          source');
  for (const r of rows.slice(0, 28)) {
    out.push(
      `${r.name.slice(0, 17).padEnd(17)} ${String(r.tris).padStart(6)} ${r.max.toFixed(2).padStart(7)}m ` +
        `${String(r.over1).padStart(5)} ${String(r.over2).padStart(5)}  ` +
        `${r.at ? `(${r.at[0].toFixed(2)}, ${r.at[1].toFixed(2)}, ${r.at[2].toFixed(2)})`.padEnd(26) : ''.padEnd(26)} ${r.src}${r.uv ? ' [worldUv]' : ''}`,
    );
  }
  return out.join('\n');
})()
