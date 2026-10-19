/**
 * Is the brown strip across the threshold the round-3 risers?
 *
 * The user's two screenshots both show a brown band lying across a doorway threshold, standing proud of
 * the boards, with a hard diagonal edge and — in the steeper of the two — a dense striped patch beside it.
 * Round 3 added exactly one thing there: `risers-0..2`, vertical quads that close the slot between two
 * floor slabs of different height, each wearing *the other slab's* material and UV'd by `worldUv`. Both
 * of those choices can produce what the screenshots show, so this asks the question directly rather than
 * reasoning about it: render the pose with the risers drawn and again with them hidden, and report which
 * pixels change and what colour they were.
 *
 *   colour — mean RGB of the changed pixels, from the frame where the risers are drawn. If the band is
 *            theirs it comes back brown; if it is the floor's own boards it comes back grey-brown like
 *            the rest of the floor, and the strip is somebody else.
 *   shape  — bounding box and fill, so a band reads as a band and not as scattered edge noise.
 *
 * Poses are round 3's own before/after stands, which is where its numbers were taken.
 *
 *   CDP_PORT=9223 CDP_MATCH=5199 node tools/cdp.mjs --file tools/_patti.js
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
  const LUMA = 8;

  const keep = { pos: cam.position.clone(), rot: cam.rotation.clone(), order: cam.rotation.order };
  const home = p.position.clone();
  const buf0 = [R.domElement.width, R.domElement.height];
  const out = [];
  d.loop.stop();
  cam.rotation.order = 'YXZ';
  R.setSize(W, H, false);
  try {
    // Every riser mesh: material, size, triangles. `edge.mat` is the *other* slab's material by design,
    // which is the first thing to check when a strip is the wrong colour.
    const risers = [];
    scene.traverse((o) => { if (o.isMesh && /^risers-/.test(o.name)) risers.push(o); });
    out.push(`riser meshes: ${risers.length}`);
    for (const o of risers) {
      const g = o.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      const idx = g.getIndex();
      const m = o.material;
      const col = m?.color ? `#${m.color.getHexString()}` : 'n/a';
      const map = m?.map?.name || m?.map?.image?.currentSrc?.split('/').pop() || (m?.map ? 'texture' : 'none');
      out.push(`  ${o.name}  ${(idx ? idx.count : g.getAttribute('position').count) / 3}t  visible ${o.visible ? 'y' : 'n'}` +
        `  mat ${m?.name || m?.type} ${col} map ${map}`);
      out.push(`      x ${bb.min.x.toFixed(3)}..${bb.max.x.toFixed(3)}  y ${bb.min.y.toFixed(3)}..${bb.max.y.toFixed(3)}  z ${bb.min.z.toFixed(3)}..${bb.max.z.toFixed(3)}`);
    }
    out.push('');

    const shoot = (buf) => {
      cam.updateMatrixWorld(true);
      R.setRenderTarget(null);
      R.render(scene, cam);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    };
    /** a = risers drawn, b = risers hidden. What changed, and what colour it was while drawn. */
    const diff = () => {
      for (const o of risers) o.visible = true;
      shoot(a);
      for (const o of risers) o.visible = false;
      shoot(b);
      for (const o of risers) o.visible = true;
      let n = 0, r = 0, g = 0, bl = 0;
      let x0 = W, x1 = -1, y0 = H, y1 = -1;
      for (let i = 0; i < W * H; i++) {
        const j = i * 4;
        const la = (a[j] * 299 + a[j + 1] * 587 + a[j + 2] * 114) / 1000;
        const lb = (b[j] * 299 + b[j + 1] * 587 + b[j + 2] * 114) / 1000;
        if (Math.abs(la - lb) <= LUMA) continue;
        n++;
        r += a[j]; g += a[j + 1]; bl += a[j + 2];
        const px = i % W, py = (i / W) | 0;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
      }
      if (n === 0) return { n: 0, txt: 'nothing changed — no riser pixel in this frame' };
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const mean = [r / n, g / n, bl / n];
      // Brown is a warm hue at middling lightness: red clearly over blue. Report the ratio rather than
      // asserting a name, so the number is checkable.
      return {
        n,
        txt: `changed ${String(n).padStart(5)}  box ${String(x1 - x0 + 1).padStart(3)}x${String(y1 - y0 + 1).padStart(3)} fill ${(n / area).toFixed(2)}` +
          `  mean rgb ${mean.map((v) => v.toFixed(0).padStart(3)).join(',')}  r/b ${(mean[0] / Math.max(1, mean[2])).toFixed(2)}`,
      };
    };

    /** Round 3's own two stands, plus the standing look-through from the second screenshot. */
    const POSES = [
      ['round3 A  16.5,4.04,-1.10 yaw0 pitch-58', 16.5, 4.04, -1.10, 0, -58 * Math.PI / 180],
      ['round3 B  16.5,4.04,-1.60 yaw0 pitch-68', 16.5, 4.04, -1.60, 0, -68 * Math.PI / 180],
      ['standing  16.5,4.10,-1.90 yaw0 pitch-25', 16.5, 4.10, -1.90, 0, -25 * Math.PI / 180],
      ['standing  16.5,4.10,-2.60 yaw0 pitch-15', 16.5, 4.10, -2.60, 0, -15 * Math.PI / 180],
      ['ground    -5,1.70,3.40 yaw pi pitch-20', -5, 1.70, 3.40, Math.PI, -20 * Math.PI / 180],
    ];
    for (const [name, x, y, z, yaw, pitch] of POSES) {
      cam.position.set(x, y, z);
      p.position.set(x, y, z);
      p.velocity.set(0, 0, 0);
      d.scene.update(1 / 60);
      cam.rotation.set(pitch, yaw, 0);
      out.push(`${name.padEnd(42)} ${diff().txt}`);
      await new Promise((res) => requestAnimationFrame(res));
    }
  } finally {
    cam.position.copy(keep.pos);
    cam.rotation.copy(keep.rot);
    cam.rotation.order = keep.order;
    p.position.copy(home);
    p.velocity.set(0, 0, 0);
    if (typeof e.resizeHandler === 'function') e.resizeHandler();
    else R.setSize(buf0[0], buf0[1], false);
    d.loop.start();
  }
  return out.join('\n');
})()
