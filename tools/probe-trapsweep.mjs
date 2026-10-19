/**
 * Sweep a region for player-trap spots: any pose where the player cannot move in ANY direction.
 *
 * Usage: node tools/probe-trapsweep.mjs <x0> <z0> <x1> <z1> <feetY> [step] [portNeedle]
 *
 * Why: one reported stuck spot is never the whole story. A trap is a place where the player's
 * collider cylinder already intersects a box, so there is no approach to stop and no face to slide
 * along — every horizontal move is refused while the ground query keeps returning a floor, so the
 * player neither moves nor falls. Probing the one reported coordinate proves that coordinate; only a
 * sweep says whether the rest of the room is safe.
 *
 * For each sampled pose this drives move() briefly in 4 cardinal directions and reports the pose
 * only if all four refuse. That is the signature of a trap, as opposed to a wall (which blocks some
 * directions) or open floor (which blocks none).
 *
 * IMPORTANT — a pose must be REACHABLE to be a trap. `warpTo` teleports a collision cylinder to an
 * exact coordinate, including coordinates no walking player could ever occupy. Sampling a grid and
 * warping to every cell therefore reports "traps" along every wall face: the cell one radius inside
 * a wall is solid, but a player walking at it is stopped *outside* it and never gets there. Those
 * readings are artefacts, and they drown the real ones.
 *
 * So each cell is first tested for reachability: walk toward it from the cell's parent (the previous
 * cell along the sweep) and only treat it as a sample if the player actually arrives. Cells the
 * player cannot walk into are skipped.
 */
const [x0, z0, x1, z1, feetY, step = '0.3', NEEDLE = '5174'] = process.argv.slice(2);
if (z1 === undefined) {
  console.error('usage: node tools/probe-trapsweep.mjs <x0> <z0> <x1> <z1> <feetY> [step] [portNeedle]');
  process.exit(2);
}
const PORT = process.env.CDP_PORT ?? '9222';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl).find((t) => t.url.includes(NEEDLE));
if (!page) {
  console.error(`no page matching ${NEEDLE}`);
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pend = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  const f = pend.get(m.id);
  if (f) {
    pend.delete(m.id);
    f(m);
  }
});
const send = (method, params = {}) =>
  new Promise((res) => {
    const n = ++id;
    pend.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });

