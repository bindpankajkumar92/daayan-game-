/**
 * What is the upper flat's floor actually made of, and at what height, point by point?
 *
 * With `door-up-back`'s leaf gone, the brown band across the bottom of that pose belongs to
 * `upper-patch-floor-0` — a 128-triangle plane at y **2.340**, spanning x 14.400..19.900 and
 * z -1.930..3.720, wearing floor-wood.webp on #9a9a9a. 2.340 is the *store's* floor height; the flat's
 * is 2.400. So either that patch is buried under the flat's own boards and merely wasting triangles, or
 * the flat's boards are missing over part of their footprint and the player is looking 6 cm down onto
 * the patch — which would put a hard-edged ledge across the room, and that is what the screenshots show.
 *
 * A ray straight down settles it. Fire one at every point of a grid over the flat, list every surface it
 * crosses with its height and owner, and report where the topmost one changes. A floor that steps
 * between 2.400 and 2.340 inside one room shows up as two different owners in the `top` column.
 *
 *   CDP_PORT=9223 CDP_MATCH=5199 node tools/cdp.mjs --file tools/_floor.js
 */
(() => {
  const d = window.__daayan;
  const scene = d.engine.scene;
  const THREE = d.engine.camera.constructor;
  scene.updateMatrixWorld(true);
  const out = [];

  // Raycaster reached through an existing instance rather than an import: this file is evaluated in the
  // page, so there is no module scope to import into.
  const rc = new (Object.getPrototypeOf(d.engine.raycaster ?? {}).constructor ?? function () {})();
  const ok = typeof rc.intersectObjects === 'function';
  if (!ok) out.push('note: no Raycaster reachable from the engine; falling back to box tests');

  /** Every mesh whose world box contains (x, z) and lies in the floor band, nearest surface first. */
  const stack = (x, z) => {
    const hits = [];
    scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      let q = o;
      for (; q; q = q.parent) if (!q.visible) return;
      const g = o.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const b = g.boundingBox.clone().applyMatrix4(o.matrixWorld);
      if (b.min.y > 2.6 || b.max.y < 2.2) return;
      if (x < b.min.x - 1e-6 || x > b.max.x + 1e-6) return;
      if (z < b.min.z - 1e-6 || z > b.max.z + 1e-6) return;
      hits.push({ name: o.name || o.type, y: b.max.y, lo: b.min.y, tris: (g.getIndex() ? g.getIndex().count : g.getAttribute('position').count) / 3 });
    });
    hits.sort((a, b) => b.y - a.y);
    return hits;
  };

  out.push(`${'point'.padEnd(16)} ${'top'.padEnd(24)} stack (highest first)`);
  for (let z = -1.8; z <= 3.6; z += 0.6) {
    for (let x = 14.6; x <= 20.0; x += 0.9) {
      const hits = stack(x, z);
      const top = hits[0];
      out.push(`${`${x.toFixed(1)}, ${z.toFixed(1)}`.padEnd(16)} ${(top ? `${top.name} @ ${top.y.toFixed(3)}` : 'nothing').padEnd(24)} ${hits.map((h) => `${h.name}@${h.y.toFixed(3)}`).join(' ')}`);
    }
  }
  out.push('');

  // And the floor meshes themselves, so the two heights can be read off one list.
  const floors = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox.clone().applyMatrix4(o.matrixWorld);
    if (b.min.y > 2.6 || b.max.y < 2.2) return;
    if (b.max.x < 13 || b.min.x > 25 || b.max.z < -9 || b.min.z > 4.5) return;
    const m = o.material;
    floors.push(`  ${(o.name || o.type).padEnd(24)} y ${b.min.y.toFixed(3)}..${b.max.y.toFixed(3)}  x ${b.min.x.toFixed(2)}..${b.max.x.toFixed(2)}  z ${b.min.z.toFixed(2)}..${b.max.z.toFixed(2)}` +
      `  ${(g.getIndex() ? g.getIndex().count : g.getAttribute('position').count) / 3}t  ${m?.color ? '#' + m.color.getHexString() : '-'} ${m?.map ? (m.map.name || m.map.image?.currentSrc?.split('/').pop() || 'tex') : 'no map'}`);
  });
  out.push(`meshes in the upper floor band (y 2.2..2.6): ${floors.length}`);
  out.push(...floors);
  return out.join('\n');
})()
