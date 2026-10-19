/**
 * What is left flickering, and is it even the same mechanism?
 *
 * _wedge2.js took the door spots from 13/12/10/2 poses down to 2/1/0/1 with the cull doing the work, but
 * not to nought: 132 changed pixels survive at UPPER_INNER, 131 at UP_BACK_DOOR, 55 at BEDROOM_DOOR, on
 * a 0/60 worst-1 noise floor. A near-plane A/B flips a pixel for either of two reasons — a triangle
 * straddling the eye plane, which is the wedge, or two surfaces at the same depth swapping which one
 * wins, which is a z-fight and has nothing to do with the near plane except that the mapping moved. So
 * this asks two questions per surviving pose:
 *
 *   near   — every visible mesh with a triangle inside 0.30 m of the eye, nearest first. Under 0.10 m is
 *            the wedge; nothing under 0.10 m means the wedge is gone and this is the other thing.
 *   blame  — hide one subtree at a time and re-shoot, descending into whichever hides the flicker, down
 *            to a single mesh. The same instrument that attributed round 1 at 494 flipped pixels -> 0.
 *
 *   CDP_PORT=9223 CDP_MATCH=5199 node tools/cdp.mjs --file tools/_blame.js
 */
(async () => {
  const d = window.__daayan;
  const e = d.engine;
  const scene = e.scene;
  const cam = e.camera;
  const R = e.renderer;
  const p = d.player;
  const gl = R.getContext();
  const EYE = p.opts.eyeHeight;
  const RAD = p.opts.radius;
  const W = 480, H = 240;
  const a = new Uint8Array(W * H * 4);
  const b = new Uint8Array(W * H * 4);
  const NEAR_A = cam.near, NEAR_B = cam.near + 0.0001;
  const LUMA = 12, HIT = 40;

  const blocked = (x, y, z) => {
    const minY = y - EYE, maxY = y;
    for (const q of p.aabbs) {
      if (q.maxY <= minY + 0.05 || q.minY >= maxY + 0.05) continue;
      if (x + RAD > q.minX && x - RAD < q.maxX && maxY > q.minY && minY < q.maxY && z + RAD > q.minZ && z - RAD < q.maxZ) return true;
    }
    return false;
  };
  const d2Tri = (t, o, px, py, pz) => {
    const ax = t[o], ay = t[o + 1], az = t[o + 2], bx = t[o + 3], by = t[o + 4], bz = t[o + 5], cx = t[o + 6], cy = t[o + 7], cz = t[o + 8];
    const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    let qx, qy, qz;
    if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; } else {
      const bpx = px - bx, bpy = py - by, bpz = pz - bz;
      const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
      if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz; } else {
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); qx = ax + v * abx; qy = ay + v * aby; qz = az + v * abz; } else {
          const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
          const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
          if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz; } else {
            const vb = d5 * d2 - d1 * d6;
            if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); qx = ax + w * acx; qy = ay + w * acy; qz = az + w * acz; } else {
              const va = d3 * d6 - d5 * d4;
              if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
                const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
                qx = bx + w * (cx - bx); qy = by + w * (cy - by); qz = bz + w * (cz - bz);
              } else {
                const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
                qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
              }
            }
          }
        }
      }
    }
    const dx = px - qx, dy = py - qy, dz = pz - qz;
    return dx * dx + dy * dy + dz * dz;
  };
  /** Nearest triangle of one mesh to a point, world space, with a bbox reject first. */
  const nearestOf = (mesh, x, y, z, cut) => {
    const g = mesh.geometry;
    if (!g) return Infinity;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
    const gx = x < bb.min.x ? bb.min.x - x : x > bb.max.x ? x - bb.max.x : 0;
    const gy = y < bb.min.y ? bb.min.y - y : y > bb.max.y ? y - bb.max.y : 0;
    const gz = z < bb.min.z ? bb.min.z - z : z > bb.max.z ? z - bb.max.z : 0;
    if (gx * gx + gy * gy + gz * gz >= cut * cut) return Infinity;
    const pos = g.getAttribute('position'), idx = g.getIndex(), el = mesh.matrixWorld.elements;
    const t = new Float64Array(9);
    const put = (i, k) => {
      const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
      t[k] = el[0] * vx + el[4] * vy + el[8] * vz + el[12];
      t[k + 1] = el[1] * vx + el[5] * vy + el[9] * vz + el[13];
      t[k + 2] = el[2] * vx + el[6] * vy + el[10] * vz + el[14];
    };
    const count = idx ? idx.count : pos.count;
    let best = Infinity;
    for (let i = 0; i + 2 < count; i += 3) {
      put(idx ? idx.getX(i) : i, 0);
      put(idx ? idx.getX(i + 1) : i + 1, 3);
      put(idx ? idx.getX(i + 2) : i + 2, 6);
      const dd = d2Tri(t, 0, x, y, z);
      if (dd < best) best = dd;
    }
    return Math.sqrt(best);
  };

  const keep = { near: cam.near, pos: cam.position.clone(), rot: cam.rotation.clone(), order: cam.rotation.order };
  const home = p.position.clone();
  const buf0 = [R.domElement.width, R.domElement.height];
  const out = [];
  d.loop.stop();
  cam.rotation.order = 'YXZ';
  R.setSize(W, H, false);
  try {
    const shoot = (buf, near) => {
      cam.near = near;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      R.setRenderTarget(null);
      R.render(scene, cam);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    };
    const changedAt = () => {
      shoot(a, NEAR_A);
      shoot(b, NEAR_B);
      let n = 0;
      for (let i = 0; i < W * H; i++) {
        const j = i * 4;
        const la = (a[j] * 299 + a[j + 1] * 587 + a[j + 2] * 114) / 1000;
        const lb = (b[j] * 299 + b[j + 1] * 587 + b[j + 2] * 114) / 1000;
        if (Math.abs(la - lb) > LUMA) n++;
      }
      return n;
    };
    /** Put the eye at a pose in the real cull state. See _wedge2.js on why the scene update is needed. */
    const pose = (x, y, z, yaw, pitch) => {
      cam.position.set(x, y, z);
      p.position.set(x, y, z);
      p.velocity.set(0, 0, 0);
      d.scene.update(1 / 60);
      cam.rotation.set(pitch, yaw, 0);
    };

    const SPOTS = [
      ['UPPER_INNER', 19.855, 1.75, 4.1],
      ['UP_BACK_DOOR', 16.5, -0.99, 4.1],
      ['BEDROOM_DOOR', -5, 2.6, 1.7],
      ['KITCHEN_DOOR', -6, 12.2, 1.7],
    ];
    const YAWS = 6, PITCHES = [0, -0.6];
    const hits = [];
    for (const [name, dx, dz, eye] of SPOTS) {
      for (const [sx, sz] of [[dx - 0.55, dz], [dx, dz], [dx + 0.55, dz], [dx, dz - 0.55], [dx, dz + 0.55]]) {
        if (blocked(sx, eye, sz)) continue;
        for (let k = 0; k < YAWS; k++) {
          for (const pitch of PITCHES) {
            const yaw = (k / YAWS) * Math.PI * 2;
            pose(sx, eye, sz, yaw, pitch);
            const n = changedAt();
            if (n > HIT) hits.push({ name, sx, sz, eye, yaw, pitch, n });
          }
        }
        await new Promise((res) => requestAnimationFrame(res));
      }
    }
    hits.sort((x, y) => y.n - x.n);
    out.push(`surviving poses above ${HIT} changed px, real cull state: ${hits.length}`);
    for (const h of hits) out.push(`  ${h.name.padEnd(14)} (${h.sx.toFixed(2)}, ${h.eye}, ${h.sz.toFixed(2)}) yaw ${h.yaw.toFixed(2)} pitch ${h.pitch.toFixed(2)}   changed ${h.n}`);
    out.push('');

    for (const h of hits.slice(0, 3)) {
      pose(h.sx, h.eye, h.sz, h.yaw, h.pitch);
      out.push(`=== ${h.name} (${h.sx.toFixed(2)}, ${h.eye}, ${h.sz.toFixed(2)}) yaw ${h.yaw.toFixed(2)} pitch ${h.pitch.toFixed(2)}   changed ${changedAt()}`);
      // Everything the eye is nearly touching. Under 0.10 m is a wedge; nothing under it is a z-fight.
      const near = [];
      scene.traverse((o) => {
        if (!o.isMesh || !o.visible) return;
        for (let q = o.parent; q; q = q.parent) if (!q.visible) return;
        const dd = nearestOf(o, h.sx, h.eye, h.sz, 0.3);
        if (dd < 0.3) near.push([dd, o]);
      });
      near.sort((x, y) => x[0] - y[0]);
      out.push(`  within 0.30 m: ${near.length ? near.map(([dd, o]) => `${o.name || o.type}@${dd.toFixed(3)}`).join('  ') : 'nothing'}`);
      // Blame, top down. Only currently-visible children are candidates; hiding an already-hidden one
      // proves nothing, and the cull has hidden most of the house from here.
      let level = scene.children.slice(), path = [];
      for (let depth = 0; depth < 6; depth++) {
        // Lights and the camera are excluded, not skipped for tidiness: hiding a light empties the frame
        // of contrast, the luma diff falls to nothing, and the search would blame the light every time.
        const cand = level.filter((o) => o.visible && !o.isLight && !o.isCamera);
        if (cand.length === 0) break;
        let best = null;
        for (const o of cand) {
          o.visible = false;
          const n = changedAt();
          o.visible = true;
          if (!best || n < best.n) best = { o, n };
        }
        path.push(`${best.o.name || best.o.type}=${best.n}`);
        if (best.n > HIT) break;
        if (best.o.isMesh || best.o.children.length === 0) {
          const m = best.o.material;
          const mat = Array.isArray(m) ? m.map((x) => x.type).join('+') : m?.type;
          const dd = best.o.isMesh ? nearestOf(best.o, h.sx, h.eye, h.sz, 50).toFixed(3) : 'n/a';
          out.push(`  blame: ${path.join(' > ')}   [${mat} , nearest triangle ${dd} m]`);
          path = null;
          break;
        }
        level = best.o.children.slice();
        best.o.visible = true;
      }
      if (path) out.push(`  blame: ${path.join(' > ')}   (no single subtree accounts for it)`);
    }
  } finally {
    cam.near = keep.near;
    cam.position.copy(keep.pos);
    cam.rotation.copy(keep.rot);
    cam.rotation.order = keep.order;
    cam.updateProjectionMatrix();
    p.position.copy(home);
    p.velocity.set(0, 0, 0);
    if (typeof e.resizeHandler === 'function') e.resizeHandler();
    else R.setSize(buf0[0], buf0[1], false);
    d.loop.start();
  }
  return out.join('\n');
})()
