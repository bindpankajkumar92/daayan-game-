/**
 * Throwaway: search the wrist's three angles for an orientation that actually shows the fist.
 *
 * Screenshot-by-screenshot bracketing found -68 on the roll, but the renders it was judged on were centred
 * and fish-eyed (see tools/_live.mjs), and at the build's true framing that pose points all four fingers
 * roughly *at* the eye — j2 sits at 0.288 m and j4 at 0.261, so the bare phalanges are foreshortened into
 * blobs and only three of the four show at all. Rather than bracket again, score the thing being looked for.
 *
 * Per digit, in camera space: `broad` is 1 - |unit(j2 -> j4) . unit(view ray)|, so 1 is a segment fully
 * side-on and 0 is one pointing down the barrel. `sep` is the closest pair of j3 points in pixels, which is
 * what stops four segments fusing into one lump. `front` is how far the segment stands ahead of the mean
 * knuckle depth, which is a cheap stand-in for whether the back of the glove is covering it.
 *
 * The grip is re-anchored for every candidate exactly as the loader does, so each one is judged where the
 * build would actually put it.
 *
 *   node tools/cdp.mjs --file tools/_sweep.js
 */
(() => {
  const d = window.__daayan;
  const e = d.engine;
  const cam = e.camera;
  const V = cam.position.constructor;
  let arms = null;
  let held = null;
  e.scene.traverse((o) => {
    if (o.name === 'held.arms') arms = o;
    if (o.name === 'held') held = o;
  });
  if (!arms || !held) return 'no rig';
  held.scale.setScalar(1);
  const byName = new Map();
  arms.traverse((o) => byName.set(o.name, o));
  const bone = (n) => byName.get(n) ?? null;

  const CHAINS = {
    point: ['R_point1_030', 'R_point2_031', 'R_point3_032', 'R_point4_033'],
    middle: ['R_middle1_034', 'R_middle2_035', 'R_middle3_036', 'R_middle4_037'],
    ring: ['R_ring1_038', 'R_ring2_039', 'R_ring3_040', 'R_ring4_041'],
    pink: ['R_pink1_042', 'R_pink2_043', 'R_pink3_044', 'R_pink4_045'],
  };
  const GRIP = [
    'R_point1_030', 'R_middle1_034', 'R_ring1_038', 'R_pink1_042',
    'R_point3_032', 'R_middle3_036', 'R_ring3_040', 'R_pink3_044',
  ];
  const wrist = bone('R_wrist_025');
  if (!wrist) return 'no R_wrist_025';
  const rest = [wrist.rotation.x, wrist.rotation.y, wrist.rotation.z];
  const D = Math.PI / 180;
  const W = e.renderer.domElement.width;
  const H = e.renderer.domElement.height;

  /** Camera-space position of a bone, with the camera at the origin looking down -z. */
  const camPos = (n) => cam.worldToLocal(bone(n).getWorldPosition(new V()));
  const ndc = (n) => bone(n).getWorldPosition(new V()).project(cam);

  const score = () => {
    arms.updateMatrixWorld(true);
    // Anchor from zero, the way the loader does: worldToLocal returns the grip including whatever offset
    // arms already carries, so negating it twice in a row walks the hand toward the camera.
    arms.position.set(0, 0, 0);
    arms.updateMatrixWorld(true);
    const g = new V();
    let n = 0;
    for (const nm of GRIP) {
      const j = bone(nm);
      if (!j) continue;
      g.add(j.getWorldPosition(new V()));
      n++;
    }
    g.multiplyScalar(1 / n);
    held.updateWorldMatrix(true, false);
    arms.position.copy(held.worldToLocal(g.clone())).negate();
    arms.updateMatrixWorld(true);

    let knuckle = 0;
    for (const c of Object.values(CHAINS)) knuckle += -camPos(c[0]).z;
    knuckle /= 4;

    const px = [];
    // The worst digit rather than the mean: an average of four hides one finger aimed straight at the eye,
    // and one blob in a row of three is exactly the artefact being removed.
    let broad = 1;
    let front = 1e9;
    let off = 0;
    for (const c of Object.values(CHAINS)) {
      const a = camPos(c[1]);
      const b = camPos(c[3]);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const dir = b.clone().sub(a).normalize();
      broad = Math.min(broad, 1 - Math.abs(dir.dot(mid.clone().normalize())));
      const p = ndc(c[2]);
      if (Math.abs(p.x) > 0.9 || Math.abs(p.y) > 0.9) off++;
      px.push([(p.x * 0.5) * W, (p.y * 0.5) * H]);
      front = Math.min(front, knuckle - -camPos(c[2]).z);
    }
    let sep = 1e9;
    for (let i = 0; i < px.length; i++) {
      for (let j = i + 1; j < px.length; j++) {
        sep = Math.min(sep, Math.hypot(px[i][0] - px[j][0], px[i][1] - px[j][1]));
      }
    }
    // Where the forearm leaves the fist, on screen. A pose can score perfectly on the hand and still be
    // wrong if it gets there by swinging the sleeve up across the view: the arm has to recede towards the
    // lower right. Its *depth* is no test at all — the shoulder is below and behind the eye, so the elbow is
    // always the nearer of the two and an early filter on that rejected all 1176 candidates including the
    // shipped pose.
    const w0 = ndc('R_wrist_025');
    const e0 = ndc('R_elbow_024');
    const arm = Math.round(Math.atan2(e0.y - w0.y, e0.x - w0.x) * 180 / Math.PI);
    const behind = -camPos('R_elbow_024').z - -camPos('R_wrist_025').z;
    return { broad, sep, front, off, arm, behind };
  };

  const value = (s) => s.broad * (1 + Math.min(s.sep, 60) / 60) + (s.front > 0 ? 0.3 : 0);
  const row = (s, x, y, z) => [
    +value(s).toFixed(4), x, y, z,
    +s.broad.toFixed(3), Math.round(s.sep), +s.front.toFixed(4), s.arm, +s.behind.toFixed(3),
  ];

  const out = [];
  for (let x = -60; x <= 60; x += 15) {
    for (let y = -20; y <= 90; y += 10) {
      for (let z = -130; z <= -10; z += 10) {
        wrist.rotation.set(x * D, y * D, z * D);
        const s = score();
        // Only the on-screen and arm-direction tests: the sleeve must still recede to the right rather than
        // swing up across the view. The shipped pose sits at -12 degrees, so this keeps that family.
        if (s.off || s.arm > 25 || s.arm < -120) continue;
        out.push(row(s, x, y, z));
      }
    }
  }
  wrist.rotation.set(rest[0], rest[1], rest[2]);
  const shipped = row(score(), +(rest[0] / D).toFixed(1), +(rest[1] / D).toFixed(1), +(rest[2] / D).toFixed(1));
  out.sort((a, b) => b[0] - a[0]);
  return JSON.stringify({
    legend: ['value', 'x', 'y', 'z', 'worstBroad', 'sepPx', 'frontM', 'armDeg', 'elbowBehindM'],
    shipped,
    tried: out.length,
    top: out.slice(0, 14),
  });
})()
