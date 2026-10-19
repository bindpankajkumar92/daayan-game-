/**
 * Is the brown band gone, and is the doorway still a doorway?
 *
 * Two questions, because removing a leaf can answer the first by breaking the second. So:
 *
 *   1. Are the three rows actually out of the scene, and is each opening still framed? makeCasing()
 *      builds the jambs and lintel, not the leaf, so the casing meshes should still be standing round
 *      each of the three openings. Reported as what is present within 1.2 m of where each leaf stood.
 *   2. What colour is the band rect now? _band.js measured it at mean rgb 82,49,34, r/b 2.38 — brown —
 *      from (16.5, 4.04, -1.10) yaw 0 pitch -58, and attributed 3266 of its 10944 pixels to the leaf.
 *      With the leaf gone the same rect should read as floor and plaster, which is grey: r/b near 1.
 *
 * Same rect, same pose, same 480x240 as _band.js, so the two numbers are comparable.
 *
 *   CDP_PORT=9223 CDP_MATCH=5199 node tools/cdp.mjs --file tools/_verify.js
 */
(() => {
  const d = window.__daayan;
  const e = d.engine;
  const scene = e.scene;
  const cam = e.camera;
  const R = e.renderer;
  const p = d.player;
  const gl = R.getContext();
  const W = 480, H = 240;
  const buf = new Uint8Array(W * H * 4);
  const out = [];

  // Where the three leaves stood, from the run that measured them.
  const SITES = [
    ['door-up-back', 16.09, 3.47, -1.44],
    ['door-up-child', 19.05, 3.47, -4.41],
    ['door-up-shrine', 16.91, 3.47, -6.85],
  ];
  scene.updateMatrixWorld(true);
  const gone = SITES.filter(([n]) => {
    let found = false;
    scene.traverse((o) => { if (o.name === n) found = true; });
    return !found;
  }).map(([n]) => n);
  out.push(`rows gone from the scene: ${gone.length}/3  ${gone.join(', ')}`);
  out.push('');

  // What is still standing at each opening. A casing is thin and tall and named for its opening, so
  // listing meshes by name and world span is enough to see a frame is there and a leaf is not.
  for (const [name, sx, sy, sz] of SITES) {
    const near = [];
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const b = g.boundingBox.clone().applyMatrix4(o.matrixWorld);
      // Overlap test against a 1.2 m cube on the opening, so a merged batch counts only if it reaches it.
      if (b.max.x < sx - 1.2 || b.min.x > sx + 1.2) return;
      if (b.max.y < sy - 1.2 || b.min.y > sy + 1.2) return;
      if (b.max.z < sz - 1.2 || b.min.z > sz + 1.2) return;
      const idx = g.getIndex();
      near.push(`${o.name || o.type}(${(idx ? idx.count : g.getAttribute('position').count) / 3}t)`);
    });
    out.push(`${name.padEnd(16)} at (${sx}, ${sz}):  ${near.length ? near.join(' ') : 'nothing — the opening is bare'}`);
  }
  out.push('');

  const keep = { pos: cam.position.clone(), rot: cam.rotation.clone(), order: cam.rotation.order, aspect: cam.aspect };
  const home = p.position.clone();
  const buf0 = [R.domElement.width, R.domElement.height];
  d.loop.stop();
  cam.rotation.order = 'YXZ';
  R.setSize(W, H, false);
  cam.aspect = W / H;
  cam.updateProjectionMatrix();
  try {
    // _band.js's rect, carried over verbatim: image coords in a 1262x624 capture, flipped for readPixels.
    const IMG_W = 1262, IMG_H = 624;
    const RECT = { x: 0, y: 540, w: 900, h: 84 };
    const rx0 = Math.round((RECT.x / IMG_W) * W);
    const rx1 = Math.round(((RECT.x + RECT.w) / IMG_W) * W);
    const ry0 = Math.round(((IMG_H - (RECT.y + RECT.h)) / IMG_H) * H);
    const ry1 = Math.round(((IMG_H - RECT.y) / IMG_H) * H);

    cam.position.set(16.5, 4.04, -1.10);
    p.position.set(16.5, 4.04, -1.10);
    p.velocity.set(0, 0, 0);
    d.scene.update(1 / 60);
    cam.rotation.set((-58 * Math.PI) / 180, 0, 0);
    cam.updateMatrixWorld(true);
    R.info.reset();
    R.setRenderTarget(null);
    R.render(scene, cam);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let n = 0, r = 0, g = 0, b = 0;
    for (let y = ry0; y < ry1; y++) {
      for (let x = rx0; x < rx1; x++) {
        const j = (y * W + x) * 4;
        n++;
        r += buf[j]; g += buf[j + 1]; b += buf[j + 2];
      }
    }
    const mean = [r / n, g / n, b / n];
    out.push(`band rect ${rx0}..${rx1} x ${ry0}..${ry1}  (${n} px), pose 16.5,4.04,-1.10 yaw0 pitch-58`);
    out.push(`  was  mean rgb 82,49,34   r/b 2.38   (leaf drawn, _band.js)`);
    out.push(`  now  mean rgb ${mean.map((v) => v.toFixed(0)).join(',')}   r/b ${(mean[0] / Math.max(1, mean[2])).toFixed(2)}`);
    out.push(`  draws ${R.info.render.calls}  tris ${(R.info.render.triangles / 1000).toFixed(1)}k at this pose`);
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
