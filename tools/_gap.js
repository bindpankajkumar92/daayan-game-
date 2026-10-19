/**
 * Throwaway: the two things the first honest render still got wrong, measured rather than eyeballed.
 *
 * With the wrist at (0,60,-70) the four bare segments finally sit side on and stacked — but they read as four
 * separate sausages with a fingernail on the end of each, where the reference photo has them pressed together
 * with the nails tucked out of sight. So two numbers are wanted: how far apart adjacent digits actually are,
 * and which way the authored splay has to move to close that.
 *
 * Gaps are segment to segment, not joint to joint, for the reason recorded in the memory of the last round: a
 * phalanx midpoint can stand clear while the bone it belongs to passes straight through its neighbour.
 *
 * Reports the authored y/z on every finger joint (FIST only ever writes x, so those are the rig's own splay
 * and twist), the adjacent gaps as shipped, and the same gaps after +-12 degrees on the knuckle's y and z —
 * which is the gradient, and says which axis abduction even lives on before anything is written to source.
 *
 *   node tools/cdp.mjs --file tools/_gap.js
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

  const CHAINS = {
    point: ['R_point1_030', 'R_point2_031', 'R_point3_032', 'R_point4_033'],
    middle: ['R_middle1_034', 'R_middle2_035', 'R_middle3_036', 'R_middle4_037'],
    ring: ['R_ring1_038', 'R_ring2_039', 'R_ring3_040', 'R_ring4_041'],
    pink: ['R_pink1_042', 'R_pink2_043', 'R_pink3_044', 'R_pink4_045'],
  };
  const NAMES = Object.keys(CHAINS);
  const GRIP = [
    'R_point1_030', 'R_middle1_034', 'R_ring1_038', 'R_pink1_042',
    'R_point3_032', 'R_middle3_036', 'R_ring3_040', 'R_pink3_044',
  ];

  // The candidate the sweep picked, so the gaps are measured in the orientation they will ship in.
  const wrist = bone('R_wrist_025');
  wrist.rotation.set(0, 60 * D, -70 * D);

  const anchor = () => {
    arms.position.set(0, 0, 0);
    arms.updateMatrixWorld(true);
    const g = new V();
    let n = 0;
    for (const nm of GRIP) {
      const j = bone(nm);
      if (j) { g.add(j.getWorldPosition(new V())); n++; }
    }
    g.multiplyScalar(1 / n);
    held.updateWorldMatrix(true, false);
    arms.position.copy(held.worldToLocal(g)).negate();
    arms.updateMatrixWorld(true);
  };

  /** Closest approach of two segments, by the usual clamped-parameter solve. */
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

  const gaps = () => {
    anchor();
    const pts = {};
    for (const [dig, ns] of Object.entries(CHAINS)) {
      pts[dig] = ns.map((n) => bone(n)).filter(Boolean).map((j) => j.getWorldPosition(new V()));
    }
    const out = {};
    for (let i = 0; i + 1 < NAMES.length; i++) {
      const A2 = pts[NAMES[i]], B2 = pts[NAMES[i + 1]];
      let best = Infinity;
      for (let m = 0; m + 1 < A2.length; m++) {
        for (let n = 0; n + 1 < B2.length; n++) {
          best = Math.min(best, segDist(A2[m], A2[m + 1], B2[n], B2[n + 1]));
        }
      }
      out[`${NAMES[i]}-${NAMES[i + 1]}`] = +(best * 1000).toFixed(1);
    }
    return out;
  };

  const deg = (r) => +(r * 180 / Math.PI).toFixed(1);
  const authored = {};
  for (const [dig, ns] of Object.entries(CHAINS)) {
    authored[dig] = ns.slice(0, 3).map((n) => {
      const j = bone(n);
      return j ? [deg(j.rotation.x), deg(j.rotation.y), deg(j.rotation.z)] : null;
    });
  }

  const knuckles = ['R_point1_030', 'R_pink1_042'].map((n) => bone(n).getWorldPosition(new V()));
  const span = +(knuckles[0].distanceTo(knuckles[1]) * 1000).toFixed(1);

  // Save and restore the knuckle rotations around each trial, so the gradient is measured from one baseline
  // rather than from wherever the previous trial left the hand.
  const base = {};
  for (const ns of Object.values(CHAINS)) {
    const j = bone(ns[0]);
    base[ns[0]] = [j.rotation.x, j.rotation.y, j.rotation.z];
  }
  const trial = (axis, delta) => {
    for (const ns of Object.values(CHAINS)) {
      const j = bone(ns[0]);
      const b = base[ns[0]];
      j.rotation.set(b[0], b[1], b[2]);
      j.rotation[axis] = b[axis === 'x' ? 0 : axis === 'y' ? 1 : 2] + delta * D;
    }
    const g = gaps();
    for (const ns of Object.values(CHAINS)) {
      const j = bone(ns[0]);
      j.rotation.set(...base[ns[0]]);
    }
    return g;
  };

  const shipped = gaps();
  const grad = {};
  for (const axis of ['y', 'z']) {
    for (const delta of [-12, 12]) grad[`${axis}${delta > 0 ? '+' : ''}${delta}`] = trial(axis, delta);
  }
  gaps();
  return JSON.stringify({ knuckleSpanMm: span, authored, shipped, grad });
})()
