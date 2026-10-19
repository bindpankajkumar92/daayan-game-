/**
 * Throwaway: measure the held right hand on the running rig.
 *
 * Reports, for each digit, the accumulated curl and where every joint lands both in camera space and in
 * NDC, because the question "does this read as a fist" is a screen-space question — a joint behind the
 * sleeve cuff is invisible however well it is posed. Also the nearest-*segment* clearances the FIST doc
 * uses, since phalanx midpoints do not tell you whether two fingers intersect.
 *
 *   node tools/cdp.mjs --file tools/_fist.js
 */
(() => {
  const d = window.__daayan;
  const cam = d.engine.camera;
  const T = window.__three ?? null;
  let arms = null;
  let hold = null;
  d.engine.scene.traverse((o) => {
    if (o.name === 'held.arms') arms = o;
    if (o.name === 'held.hold' || o.name === 'held.lantern' || o.name === 'held.swing') hold ??= o;
  });
  if (!arms) return 'no held.arms';

  const V = cam.position.constructor; // Vector3 without importing three
  const bone = (n) => {
    let f = null;
    arms.traverse((o) => {
      if (o.name === n) f = o;
    });
    return f;
  };

  const DIGITS = [
    ['point', ['R_point1_030', 'R_point2_031', 'R_point3_032', 'R_point4_033']],
    ['middle', ['R_middle1_034', 'R_middle2_035', 'R_middle3_036', 'R_middle4_037']],
    ['ring', ['R_ring1_038', 'R_ring2_039', 'R_ring3_040', 'R_ring4_041']],
    ['pink', ['R_pink1_042', 'R_pink2_043', 'R_pink3_044', 'R_pink4_045']],
    ['thumb', ['R_thumb1_026', 'R_thumb2_027', 'R_thumb3_028', 'R_thumb4_029']],
  ];
  const DEG = 180 / Math.PI;
  const out = [];

  // World -> camera space, and camera space -> NDC. The arms are camera children, so camera space is
  // what HOLD is written in and is the frame worth reporting in.
  const camLocal = (o) => cam.worldToLocal(o.getWorldPosition(new V()));
  const ndc = (o) => o.getWorldPosition(new V()).project(cam);

  const wrist = bone('R_wrist_025');
  out.push(`wrist  cam=${fmt(camLocal(wrist))}  ndc=${fmt2(ndc(wrist))}`);
  const elbow = bone('R_elbow_024');
  out.push(`elbow  cam=${fmt(camLocal(elbow))}  ndc=${fmt2(ndc(elbow))}`);

  function fmt(v) {
    return `[${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}]`;
  }
  function fmt2(v) {
    return `[${v.x.toFixed(3)}, ${v.y.toFixed(3)}]`;
  }

  const pos = {};
  for (const [name, names] of DIGITS) {
    const rots = [];
    const line = [];
    for (const n of names) {
      const b = bone(n);
      if (!b) {
        line.push(`${n}=MISSING`);
        continue;
      }
      const p = camLocal(b);
      const s = ndc(b);
      pos[n] = b.getWorldPosition(new V());
      rots.push(
        `${(b.rotation.x * DEG).toFixed(0)}/${(b.rotation.y * DEG).toFixed(0)}/${(b.rotation.z * DEG).toFixed(0)}`,
      );
      line.push(`${n.replace(/^R_|_0?\d+$/g, '')} cam=${fmt(p)} ndc=${fmt2(s)}`);
    }
    const curl = names
      .slice(0, 3)
      .map((n) => bone(n))
      .filter(Boolean)
      .reduce((a, b) => a + b.rotation.x * DEG, 0);
    out.push(`\n${name}  curl(x sum of 3)=${curl.toFixed(0)}deg  rots=${rots.join('  ')}`);
    for (const l of line) out.push(`   ${l}`);
  }

  // Nearest distance between two segments, in metres of world space.
  const seg = (a, b, c, e) => {
    const u = b.clone().sub(a);
    const v = e.clone().sub(c);
    const w = a.clone().sub(c);
    const A = u.dot(u);
    const B = u.dot(v);
    const C = v.dot(v);
    const D = u.dot(w);
    const E = v.dot(w);
    const den = A * C - B * B;
    let s = den > 1e-12 ? (B * E - C * D) / den : 0;
    s = Math.max(0, Math.min(1, s));
    let t = C > 1e-12 ? (B * s + E) / C : 0;
    t = Math.max(0, Math.min(1, t));
    s = A > 1e-12 ? Math.max(0, Math.min(1, (B * t - D) / A)) : 0;
    return a.clone().addScaledVector(u, s).distanceTo(c.clone().addScaledVector(v, t));
  };
  const chainSegs = (names) => {
    const s = [];
    for (let i = 0; i < names.length - 1; i++) if (pos[names[i]] && pos[names[i + 1]]) s.push([pos[names[i]], pos[names[i + 1]]]);
    return s;
  };
  out.push('\nnearest-segment clearance (mm):');
  for (let i = 0; i < DIGITS.length; i++) {
    for (let j = i + 1; j < DIGITS.length; j++) {
      let best = Infinity;
      for (const [a, b] of chainSegs(DIGITS[i][1])) for (const [c, e] of chainSegs(DIGITS[j][1])) best = Math.min(best, seg(a, b, c, e));
      out.push(`  ${DIGITS[i][0]} - ${DIGITS[j][0]}: ${(best * 1000).toFixed(1)}`);
    }
  }

  // The handle the fist is meant to be closed around.
  if (hold) {
    const hp = cam.worldToLocal(hold.getWorldPosition(new V()));
    out.push(`\n${hold.name} cam=${fmt(hp)}`);
  }
  const names2 = [];
  d.engine.scene.traverse((o) => {
    if (/^held\./.test(o.name)) names2.push(o.name);
  });
  out.push(`held groups: ${names2.join(', ')}`);
  return out.join('\n');
})()
