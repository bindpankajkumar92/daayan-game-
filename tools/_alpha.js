/**
 * The transparency of the upper flat's shell, as the running build actually has it.
 *
 * `room-upper.glb` declares its 16,754-triangle shell material `alphaMode: BLEND` with no texture, and
 * ModelLoader's rule for "transparent with no map" is `transparent = true, depthWrite = false`. That is
 * the whole flat drawn in the sorted pass, writing no depth: its own near and far walls stop occluding
 * each other and paint over one another in buffer order as the camera moves. This prints the state so
 * the claim is measured rather than read off the source.
 *
 *   node tools/cdp.mjs --file tools/_alpha.js
 */
(() => {
  const d = window.__daayan;
  const scene = d.engine.scene;
  const cam = d.engine.camera;
  const rows = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    let onCam = false, root = o;
    for (let p = o; p; p = p.parent) { if (p === cam) onCam = true; if (p.name) root = p; }
    if (onCam || o.name === 'grade') return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m?.transparent && m?.depthWrite !== false) continue;
      rows.push({
        where: `${root.name}/${o.name || '(unnamed)'}`,
        mat: m.name || m.type,
        tris: (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3,
        transparent: m.transparent,
        depthWrite: m.depthWrite,
        opacity: m.opacity,
        alphaTest: m.alphaTest,
        map: !!m.map,
        col: m.color?.getHexString?.(),
        order: o.renderOrder,
      });
    }
  });
  rows.sort((a, b) => b.tris - a.tris);
  const out = [
    `${rows.length} mesh/material pairs are transparent or skip depth`,
    'where                              mat            tris  transp depthW opac aTest map col      rOrder',
  ];
  for (const r of rows.slice(0, 20)) {
    out.push(
      `${r.where.slice(0, 34).padEnd(34)} ${String(r.mat).slice(0, 13).padEnd(13)} ${String(r.tris).padStart(5)}  ` +
        `${String(r.transparent).padEnd(6)} ${String(r.depthWrite).padEnd(6)} ${String(r.opacity).padEnd(4)} ` +
        `${String(r.alphaTest).padEnd(5)} ${r.map ? 'yes' : 'no '} #${String(r.col).padEnd(7)} ${r.order}`,
    );
  }
  const t = rows.reduce((s, r) => s + (r.depthWrite === false ? r.tris : 0), 0);
  out.push('', `triangles drawn with depthWrite off: ${t}`);
  return out.join('\n');
})()
