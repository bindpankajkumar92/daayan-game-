/**
 * Throwaway: make the four curls parallel by construction, then close the gaps to a chosen millimetre.
 *
 * The brute-force ramp in tools/_fing.js was the wrong parametrisation. It kept asking for more twist at the
 * edge of its range because it was scoring a *side effect*: what makes the fingers fan is that each knuckle's
 * authored twist (-1.6, -30.6, -28.5, -50.4 from index to pinky) rotates the plane its 85-degree curl bends
 * in, so the four close in four different directions. Searching gap millimetres against a two-parameter line
 * gropes at that indirectly. Aligning the planes states it exactly.
 *
 * Stage 1, per digit, picks the twist that puts this finger's curl axis parallel to the index's. The curl axis
 * is the joint's own local x in world space, so what is minimised is the angle between the *child* joint's x
 * and the index child's x — measured, not assumed, because the rig is authored and the axes cannot be taken on
 * faith. Done for the knuckle (aligning joint 2) and again for joint 2 (aligning joint 3).
 *
 * Stage 2 walks outwards and sets each digit's abduction so the segment-to-segment gap to its neighbour is the
 * target: touching, but not modelled through each other.
 *
 * Stage 3 sweeps the distal curl, which is uniform across the hand, for the two things a fist has to do at
 * once: keep the middle phalanges side on to the eye (`broad`) and fold the fingertips out of sight (`tuck`,
 * joint 4 deeper than joint 3, so nails point away rather than at the camera).
 *
 *   node tools/cdp.mjs --file tools/_align.js
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
  const deg = (r) => +(r * 180 / Math.PI).toFixed(1);

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

  // The shipped pose, read off the rig before anything here touched it: x is what FIST writes, y and z are the
  // rig's own authored splay and twist. Hard-coded so the script starts from the same place every run — the
  // stages below write absolute angles, so without this a second run would align against the first run's
  // output and the numbers would drift a little each time.
  const SHIP = {
    R_point1_030: [-64, 3.7, -1.6], R_point2_031: [-86, 7.5, 0.2], R_point3_032: [-16, -7.1, -1.3],
    R_middle1_034: [-64, 2.8, -30.6], R_middle2_035: [-88, 3.9, -0.8], R_middle3_036: [-16, 4, 5.3],
    R_ring1_038: [-60, 6.5, -28.5], R_ring2_039: [-85, 4, -13.3], R_ring3_040: [-16, 5.8, 5.3],
    R_pink1_042: [-56, -3.1, -50.4], R_pink2_043: [-84, 10, 3.7], R_pink3_044: [-16, -2.7, -1.1],
  };
  for (const [n, r] of Object.entries(SHIP)) bone(n).rotation.set(r[0] * D, r[1] * D, r[2] * D);
  arms.updateMatrixWorld(true);

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

  /** World direction of a joint's own local x — the axis its x rotation curls about. */
  const axis = (n) => {
    const m = bone(n).matrixWorld.elements;
    return new V(m[0], m[1], m[2]).normalize();
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

  const pts = (i) => CHAINS[i].map((n) => bone(n).getWorldPosition(new V()));
  const gapBetween = (i, j) => {
    const A = pts(i), B = pts(j);
    let best = Infinity;
    for (let m = 0; m + 1 < 4; m++) {
      for (let n = 0; n + 1 < 4; n++) best = Math.min(best, segDist(A[m], A[m + 1], B[n], B[n + 1]));
    }
    return best * 1000;
  };

  // Stage 1: parallel curl planes. Search is over whole degrees across the full circle; a gradient step would
  // be cheaper but the objective has two minima 180 degrees apart (an axis is a line, not an arrow) and the
  // far one folds the finger backwards.
  const twist = [];
  for (const [ji, child] of [[0, 1], [1, 2]]) {
    const target = axis(CHAINS[0][child]);
    for (let i = 1; i < CHAINS.length; i++) {
      const j = bone(CHAINS[i][ji]);
      const keep = j.rotation.z;
      let best = null;
      for (let z = -120; z <= 120; z += 1) {
        j.rotation.z = z * D;
        arms.updateMatrixWorld(true);
        const a = Math.acos(Math.min(1, Math.max(-1, axis(CHAINS[i][child]).dot(target)))) / D;
        if (!best || a < best[1]) best = [z, a];
      }
      // Only accept an alignment that is actually reachable by twisting this joint. If the best angle is still
      // wide the axes are skew and forcing the twist would just roll the finger for nothing.
      if (best[1] < 25) j.rotation.z = best[0] * D;
      else j.rotation.z = keep;
      arms.updateMatrixWorld(true);
      twist.push([CHAINS[i][ji], deg(keep), best[0], +best[1].toFixed(1), best[1] < 25 ? 'set' : 'kept']);
    }
  }

  // Stage 2: abduction, outwards, each against the digit already placed.
  //
  // The objective here is *not* a small gap, which is what the first version of this asked for and what made
  // it drive all three digits to the +35 limit for nothing. segDist measures bone centre line to bone centre
  // line, and a finger is about 15 mm thick: adjacent fingers pressed together read as 17 mm apart, which is
  // just the knuckle pitch, and 2.3 mm apart — what the index and middle authored to — means the two are
  // modelled through each other. The min distance also cannot see a fan at all, because it is dominated by the
  // knuckle end where even splayed fingers are still one pitch apart.
  //
  // So parallelism is the objective and the distance is only a floor: match each middle phalanx's direction to
  // the index's, and refuse any twist of the knuckle that pushes the bones closer than 11 mm.
  const dirOf = (i) => pts(i)[2].clone().sub(pts(i)[1]).normalize();
  const abduct = [];
  for (let i = 1; i < CHAINS.length; i++) {
    const j = bone(CHAINS[i][0]);
    const keep = j.rotation.y;
    const target = dirOf(0);
    let best = null;
    for (let y = -30; y <= 30; y += 1) {
      j.rotation.y = y * D;
      anchor();
      if (gapBetween(i - 1, i) < 11) continue;
      const a = Math.acos(Math.min(1, Math.max(-1, dirOf(i).dot(target)))) / D;
      if (!best || a < best[1]) best = [y, a];
    }
    j.rotation.y = (best ? best[0] : deg(keep)) * D;
    anchor();
    abduct.push([CHAINS[i][0], deg(keep), best ? best[0] : 'kept', best ? +best[1].toFixed(1) : null,
      +gapBetween(i - 1, i).toFixed(1)]);
  }

  // Stage 3: distal curl, uniform.
  //
  // `broad` is measured across joints 2 to 3 only. Taking it to joint 4 conflated the two halves of the
  // question: folding the fingertip away is the point, and it shortens and turns the 2-to-4 chord, so the
  // first version of this scored a tucked fist as *worse* than one presenting its nails to the camera.
  const distal = [];
  for (let c = -10; c >= -95; c -= 5) {
    for (const ns of CHAINS) bone(ns[2]).rotation.x = c * D;
    anchor();
    let broad = 1;
    let tuck = 1e9;
    let front = 1e9;
    let knuckle = 0;
    const cp = CHAINS.map((ns) => ns.map((n) => cam.worldToLocal(bone(n).getWorldPosition(new V()))));
    for (const c2 of cp) knuckle += -c2[0].z;
    knuckle /= 4;
    for (const c2 of cp) {
      const dir = c2[2].clone().sub(c2[1]).normalize();
      broad = Math.min(broad, 1 - Math.abs(dir.dot(c2[1].clone().add(c2[2]).multiplyScalar(0.5).normalize())));
      tuck = Math.min(tuck, -c2[3].z - -c2[2].z);
      front = Math.min(front, knuckle - -c2[2].z);
    }
    const gaps = [gapBetween(0, 1), gapBetween(1, 2), gapBetween(2, 3)].map((g) => +g.toFixed(1));
    distal.push([c, +broad.toFixed(3), +tuck.toFixed(4), +front.toFixed(4), gaps]);
  }

  const fan = [];
  for (let i = 1; i < CHAINS.length; i++) {
    fan.push(Math.round(Math.acos(Math.min(1, Math.max(-1, dirOf(i).dot(dirOf(i - 1))))) / D));
  }

  const pose = {};
  for (const ns of CHAINS) {
    for (const n of ns.slice(0, 3)) {
      const j = bone(n);
      pose[n] = [deg(j.rotation.x), deg(j.rotation.y), deg(j.rotation.z)];
    }
  }
  return JSON.stringify({
    twist,
    abductLegend: ['bone', 'authoredY', 'setY', 'residualDeg', 'centreLineMm'],
    abduct,
    fanDeg: fan,
    distalLegend: ['x', 'worstBroad', 'tuckM', 'frontM', 'centreLineMm'],
    distal,
    pose,
  });
})()
