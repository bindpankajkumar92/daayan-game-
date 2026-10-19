/**
 * Is the surviving 129 px the reported defect, or a house-wide faint thing that predates it?
 *
 * _repeat.js showed the reading is exactly repeatable and that only UP_BACK_DOOR still flips: 129 px at a
 * peak luma difference of 20/255, no black flip. _zfight.js blamed coplanar faces inside one mesh of
 * `door-inner.glb` — and that model is what ten of the twelve leaf rows are, including every ground-floor
 * interior door the user says is already fine. If those doors show the same residual, it is not the
 * second-floor glitch and never was; if they are clean and only the upper one flips, it is.
 *
 * Two things per pose beyond the count:
 *
 *   shape — the bounding box of the changed pixels and how much of it they fill. A w->0 wedge is a solid
 *           region and fills its box; an edge shimmer along a seam is a thin line through a large box and
 *           fills almost none of it. This distinguishes the two mechanisms without looking at a picture.
 *   black — how many of the changed pixels cross the black threshold in either direction. The reported
 *           defect is a black shape appearing and disappearing. A z-fight between two lit surfaces of
 *           similar colour moves the luma a little and crosses nothing.
 *
 *   CDP_PORT=9223 CDP_MATCH=5199 node tools/cdp.mjs --file tools/_ground.js
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
  const LUMA = 12, BLACK = 26;

  const keep = { near: cam.near, pos: cam.position.clone(), rot: cam.rotation.clone(), order: cam.rotation.order };
  const home = p.position.clone();
  const buf0 = [R.domElement.width, R.domElement.height];
  const out = [];
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
    const probe = () => {
      shoot(a, NEAR_A);
      shoot(b, NEAR_B);
      let n = 0, black = 0, peak = 0;
      let x0 = W, x1 = -1, y0 = H, y1 = -1;
      for (let i = 0; i < W * H; i++) {
        const j = i * 4;
        const la = (a[j] * 299 + a[j + 1] * 587 + a[j + 2] * 114) / 1000;
        const lb = (b[j] * 299 + b[j + 1] * 587 + b[j + 2] * 114) / 1000;
        const dd = Math.abs(la - lb);
        if (dd > peak) peak = dd;
        if (dd <= LUMA) continue;
        n++;
        if ((la < BLACK) !== (lb < BLACK)) black++;
        const px = i % W, py = (i / W) | 0;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
      }
      const area = n === 0 ? 0 : (x1 - x0 + 1) * (y1 - y0 + 1);
      return { n, black, peak, area, fill: area === 0 ? 0 : n / area, box: n === 0 ? '-' : `${x1 - x0 + 1}x${y1 - y0 + 1}` };
    };

    /**
     * The upper survivor, then the same model on the ground floor. The ground poses stand a little back
     * from each doorway and look through it, which is the stand the leaf fills the view from. Eye 1.7 is
     * standing height; the upper ones are at 4.1 because that is the second storey's floor plus the eye.
     */
    const POSES = [
      ['UP_BACK_DOOR   upper', 16.5, 4.1, -0.99, 0],
      ['UPPER_INNER    upper', 19.305, 4.1, 1.75, 4.1888],
      ['door-kitchen   ground', -6, 1.7, 12.2, 3.1416],
      ['door-store     ground', -6, 1.7, 9.0, 3.1416],
      ['door-bedroom   ground', -5, 1.7, 2.6, 3.1416],
      ['door-living    ground', 0, 1.7, 2.6, 0],
      ['door-pooja     ground', -6, 1.7, 6.0, 3.1416],
      ['hall  (control)', 0, 1.7, 6.5, 0],
    ];
    out.push(`${'pose'.padEnd(22)} ${'changed'.padStart(7)} ${'black'.padStart(6)} ${'peak'.padStart(5)} ${'box'.padStart(9)} ${'fill'.padStart(6)}   nearest visible mesh`);
    for (const [name, x, y, z, yaw] of POSES) {
      cam.position.set(x, y, z);
      p.position.set(x, y, z);
      p.velocity.set(0, 0, 0);
      d.scene.update(1 / 60);
      cam.rotation.set(0, yaw, 0);
      const r = probe();
      // Which leaf rows are actually being drawn from here — a pose whose door is culled proves nothing
      // about that door, and the count above would be someone else's.
      const drawn = [];
      scene.traverse((o) => {
        if (!o.name || !o.name.startsWith('door')) return;
        if (!o.visible) return;
        for (let q = o.parent; q; q = q.parent) if (!q.visible) return;
        drawn.push(o.name);
      });
      out.push(`${name.padEnd(22)} ${String(r.n).padStart(7)} ${String(r.black).padStart(6)} ${r.peak.toFixed(0).padStart(5)} ${r.box.padStart(9)} ${r.fill.toFixed(3).padStart(6)}   doors drawn: ${drawn.join(' ') || 'none'}`);
      await new Promise((res) => requestAnimationFrame(res));
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
  return out.join('\n');
})()
