/**
 * "What drew this pixel?" — ray-cast a few NDC points against every triangle in the scene and name the
 * mesh, material and face that answers.
 *
 * three's own Raycaster is not reachable from the page (nothing exports THREE onto window), so this is a
 * hand-rolled Möller-Trumbore in local space: invert the ray once per mesh, walk its index buffer, keep
 * the nearest hit. A few hundred thousand triangle tests, which is nothing for four rays, and it answers
 * the one question a screenshot cannot — a smooth dark panel on screen is either a wall with the wrong
 * material or a hole with fog behind it, and those two have completely different fixes.
 *
 *   node tools/cdp.mjs --file tools/_who.js
 */
(() => {
  const d = window.__daayan;
  const cam = d.engine.camera;
  const scene = d.engine.scene;
  const V3 = cam.position.constructor;

  // NDC points to probe, named. Derived from .thresh/30-user-pose.png: the canvas occupies x 105..2325,
  // y 104..1080 of the 2460x1080 screencap.
  const PROBES = [
    ['panel-left    ', -0.097, 0.582],
    ['panel-mid     ', 0.346, 0.457],
    ['panel-right   ', 0.845, 0.658],
    ['panel-low     ', 0.346, 0.15],
    ['floor-control ', 0.124, -0.551],
    ['seam          ', 0.346, 0.28],
  ];

  const origin = cam.position.clone();
  const rays = PROBES.map(([name, nx, ny]) => {
    const far = new V3(nx, ny, 0.5).applyMatrix4(cam.projectionMatrixInverse).applyMatrix4(cam.matrixWorld);
    return { name, dir: far.sub(origin).normalize() };
  });

  const meshes = [];
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    let vis = true;
    let onCamera = false;
    let root = o;
    for (let p = o; p; p = p.parent) {
      if (!p.visible) vis = false;
      if (p === cam) onCamera = true;
      if (p.name) root = p;
    }
    // The grade quad and the held-lantern arm ride the camera and would answer every ray at 0.3 m.
    if (!vis || onCamera || o.name === 'grade') return;
    meshes.push(Object.assign(o, { __root: root.name }));
  });

  const lo = new V3(), ld = new V3(), inv = new cam.matrixWorld.constructor();
  const a = new V3(), b = new V3(), c = new V3(), e1 = new V3(), e2 = new V3(), pv = new V3(), qv = new V3(), tv = new V3();
  const out = [`cam ${origin.toArray().map((v) => v.toFixed(2)).join(', ')}  fov ${cam.fov}  meshes ${meshes.length}`];

  for (const ray of rays) {
    let best = null;
    for (const mesh of meshes) {
      inv.copy(mesh.matrixWorld).invert();
      lo.copy(origin).applyMatrix4(inv);
      ld.copy(ray.dir).transformDirection(inv);
      const pos = mesh.geometry.attributes.position;
      const idx = mesh.geometry.index;
      const n = idx ? idx.count : pos.count;
      for (let i = 0; i < n; i += 3) {
        const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
        a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
        e1.subVectors(b, a); e2.subVectors(c, a);
        pv.crossVectors(ld, e2);
        const det = e1.dot(pv);
        if (Math.abs(det) < 1e-12) continue;
        const invDet = 1 / det;
        tv.subVectors(lo, a);
        const u = tv.dot(pv) * invDet;
        if (u < 0 || u > 1) continue;
        qv.crossVectors(tv, e1);
        const v = ld.dot(qv) * invDet;
        if (v < 0 || u + v > 1) continue;
        const t = e2.dot(qv) * invDet;
        if (t <= 0.01) continue;
        // t is in the mesh's *local* units; these models carry scales of 100+, so ordering hits by it
        // would put a distant imported wall in front of a floorboard 30 cm away. Measure in world space.
        const world = lo.clone().addScaledVector(ld, t).applyMatrix4(mesh.matrixWorld);
        const wd = world.distanceTo(origin);
        if (!best || wd < best.wd) best = { wd, mesh, world, face: i / 3 };
      }
    }
    if (!best) { out.push(`${ray.name} -> nothing (fog)`); continue; }
    const m = Array.isArray(best.mesh.material) ? best.mesh.material[0] : best.mesh.material;
    out.push(
      `${ray.name} -> ${`${best.mesh.__root}/${best.mesh.name || '(unnamed)'}`.padEnd(34)} ` +
        `${best.world.toArray().map((q) => q.toFixed(2)).join(', ').padEnd(22)} ` +
        `d=${best.wd.toFixed(2)}m  mat=${m?.name || m?.type} map=${m?.map ? (m.map.name || 'yes') : 'NONE'} ` +
        `col=#${m?.color?.getHexString?.() ?? '?'} side=${m?.side} rough=${m?.roughness ?? '-'}`,
    );
  }
  return out.join('\n');
})()
