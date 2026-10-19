/**
 * Is the residual reading stable, or is the instrument?
 *
 * _blame.js measured 132 / 131 / 90 / 55 changed pixels at four poses; _zfight.js, cold, measured 0 at
 * three of the same four and 130 at the fourth. Both used the same near-plane A/B and the same poses, so
 * something outside the depth buffer moves between runs — the lantern flicker and the arm sway both
 * advance on every scene update, and the grade quad sits in the scene at 0.2 m. A number that is not
 * repeatable is not a measurement, so before any of it is reported: same pose, A/B repeated with nothing
 * touched, then repeated with one scene update in between.
 *
 *   CDP_PORT=9223 CDP_MATCH=5199 node tools/cdp.mjs --file tools/_repeat.js
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
  const LUMA = 12;

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
    /** changed px between the two near values, and how far the two frames differ at their loudest. */
    const pair = () => {
      shoot(a, NEAR_A);
      shoot(b, NEAR_B);
      let n = 0, peak = 0;
      for (let i = 0; i < W * H; i++) {
        const j = i * 4;
        const la = (a[j] * 299 + a[j + 1] * 587 + a[j + 2] * 114) / 1000;
        const lb = (b[j] * 299 + b[j + 1] * 587 + b[j + 2] * 114) / 1000;
        const dd = Math.abs(la - lb);
        if (dd > peak) peak = dd;
        if (dd > LUMA) n++;
      }
      return { n, peak };
    };
    /** Same near on both shots. Whatever this reports is the instrument's own noise, not depth. */
    const control = () => {
      shoot(a, NEAR_A);
      shoot(b, NEAR_A);
      let n = 0;
      for (let i = 0; i < W * H; i++) {
        const j = i * 4;
        const la = (a[j] * 299 + a[j + 1] * 587 + a[j + 2] * 114) / 1000;
        const lb = (b[j] * 299 + b[j + 1] * 587 + b[j + 2] * 114) / 1000;
        if (Math.abs(la - lb) > LUMA) n++;
      }
      return n;
    };

    const POSES = [
      ['UPPER_INNER', 19.305, 4.1, 1.75, 4.1888, 0],
      ['UP_BACK_DOOR', 16.5, 4.1, -0.99, 0, 0],
      ['UPPER_INNER b', 20.405, 4.1, 1.75, 2.0944, 0],
      ['BEDROOM_DOOR', -5, 1.7, 2.05, 3.1416, 0],
    ];
    out.push(`${'pose'.padEnd(15)} ${'still x4'.padEnd(24)} ${'after one update x4'.padEnd(24)} same-near control`);
    for (const [name, x, y, z, yaw, pitch] of POSES) {
      cam.position.set(x, y, z);
      p.position.set(x, y, z);
      p.velocity.set(0, 0, 0);
      d.scene.update(1 / 60);
      cam.rotation.set(pitch, yaw, 0);
      const still = [];
      for (let i = 0; i < 4; i++) still.push(pair());
      const moved = [];
      for (let i = 0; i < 4; i++) {
        d.scene.update(1 / 60);
        cam.rotation.set(pitch, yaw, 0);
        moved.push(pair());
      }
      out.push(`${name.padEnd(15)} ${still.map((r) => r.n).join(' ').padEnd(24)} ${moved.map((r) => r.n).join(' ').padEnd(24)} ${control()}` +
        `   peak luma diff ${Math.max(...still.map((r) => r.peak), ...moved.map((r) => r.peak)).toFixed(0)}`);
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
