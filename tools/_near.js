/**
 * Why does an already-bounded mesh still flip under a near nudge?
 *
 * _attrib.js names the culprit at UPPER_INNER: the two meshes of door-inner.glb, at 0.82 m, account for
 * 358 + 201 of 557 flipped pixels — all of it. That is the one model round 3 *did* subdivide
 * ("0 triangles over 1 m, longest 0.99 m" by tools/glb-edges.mjs), so either the shipped asset does not
 * carry the split or a 1 m bound is not tight enough against a 0.1 m near plane.
 *
 * Both are measurable at the pose. For each triangle of those meshes: the longest edge in world metres,
 * the nearest vertex distance to the eye, and the view-space depth of the nearest and furthest vertex —
 * the ratio of the two is what decides whether 1/w interpolation across the triangle has any precision
 * left. A triangle with one vertex at 0.11 m and another at 1.5 m spans a 14x range of w inside one
 * primitive, and that is the round-1 failure whatever its edge length is.
 *
 * The diff is also printed as a 60x30 map, because the shape says what made it: a wedge is one connected
 * region with a straight edge, and depth noise at range is scattered pixels.
 *
 *   node tools/cdp.mjs --file tools/_near.js
 */
(() => {
  const d = window.__daayan;
  const e = d.engine;
  const scene = e.scene;
  const cam = e.camera;
  const R = e.renderer;
  const gl = R.getContext();
  const W = 480, H = 240;
  const a = new Uint8Array(W * H * 4);
  const b = new Uint8Array(W * H * 4);

  const hidden = [];
  scene.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
  const keep = { near: cam.near, pos: cam.position.clone(), rot: cam.rotation.clone(), order: cam.rotation.order };
  const buf0 = [R.domElement.width, R.domElement.height];
  cam.rotation.order = 'YXZ';
  R.setSize(W, H, false);

  cam.position.set(19.855, 4.1, 2.3);
  cam.rotation.set(-0.85, 5.4978, 0);
  cam.updateMatrixWorld(true);
  scene.updateMatrixWorld(true);

  const shoot = (buf, near) => {
    cam.near = near;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    R.setRenderTarget(null);
    R.render(scene, cam);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  };
  shoot(a, keep.near);
  shoot(b, keep.near + 0.0001);

  const out = [];
  const GX = 60, GY = 30;
  const cell = new Float64Array(GX * GY);
  let changed = 0;
  for (let i = 0; i < W * H; i++) {
    const j = i * 4;
    const la = (a[j] * 299 + a[j + 1] * 587 + a[j + 2] * 114) / 1000;
    const lb = (b[j] * 299 + b[j + 1] * 587 + b[j + 2] * 114) / 1000;
    if (Math.abs(la - lb) > 12) {
      changed++;
      // readPixels is bottom-up; flip so the map reads the way the frame does.
      const x = i % W, y = H - 1 - Math.floor(i / W);
      cell[Math.min(GY - 1, Math.floor((y / H) * GY)) * GX + Math.min(GX - 1, Math.floor((x / W) * GX))]++;
    }
  }
  out.push(`pose (19.855, 4.1, 2.3) yaw 5.4978 pitch -0.85 — ${changed} pixels flipped by a 0.1 mm near nudge`);
  out.push(`diff map, ${GX}x${GY} cells over ${W}x${H}; . none, : 1-3, + 4-15, # over 15`);
  const per = (W / GX) * (H / GY);
  for (let gy = 0; gy < GY; gy++) {
    let row = '';
    for (let gx = 0; gx < GX; gx++) {
      const n = cell[gy * GX + gx];
      row += n === 0 ? '.' : n <= 3 ? ':' : n <= 15 ? '+' : '#';
    }
    out.push(`  ${row}`);
  }
  out.push(`  (a full cell is ${per} pixels)`);

  // Per-triangle geometry of the two meshes the attribution named, in world metres and view-space depth.
  const eye = cam.position;
  const fwd = { x: -Math.sin(5.4978) * Math.cos(-0.85), y: Math.sin(-0.85), z: -Math.cos(5.4978) * Math.cos(-0.85) };
  const targets = [];
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    let src = '';
    for (let p = o; p; p = p.parent) if (/door-inner/.test(p.name || '')) src = p.name;
    if (src) targets.push(o);
  });
  out.push('');
  out.push(`${targets.length} door-inner meshes in the scene; the two nearest are what flipped`);
  const rows = [];
  for (const o of targets) {
    const g = o.geometry;
    const pos = g.attributes.position;
    if (!pos) continue;
    const el = o.matrixWorld.elements;
    const wp = (j) => {
      const x = pos.getX(j), y = pos.getY(j), z = pos.getZ(j);
      return [el[0] * x + el[4] * y + el[8] * z + el[12], el[1] * x + el[5] * y + el[9] * z + el[13], el[2] * x + el[6] * y + el[10] * z + el[14]];
    };
    const idx = g.index;
    const n = idx ? idx.count : pos.count;
    let maxEdge = 0, over1 = 0, minDepth = Infinity, worstRatio = 0, worstAt = null, nearest = Infinity;
    for (let i = 0; i + 2 < n; i += 3) {
      const t = [0, 1, 2].map((k) => wp(idx ? idx.getX(i + k) : i + k));
      let longest = 0;
      for (let k = 0; k < 3; k++) {
        const p = t[k], q = t[(k + 1) % 3];
        longest = Math.max(longest, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
      }
      if (longest > maxEdge) maxEdge = longest;
      if (longest > 1.0) over1++;
      // View-space depth of each vertex: the component along the forward axis, which is w in the
      // projection. A vertex with depth below `near` is clipped; the danger is a triangle that straddles.
      const dep = t.map((p) => (p[0] - eye.x) * fwd.x + (p[1] - eye.y) * fwd.y + (p[2] - eye.z) * fwd.z);
      const lo = Math.min(...dep), hi = Math.max(...dep);
      const dist = Math.min(...t.map((p) => Math.hypot(p[0] - eye.x, p[1] - eye.y, p[2] - eye.z)));
      if (dist < nearest) nearest = dist;
      if (lo < minDepth) minDepth = lo;
      if (hi > 0 && lo > 0 && hi / lo > worstRatio) {
        worstRatio = hi / lo;
        worstAt = [lo, hi, longest];
      }
    }
    rows.push({ name: o.name || '(unnamed)', tris: n / 3, maxEdge, over1, minDepth, nearest, worstRatio, worstAt });
  }
  rows.sort((p, q) => p.nearest - q.nearest);
  for (const r of rows) {
    out.push(
      `  ${r.name.slice(0, 24).padEnd(24)} ${String(r.tris).padStart(5)} tris  longest edge ${r.maxEdge.toFixed(2)}m  over1m ${r.over1}` +
        `  nearest vertex ${r.nearest.toFixed(3)}m  min view depth ${r.minDepth.toFixed(3)}m` +
        (r.worstAt ? `  worst w range ${r.worstAt[0].toFixed(3)}..${r.worstAt[1].toFixed(3)} (${r.worstRatio.toFixed(1)}x) on a ${r.worstAt[2].toFixed(2)}m edge` : ''),
    );
  }

  cam.near = keep.near;
  cam.position.copy(keep.pos);
  cam.rotation.copy(keep.rot);
  cam.rotation.order = keep.order;
  cam.updateProjectionMatrix();
  for (const o of hidden) o.visible = false;
  if (typeof e.resizeHandler === 'function') e.resizeHandler();
  else R.setSize(buf0[0], buf0[1], false);
  return out.join('\n');
})()
