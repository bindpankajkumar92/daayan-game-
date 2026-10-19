/**
 * Throwaway: the whole pose, solved in one evaluate — curl planes, abduction, distal fold, wrist, thumb.
 *
 * Supersedes tools/_align.js and tools/_fing.js, both of which optimised metrics that turned out to measure
 * something other than what the eye reads:
 *
 *   - Gap in millimetres. segDist is bone centre line to bone centre line and a finger is about 15 mm thick,
 *     so fingers pressed together read as ~17 mm apart — the knuckle pitch — and the 2.3 mm the index and
 *     middle authored to means those two are modelled *through* each other. Worse, the minimum over a whole
 *     digit is dominated by the knuckle end, where even a splayed hand is still one pitch apart, so it cannot
 *     see a fan at all. Parallelism of the middle phalanges is the thing; distance is only a floor.
 *
 *   - `broad` across joints 2 to 4. Folding the fingertip out of sight shortens and turns that chord, so a
 *     tucked fist scored *worse* than one presenting its nails to the camera, and the wrist angle chosen
 *     against it (0, 60, -70) was chosen for the wrong reason. Measured across joints 2 to 3 it is the bare
 *     middle phalanx alone, which is the surface the reference photo actually shows.
 *
 * Stage order matters and is not arbitrary: twist and abduction are judged on the hand's own geometry, so they
 * are camera-independent and settle first; the wrist and thumb are judged through the player's camera and
 * depend on them. Nothing here needs a second pass over the first two.
 *
 *   node tools/cdp.mjs --file tools/_pose.js
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
  const W = d.engine.renderer.domElement.width;
  const H = d.engine.renderer.domElement.height;

  const CHAINS = [
    ['R_point1_030', 'R_point2_031', 'R_point3_032', 'R_point4_033'],
    ['R_middle1_034', 'R_middle2_035', 'R_middle3_036', 'R_middle4_037'],
    ['R_ring1_038', 'R_ring2_039', 'R_ring3_040', 'R_ring4_041'],
    ['R_pink1_042', 'R_pink2_043', 'R_pink3_044', 'R_pink4_045'],
  ];
  const THUMB = ['R_thumb1_026', 'R_thumb2_027', 'R_thumb3_028', 'R_thumb4_029'];
  const GRIP = [
    'R_point1_030', 'R_middle1_034', 'R_ring1_038', 'R_pink1_042',
    'R_point3_032', 'R_middle3_036', 'R_ring3_040', 'R_pink3_044',
  ];

  /**
   * The shipped pose: x is what FIST writes, y and z are the rig's own authored splay and twist. Hard-coded so
   * every run starts from the same place — the stages below write absolute angles, so without this a second
   * run would align against the first run's output.
   */
  const SHIP = {
    R_point1_030: [-64, 3.7, -1.6], R_point2_031: [-86, 7.5, 0.2], R_point3_032: [-16, -7.1, -1.3],
    R_middle1_034: [-64, 2.8, -30.6], R_middle2_035: [-88, 3.9, -0.8], R_middle3_036: [-16, 4, 5.3],
    R_ring1_038: [-60, 6.5, -28.5], R_ring2_039: [-85, 4, -13.3], R_ring3_040: [-16, 5.8, 5.3],
    R_pink1_042: [-56, -3.1, -50.4], R_pink2_043: [-84, 10, 3.7], R_pink3_044: [-16, -2.7, -1.1],
  };
  for (const [n, r] of Object.entries(SHIP)) bone(n).rotation.set(r[0] * D, r[1] * D, r[2] * D);
  const thumbRest = THUMB.slice(0, 3).map((n) => [bone(n).rotation.x, bone(n).rotation.y, bone(n).rotation.z]);
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
  const chainPts = (ns) => ns.map((n) => bone(n).getWorldPosition(new V()));
  const between = (a, b) => {
    let best = Infinity;
    for (let m = 0; m + 1 < a.length; m++) {
      for (let n = 0; n + 1 < b.length; n++) best = Math.min(best, segDist(a[m], a[m + 1], b[n], b[n + 1]));
    }
    return best * 1000;
  };
  const gapBetween = (i, j) => between(chainPts(CHAINS[i]), chainPts(CHAINS[j]));
  const dirOf = (i) => {
    const p = chainPts(CHAINS[i]);
    return p[2].clone().sub(p[1]).normalize();
  };

  // ---- Stage 1: parallel curl planes ------------------------------------------------------------------
  // Whole degrees across the full circle rather than a gradient step: an axis is a line, not an arrow, so the
  // objective has a second minimum 180 degrees away that folds the finger backwards.
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
      // Refuse an alignment that is not actually reachable by twisting this one joint: if the residual is still
      // wide the two axes are skew and the twist would roll the finger for no gain.
      j.rotation.z = (best[1] < 25 ? best[0] : deg(keep)) * D;
      arms.updateMatrixWorld(true);
      twist.push([CHAINS[i][ji], deg(keep), best[1] < 25 ? best[0] : 'kept', +best[1].toFixed(1)]);
    }
  }

  // ---- Stage 2: place each digit against both its neighbours ------------------------------------------
  //
  // Three axes per digit, and clearance as a *penalty* rather than a constraint. As a hard floor it was
  // infeasible: aligning every curl plane to the index's (stage 1) swings the pinky's 50-degree authored twist
  // out of the way and into the ring finger, and once the ring has been placed for parallelism the pinky has
  // nowhere legal left — it sat 3.6 mm centre line to centre line inside it, about 8 mm of interpenetration,
  // and the search returned "kept" three times running. Priced instead, the pinky can buy clearance with the
  // parallelism it cannot use, and something is always returned. Two passes, and each digit is scored against
  // the neighbour on *both* sides, so the ring can move back out of the pinky's way after the pinky is placed.
  //
  // Clearance is a *band*, not a floor, for the same reason the thumb's reach had to be a target and not a
  // maximum. With a floor only, the four settled exactly parallel one knuckle pitch apart — 16.6 mm, legal and
  // wrong, because parallel lines never converge and the render showed daylight down every seam where the
  // reference has one solid block. A real fist converges: the tips come together over the palm. So pay for
  // being too far apart as well as too close, and let parallelism decide only inside the band.
  const FLOOR = [12, 11, 10];
  const TIGHT = [14, 13, 12];
  const abduct = [];
  const price = (k) => {
    const g = gapBetween(k, k + 1);
    return 6 * Math.max(0, FLOOR[k] - g) + 2 * Math.max(0, g - TIGHT[k]);
  };
  const clash = (i) => price(i - 1) + (i + 1 < CHAINS.length ? price(i) : 0);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < CHAINS.length; i++) {
      const j = bone(CHAINS[i][0]);
      const keep = [deg(j.rotation.x), deg(j.rotation.y), deg(j.rotation.z)];
      const target = dirOf(0);
      let best = null;
      for (let dx = -12; dx <= 12; dx += 6) {
        for (let y = -40; y <= 40; y += 4) {
          for (let dz = -70; dz <= 30; dz += 10) {
            j.rotation.set((keep[0] + dx) * D, y * D, (keep[2] + dz) * D);
            anchor();
            const a = Math.acos(Math.min(1, Math.max(-1, dirOf(i).dot(target)))) / D + clash(i);
            if (!best || a < best[3]) best = [keep[0] + dx, y, keep[2] + dz, a];
          }
        }
      }
      j.rotation.set(best[0] * D, best[1] * D, best[2] * D);
      anchor();
      if (pass) {
        abduct.push([CHAINS[i][0], keep, best.slice(0, 3), +best[3].toFixed(1),
          +gapBetween(i - 1, i).toFixed(1)]);
      }
    }
  }

  // ---- Camera-space metrics --------------------------------------------------------------------------
  const look = () => {
    anchor();
    const cp = CHAINS.map((ns) => ns.map((n) => cam.worldToLocal(bone(n).getWorldPosition(new V()))));
    let knuckle = 0;
    for (const c of cp) knuckle += -c[0].z;
    knuckle /= 4;
    let broad = 1;
    let tuck = 1e9;
    let front = 1e9;
    let off = 0;
    const px = [];
    for (let i = 0; i < cp.length; i++) {
      const c = cp[i];
      const dir = c[2].clone().sub(c[1]).normalize();
      broad = Math.min(broad, 1 - Math.abs(dir.dot(c[1].clone().add(c[2]).multiplyScalar(0.5).normalize())));
      tuck = Math.min(tuck, -c[3].z - -c[2].z);
      front = Math.min(front, knuckle - -c[2].z);
      const p = bone(CHAINS[i][2]).getWorldPosition(new V()).project(cam);
      if (Math.abs(p.x) > 0.9 || Math.abs(p.y) > 0.9) off++;
      px.push([p.x * 0.5 * W, p.y * 0.5 * H]);
    }
    let sep = 1e9;
    for (let i = 0; i < px.length; i++) {
      for (let j = i + 1; j < px.length; j++) {
        sep = Math.min(sep, Math.hypot(px[i][0] - px[j][0], px[i][1] - px[j][1]));
      }
    }
    const w0 = bone('R_wrist_025').getWorldPosition(new V()).project(cam);
    const e0 = bone('R_elbow_024').getWorldPosition(new V()).project(cam);
    return { broad, tuck, front, off, sep, arm: Math.round(Math.atan2(e0.y - w0.y, e0.x - w0.x) / D) };
  };

  // ---- Stage 3: distal fold ---------------------------------------------------------------------------
  // Uniform, as FIST has it. Chosen for `tuck`: the fingertip has to finish deeper than the joint it folds
  // from, which is what turns four nails pointed at the eye into four knuckle bumps.
  const distal = [];
  for (let c = -20; c >= -95; c -= 5) {
    for (const ns of CHAINS) bone(ns[2]).rotation.x = c * D;
    const m = look();
    distal.push([c, +m.tuck.toFixed(4), +between(chainPts(CHAINS[0]), chainPts(CHAINS[1])).toFixed(1)]);
  }
  const C3 = -70;
  for (const ns of CHAINS) bone(ns[2]).rotation.x = C3 * D;

  // ---- Stage 4: the wrist ----------------------------------------------------------------------------
  //
  // `tuck` and `front` are admissibility, not bonuses. Paid as a flat +0.3 each they were affordable: the
  // winning wrist came back with tuck exactly 0 — the fingernails facing the eye again, undoing stage 3 — and
  // still outscored a runner-up that kept the fold, because a hundredth of `broad` was worth more than the
  // gate. They are conditions on a fist reading as a fist, so they are conditions here: the fingertips must
  // finish at least 3 mm deeper than the joints they fold from, and the middle phalanges must sit in front of
  // the knuckle plane rather than behind the back of the glove. What is then ranked is the one thing left to
  // want, how side-on and how spread the four bare segments are.
  const wrist = bone('R_wrist_025');
  const value = (m) => m.broad * (1 + Math.min(m.sep, 45) / 45);
  const wrows = [];
  const loose = [];
  for (let x = -60; x <= 60; x += 15) {
    for (let y = -30; y <= 90; y += 10) {
      for (let z = -140; z <= 0; z += 10) {
        wrist.rotation.set(x * D, y * D, z * D);
        const m = look();
        if (m.off || m.arm > 25 || m.arm < -120) continue;
        const row = [+value(m).toFixed(3), x, y, z, +m.broad.toFixed(3), Math.round(m.sep),
          +m.tuck.toFixed(4), +m.front.toFixed(4), m.arm];
        loose.push(row);
        if (m.tuck > 0.003 && m.front > 0) wrows.push(row);
      }
    }
  }
  const strict = wrows.length > 0;
  const wsort = (strict ? wrows : loose).sort((a, b) => b[0] - a[0]);
  const WR = wsort.length ? wsort[0].slice(1, 4) : [0, 60, -70];
  wrist.rotation.set(WR[0] * D, WR[1] * D, WR[2] * D);
  anchor();

  // ---- Stage 5: the thumb ----------------------------------------------------------------------------
  // Wrapped over the front of the fingers, as in the reference: crossing them, a little nearer the eye, and
  // resting on them rather than passing through or hovering. Both terms have to be *targets*, not maxima — the
  // first version maximised nearness and picked a thumb standing 51 mm proud of the fingers, straight at the
  // camera. Swept as deltas off the authored abduction, and kept small, because that is the part of the thumb
  // the rig gets right.
  const idx = () => chainPts(CHAINS[0]);
  const mid = () => chainPts(CHAINS[1]);
  const thumbLook = () => {
    const t = chainPts(THUMB);
    const near = Math.min(between(t, idx()), between(t, mid()));
    const tc = t.slice(1).map((p) => cam.worldToLocal(p.clone()));
    const ic = idx().slice(1, 3).map((p) => cam.worldToLocal(p.clone()));
    const tz = Math.min(...tc.map((p) => -p.z));
    const iz = Math.min(...ic.map((p) => -p.z));
    const p = bone(THUMB[2]).getWorldPosition(new V()).project(cam);
    // Crossing the fingers rather than lying along them. Without this the search is satisfied by a straight
    // thumb touching at one point, which is a thumb sticking out beside the fist, not wrapped over it.
    const td = t[3].clone().sub(t[2]).normalize();
    const cross = 1 - Math.abs(td.dot(dirOf(0)));
    return { near, cross, over: (iz - tz) * 1000, off: Math.abs(p.x) > 0.9 || Math.abs(p.y) > 0.9 ? 1 : 0 };
  };
  const trows = [];
  for (let x1 = -30; x1 <= 10; x1 += 10) {
    for (let dy = -20; dy <= 20; dy += 10) {
      for (let dz = -20; dz <= 20; dz += 10) {
        for (let x2 = -20; x2 >= -70; x2 -= 10) {
          for (let x3 = -20; x3 >= -60; x3 -= 20) {
            bone(THUMB[0]).rotation.set(x1 * D, thumbRest[0][1] + dy * D, thumbRest[0][2] + dz * D);
            bone(THUMB[1]).rotation.x = x2 * D;
            bone(THUMB[2]).rotation.x = x3 * D;
            arms.updateMatrixWorld(true);
            const t = thumbLook();
            if (t.off) continue;
            // 14 mm centre line to centre line is a thumb pad on a phalanx; 8 mm proud of them is crossing in
            // front rather than buried in the fist or waved at the camera. Both are targets, not maxima — an
            // earlier version maximised nearness and picked a thumb standing 51 mm proud, straight at the eye.
            const err = Math.abs(t.near - 14) / 10 + Math.abs(t.over - 8) / 20 - t.cross;
            trows.push([+err.toFixed(2), x1, dy, dz, x2, x3, +t.near.toFixed(1), +t.over.toFixed(1),
              +t.cross.toFixed(2)]);
          }
        }
      }
    }
  }
  trows.sort((a, b) => a[0] - b[0]);
  if (trows.length) {
    const [, x1, dy, dz, x2, x3] = trows[0];
    bone(THUMB[0]).rotation.set(x1 * D, thumbRest[0][1] + dy * D, thumbRest[0][2] + dz * D);
    bone(THUMB[1]).rotation.x = x2 * D;
    bone(THUMB[2]).rotation.x = x3 * D;
  } else {
    for (let i = 0; i < 3; i++) bone(THUMB[i]).rotation.set(...thumbRest[i]);
  }
  anchor();

  const pose = {};
  for (const ns of [...CHAINS, THUMB]) {
    for (const n of ns.slice(0, 3)) {
      const j = bone(n);
      pose[n] = [deg(j.rotation.x), deg(j.rotation.y), deg(j.rotation.z)];
    }
  }
  pose.R_wrist_025 = [deg(wrist.rotation.x), deg(wrist.rotation.y), deg(wrist.rotation.z)];
  const fan = [];
  for (let i = 1; i < CHAINS.length; i++) {
    fan.push(Math.round(Math.acos(Math.min(1, Math.max(-1, dirOf(i).dot(dirOf(i - 1))))) / D));
  }
  const m = look();
  return JSON.stringify({
    twist,
    abductLegend: ['bone', 'wasXYZ', 'setXYZ', 'scoreDegPlusPenalty', 'centreLineMm'],
    abduct,
    fanDeg: fan,
    distalLegend: ['x', 'tuckM', 'pointMiddleMm'],
    distal,
    wristLegend: ['value', 'x', 'y', 'z', 'worstBroad', 'sepPx', 'tuckM', 'frontM', 'armDeg'],
    wristAdmissible: [wrows.length, loose.length, strict ? 'tuck+front' : 'RELAXED'],
    wristTop: wsort.slice(0, 8),
    thumbLegend: ['err', 'x1', 'dY', 'dZ', 'x2', 'x3', 'nearMm', 'overMm', 'cross'],
    thumbTried: trows.length,
    thumbTop: trows.slice(0, 6),
    final: {
      broad: +m.broad.toFixed(3), sepPx: Math.round(m.sep), tuck: +m.tuck.toFixed(4),
      front: +m.front.toFixed(4), arm: m.arm,
      gaps: [gapBetween(0, 1), gapBetween(1, 2), gapBetween(2, 3)].map((g) => +g.toFixed(1)),
    },
    pose,
  });
})()
