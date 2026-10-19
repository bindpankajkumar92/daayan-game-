/**
 * Round 1's wedge detector, pointed at the two doorways the report survives at.
 *
 * A w -> 0 depth artefact is the one thing in a frame that is hypersensitive to the near plane: moving
 * `camera.near` by 0.1 mm leaves the projected x/y of every vertex untouched (the frustum's angular
 * extent is fixed by fov and aspect; the 2n/(r-l) scale cancels) and changes only the depth mapping. So
 * an A/B on near is a clean test — ordinary geometry gives a bit-identical image, and only fragments
 * whose visibility was decided by depth resolution flip. PROGRESS.md records the same instrument at
 * `posesWithWedge 17 -> 0` for round 1 and `0` at the wing doors for round 3.
 *
 * Rendered into an offscreen target with renderer.render, which bypasses `engine.grade`. That is the
 * point: the device's own screencap of two shots at the same pose differs by up to 166/255 because the
 * lantern swings and the frame is graded, and no threshold survives that. Here the only variable is the
 * near plane.
 *
 * Every mesh is forced visible for the sweep. The culler flips `visible` per frame from wherever the
 * player is standing, and a sweep that inherits that state answers "does this wedge from where the
 * player happens to be", not "does this geometry wedge" — the same trap the first run of the coplanar
 * probe fell into. Anything this finds is then to be confirmed on the device in the real game state.
 *
 *   node tools/cdp.mjs --file tools/_wedge.js
 */
