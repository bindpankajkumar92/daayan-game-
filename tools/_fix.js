/**
 * Four candidate fixes, measured against the same instrument, before any file is edited.
 *
 * _near.js settled the mechanism: at UPPER_INNER the leaf of door-inner.glb reaches 0.070 m from the eye
 * and 0.401 m *behind* it, and one 0.55 m triangle spans w 0.000..0.427. So the camera is inside a
 * front-face-only solid, and no amount of edge subdivision helps — round 3 already bounded this file to
 * 0.99 m and the flip survives.
 *
 * That leaves four things that could stop it, and there is no reason to argue about them when each can be
 * applied live and scored by the same near-plane A/B:
 *
 *   base    what it does now
 *   near35  camera.near 0.1 -> 0.35, past the leaf's 0.070 m. A diagnostic, not a shippable fix: the
 *           held lantern sits at z -0.27 and the arms cross near 0.1 on purpose (HeldLantern.ts:69-76),
 *           so shipping this would clip the player's own hands. If it zeroes the flip, the mechanism is
 *           confirmed as near-plane w -> 0 and nothing else.
 *   double  side = DoubleSide on the leaf's materials. If the artefact is "eye inside an unlit hollow",
 *           the back faces fill it and the flicker becomes an honest solid.
 *   hidden  the two leaf meshes removed. The control: this must go to ~0, or the attribution was wrong.
 *
 * Each is applied, scored at both poses, and undone before the next, and `base` is re-scored after every
 * one — the same interleaved re-baseline _attrib.js needed, for the same reason.
 *
 *   node tools/cdp.mjs --file tools/_fix.js
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
  /** Flipped pixels for a 0.1 mm nudge about whatever `near` the variant wants as its baseline. */
  const diff = (near) => {
    shoot(a, near);
    shoot(b, near + 0.0001);
    let changed = 0;
    for (let i = 0; i < W * H; i++) {
      const j = i * 4;
      const la = (a[j] * 299 + a[j + 1] * 587 + a[j + 2] * 114) / 1000;
      const lb = (b[j] * 299 + b[j + 1] * 587 + b[j + 2] * 114) / 1000;
      if (Math.abs(la - lb) > LUMA) changed++;
    }
    return changed;
  };

  // The leaf: every mesh under a door-inner placement, and its materials, deduped.
  const leaves = [];
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    for (let p = o; p; p = p.parent) if (/door-inner/.test(p.name || '')) { leaves.push(o); return; }
  });
  const mats = [];
  for (const o of leaves) for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m && !mats.includes(m)) mats.push(m);

  const POSES = [
    ['UPPER_INNER', 19.855, 4.1, 2.3, 5.4978, -0.85],
    ['UP_BACK_DOOR', 16.5, 4.1, -1.54, 5.4978, 0.0],
  ];
  const out = [];
  out.push(`${W}x${H}, luma ${LUMA}; ${hidden.length} objects forced visible`);
  out.push(`${leaves.length} door-inner meshes, ${mats.length} distinct materials (shared across the 8 clones)`);
  out.push('');
  out.push('pose          base   near35  double  hidden   rebase');

  for (const [name, px, py, pz, yaw, pitch] of POSES) {
    cam.position.set(px, py, pz);
    cam.rotation.set(pitch, yaw, 0);
    cam.updateMatrixWorld(true);

    const base = diff(0.1);

    const near35 = diff(0.35);

    const side0 = mats.map((m) => m.side);
    for (const m of mats) { m.side = 2; m.needsUpdate = true; } // 2 === DoubleSide
    const dbl = diff(0.1);
    for (let i = 0; i < mats.length; i++) { mats[i].side = side0[i]; mats[i].needsUpdate = true; }

    const vis0 = leaves.map((o) => o.visible);
    for (const o of leaves) o.visible = false;
    const hid = diff(0.1);
    for (let i = 0; i < leaves.length; i++) leaves[i].visible = vis0[i];

    const rebase = diff(0.1);
    out.push(
      `${name.padEnd(13)} ${String(base).padStart(5)} ${String(near35).padStart(8)} ` +
        `${String(dbl).padStart(7)} ${String(hid).padStart(7)} ${String(rebase).padStart(8)}`,
    );
    await new Promise((res) => requestAnimationFrame(res));
  }

  // Where the leaf actually is, since the flip depends on it and the live swing state is not knowable
  // from the source: its world box, and how far the nearest face is from each pose.
  out.push('');
  for (const o of leaves.slice(0, 4)) {
    const g = o.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox.clone().applyMatrix4(o.matrixWorld);
    out.push(
      `  ${(o.name || '(unnamed)').slice(0, 24).padEnd(24)} world box ` +
        `x ${bb.min.x.toFixed(2)}..${bb.max.x.toFixed(2)}  y ${bb.min.y.toFixed(2)}..${bb.max.y.toFixed(2)}  z ${bb.min.z.toFixed(2)}..${bb.max.z.toFixed(2)}`,
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
