/**
 * Scratch probe: from *legal* eye positions on the flat, is any part of the hidden room visible?
 *
 * The report this change came from was "the room is visible from three sides", and no screenshot
 * settles it: a dark JPEG of a stairwell cannot say whether the dark thing at the bottom is the flight
 * or the room's floor. `_hidwalk.mjs` says where the player can go, `_hidhit.mjs` says which box
 * refuses a move — neither answers *sight*.
 *
 * Two things this does differently from a pose-and-yaw sweep, both learned the hard way:
 *
 * 1. It tests **points**, not angles. A pose list plus a yaw/pitch fan reports "a ray went there" and
 *    leaves you to work out whether a player could stand where the ray started. Asking instead "can an
 *    eye at A see point P" makes the answer the thing being reported, and a hit within 0.15 m of P's
 *    own distance is the answer "yes".
 * 2. It filters the poses with the controller's own predicates *and* a standoff. `__daayan.look()`
 *    casts from half a metre in front of the eye — deliberately, because the viewmodel is 0.2 m away —
 *    so an eye pressed against a wall or a kerb has that first half-metre skipped and reports a
 *    sightline through the very thing that blocks it. Every pose here keeps 0.6 m of clear air, which is
 *    what "walking around the entry room" means anyway; someone leaning right over the kerb is a
 *    separate question, and a screenshot answers that one.
 *
 * Usage: node tools/_hidsee.mjs [portNeedle]
 */
const [NEEDLE = '5174'] = process.argv.slice(2);
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
  const d = window.__daayan, p = d.player, c = d.engine.camera;
  const V = p.position.constructor;
  const keep = { pos: p.position.clone(), facing: p.facing.clone() };
  const r = p.getRadius ? p.getRadius() : 0.35;
  const EYE = 4.1;                     // the flat's 2.4 plus the 1.7 standing eye
  const ROOM = { x0: 15.71, x1: 21.49, z0: -6.09, z1: 0.5, y0: 0.2, y1: 2.4 };
  const WELL = { x0: 16.11, x1: 18.71, z0: -1.28, z1: 0.36 };   // the shaft plus its own new walls

  // Every eye the player can legally stand at on the flat, keeping 0.6 m of clear air around it. The
  // grid covers both halves of the upper storey the room could be seen from: the entry room (west of
  // the nook's wall) and the nook itself, in front of the door.
  const clear = (x, y, z) => {
    p.position.set(x, y, z);
    if (p.collidesAabb(p.position, r) || p.collidesAabbAt(p.position, r)) return false;
    for (const a of p.aabbs || []) {
      if (a.maxY <= y - 1.7 + 0.05) continue;      // underfoot: the boards, not a wall
      if (a.minY >= y + 0.05) continue;            // overhead
      const dx = Math.max(a.minX - x, 0, x - a.maxX);
      const dz = Math.max(a.minZ - z, 0, z - a.maxZ);
      if (dx * dx + dz * dz < 0.6 * 0.6) return false;
    }
    return true;
  };
  // \`POSES=inside\` is the positive control: eyes standing in the hidden room itself, where sightlines
  // between two points of it are unremarkable. A run that reports no leaks from those eyes is a broken
  // probe, not a sealed room — and "0 leaks" is exactly the answer that most needs to be distrusted.
  const inside = '${process.env.POSES ?? ''}' === 'inside';
  const poses = [];
  if (inside) {
    for (let x = 16.2; x <= 21.0; x += 0.8) {
      for (let z = -5.6; z <= 0.0; z += 0.8) {
        const px = Math.round(x * 100) / 100, pz = Math.round(z * 100) / 100;
        if (clear(px, 1.9, pz)) poses.push([px, 1.9, pz]);
      }
    }
  } else {
    for (let x = 14.9; x <= 19.6; x += 0.5) {
      for (let z = -1.7; z <= 3.5; z += 0.5) {
        const px = Math.round(x * 100) / 100, pz = Math.round(z * 100) / 100;
        if (clear(px, EYE, pz)) poses.push([px, EYE, pz]);
      }
    }
  }

  // Targets inside the room, on a coarse grid: floor level up to just under its ceiling.
  const targets = [];
  for (let x = 16.0; x <= 21.0; x += 1.0) {
    for (let z = -5.5; z <= 0.5; z += 1.0) {
      for (const y of [0.6, 1.2, 1.8]) targets.push([x, y, z]);
    }
  }

  const dir = new V();
  const leaks = [];
  let rays = 0;
  for (const a of poses) {
    for (const t of targets) {
      const len = Math.hypot(t[0] - a[0], t[1] - a[1], t[2] - a[2]);
      p.position.set(a[0], a[1], a[2]);
      c.position.copy(p.position);
      // Aim the camera at the target with the engine's own \`lookAt\` rather than by computing a yaw and
      // a pitch: the first version of this probe did the trigonometry by hand, and the pitch it derived
      // was only right at yaw 0 and 180 — the ray then stopped short of the target on a different wall
      // and the tolerance below silently discarded it. \`lookAt\` cannot disagree with the direction the
      // ray uses, and \`updateMatrixWorld\` is what makes \`getWorldDirection\` inside \`look()\` see it.
      c.lookAt(t[0], t[1], t[2]);
      c.updateMatrixWorld(true);
      const s = d.look();
      c.getWorldDirection(dir);
      rays++;
      const m = /at\\(([-0-9.]+), ([-0-9.]+), ([-0-9.]+)\\) d=([0-9.]+)/.exec(s);
      if (!m) continue;
      const hit = [+m[1], +m[2], +m[3]], hd = +m[4];
      // Stopped at the target itself, within tolerance: the sightline exists.
      if (Math.abs(hd - len) > 0.15) continue;
      const inRoom =
        hit[0] > ROOM.x0 && hit[0] < ROOM.x1 && hit[1] > ROOM.y0 && hit[1] < ROOM.y1 &&
        hit[2] > ROOM.z0 && hit[2] < ROOM.z1;
      const inWell = hit[0] > WELL.x0 && hit[0] < WELL.x1 && hit[2] > WELL.z0 && hit[2] < WELL.z1;
      if (!inRoom || inWell) continue;
      leaks.push({
        from: a, to: t, dir: [+dir.x.toFixed(2), +dir.y.toFixed(2), +dir.z.toFixed(2)],
        d: +hd.toFixed(2), hit: hit.map((v) => +v.toFixed(2)),
      });
    }
  }

  p.position.copy(keep.pos);
  p.facing.copy(keep.facing);
  c.position.copy(keep.pos);
  c.quaternion.setFromEuler(keep.facing);
  // One line per eye position: a pose with a sightline in it is the finding, and the rest is noise.
  const byEye = new Map();
  for (const l of leaks) {
    const k = l.from.join(',');
    if (!byEye.has(k)) byEye.set(k, l);
  }
  return JSON.stringify({
    poses: poses.length, targets: targets.length, rays, leaks: leaks.length,
    eyes: byEye.size, sample: [...byEye.values()].slice(0, 25),
  });
})()`;

const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
if (res.result?.exceptionDetails) {
  console.error('eval failed:', res.result.exceptionDetails.text, res.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
const o = JSON.parse(res.result.result.value);
console.log(`poses ${o.poses}  targets ${o.targets}  rays ${o.rays}  LEAKS ${o.leaks} from ${o.eyes} eye positions`);
for (const l of o.sample) {
  console.log(
    `  eye (${l.from.join(', ')}) sees (${l.to.join(', ')}) at (${l.hit.join(', ')}) d ${l.d}` +
      `  dir (${l.dir.join(', ')})`,
  );
}
ws.close();