const expr = `(() => {
  const p = window.__daayan.player;
  const eye = p.currentEyeHeight();
  const X0 = ${Number(x0)}, Z0 = ${Number(z0)}, X1 = ${Number(x1)}, Z1 = ${Number(z1)};
  const FY = ${Number(feetY)}, STEP = ${Number(step)};
  const DT = 1 / 60, speed = p.opts.walkSpeed;
  const R = p.getRadius ? p.getRadius() : 0.35;

  // Can the player move from this pose in any cardinal direction?
  const canMove = (px, pz) => {
    for (const [ux, uz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      p.warpTo(new (p.position.constructor)(px, FY + eye, pz), 0);
      p.onGround = true;
      const s = p.position.x, t = p.position.z;
      const sinY = 0, cosY = 1;   // yaw 0 => forward is -z
      const strafe = ux * cosY - uz * sinY;
      const forward = -ux * sinY - uz * cosY;
      const mag = 0.1 / (speed * DT);
      for (let i = 0; i < 12; i++) p.move(strafe * mag, forward * mag, DT);
      if (Math.hypot(p.position.x - s, p.position.z - t) > 0.05) return true;
    }
    return false;
  };

  const trapped = [];
  const cells = [];
  let skippedUnreachable = 0;

  // Walk from one point toward another and say whether the player arrives near the target. This is
  // the reachability gate: a cell that cannot be walked into is not a place the player can be stuck
  // in, whatever a teleport to it reports.
  const canWalkTo = (fx, fz, tx, tz) => {
    p.warpTo(new (p.position.constructor)(fx, FY + eye, fz), 0);
    p.onGround = true;
    const DT = 1 / 60, speed = p.opts.walkSpeed;
    for (let i = 0; i < 30; i++) {
      const len = Math.hypot(tx - p.position.x, tz - p.position.z) || 1;
      const ux = (tx - p.position.x) / len, uz = (tz - p.position.z) / len;
      const adv = Math.min(0.04, len);
      const sinY = Math.sin(p.facing.y), cosY = Math.cos(p.facing.y);
      const strafe = ux * cosY - uz * sinY;
      const forward = -ux * sinY - uz * cosY;
      p.move(strafe * (adv / (speed * DT)), forward * (adv / (speed * DT)), DT);
      if (Math.hypot(p.position.x - tx, p.position.z - tz) < 0.08) return true;
    }
    return false;
  };

  for (let x = X0; x <= X1 + 1e-6; x += STEP) {
    for (let z = Z0; z <= Z1 + 1e-6; z += STEP) {
      // Only consider poses that are actually on a walkable floor near the requested height.
      const g = p.groundYAt(x, z);
      if (Math.abs(g - FY) > 0.6) continue;
      const px = Number(x.toFixed(3)), pz = Number(z.toFixed(3));

      // Reachability: try to walk in from each neighbour already known to be a valid sample. A cell
      // is a valid sample if the player can arrive at it from ANY adjacent walkable cell.
      const parents = [[px - STEP, pz], [px + STEP, pz], [px, pz - STEP], [px, pz + STEP]];
      let reachable = false;
      for (const [fx, fz] of parents) {
        const fg = p.groundYAt(fx, fz);
        if (Math.abs(fg - FY) > 0.6) continue;
        const fr = (p.aabbs || []).filter((a) =>
          fx + R > a.minX && fx - R < a.maxX && fz + R > a.minZ && fz - R < a.maxZ &&
          FY + 0.2 > a.minY && FY + 1.5 < a.maxY);
        if (fr.length) continue;   // parent is itself inside a box; not a valid launch point
        if (canWalkTo(fx, fz, px, pz)) { reachable = true; break; }
      }
      if (!reachable) { skippedUnreachable++; continue; }

      cells.push([Number(x.toFixed(2)), Number(z.toFixed(2))]);
      p.warpTo(new (p.position.constructor)(px, FY + eye, pz), 0);
      p.onGround = true;
      const hits = (p.aabbs || []).filter((a) =>
        px + R > a.minX && px - R < a.maxX && pz + R > a.minZ && pz - R < a.maxZ &&
        FY + 0.2 > a.minY && FY + 1.5 < a.maxY);
      if (!hits.length) continue;
      if (!canMove(px, pz)) {
        trapped.push({ at: [px, pz], groundY: Number(g.toFixed(3)),
          boxes: hits.map((a) => ({ x: [Number(a.minX.toFixed(2)), Number(a.maxX.toFixed(2))],
                                    y: [Number(a.minY.toFixed(2)), Number(a.maxY.toFixed(2))],
                                    z: [Number(a.minZ.toFixed(2)), Number(a.maxZ.toFixed(2))] })) });
      }
    }
  }
  return JSON.stringify({ sampled: cells.length, skippedUnreachable, trappedCount: trapped.length,
    trapped: trapped.slice(0, 12), feetY: FY });
})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
if (r.result?.exceptionDetails) {
  console.error('eval failed:', r.result.exceptionDetails.text, r.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
const o = JSON.parse(r.result.result.value);
console.log(`swept x ${x0}..${x1}  z ${z0}..${z1}  at feet y ${o.feetY}`);
console.log(`${o.sampled} poses reachable on foot   (${o.skippedUnreachable} cells skipped: not walkable into)`);
console.log(`TRAPS FOUND: ${o.trappedCount}`);
for (const t of o.trapped) {
  console.log(`\n  trapped at (${t.at[0]}, ${t.at[1]})  groundY ${t.groundY}`);
  for (const b of t.boxes) console.log('    inside box  x', b.x, ' y', b.y, ' z', b.z);
}
if (o.trappedCount === 0) console.log('\nNo pose in this region can be entered and not left.');
ws.close();
