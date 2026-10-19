/**
 * The wedge detector again, but through the cull the fix works in.
 *
 * _wedge.js forces every object visible before it sweeps (see the note at its `hidden` loop), which was
 * right when the fix under test was geometry: it asks "does this geometry wedge". This fix is not
 * geometry. The twelve static leaves are unchanged and they still wedge if you draw them from inside;
 * what changed is that the cull stops drawing one while the eye is inside it. So the instrument has to
 * run with the real cull state, from the real eye, or it measures the thing the fix deliberately leaves
 * alone and reports no change.
 *
 * Both passes are here, same poses, same near-plane A/B:
 *
 *   forced — every object visible, no cull. The positive control: it should still find the wedge, which
 *            is what makes a zero in the other column mean something.
 *   real   — the player put at the pose and HouseScene.update run once, so ModelProps' cull fires from
 *            that eye position exactly as it does in the game. This is the one that has to be clean.
 *
 * Poses that the collider set forbids are counted apart. A pose inside a wall is not a pose the player
 * can hold, and the two doors that swing keep their keep-outs, so some of _wedge.js's stands are now
 * unreachable by construction rather than by luck.
 *
 *   CDP_PORT=9223 CDP_MATCH=5199 node tools/cdp.mjs --file tools/_wedge2.js
 */