(async () => {
  const d = window.__daayan;
  const e = d.engine;
  const scene = e.scene;
  const cam = e.camera;
  const R = e.renderer;
  const gl = R.getContext();
  // Read back from the default framebuffer at a reduced drawing-buffer size rather than from a
  // WebGLRenderTarget: nothing reachable from `window.__daayan` exposes that class (engine.tmpA/tmpB are
  // Vector3 scratch, and grade hands out four functions), and a full-size 1618x786 readback twice per
  // pose is 2.5 MB a shot. The size is restored through the engine's own resize handler and re-reported
  // at the end, so a restore that did not take is visible instead of silent.
  const W = 480, H = 240;
  const a = new Uint8Array(W * H * 4);
  const b = new Uint8Array(W * H * 4);
  const NEAR_A = cam.near;
  const NEAR_B = cam.near + (window.__wedgeDelta ?? 0.0001);
  const LUMA = 12;

  // Every object, not every mesh: the culler flips `visible` on the room Groups, and a hidden Group hides
  // its subtree whatever the meshes under it say. Forcing only meshes left whole rooms culled and made the
  // sweep depend on where the player was standing — two runs of this file gave UPPER_INNER 0/120 and
  // 29/120 from that alone.
  const hidden = [];
  scene.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });

  const keep = { near: cam.near, pos: cam.position.clone(), rot: cam.rotation.clone(), order: cam.rotation.order };
  const buf0 = [R.domElement.width, R.domElement.height];
  cam.rotation.order = 'YXZ';
  R.setSize(W, H, false);

  const shoot = (buf, near) => {
    cam.near = near;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    R.setRenderTarget(null);
    R.render(scene, cam);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  };

  /** One pose: how many pixels the near nudge moved, and how many of those were black on one side. */
  const probe = (x, y, z, yaw, pitch) => {
    cam.position.set(x, y, z);
    cam.rotation.set(pitch, yaw, 0);
    shoot(a, NEAR_A);
    shoot(b, NEAR_B);
    let changed = 0, blackFlip = 0, blackA = 0;
    for (let i = 0; i < W * H; i++) {
      const j = i * 4;
      const la = (a[j] * 299 + a[j + 1] * 587 + a[j + 2] * 114) / 1000;
      const lb = (b[j] * 299 + b[j + 1] * 587 + b[j + 2] * 114) / 1000;
      if (la < 26) blackA++;
      if (Math.abs(la - lb) > LUMA) {
        changed++;
        if ((la < 26) !== (lb < 26)) blackFlip++;
      }
    }
    return { changed, blackFlip, blackA };
  };

  // Two reported doorways on the flat's storey, plus one ground-floor doorway the user reports as already
  // fixed — a control, so a hit upstairs can be read as a hit rather than as whatever this instrument
  // does to any door.
  const SPOTS = [
    ['UPPER_INNER', 19.855, 1.75, 4.1],
    ['UP_BACK_DOOR', 16.5, -0.99, 4.1],
    ['BEDROOM_DOOR', -5, 2.6, 1.7],
  ];
  const YAWS = 8;
  const PITCHES = [0, -0.45, -0.85];
  const rows = [];
  let poses = 0, withWedge = 0, worst = null;
  const perSpot = new Map();

  for (const [name, dx, dz, eye] of SPOTS) {
    // Both sides of the threshold and standing in it, at the distances a player actually passes at.
    const STANDS = [[dx - 0.55, dz], [dx, dz], [dx + 0.55, dz], [dx, dz - 0.55], [dx, dz + 0.55]];
    for (const [sx, sz] of STANDS) {
      for (let k = 0; k < YAWS; k++) {
        const yaw = (k / YAWS) * Math.PI * 2;
        for (const pitch of PITCHES) {
          const r = probe(sx, eye, sz, yaw, pitch);
          poses++;
          const s = perSpot.get(name) ?? { n: 0, hits: 0, max: 0, maxBlack: 0 };
          s.n++;
          if (r.changed > s.max) s.max = r.changed;
          if (r.blackFlip > s.maxBlack) s.maxBlack = r.blackFlip;
          if (r.changed > 40) {
            s.hits++;
            withWedge++;
            const row = { name, sx, sz, eye, yaw, pitch, ...r };
            rows.push(row);
            if (!worst || r.changed > worst.changed) worst = row;
          }
          perSpot.set(name, s);
        }
      }
      await new Promise((res) => requestAnimationFrame(res));
    }
  }

  cam.near = keep.near;
  cam.position.copy(keep.pos);
  cam.rotation.copy(keep.rot);
  cam.rotation.order = keep.order;
  cam.updateProjectionMatrix();
  for (const o of hidden) o.visible = false;
  if (typeof e.resizeHandler === 'function') e.resizeHandler();
  else R.setSize(buf0[0], buf0[1], false);

  const out = [];
  out.push(`${W}x${H} default framebuffer, near ${NEAR_A} vs ${NEAR_B}, luma threshold ${LUMA}`);
  out.push(`drawing buffer ${buf0.join('x')} -> ${W}x${H} -> ${R.domElement.width}x${R.domElement.height}`);
  out.push(`forced visible for the sweep: ${hidden.length} meshes`);
  out.push(`${poses} poses, ${withWedge} with more than 40 changed pixels`);
  for (const [name, s] of perSpot) {
    out.push(`  ${name.padEnd(14)} ${String(s.hits).padStart(3)}/${s.n} poses   worst changed ${String(s.max).padStart(5)}   worst blackFlip ${String(s.maxBlack).padStart(5)}`);
  }
  out.push('');
  rows.sort((p, q) => q.changed - p.changed);
  out.push('door           stand              yaw   pitch  changed  blackFlip  blackA');
  for (const r of rows.slice(0, 20)) {
    out.push(
      `${r.name.padEnd(14)} (${r.sx.toFixed(2)}, ${r.sz.toFixed(2)})`.padEnd(33) +
        ` ${r.yaw.toFixed(2).padStart(5)} ${r.pitch.toFixed(2).padStart(6)} ` +
        `${String(r.changed).padStart(8)} ${String(r.blackFlip).padStart(10)} ${String(r.blackA).padStart(7)}`,
    );
  }
  if (worst) {
    out.push('');
    out.push(`worst pose: node tools/devshot.mjs .thresh/wedge.png ${worst.sx.toFixed(3)} ${worst.eye} ${worst.sz.toFixed(3)} ${worst.yaw.toFixed(4)} ${worst.pitch.toFixed(2)}`);
  }
  return out.join('\n');
})()
