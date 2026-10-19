/**
 * Two coplanar surfaces or one bad triangle? Every subtree whose removal stops the flicker.
 *
 * _blame.js descended into whichever subtree scored lowest and reported one culprit. That is the wrong
 * shape of answer for a z-fight, where hiding *either* of the two fighting surfaces stops it, and the
 * one it descended into was only the first of them. _obj6.js then showed the nearest thing to the eye at
 * those poses is the player's own hands at 0.099 m — parented to the camera, identical at both doors,
 * and present in both frames of the A/B — with no door triangle inside 0.30 m at all. So what survives
 * is not the wedge: nothing is straddling the eye plane any more. It is two surfaces at one depth
 * swapping which of them wins when the depth mapping moves.
 *
 * This finds all of them: hide one subtree at a time, keep every one that takes the flip to the noise
 * floor, and narrow each by recursing into it. A pair shows up as two independent killers.
 *
 *   CDP_PORT=9223 CDP_MATCH=5199 node tools/cdp.mjs --file tools/_zfight.js
 */
(async () => {
  const d = window.__daayan;
  const e = d.engine;
  const scene = e.scene;
  const cam = e.camera;
  const R = e.renderer;
  const p = d.player;
  const gl = R.getContext();
  const W = 480, H = 240;
  const a = new Uint8Array(W * H * 4);
  const b = new Uint8Array(W * H * 4);
  const NEAR_A = cam.near, NEAR_B = cam.near + 0.0001;
  const LUMA = 12, HIT = 40;
  const BUDGET = 600;

  const keep = { near: cam.near, pos: cam.position.clone(), rot: cam.rotation.clone(), order: cam.rotation.order };
  const home = p.position.clone();
  const buf0 = [R.domElement.width, R.domElement.height];
  const out = [];
  let renders = 0;
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
    const changedAt = () => {
      renders++;
      shoot(a, NEAR_A);
      shoot(b, NEAR_B);
      let n = 0;
      for (let i = 0; i < W * H; i++) {
        const j = i * 4;
        const la = (a[j] * 299 + a[j + 1] * 587 + a[j + 2] * 114) / 1000;
        const lb = (b[j] * 299 + b[j + 1] * 587 + b[j + 2] * 114) / 1000;
        if (Math.abs(la - lb) > LUMA) n++;
      }
      return n;
    };

    // The four poses _wedge2.js was left with, in the real cull state. See _wedge2.js on the scene update.
    const POSES = [
      ['UPPER_INNER', 19.305, 4.1, 1.75, 4.1888, 0],
      ['UP_BACK_DOOR', 16.5, 4.1, -0.99, 0, 0],
      ['UPPER_INNER b', 20.405, 4.1, 1.75, 2.0944, 0],
      ['BEDROOM_DOOR', -5, 1.7, 2.05, 3.1416, 0],
    ];
    for (const [name, x, y, z, yaw, pitch] of POSES) {
      cam.position.set(x, y, z);
      p.position.set(x, y, z);
      p.velocity.set(0, 0, 0);
      d.scene.update(1 / 60);
      cam.rotation.set(pitch, yaw, 0);
      const base = changedAt();
      out.push(`=== ${name} (${x}, ${y}, ${z}) yaw ${yaw.toFixed(2)}   changed ${base}`);
      if (base <= HIT) { out.push('  at the noise floor already'); continue; }
      const found = [];
      const walk = (node, path) => {
        if (renders > BUDGET) return;
        for (const c of node.children) {
          if (!c.visible || c.isLight || c.isCamera) continue;
          c.visible = false;
          const n = changedAt();
          c.visible = true;
          if (n > HIT) continue;
          const label = `${path}/${c.name || c.type}`;
          // Narrow it: if a child of this also kills the flip on its own, that child is the better
          // answer. If none does, this node is as far as the flip can be localised.
          const before = found.length;
          walk(c, label);
          if (found.length === before) found.push({ label, n, node: c });
        }
      };
      walk(scene, '');
      for (const f of found) {
        const g = f.node.isMesh ? f.node.geometry : null;
        let extra = '';
        if (g) {
          const idx = g.getIndex();
          const m = f.node.material;
          extra = `   ${(idx ? idx.count : g.getAttribute('position').count) / 3}t  ${Array.isArray(m) ? m.map((q) => q.name || q.type).join('+') : m?.name || m?.type}`;
        }
        out.push(`  killer  ${String(f.n).padStart(4)}  ${f.label}${extra}`);
      }
      if (found.length === 0) out.push('  nothing on its own accounts for it');
      await new Promise((res) => requestAnimationFrame(res));
    }
    out.push('');
    out.push(`${renders} A/B pairs rendered`);
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
  return out.join('\n');
})()
