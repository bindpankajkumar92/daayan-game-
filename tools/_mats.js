/**
 * Census of every material actually on the GPU, grouped by whether it has a base-colour map.
 *
 * The point of the grouping: a large imported wall with `map: null` and a flat tint is round 2's defect
 * over again — a smooth panel of the wrong colour among textured neighbours — and it cannot be seen in
 * the source the way a `tone:` flag can, because it lives inside a .glb.
 *
 *   node tools/cdp.mjs --file tools/_mats.js
 */
(() => {
  const d = window.__daayan;
  const scene = d.engine.scene;
  const cam = d.engine.camera;
  const rows = [];
  const seen = new Set();
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    let onCam = false, root = o;
    for (let p = o; p; p = p.parent) { if (p === cam) onCam = true; if (p.name) root = p; }
    if (onCam || o.name === 'grade') return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
    const size = bb.getSize(new cam.position.constructor());
    for (const m of mats) {
      if (!m) continue;
      const key = `${root.name}/${o.name}#${m.uuid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        where: `${root.name}/${o.name || '(unnamed)'}`,
        mat: m.name || m.type,
        map: !!m.map,
        col: m.color?.getHexString?.() ?? '',
        side: m.side,
        tris: (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3,
        // Rough "how much wall is this" measure: the two largest extents of its world box.
        area: (() => { const s = [size.x, size.y, size.z].sort((a, b) => b - a); return s[0] * s[1]; })(),
        box: `${bb.min.toArray().map((v) => v.toFixed(1)).join()} .. ${bb.max.toArray().map((v) => v.toFixed(1)).join()}`,
      });
    }
  });
  const noMap = rows.filter((r) => !r.map).sort((a, b) => b.area - a.area);
  const out = [
    `${rows.length} mesh/material pairs; ${noMap.length} with no base-colour map`,
    '',
    'no map, largest first:',
    'where                              mat                  m2    tris  col      side  box',
  ];
  for (const r of noMap.slice(0, 22)) {
    out.push(
      `${r.where.slice(0, 34).padEnd(34)} ${r.mat.slice(0, 20).padEnd(20)} ${r.area.toFixed(1).padStart(5)} ${String(r.tris).padStart(5)}  #${r.col.padEnd(7)} ${String(r.side).padEnd(4)} ${r.box}`,
    );
  }
  return out.join('\n');
})()
