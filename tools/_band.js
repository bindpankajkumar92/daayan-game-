/**
 * What is the brown strip along the bottom of the frame at the upper flat's back doorway?
 *
 * _patti.js ruled out the round-3 risers: at this pose they are a 125x2 px line, not a band, and hiding
 * them changes 212 pixels. A desktop capture at the same stand (.thresh/p1.png) shows what the user's
 * screenshot shows — a dark reddish-brown horizontal band across the bottom of the view with a hard top
 * edge and a lighter wedge beside it, sitting over the floorboards rather than among them. So this asks
 * the frame instead of the geometry: hide one subtree at a time and report which removal changes *that
 * region*, recursing into whichever does.
 *
 * Region-limited rather than whole-frame because the whole frame is full of legitimate differences — the
 * lantern, the arm, the door — and a blame search over all of it answers a question nobody asked. The rect
 * is given in image coordinates, top-left origin, as read off the PNG; readPixels is bottom-up, so it is
 * flipped here once.
 *
 *   CDP_PORT=9223 CDP_MATCH=5199 node tools/cdp.mjs --file tools/_band.js
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

  // The band in .thresh/p1.png (1262x624): full width, from just above its top edge to the bottom.
  const IMG_W = 1262, IMG_H = 624;
  const RECT = { x: 0, y: 540, w: 900, h: 84 };
  const rx0 = Math.round((RECT.x / IMG_W) * W);
  const rx1 = Math.round(((RECT.x + RECT.w) / IMG_W) * W);
  // Flip: image row y counts down from the top, readPixels row counts up from the bottom.
  const ry0 = Math.round(((IMG_H - (RECT.y + RECT.h)) / IMG_H) * H);
  const ry1 = Math.round(((IMG_H - RECT.y) / IMG_H) * H);

  const keep = { pos: cam.position.clone(), rot: cam.rotation.clone(), order: cam.rotation.order };
  const home = p.position.clone();
  const buf0 = [R.domElement.width, R.domElement.height];
  const out = [];
  let renders = 0;
  d.loop.stop();
  cam.rotation.order = 'YXZ';
  R.setSize(W, H, false);
  try {
    const shoot = (buf) => {
      renders++;
      cam.updateMatrixWorld(true);
      R.setRenderTarget(null);
      R.render(scene, cam);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    };
    /** Mean RGB inside the rect, and how many of its pixels differ from the reference shot. */
    const stat = (buf, ref) => {
      let n = 0, r = 0, g = 0, bl = 0, changed = 0;
      for (let y = ry0; y < ry1; y++) {
        for (let x = rx0; x < rx1; x++) {
          const j = (y * W + x) * 4;
          n++;
          r += buf[j]; g += buf[j + 1]; bl += buf[j + 2];
          if (ref) {
            const l0 = (buf[j] * 299 + buf[j + 1] * 587 + buf[j + 2] * 114) / 1000;
            const l1 = (ref[j] * 299 + ref[j + 1] * 587 + ref[j + 2] * 114) / 1000;
            if (Math.abs(l0 - l1) > 8) changed++;
          }
        }
      }
      return { mean: [r / n, g / n, bl / n], changed, n };
    };

    cam.position.set(16.5, 4.04, -1.10);
    p.position.set(16.5, 4.04, -1.10);
    p.velocity.set(0, 0, 0);
    d.scene.update(1 / 60);
    cam.rotation.set(-58 * Math.PI / 180, 0, 0);
    shoot(a);
    const base = stat(a, null);
    out.push(`rect ${rx0}..${rx1} x ${ry0}..${ry1} of ${W}x${H}  (${base.n} px)`);
    out.push(`baseline mean rgb ${base.mean.map((v) => v.toFixed(0)).join(',')}   r/b ${(base.mean[0] / base.mean[2]).toFixed(2)}`);
    out.push('');

    /**
     * Hide each visible child in turn and report how much of the rect moves. Lights and the camera are
     * excluded for the same reason as in _blame.js: hiding a light changes every pixel and wins every
     * search. Descends into the biggest mover so long as it has children.
     */
    let level = scene.children.slice();
    const trail = [];
    for (let depth = 0; depth < 8; depth++) {
      const cand = level.filter((o) => o.visible && !o.isLight && !o.isCamera);
      if (cand.length === 0) break;
      const scored = [];
      for (const o of cand) {
        o.visible = false;
        shoot(b);
        o.visible = true;
        const s = stat(b, a);
        scored.push({ o, changed: s.changed, mean: s.mean });
      }
      scored.sort((x, y) => y.changed - x.changed);
      const top = scored.slice(0, 4).map((s) => `${s.o.name || s.o.type}=${s.changed}`).join('  ');
      out.push(`depth ${depth}  ${cand.length} candidates   ${top}`);
      const best = scored[0];
      if (!best || best.changed === 0) break;
      trail.push(best.o.name || best.o.type);
      // A mesh is the end of the road; so is a node whose children cannot be descended into.
      if (best.o.isMesh || best.o.children.length === 0) {
        const g = best.o.isMesh ? best.o.geometry : null;
        const m = best.o.material;
        if (g && !g.boundingBox) g.computeBoundingBox();
        const bb = g?.boundingBox;
        out.push('');
        out.push(`culprit: ${trail.join(' > ')}`);
        out.push(`  ${g ? (g.getIndex() ? g.getIndex().count : g.getAttribute('position').count) / 3 : '?'} tris` +
          `  mat ${Array.isArray(m) ? m.map((q) => q.name || q.type).join('+') : m?.name || m?.type}` +
          `  colour ${m?.color ? '#' + m.color.getHexString() : 'n/a'}` +
          `  map ${m?.map ? (m.map.name || m.map.image?.currentSrc?.split('/').pop() || 'texture') : 'none'}`);
        if (bb) {
          out.push(`  local box x ${bb.min.x.toFixed(3)}..${bb.max.x.toFixed(3)}  y ${bb.min.y.toFixed(3)}..${bb.max.y.toFixed(3)}  z ${bb.min.z.toFixed(3)}..${bb.max.z.toFixed(3)}`);
          const wb = bb.clone().applyMatrix4(best.o.matrixWorld);
          out.push(`  world box x ${wb.min.x.toFixed(3)}..${wb.max.x.toFixed(3)}  y ${wb.min.y.toFixed(3)}..${wb.max.y.toFixed(3)}  z ${wb.min.z.toFixed(3)}..${wb.max.z.toFixed(3)}`);
        }
        const chain = [];
        for (let q = best.o; q; q = q.parent) chain.push(q.name || q.type);
        out.push(`  chain ${chain.reverse().join(' > ')}`);
        break;
      }
      level = best.o.children.slice();
      await new Promise((res) => requestAnimationFrame(res));
    }
    out.push('');
    out.push(`${renders} renders`);
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
