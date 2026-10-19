/**
 * Is the brown band a door leaf standing up, or one lying flat?
 *
 * _band.js put it on `door-up-back > inner-door.pivot > ... > Cube002_Cube000` — the leaf slab of the
 * upper flat's back door. That is either the leaf legitimately close to the eye and seen nearly edge-on,
 * or a leaf that is not standing where a leaf should stand. A slab lying flat across the floor is exactly
 * what the screenshot looks like, and the two cases are told apart by one number: the world box's y span
 * against its x/z span. A door is ~2 m tall and ~0.04 m thick; a door lying down is the other way round.
 *
 * Also printed: the pivot's own rotation and quaternion, since a leaf turned about the wrong axis is how
 * a standing slab ends up flat, and the eye-to-leaf distance, since if it is standing then the only
 * question left is whether round 5's hide should have fired here.
 *
 *   CDP_PORT=9223 CDP_MATCH=5199 node tools/cdp.mjs --file tools/_leaf.js
 */
(() => {
  const d = window.__daayan;
  const scene = d.engine.scene;
  const p = d.player;
  scene.updateMatrixWorld(true);
  const out = [];

  const roots = [];
  scene.traverse((o) => { if (/^door-up-|^door-inner|^door-bedroom|^door-kitchen/.test(o.name || '')) roots.push(o); });

  for (const root of roots) {
    out.push(`=== ${root.name}   visible ${root.visible ? 'y' : 'n'}`);
    root.traverse((o) => {
      if (!/pivot/.test(o.name || '')) return;
      const q = o.quaternion;
      out.push(`  pivot ${o.name}  rot xyz ${o.rotation.x.toFixed(4)} ${o.rotation.y.toFixed(4)} ${o.rotation.z.toFixed(4)} order ${o.rotation.order}` +
        `   quat ${q.x.toFixed(3)},${q.y.toFixed(3)},${q.z.toFixed(3)},${q.w.toFixed(3)}` +
        `   pos ${o.position.x.toFixed(3)},${o.position.y.toFixed(3)},${o.position.z.toFixed(3)}` +
        `   scale ${o.scale.x.toFixed(4)},${o.scale.y.toFixed(4)},${o.scale.z.toFixed(4)}`);
    });
    root.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const wb = g.boundingBox.clone().applyMatrix4(o.matrixWorld);
      const sx = wb.max.x - wb.min.x, sy = wb.max.y - wb.min.y, sz = wb.max.z - wb.min.z;
      // A door standing up has y as its biggest span by a wide margin. Report which axis is biggest
      // rather than judging it here, so the reading is the evidence.
      const big = sy >= sx && sy >= sz ? 'y (upright)' : sx >= sz ? 'x (flat/wide)' : 'z (flat/wide)';
      const idx = g.getIndex();
      out.push(`  ${(o.name || o.type).padEnd(24)} ${String((idx ? idx.count : g.getAttribute('position').count) / 3).padStart(5)}t  vis ${o.visible ? 'y' : 'n'}` +
        `  span ${sx.toFixed(3)} x ${sy.toFixed(3)} y ${sz.toFixed(3)} z   biggest ${big}`);
      out.push(`      world x ${wb.min.x.toFixed(3)}..${wb.max.x.toFixed(3)}  y ${wb.min.y.toFixed(3)}..${wb.max.y.toFixed(3)}  z ${wb.min.z.toFixed(3)}..${wb.max.z.toFixed(3)}`);
    });
  }
  out.push('');
  out.push(`player at ${p.position.x.toFixed(3)}, ${p.position.y.toFixed(3)}, ${p.position.z.toFixed(3)}  (eye)`);
  return out.join('\n');
})()
