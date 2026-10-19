/**
 * What surfaces actually wear the upper flat's sealed shell material — walls only, or floor and ceiling
 * too?
 *
 * It decides the shape of the fix. A shell that is only vertical wall can take one plaster map. One that
 * also carries the flat's 179 m2 floor slab and its ceiling needs the geometry split by facing first,
 * because boards and plaster are different images, and a single material cannot be both.
 *
 * Areas are world areas: the model is fitted by height and carries a scale near 100, so a local-space
 * measurement would be meaningless.
 *
 *   node tools/cdp.mjs --file tools/_shell.js
 */
(() => {
  const d = window.__daayan;
  const scene = d.engine.scene;
  const V3 = d.engine.camera.position.constructor;
  scene.updateMatrixWorld(true);

  const targets = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.some((m) => m && !m.map && m.color?.getHex?.() === 0x4a4a52)) targets.push(o);
  });

  const a = new V3(), b = new V3(), c = new V3(), e1 = new V3(), e2 = new V3(), n = new V3();
  const buckets = new Map();
  const out = [];
  for (const mesh of targets) {
    const pos = mesh.geometry.attributes.position;
    const idx = mesh.geometry.index;
    const count = idx ? idx.count : pos.count;
    let area = 0;
    for (let i = 0; i < count; i += 3) {
      const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);
      e1.subVectors(b, a); e2.subVectors(c, a);
      n.crossVectors(e1, e2);
      const tri = n.length() / 2;
      if (!(tri > 0)) continue;
      area += tri;
      n.normalize();
      const ay = Math.abs(n.y);
      const face = ay > 0.7 ? (n.y > 0 ? 'up (floor)' : 'down (ceiling)') : ay < 0.3 ? 'vertical (wall)' : 'sloped';
      // Bucket by facing and by the height band it sits in, rounded to 10 cm.
      const yb = ((a.y + b.y + c.y) / 3).toFixed(1);
      const key = `${face} @y~${yb}`;
      const cur = buckets.get(key) ?? { area: 0, tris: 0 };
      cur.area += tri; cur.tris++;
      buckets.set(key, cur);
    }
    out.push(`${mesh.name}  ${count / 3} tris  ${area.toFixed(1)} m2  scale ${mesh.matrixWorld.elements[0].toFixed(3)}`);
  }

  const byFace = new Map();
  for (const [k, v] of buckets) {
    const face = k.split(' @')[0];
    const cur = byFace.get(face) ?? { area: 0, tris: 0 };
    cur.area += v.area; cur.tris += v.tris;
    byFace.set(face, cur);
  }
  out.push('', 'by facing:');
  for (const [k, v] of [...byFace].sort((p, q) => q[1].area - p[1].area)) {
    out.push(`  ${k.padEnd(18)} ${v.area.toFixed(1).padStart(7)} m2  ${String(v.tris).padStart(6)} tris`);
  }
  out.push('', 'largest bands:');
  for (const [k, v] of [...buckets].sort((p, q) => q[1].area - p[1].area).slice(0, 14)) {
    out.push(`  ${k.padEnd(30)} ${v.area.toFixed(1).padStart(7)} m2  ${String(v.tris).padStart(6)} tris`);
  }
  const uv = targets[0]?.geometry.attributes.uv;
  out.push('', `uv attribute on ${targets[0]?.name}: ${uv ? `${uv.count} x ${uv.itemSize}` : 'NONE'}`);
  if (uv) {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < uv.count; i++) { mn = Math.min(mn, uv.getX(i), uv.getY(i)); mx = Math.max(mx, uv.getX(i), uv.getY(i)); }
    out.push(`  uv range ${mn.toFixed(3)} .. ${mx.toFixed(3)}`);
  }
  return out.join('\n');
})()
