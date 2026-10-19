/**
 * Throwaway: close the splay and tuck the nails, by search rather than by eye.
 *
 * tools/_gap.js found the cause of the four separate sausages. It is not abduction: the knuckles' authored
 * *twist* runs -1.6, -30.6, -28.5, -50.4 degrees from index to pinky, so each finger's 84-to-88 degree curl
 * bends in a plane up to 50 degrees from its neighbour's and the four fan apart as they close. A uniform
 * delta cannot fix that — measured, +-12 degrees on y or z moved middle-ring by at most 1.8 mm — because what
 * matters is the *difference* between digits. So sweep the twist as a line across the hand: `z0` on the index
 * and `step` per digit outwards, which reaches both a parallel fist (step 0) and a gently convergent one.
 *
 * The other half is the nails. FIST leaves the distal joints at -16, so each pale segment is a middle *and* a
 * distal phalanx read as one long finger with a nail pointing at the eye. A real closed fist folds the distal
 * out of sight, so `tuck` requires j4 to sit deeper than j3 — the last segment receding from the camera —
 * and `c3` sweeps how hard it is folded to get there.
 *
 * Gaps are wanted small but not zero: 1 to 4 mm reads as fingers pressed together, 0 is interpenetration and
 * the glove shows it as a crease, and past about 6 mm the gap is visible as a gap.
 *
 *   node tools/cdp.mjs --file tools/_fing.js
 */
(() => {
  const d = window.__daayan;
  const cam = d.engine.camera;
  const V = cam.position.constructor;
  let arms = null;
  let held = null;
  d.engine.scene.traverse((o) => {
    if (o.name === 'held.arms') arms = o;
    if (o.name === 'held') held = o;
  });
  if (!arms || !held) return 'no rig';
  held.scale.setScalar(1);
  const byName = new Map();
  arms.traverse((o) => byName.set(o.name, o));
  const bone = (n) => byName.get(n) ?? null;
  const D = Math.PI / 180;

  const CHAINS = [
    ['R_point1_030', 'R_point2_031', 'R_point3_032', 'R_point4_033'],
    ['R_middle1_034', 'R_middle2_035', 'R_middle3_036', 'R_middle4_037'],
    ['R_ring1_038', 'R_ring2_039', 'R_ring3_040', 'R_ring4_041'],
    ['R_pink1_042', 'R_pink2_043', 'R_pink3_044', 'R_pink4_045'],
  ];
  const GRIP = [
    'R_point1_030', 'R_middle1_034', 'R_ring1_038', 'R_pink1_042',
    'R_point3_032', 'R_middle3_036', 'R_ring3_040', 'R_pink3_044',
  ];
  bone('R_wrist_025').rotation.set(0, 60 * D, -70 * D);

  const base = {};
  arms.traverse((o) => { if (/^R_/.test(o.name)) base[o.name] = [o.rotation.x, o.rotation.y, o.rotation.z]; });

  const anchor = () => {
    arms.position.set(0, 0, 0);
    arms.updateMatrixWorld(true);
    const g = new V();
    let n = 0;
    for (const nm of GRIP) { const j = bone(nm); if (j) { g.add(j.getWorldPosition(new V())); n++; } }
    g.multiplyScalar(1 / n);
    held.updateWorldMatrix(true, false);
    arms.position.copy(held.worldToLocal(g)).negate();
    arms.updateMatrixWorld(true);
  };

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

  const measure = () => {
    anchor();
    const pts = CHAINS.map((ns) => ns.map((n) => bone(n).getWorldPosition(new V())));
    const cp = pts.map((ps) => ps.map((p) => cam.worldToLocal(p.clone())));
    const gap = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      let best = Infinity;
      for (let m = 0; m + 1 < 4; m++) {
        for (let n = 0; n + 1 < 4; n++) {
          best = Math.min(best, segDist(pts[i][m], pts[i][m + 1], pts[i + 1][n], pts[i + 1][n + 1]));
        }
      }
      gap.push(+(best * 1000).toFixed(1));
    }
    let broad = 1;
    let tuck = 1e9;
    let front = 1e9;
    let knuckle = 0;
    for (const c of cp) knuckle += -c[0].z;
    knuckle /= 4;
    for (const c of cp) {
      const dir = c[3].clone().sub(c[1]).normalize();
      broad = Math.min(broad, 1 - Math.abs(dir.dot(c[1].clone().add(c[3]).multiplyScalar(0.5).normalize())));
      tuck = Math.min(tuck, -c[3].z - -c[2].z);
      front = Math.min(front, knuckle - -c[2].z);
    }
    return { gap, broad, tuck, front };
  };

  const value = (m) => {
    let pen = 0;
    for (const g of m.gap) pen += Math.max(0, g - 4) / 12 + Math.max(0, 1 - g) * 0.4;
    return m.broad + (m.tuck > 0 ? 0.35 : 0) + (m.front > 0 ? 0.25 : 0) - pen;
  };

  const out = [];
  for (let z0 = -40; z0 <= 10; z0 += 10) {
    for (const step of [-15, -10, -5, 0, 5]) {
      for (let c3 = -20; c3 >= -85; c3 -= 5) {
        for (const dy of [-15, -5, 5]) {
          for (let i = 0; i < CHAINS.length; i++) {
            const k = bone(CHAINS[i][0]);
            const b = base[CHAINS[i][0]];
            k.rotation.set(b[0], b[1] + dy * D, (z0 + step * i) * D);
            bone(CHAINS[i][2]).rotation.x = c3 * D;
          }
          const m = measure();
          out.push([+value(m).toFixed(3), z0, step, c3, dy, +m.broad.toFixed(3), m.gap,
            +m.tuck.toFixed(4), +m.front.toFixed(4)]);
        }
      }
    }
  }
  for (const ns of CHAINS) {
    for (const n of ns) bone(n).rotation.set(...base[n]);
  }
  const shipped = (() => {
    const m = measure();
    return [+value(m).toFixed(3), 'authored', '-', -16, 0, +m.broad.toFixed(3), m.gap,
      +m.tuck.toFixed(4), +m.front.toFixed(4)];
  })();
  out.sort((a, b) => b[0] - a[0]);
  return JSON.stringify({
    legend: ['value', 'z0', 'stepPerDigit', 'distalX', 'dY', 'worstBroad', 'gapsMm', 'tuckM', 'frontM'],
    shipped,
    tried: out.length,
    top: out.slice(0, 12),
  });
})()