(async () => {
  const d = window.__daayan;
  const e = d.engine;
  const scene = e.scene;
  const cam = e.camera;
  const R = e.renderer;
  const p = d.player;
  const gl = R.getContext();
  const EYE = p.opts.eyeHeight;
  const RAD = p.opts.radius;
  const W = 480, H = 240;
  const a = new Uint8Array(W * H * 4);
  const b = new Uint8Array(W * H * 4);
  const NEAR_A = cam.near;
  const NEAR_B = cam.near + 0.0001;
  const LUMA = 12;
  const HIT = 40;

  const blocked = (x, y, z) => {
    const minY = y - EYE, maxY = y;
    for (const q of p.aabbs) {
      if (q.maxY <= minY + 0.05 || q.minY >= maxY + 0.05) continue;
      if (x + RAD > q.minX && x - RAD < q.maxX && maxY > q.minY && minY < q.maxY && z + RAD > q.minZ && z - RAD < q.maxZ) return true;
    }
    return false;
  };

  const keep = { near: cam.near, pos: cam.position.clone(), rot: cam.rotation.clone(), order: cam.rotation.order };
  const home = p.position.clone();
  const buf0 = [R.domElement.width, R.domElement.height];
  const out = [];
  // The loop's own frames would render at the reduced size and, worse, run the cull from wherever the
  // player drifted to between poses. Stopped for the sweep and restarted in the finally.
  d.loop.stop();
  cam.rotation.order = 'YXZ';
  R.setSize(W, H, false);
  try {
    const shoot = (buf, near) => {
      cam.near = near;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      R.setRenderTarget(null);
      R.render(scene, cam);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    };
    const probe = (yaw, pitch) => {
      cam.rotation.set(pitch, yaw, 0);
      shoot(a, NEAR_A);
      shoot(b, NEAR_B);
      let changed = 0, blackFlip = 0;
      for (let i = 0; i < W * H; i++) {
        const j = i * 4;
        const la = (a[j] * 299 + a[j + 1] * 587 + a[j + 2] * 114) / 1000;
        const lb = (b[j] * 299 + b[j + 1] * 587 + b[j + 2] * 114) / 1000;
        if (Math.abs(la - lb) > LUMA) {
          changed++;
          if ((la < 26) !== (lb < 26)) blackFlip++;
        }
      }
      return { changed, blackFlip };
    };

    // _wedge.js's three, plus two controls on open floor for the noise floor.
    const SPOTS = [
      ['UPPER_INNER', 19.855, 1.75, 4.1],
      ['UP_BACK_DOOR', 16.5, -0.99, 4.1],
      ['BEDROOM_DOOR', -5, 2.6, 1.7],
      ['KITCHEN_DOOR', -6, 12.2, 1.7],
      ['hall (control)', 0, 6.5, 1.7],
    ];
    const YAWS = 6;
    const PITCHES = [0, -0.6];
    const stats = new Map();
    let drift = 0;
    for (const [name, dx, dz, eye] of SPOTS) {
      const s = { n: 0, legal: 0, fHits: 0, fMax: 0, rHits: 0, rMax: 0, rBlack: 0, worst: null };
      for (const [sx, sz] of [[dx - 0.55, dz], [dx, dz], [dx + 0.55, dz], [dx, dz - 0.55], [dx, dz + 0.55]]) {
        const legal = !blocked(sx, eye, sz);
        // The real pass. HouseScene.update does not touch the camera — the controller syncs it from its
        // own update, which the loop calls, not the scene — so the camera is set here and the scene
        // update is what runs the cull over it. The player is moved with it because the storey checks
        // read one and the collider tests the other, and they should not disagree. Yaw and pitch come
        // after: the cull reads eye *position* only, so one update covers every heading from the stand.
        cam.position.set(sx, eye, sz);
        p.position.set(sx, eye, sz);
        p.velocity.set(0, 0, 0);
        d.scene.update(1 / 60);
        drift = Math.max(drift, Math.hypot(cam.position.x - sx, cam.position.y - eye, cam.position.z - sz));
        const real = [];
        for (let k = 0; k < YAWS; k++) for (const pitch of PITCHES) real.push(probe((k / YAWS) * Math.PI * 2, pitch));
        // The forced pass, same stand: everything visible, nothing culled.
        const hidden = [];
        scene.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
        const forced = [];
        for (let k = 0; k < YAWS; k++) for (const pitch of PITCHES) forced.push(probe((k / YAWS) * Math.PI * 2, pitch));
        for (const o of hidden) o.visible = false;
        real.forEach((r, i) => {
          const f = forced[i];
          s.n++;
          if (legal) s.legal++;
          if (f.changed > s.fMax) s.fMax = f.changed;
          if (f.changed > HIT) s.fHits++;
          if (!legal) return;
          if (r.changed > s.rMax) s.rMax = r.changed;
          if (r.blackFlip > s.rBlack) s.rBlack = r.blackFlip;
          if (r.changed > HIT) {
            s.rHits++;
            const yaw = (Math.floor(i / PITCHES.length) / YAWS) * Math.PI * 2;
            if (!s.worst || r.changed > s.worst.changed) s.worst = { sx, sz, eye, yaw, pitch: PITCHES[i % PITCHES.length], ...r };
          }
        });
        await new Promise((res) => requestAnimationFrame(res));
      }
      stats.set(name, s);
    }

    out.push(`${W}x${H}, near ${NEAR_A} vs ${NEAR_B}, luma ${LUMA}, hit above ${HIT} changed px`);
    out.push(`colliders ${p.aabbs.length}   worst eye drift from the intended stand ${drift.toFixed(3)} m`);
    out.push('');
    out.push(`${'spot'.padEnd(15)} ${'poses'.padStart(5)} ${'legal'.padStart(5)}   forced: ${'hits'.padStart(4)} ${'worst'.padStart(6)}    real: ${'hits'.padStart(4)} ${'worst'.padStart(6)} ${'blackFlip'.padStart(9)}`);
    for (const [name, s] of stats) {
      out.push(`${name.padEnd(15)} ${String(s.n).padStart(5)} ${String(s.legal).padStart(5)}           ${String(s.fHits).padStart(4)} ${String(s.fMax).padStart(6)}          ${String(s.rHits).padStart(4)} ${String(s.rMax).padStart(6)} ${String(s.rBlack).padStart(9)}`);
    }
    const worst = [...stats.values()].map((s) => s.worst).filter(Boolean).sort((x, y) => y.changed - x.changed)[0];
    if (worst) {
      out.push('');
      out.push(`worst surviving pose: node tools/devshot.mjs .thresh/wedge.png ${worst.sx.toFixed(3)} ${worst.eye} ${worst.sz.toFixed(3)} ${worst.yaw.toFixed(4)} ${worst.pitch.toFixed(2)}`);
    }
  } finally {
    cam.near = keep.near;
    cam.position.copy(keep.pos);
    cam.rotation.copy(keep.rot);
    cam.rotation.order = keep.order;
    cam.updateProjectionMatrix();
    p.position.copy(home);
    p.velocity.set(0, 0, 0);
    if (typeof e.resizeHandler === 'function') e.resizeHandler();
    else R.setSize(buf0[0], buf0[1], false);
    d.loop.start();
  }
  out.push(`drawing buffer ${buf0.join('x')} -> ${W}x${H} -> ${R.domElement.width}x${R.domElement.height}`);
  return out.join('\n');
})()
