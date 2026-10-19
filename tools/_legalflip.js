/**
 * The last link: does the flip fire at a pose the player can legally stand in, with the door open?
 *
 * _legal.js found 41 legal grid points inside the 0.1 m near plane once the door is open, closest 0.003 m.
 * _fix.js proved the flip at an *illegal* pose. This joins them — open the door the way onUse does, sweep
 * only the legal points that get within 0.1 m of a leaf triangle, and run the same near-plane A/B at each.
 *
 * If it fires here, the chain is closed: the player opens the inner door, walks into the swung leaf because
 * it carries no collider, and the leaf's triangles straddle the eye plane. Nothing about edge length, which
 * is why round 3's 1 m bound on this exact file changed nothing.
 *
 * Also scores the same poses with the leaf hidden, so the "before" number has its own control rather than
 * being trusted, and prints the open leaf's world box — the fix needs those numbers.
 *
 *   node tools/cdp.mjs --file tools/_legalflip.js
 */
(async () => {
  const d = window.__daayan;
  const e = d.engine;
  const scene = e.scene;
  const cam = e.camera;
  const R = e.renderer;
  const gl = R.getContext();
  const p = d.player;
  const EYE = p.opts.eyeHeight;
  const RAD = p.opts.radius;
  const W = 320, H = 160;
  const a = new Uint8Array(W * H * 4);
  const b = new Uint8Array(W * H * 4);
  const LUMA = 12;

  const hidden = [];
  scene.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
  const keep = { near: cam.near, pos: cam.position.clone(), rot: cam.rotation.clone(), order: cam.rotation.order };
  const buf0 = [R.domElement.width, R.domElement.height];
  cam.rotation.order = 'YXZ';
  R.setSize(W, H, false);

  const blocked = (x, y, z) => {
    const minY = y - EYE, maxY = y;
    for (const q of p.aabbs) {
      if (q.maxY <= minY + 0.05) continue;
      if (q.minY >= maxY + 0.05) continue;
      if (x + RAD > q.minX && x - RAD < q.maxX && maxY > q.minY && minY < q.maxY && z + RAD > q.minZ && z - RAD < q.maxZ) return true;
    }
    return false;
  };

  const leaves = [];
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    for (let q = o; q; q = q.parent) if (/door-inner/.test(q.name || '')) { leaves.push(o); return; }
  });
  let pivot = null;
  scene.traverse((o) => { if (o.name === 'inner-door.pivot') pivot = o; });
  const shut = pivot.rotation.y;
  const blocker = p.aabbs.find(
    (q) => Math.abs((q.minX + q.maxX) / 2 - 19.855) < 0.02 && Math.abs((q.minZ + q.maxZ) / 2 - 1.75) < 0.05 && q.maxX - q.minX < 0.4,
  );
  const kept = { minY: blocker.minY, maxY: blocker.maxY };

  // Open it, exactly as InnerDoor.onUse does.
  pivot.rotation.y = shut + (100 * Math.PI) / 180;
  blocker.minY = -60;
  blocker.maxY = -59.8;
  scene.updateMatrixWorld(true);

  const tri = [];
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const o of leaves) {
    const g = o.geometry, pos = g.attributes.position, idx = g.index;
    const el = o.matrixWorld.elements;
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i + 2 < n; i += 3) {
      const t = [];
      for (let k = 0; k < 3; k++) {
        const j = idx ? idx.getX(i + k) : i + k;
        const x = pos.getX(j), y = pos.getY(j), z = pos.getZ(j);
        const w = [el[0] * x + el[4] * y + el[8] * z + el[12], el[1] * x + el[5] * y + el[9] * z + el[13], el[2] * x + el[6] * y + el[10] * z + el[14]];
        for (let m = 0; m < 3; m++) { if (w[m] < lo[m]) lo[m] = w[m]; if (w[m] > hi[m]) hi[m] = w[m]; }
        t.push(w);
      }
      tri.push(t);
    }
  }

  const shoot = (buf, near) => {
    cam.near = near;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    R.setRenderTarget(null);
    R.render(scene, cam);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  };
  const diff = () => {
    shoot(a, 0.1);
    shoot(b, 0.1001);
    let changed = 0;
    for (let i = 0; i < W * H; i++) {
      const j = i * 4;
      const la = (a[j] * 299 + a[j + 1] * 587 + a[j + 2] * 114) / 1000;
      const lb = (b[j] * 299 + b[j + 1] * 587 + b[j + 2] * 114) / 1000;
      if (Math.abs(la - lb) > LUMA) changed++;
    }
    return changed;
  };

  // Point-to-box distance is enough to pick candidate stands; the flip itself is the measurement.
  const nearBox = (x, z) => {
    const dx = Math.max(lo[0] - x, 0, x - hi[0]);
    const dz = Math.max(lo[2] - z, 0, z - hi[2]);
    return Math.hypot(dx, dz);
  };

  const stands = [];
  for (let x = lo[0] - 1.2; x <= hi[0] + 1.2; x += 0.1) {
    for (let z = lo[2] - 1.2; z <= hi[2] + 1.2; z += 0.1) {
      if (blocked(x, 4.1, z)) continue;
      const dist = nearBox(x, z);
      if (dist < 0.12) stands.push([x, z, dist]);
    }
  }
  stands.sort((q, r) => q[2] - r[2]);

  const out = [];
  out.push(`${W}x${H}, near 0.1 vs 0.1001, luma ${LUMA}; ${hidden.length} objects forced visible`);
  out.push(`open leaf world box  x ${lo[0].toFixed(3)}..${hi[0].toFixed(3)}  y ${lo[1].toFixed(3)}..${hi[1].toFixed(3)}  z ${lo[2].toFixed(3)}..${hi[2].toFixed(3)}`);
  out.push(`${tri.length} leaf triangles; ${stands.length} legal stands within 0.12 m of the open leaf in plan`);
  out.push('');
  out.push('stand              plan dist   yaw   changed   leaf hidden');

  const YAWS = 6;
  let worst = null, fired = 0, tested = 0;
  for (const [sx, sz, dist] of stands.slice(0, 10)) {
    for (let k = 0; k < YAWS; k++) {
      const yaw = (k / YAWS) * Math.PI * 2;
      cam.position.set(sx, 4.1, sz);
      cam.rotation.set(0, yaw, 0);
      cam.updateMatrixWorld(true);
      const changed = diff();
      tested++;
      if (changed > 40) {
        fired++;
        const vis0 = leaves.map((o) => o.visible);
        for (const o of leaves) o.visible = false;
        const without = diff();
        for (let i = 0; i < leaves.length; i++) leaves[i].visible = vis0[i];
        if (!worst || changed > worst.changed) worst = { sx, sz, yaw, changed, without, dist };
        if (out.length < 18) {
          out.push(
            `(${sx.toFixed(2)}, ${sz.toFixed(2)})`.padEnd(19) + ` ${dist.toFixed(3).padStart(9)} ${yaw.toFixed(2).padStart(5)} ` +
              `${String(changed).padStart(9)} ${String(without).padStart(13)}`,
          );
        }
      }
    }
    await new Promise((res) => requestAnimationFrame(res));
  }

  out.push('');
  out.push(`${fired}/${tested} legal door-open poses flipped more than 40 pixels of ${W * H}`);
  if (worst) {
    out.push(`worst legal pose (${worst.sx.toFixed(3)}, 4.1, ${worst.sz.toFixed(3)}) yaw ${worst.yaw.toFixed(4)}: ${worst.changed} flipped, ${worst.without} with the leaf hidden`);
  } else {
    out.push('no legal door-open pose flipped — the artefact is not reachable and the leaf is not the bug');
  }

  pivot.rotation.y = shut;
  blocker.minY = kept.minY;
  blocker.maxY = kept.maxY;
  scene.updateMatrixWorld(true);
  cam.near = keep.near;
  cam.position.copy(keep.pos);
  cam.rotation.copy(keep.rot);
  cam.rotation.order = keep.order;
  cam.updateProjectionMatrix();
  for (const o of hidden) o.visible = false;
  if (typeof e.resizeHandler === 'function') e.resizeHandler();
  else R.setSize(buf0[0], buf0[1], false);
  return out.join('\n');
})()
