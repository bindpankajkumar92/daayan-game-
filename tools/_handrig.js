/**
 * Throwaway: a magnifier and a pose dial for the held hand, installed into the running WebView.
 *
 * The hand is 5.2 cm across at 27 cm from the eye, which is about 250 x 190 px of a 2460 x 1080 phone
 * framebuffer — too few to judge a curl by, and `screencap` cannot give more because it grabs the
 * composited screen rather than the render target. So instead of raising the resolution, this raises the
 * *subject*: `held` is a camera child holding both the arms and the lantern, so scaling that one node
 * magnifies the pose and the lantern together with their relationship intact, and re-anchoring it puts
 * the fist in the middle of the frame. What comes back is the in-game view of the hand, larger.
 *
 * Installs three globals:
 *   __setfist({point:[x,y,z], ...})  candidate rotations in degrees; omitted y/z keep the rig's authored
 *                                    splay and twist, read off the rest pose captured on first install
 *   __handview({k, lantern, world})   stop the loop, magnify, render one frame
 *   __handrestore()                   put everything back and restart the loop
 *
 *   node tools/cdp.mjs --file tools/_handrig.js
 *   node tools/cdp.mjs "__handview({k:4})"
 */
(() => {
  const d = window.__daayan;
  const e = d.engine;
  const R = e.renderer;
  const cam = e.camera;
  const scene = e.scene;
  const V = cam.position.constructor;

  let arms = null;
  let held = null;
  let swing = null;
  scene.traverse((o) => {
    if (o.name === 'held.arms') arms = o;
    if (o.name === 'held') held = o;
    if (o.name === 'held.swing') swing = o;
  });
  if (!arms || !held) return 'no held.arms / held';
  const bone = (n) => {
    let f = null;
    arms.traverse((o) => {
      if (o.name === n) f = o;
    });
    return f;
  };

  const GRIP = [
    'R_point1_030', 'R_middle1_034', 'R_ring1_038', 'R_pink1_042',
    'R_point3_032', 'R_middle3_036', 'R_ring3_040', 'R_pink3_044',
  ];
  const gripCam = () => cam.worldToLocal(gripCam0());
  /** The grip mean in *world* space — what both the loader's anchoring and the view need. */
  function gripCam0() {
    const v = new V();
    let n = 0;
    for (const nm of GRIP) {
      const j = bone(nm);
      if (!j) continue;
      v.add(j.getWorldPosition(new V()));
      n++;
    }
    return v.multiplyScalar(1 / n);
  }

  const DIG = {
    point: ['R_point1_030', 'R_point2_031', 'R_point3_032'],
    middle: ['R_middle1_034', 'R_middle2_035', 'R_middle3_036'],
    ring: ['R_ring1_038', 'R_ring2_039', 'R_ring3_040'],
    pink: ['R_pink1_042', 'R_pink2_043', 'R_pink3_044'],
    thumb: ['R_thumb1_026', 'R_thumb2_027', 'R_thumb3_028'],
    wrist: ['R_wrist_025'],
  };

  // The authored rest pose, captured before anything overwrites it. FIST only ever writes x on most
  // joints, so y and z here are the rig's own splay and twist and a candidate that omits them must get
  // these back rather than zero.
  if (!window.__rest) {
    window.__rest = {};
    arms.traverse((o) => {
      if (/^[RL]_/.test(o.name)) window.__rest[o.name] = [o.rotation.x, o.rotation.y, o.rotation.z];
    });
  }

  window.__setfist = (spec) => {
    const D = Math.PI / 180;
    const touched = [];
    for (const [dig, vals] of Object.entries(spec)) {
      const names = DIG[dig];
      if (!names) continue;
      for (let i = 0; i < names.length; i++) {
        const j = bone(names[i]);
        const r = vals[i];
        if (!j || r == null) continue;
        const rest = window.__rest[names[i]] ?? [0, 0, 0];
        const a = Array.isArray(r) ? r : [r];
        j.rotation.x = a[0] * D;
        j.rotation.y = a[1] != null ? a[1] * D : rest[1];
        j.rotation.z = a[2] != null ? a[2] * D : rest[2];
        touched.push(names[i]);
      }
    }
    arms.updateMatrixWorld(true);
    // Re-anchor exactly as the loader does, because closing the fingers moves the grip mean and the
    // shipped build re-reads it *after* FIST. Without this a live edit slides the fist off the handle and
    // the view would show a gap the real build never has.
    held.updateWorldMatrix(true, false);
    arms.position.copy(held.worldToLocal(gripCam0())).negate();
    arms.updateMatrixWorld(true);
    return `set ${touched.length} joints`;
  };

  /**
   * Hide every DOM layer over the canvas, by walking body rather than by id. The loading and menu
   * overlays are opaque and one of them is up whenever the app has just been relaunched — which on this
   * phone is most of the time — so a fixed id list quietly returns a screenshot of the title screen.
   */
  const overlays = (hide) => {
    for (const el of document.body.children) {
      if (el.id === 'app') continue;
      if (hide) {
        if (el.dataset.hv === undefined) el.dataset.hv = el.style.display;
        el.style.display = 'none';
      } else if (el.dataset.hv !== undefined) {
        el.style.display = el.dataset.hv;
        delete el.dataset.hv;
      }
    }
  };

  window.__handview = (o = {}) => {
    const k = o.k ?? 4;
    // The build collapses L_arm_01 to 1e-3 to hide the left arm, but arms.glb is a single skinned mesh, so
    // that collapse can drag shared-weight triangles into spikes rather than removing them. `left` puts the
    // scale back so a render can say whether the black shards over the fist are that or the sleeve cuff.
    if (o.left != null) {
      const la = bone('L_arm_01');
      if (la) la.scale.setScalar(o.left);
      arms.updateMatrixWorld(true);
    }
    if (!window.__hvState) {
      window.__hvState = { pos: held.position.clone(), scale: held.scale.clone() };
    }
    const st = window.__hvState;
    d.loop.stop();
    overlays(true);
    for (const c of scene.children) {
      if (c.type === 'PerspectiveCamera' || c.isLight) continue;
      if (c.userData._hv === undefined) c.userData._hv = c.visible;
      c.visible = o.world ?? false;
    }
    if (swing) swing.visible = o.lantern ?? true;

    // Reset before shifting, so repeated calls do not accumulate.
    held.position.copy(st.pos);
    held.scale.copy(st.scale).multiplyScalar(k);
    held.updateMatrixWorld(true);
    cam.updateMatrixWorld(true);
    const g = gripCam();
    // `recenter:false` leaves the rig where the build puts it, which is the only way to see the true
    // in-game framing — recentring moves the fist to the middle of the screen.
    if (o.recenter !== false) {
      held.position.add(new V(o.tx ?? 0, o.ty ?? 0, o.tz ?? -0.32).sub(g));
      held.updateMatrixWorld(true);
    }
    R.setRenderTarget(null);
    R.render(scene, cam);
    // Report where the hand actually landed, in NDC, so the caller can crop to it instead of guessing a
    // fixed box. A guessed box silently clips the hand and then every judgement is made on a fragment.
    // These are joint positions, so the mesh surface reaches past them — the caller must pad.
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, n = 0;
    arms.traverse((o) => {
      // Hand only. `R_` also matches the shoulder and forearm, which run off the bottom of the frame and
      // would blow the box up to the whole arm.
      if (!/^R_(wrist|point|middle|ring|pink|thumb)/.test(o.name)) return;
      const p = o.getWorldPosition(new V()).project(cam);
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
      n++;
    });
    return JSON.stringify({
      k,
      gripCam: gripCam().toArray().map((v) => +v.toFixed(4)),
      ndc: n ? [x0, y0, x1, y1].map((v) => +v.toFixed(4)) : null,
      canvas: [R.domElement.width, R.domElement.height],
      // The grip mean must sit on `held`'s own origin once the loader (or __setfist) has anchored it. When
      // these two disagree the rig has not been set up yet — HeldLantern applies PALM_SPAN scaling and the
      // anchor on a tick, and stopping the loop right after a relaunch freezes it half-built. Renders taken
      // in that state show a smaller hand at the wrong depth, so the caller must retry rather than judge.
      heldPos: held.position.toArray().map((v) => +v.toFixed(4)),
      mm: o.measure ? window.__handmeasure() : undefined,
      // Wrist is not in FIST, so this is the rig's authored forearm/palm orientation — the number a
      // candidate wrist twist has to be expressed relative to.
      wrist: (() => {
        const w = bone('R_wrist_025');
        const deg = (r) => +(r * 180 / Math.PI).toFixed(1);
        return w ? [deg(w.rotation.x), deg(w.rotation.y), deg(w.rotation.z)] : null;
      })(),
    });
  };

  /**
   * Nearest distance between each pair of digits, in millimetres, normalised so the index-knuckle to
   * pinky-knuckle span reads as the 52 mm PALM_SPAN the loader scales to. Segment-to-segment rather than
   * joint-to-joint, because a phalanx midpoint can stand clear while the bone it belongs to passes straight
   * through its neighbour — which is the difference between a thumb pad resting on the index and one
   * modelled through it.
   */
  window.__handmeasure = () => {
    const chains = {
      point: ['R_point1_030', 'R_point2_031', 'R_point3_032', 'R_point4_033'],
      middle: ['R_middle1_034', 'R_middle2_035', 'R_middle3_036', 'R_middle4_037'],
      ring: ['R_ring1_038', 'R_ring2_039', 'R_ring3_040', 'R_ring4_041'],
      pink: ['R_pink1_042', 'R_pink2_043', 'R_pink3_044', 'R_pink4_045'],
      thumb: ['R_thumb1_026', 'R_thumb2_027', 'R_thumb3_028', 'R_thumb4_029'],
    };
    arms.updateMatrixWorld(true);
    const pts = {};
    for (const [dig, names] of Object.entries(chains)) {
      pts[dig] = names.map((n) => bone(n)).filter(Boolean).map((j) => j.getWorldPosition(new V()));
    }
    const a = bone('R_point1_030');
    const b = bone('R_pink1_042');
    if (!a || !b) return null;
    const mm = 52 / a.getWorldPosition(new V()).distanceTo(b.getWorldPosition(new V()));

    // Closest approach of two segments, by the usual clamped-parameter solve.
    const segDist = (p1, q1, p2, q2) => {
      const d1 = q1.clone().sub(p1);
      const d2 = q2.clone().sub(p2);
      const r = p1.clone().sub(p2);
      const A = d1.dot(d1), E = d2.dot(d2), F = d2.dot(r), C = d1.dot(r), B = d1.dot(d2);
      const den = A * E - B * B;
      let s = den > 1e-12 ? Math.min(1, Math.max(0, (B * F - C * E) / den)) : 0;
      let t = (B * s + F) / (E || 1);
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -C / (A || 1))); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (B - C) / (A || 1))); }
      return d1.clone().multiplyScalar(s).add(p1).distanceTo(d2.clone().multiplyScalar(t).add(p2));
    };

    const out = {};
    const digs = Object.keys(chains);
    for (let i = 0; i < digs.length; i++) {
      for (let j = i + 1; j < digs.length; j++) {
        const A2 = pts[digs[i]], B2 = pts[digs[j]];
        let best = Infinity;
        for (let m = 0; m + 1 < A2.length; m++) {
          for (let n2 = 0; n2 + 1 < B2.length; n2++) {
            best = Math.min(best, segDist(A2[m], A2[m + 1], B2[n2], B2[n2 + 1]));
          }
        }
        out[`${digs[i]}-${digs[j]}`] = +(best * mm).toFixed(1);
      }
    }
    return out;
  };

  window.__handrestore = () => {
    const st = window.__hvState;
    if (st) {
      held.position.copy(st.pos);
      held.scale.copy(st.scale);
      delete window.__hvState;
    }
    for (const c of scene.children) {
      if (c.userData._hv !== undefined) {
        c.visible = c.userData._hv;
        delete c.userData._hv;
      }
    }
    if (swing) swing.visible = true;
    overlays(false);
    d.loop.start();
    return 'restored';
  };

  return 'installed: __setfist, __handview, __handrestore';
})()
