/**
 * Do the other two upper-wing leaves make the same brown band as `door-up-back`, from stands a player
 * actually stands at?
 *
 * _band.js proved the band in the user's screenshot is `door-up-back`'s leaf, and _why.js proved why
 * round 5's hide misses it: `leafBoxes` traces the slab's own diagonal, so its four windows cover
 * z -1.851..-1.029 while the stands where the leaf fills the bottom of the frame are at z -0.7..-1.3 —
 * half a metre off the slab, which is not "inside" it by any margin and never will be. At half a metre a
 * door is legitimately drawn; it is just that a 1.07 x 2.15 m slab standing 57 degrees across a 1.4 m
 * doorway, seen from half a metre with the head tipped down, *is* a brown band across the lower frame.
 *
 * `door-up-child` and `door-up-shrine` are the same file at the same height with the same yaw magnitude
 * in the same 1.4 m openings, so they should do the same thing — but "should" is what got refuted twice
 * already, so measure it. For each of the three: walk a ring of stands round the leaf, aim at it, and
 * report how much of the *bottom third* of the frame the leaf owns, with the row's real per-frame cull
 * left in charge so the number is what the player sees and not what the leaf could do if forced.
 *
 *   changed — pixels in the lower band that move when the leaf stops being drawn.
 *   fill    — of the changed region's own bounding box, so a band reads as a band and not as edge noise.
 *   vis     — what the cull decided at that stand. 0 changed with vis y means the leaf is off-frame.
 *
 *   CDP_PORT=9223 CDP_MATCH=5199 node tools/cdp.mjs --file tools/_patti2.js
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
  const BAND = (H / 3) | 0; // readPixels counts up from the bottom, so rows 0..BAND are the lower third.
  const a = new Uint8Array(W * H * 4);
  const b = new Uint8Array(W * H * 4);
  const LUMA = 8;

  const keep = { pos: cam.position.clone(), rot: cam.rotation.clone(), order: cam.rotation.order, aspect: cam.aspect };
  const home = p.position.clone();
  const buf0 = [R.domElement.width, R.domElement.height];
  const out = [];
  d.loop.stop();
  cam.rotation.order = 'YXZ';
  R.setSize(W, H, false);
  cam.aspect = W / H;
  cam.updateProjectionMatrix();
  try {
    const shoot = (buf) => {
      cam.updateMatrixWorld(true);
      R.setRenderTarget(null);
      R.render(scene, cam);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    };
    /** How much of the lower band moves between the two shots, and what colour it was while drawn. */
    const band = () => {
      let n = 0, r = 0, g = 0, bl = 0;
      let x0 = W, x1 = -1, y0 = H, y1 = -1;
      for (let y = 0; y < BAND; y++) {
        for (let x = 0; x < W; x++) {
          const j = (y * W + x) * 4;
          const la = (a[j] * 299 + a[j + 1] * 587 + a[j + 2] * 114) / 1000;
          const lb = (b[j] * 299 + b[j + 1] * 587 + b[j + 2] * 114) / 1000;
          if (Math.abs(la - lb) <= LUMA) continue;
          n++;
          r += a[j]; g += a[j + 1]; bl += a[j + 2];
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
      if (n === 0) return { n: 0, txt: '' };
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const mean = [r / n, g / n, bl / n];
      return {
        n,
        pct: (n / (W * BAND)) * 100,
        txt: `${String(x1 - x0 + 1).padStart(3)}x${String(y1 - y0 + 1).padStart(3)} fill ${(n / area).toFixed(2)}` +
          `  rgb ${mean.map((v) => v.toFixed(0).padStart(3)).join(',')} r/b ${(mean[0] / Math.max(1, mean[2])).toFixed(2)}`,
      };
    };

    const roots = [];
    scene.traverse((o) => { if (/^door-up-(back|child|shrine)$/.test(o.name || '')) roots.push(o); });
    out.push(`upper-wing leaf rows found: ${roots.map((o) => o.name).join(', ')}`);
    out.push('');

    for (const root of roots) {
      root.updateWorldMatrix(true, true);
      // World box of the leaf, from its meshes, so the ring is centred on the slab and not on the row's
      // nominal x/z — the same reason leafBoxes measures off matrixWorld.
      let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity;
      root.traverse((o) => {
        if (!o.isMesh) return;
        const geo = o.geometry;
        if (!geo.boundingBox) geo.computeBoundingBox();
        const q = geo.boundingBox.clone().applyMatrix4(o.matrixWorld);
        mnx = Math.min(mnx, q.min.x); mxx = Math.max(mxx, q.max.x);
        mny = Math.min(mny, q.min.y); mxy = Math.max(mxy, q.max.y);
        mnz = Math.min(mnz, q.min.z); mxz = Math.max(mxz, q.max.z);
      });
      const cx = (mnx + mxx) / 2, cz = (mnz + mxz) / 2;
      out.push(`=== ${root.name}   leaf world x ${mnx.toFixed(3)}..${mxx.toFixed(3)}  y ${mny.toFixed(3)}..${mxy.toFixed(3)}  z ${mnz.toFixed(3)}..${mxz.toFixed(3)}`);

      const stands = [];
      for (const rad of [0.5, 0.8, 1.2, 1.8]) {
        for (let k = 0; k < 12; k++) {
          const ang = (k / 12) * Math.PI * 2;
          const sx = cx + Math.cos(ang) * rad, sz = cz + Math.sin(ang) * rad;
          // Aim at the leaf. Camera forward at yaw t is (-sin t, 0, -cos t), so t = atan2(-dx, -dz).
          const yaw = Math.atan2(-(cx - sx), -(cz - sz));
          for (const eyeY of [4.1, 4.04]) {
            for (const pitch of [-25, -40, -58]) stands.push({ sx, sz, eyeY, yaw, pitch, rad });
          }
        }
      }

      const scored = [];
      for (const s of stands) {
        cam.position.set(s.sx, s.eyeY, s.sz);
        p.position.set(s.sx, s.eyeY, s.sz);
        p.velocity.set(0, 0, 0);
        d.scene.update(1 / 60); // The real cull decides, exactly as it does in the game.
        cam.rotation.set((s.pitch * Math.PI) / 180, s.yaw, 0);
        const wasVisible = root.visible;
        shoot(a);
        root.visible = false;
        shoot(b);
        root.visible = wasVisible;
        const r = band();
        if (r.n > 0) scored.push({ ...s, ...r, vis: wasVisible });
      }
      scored.sort((x, y) => y.n - x.n);
      if (scored.length === 0) out.push('  the leaf owns no pixel of the lower band from any stand on the ring');
      for (const s of scored.slice(0, 5)) {
        out.push(`  (${s.sx.toFixed(2)}, ${s.eyeY}, ${s.sz.toFixed(2)}) r${s.rad} yaw ${s.yaw.toFixed(2)} pitch ${s.pitch}` +
          `  vis ${s.vis ? 'y' : 'n'}  band ${String(s.n).padStart(5)} = ${s.pct.toFixed(1)}%  ${s.txt}`);
      }
      out.push('');
      await new Promise((res) => requestAnimationFrame(res));
    }
  } finally {
    cam.position.copy(keep.pos);
    cam.rotation.copy(keep.rot);
    cam.rotation.order = keep.order;
    cam.aspect = keep.aspect;
    cam.updateProjectionMatrix();
    p.position.copy(home);
    p.velocity.set(0, 0, 0);
    if (typeof e.resizeHandler === 'function') e.resizeHandler();
    else R.setSize(buf0[0], buf0[1], false);
    d.loop.start();
  }
  return out.join('\n');
})()
