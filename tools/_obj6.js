/**
 * Object_6 at 0.099 m — which mesh is that, and why did _hide.js not see it?
 *
 * _blame.js put the surviving flicker at both upper doors on a mesh named Object_6, 0.099 m from the eye,
 * inside the door subtree, and hiding that subtree takes the near-plane A/B to 0. But _hide.js swept
 * every collision-legal eye position round the same two roots and reported a nearest of 0.400 m with no
 * position inside 0.10 m. One of the two is wrong about something, and the answer decides whether the
 * upper doors need anything further.
 *
 *   CDP_PORT=9223 CDP_MATCH=5199 node tools/cdp.mjs --file tools/_obj6.js
 */
(() => {
  const d = window.__daayan;
  const p = d.player;
  const scene = d.engine.scene;
  const EYE = p.opts.eyeHeight;
  const RAD = p.opts.radius;
  scene.updateMatrixWorld(true);
  const out = [];

  const POSES = [[19.305, 4.1, 1.75], [16.5, 4.1, -0.99], [20.405, 4.1, 1.75]];
  const blocked = (x, y, z) => {
    const minY = y - EYE, maxY = y;
    let n = 0;
    for (const q of p.aabbs) {
      if (q.maxY <= minY + 0.05 || q.minY >= maxY + 0.05) continue;
      if (x + RAD > q.minX && x - RAD < q.maxX && maxY > q.minY && minY < q.maxY && z + RAD > q.minZ && z - RAD < q.maxZ) n++;
    }
    return n;
  };
  const heightsAt = (x, z) => p.floors.filter((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1).map((r) => r.y);

  for (const [x, y, z] of POSES) {
    out.push(`pose (${x}, ${y}, ${z})   blocking boxes ${blocked(x, y, z)}   floor heights under it [${heightsAt(x, z).join(' ')}]`);
  }
  out.push('');

  // Every mesh named Object_6 anywhere, with its parent chain and its world box. A leaf slab is about
  // 0.05 m thick and a metre across; anything much bigger than that is not a leaf.
  const rows = [];
  scene.traverse((o) => {
    if (!o.isMesh || o.name !== 'Object_6') return;
    const chain = [];
    for (let q = o; q; q = q.parent) chain.push(q.name || q.type);
    const g = o.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox.clone().applyMatrix4(o.matrixWorld);
    const idx = g.getIndex();
    rows.push({
      chain: chain.reverse().join(' > '),
      tris: (idx ? idx.count : g.getAttribute('position').count) / 3,
      visible: o.visible,
      lo: [bb.min.x, bb.min.y, bb.min.z],
      hi: [bb.max.x, bb.max.y, bb.max.z],
    });
  });
  out.push(`meshes named Object_6: ${rows.length}`);
  for (const r of rows) {
    out.push(`  tris ${String(r.tris).padStart(5)}  visible ${r.visible ? 'y' : 'n'}  ` +
      `x ${r.lo[0].toFixed(3)}..${r.hi[0].toFixed(3)}  y ${r.lo[1].toFixed(3)}..${r.hi[1].toFixed(3)}  z ${r.lo[2].toFixed(3)}..${r.hi[2].toFixed(3)}`);
    out.push(`      ${r.chain}`);
  }
  out.push('');

  // And the two door roots, mesh by mesh, so a part that is not in the swing is visible as one.
  for (const name of ['door-inner.glb', 'door-up-back']) {
    let root = null;
    scene.traverse((o) => { if (o.name === name) root = o; });
    if (!root) { out.push(`${name}: not in the scene`); continue; }
    const parts = [];
    root.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox.clone().applyMatrix4(o.matrixWorld);
      const idx = g.getIndex();
      let underPivot = false;
      for (let q = o.parent; q && q !== root; q = q.parent) if ((q.name || '').includes('pivot')) underPivot = true;
      parts.push(`${o.name}[${(idx ? idx.count : g.getAttribute('position').count) / 3}t ${underPivot ? 'swings' : 'STATIC'} ` +
        `x ${bb.min.x.toFixed(2)}..${bb.max.x.toFixed(2)} y ${bb.min.y.toFixed(2)}..${bb.max.y.toFixed(2)} z ${bb.min.z.toFixed(2)}..${bb.max.z.toFixed(2)}]`);
    });
    out.push(`${name}: ${parts.length} mesh(es)`);
    for (const s of parts) out.push(`  ${s}`);
  }
  return out.join('\n');
})()
