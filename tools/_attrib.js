/**
 * Which mesh is the near-plane A/B actually flipping?
 *
 * _wedge.js proves a depth-precision artefact exists at the two upper doorways and nowhere on the ground
 * floor, but it does not name the geometry. This does it the only way that cannot be argued with: at a
 * pose that fires, hide one mesh, re-run the same A/B, and see whether the flipping pixels go away. A
 * candidate whose removal takes `changed` to zero *is* the artefact; one whose removal changes nothing is
 * innocent whatever its triangle census says.
 *
 * Candidates are every mesh within 9 m of the camera, which at fov 70 covers everything that can be
 * responsible, ordered by distance so the report reads outward from the eye.
 *
 * Also reports the pixel bounding box of the flip, because a w -> 0 wedge is a large connected region
 * with a straight edge and depth-buffer noise at range is scattered single pixels.
 *
 *   node tools/cdp.mjs --file tools/_attrib.js
 */
(async () => {
  const d = window.__daayan;
  const e = d.engine;
  const scene = e.scene;
  const cam = e.camera;
  const R = e.renderer;
  const gl = R.getContext();
  const W = 480, H = 240;
  const a = new Uint8Array(W * H * 4);
  const b = new Uint8Array(W * H * 4);
  const NEAR_A = cam.near;
  const NEAR_B = cam.near + 0.0001;
  const LUMA = 12;

  const hidden = [];
  scene.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
  const keep = { near: cam.near, pos: cam.position.clone(), rot: cam.rotation.clone(), order: cam.rotation.order };
  const buf0 = [R.domElement.width, R.domElement.height];
  cam.rotation.order = 'YXZ';
  R.setSize(W, H, false);
  scene.updateMatrixWorld(true);

  const shoot = (buf, near) => {
    cam.near = near;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    R.setRenderTarget(null);
    R.render(scene, cam);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  };
  const diff = () => {
    shoot(a, NEAR_A);
    shoot(b, NEAR_B);
    let changed = 0, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let i = 0; i < W * H; i++) {
      const j = i * 4;
      const la = (a[j] * 299 + a[j + 1] * 587 + a[j + 2] * 114) / 1000;
      const lb = (b[j] * 299 + b[j + 1] * 587 + b[j + 2] * 114) / 1000;
      if (Math.abs(la - lb) > LUMA) {
        changed++;
        const x = i % W, y = Math.floor(i / W);
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return { changed, box: changed ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : null };
  };

  // The two poses _wedge.js ranked worst, one at each doorway.
  const POSES = [
    ['UP_BACK_DOOR', 16.5, 4.1, -1.54, 5.4978, 0.0],
    ['UPPER_INNER', 19.855, 4.1, 2.3, 5.4978, -0.85],
  ];
  const out = [];

  for (const [name, px, py, pz, yaw, pitch] of POSES) {
    cam.position.set(px, py, pz);
    cam.rotation.set(pitch, yaw, 0);
    cam.updateMatrixWorld(true);
    const base = diff();
    out.push('');
    out.push(`${name} at (${px}, ${py}, ${pz}) yaw ${yaw} pitch ${pitch}`);
    out.push(`  baseline changed ${base.changed}${base.box ? `  flip box ${base.box.join(',')} of ${W}x${H}` : ''}`);
    if (base.changed === 0) { out.push('  nothing to attribute'); continue; }

    const cands = [];
    scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const g = o.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      const c = g.boundingSphere.center.clone().applyMatrix4(o.matrixWorld);
      const dist = c.distanceTo(cam.position);
      if (dist > 9) return;
      const path = [];
      for (let p = o; p && p !== scene; p = p.parent) path.push(p.name || p.type);
      cands.push({ o, dist, name: o.name || '(unnamed)', src: path.reverse().join('/').split('/').slice(0, 2).join('/') });
    });
    cands.sort((p, q) => p.dist - q.dist);
    out.push(`  ${cands.length} meshes within 9 m; hiding each in turn`);

    const scored = [];
    // Re-measure with nothing hidden after every candidate. The first version of this loop scored every
    // one of 91 meshes at a 100% drop, which is not an attribution but a symptom: something about the
    // *second* diff at a pose reads zero regardless of what is hidden. The interleaved re-baseline is what
    // tells those two apart, and it is printed for the first few candidates rather than assumed.
    const trace = [];
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      c.o.visible = false;
      const r = diff();
      c.o.visible = true;
      const again = diff();
      if (trace.length < 6) trace.push(`   trace ${i}: hide ${c.name} -> ${r.changed}; restored -> ${again.changed}`);
      if (again.changed > 0 && r.changed < again.changed) scored.push({ ...c, left: r.changed, drop: again.changed - r.changed });
      if (i % 8 === 7) await new Promise((res) => requestAnimationFrame(res));
    }
    out.push(...trace);
    scored.sort((p, q) => q.drop - p.drop);
    if (scored.length === 0) out.push('  no single mesh accounts for any of it');
    for (const s of scored.slice(0, 10)) {
      out.push(
        `   -${String(s.drop).padStart(5)} px  leaves ${String(s.left).padStart(5)}  ` +
          `${s.dist.toFixed(2)}m  ${s.name.padEnd(16)} ${s.src}`,
      );
    }
    await new Promise((res) => requestAnimationFrame(res));
  }

  cam.near = keep.near;
  cam.position.copy(keep.pos);
  cam.rotation.copy(keep.rot);
  cam.rotation.order = keep.order;
  cam.updateProjectionMatrix();
  for (const o of hidden) o.visible = false;
  if (typeof e.resizeHandler === 'function') e.resizeHandler();
  else R.setSize(buf0[0], buf0[1], false);
  out.unshift(`${W}x${H}, near ${NEAR_A} vs ${NEAR_B}, luma ${LUMA}; ${hidden.length} objects forced visible`);
  return out.join('\n');
})()
