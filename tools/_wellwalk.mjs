/**
 * Walk the hidden flight with the controller's own `move()`, and report where the feet stop following the
 * floor.
 *
 * `_hidwalk.mjs` samples a line and asks the two predicates; that finds walls but not this. What it cannot
 * see is a walker who is *allowed* to move and yet cannot descend, because the refusal is in
 * `moveAxisVertical` and not in the horizontal test: a collider whose box reaches down to the storey's
 * floor line is skipped by `collidesAabb` (which compares its top against the eye) but not by
 * `collidesAabbAt` (which inflates the capsule by its radius), so a walker passing *under* it keeps the
 * height of the step they were on and the step down never comes. Feet against `groundYAt` is the only way
 * to see it.
 *
 * Usage: node tools/_wellwalk.mjs [portNeedle]
 *
 * Eye height, not feet: `position.y` is the eye, so 0.475 of tread reads as 2.175.
 */
const [NEEDLE = '5174'] = process.argv.slice(2);
const PORT = process.env.CDP_PORT ?? '9222';

/** name, start eye position, yaw, frames, posture. Forward is +1 along the facing, yaw pi/2 faces -x. */
const RUNS = [
  // Down the flight: the descent the head's collider must not refuse a step of, in all three postures.
  // It starts on tread 2, because the hidden door is shut and its own collider owns the treads above.
  ['down the flight, west', [17.9, 1.575 + 1.7, -0.46], Math.PI / 2, 300, {}],
  ['down the flight, west, running', [17.9, 1.575 + 1.7, -0.46], Math.PI / 2, 300, { run: true }],
  ['down the flight, west, crouched', [17.9, 1.575 + 1.1, -0.46], Math.PI / 2, 300, { crouch: true }],
  // Back up it, from the room's own floor just west of the flight's foot.
  ['up the flight, east', [16.2, 0.2 + 1.7, -0.46], -Math.PI / 2, 420, {}],
  // Off the last tread on its own, which is where a held walker was left hanging before.
  ['off the last tread, west', [16.6, 0.475 + 1.7, -0.46], Math.PI / 2, 120, {}],
  // Onto the head from the landing: the walk that has to be stopped, standing and crouched, because a
  // collider based above the crouched eye would let a crouched player walk out over the well.
  ['the landing, east into the head', [14.9, 2.4 + 1.7, 0.46], -Math.PI / 2, 240, {}],
  ['the landing, east, crouched', [14.9, 2.4 + 1.1, 0.46], -Math.PI / 2, 240, { crouch: true }],
  ['the landing, east, running', [14.9, 2.4 + 1.7, 0.46], -Math.PI / 2, 240, { run: true }],
];

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
  const d = window.__daayan, p = d.player;
  const eye = p.currentEyeHeight ? p.currentEyeHeight() : 1.7;
  const r = p.getRadius ? p.getRadius() : 0.35;
  const keep = { x: p.position.x, y: p.position.y, z: p.position.z, fy: p.facing.y, fx: p.facing.x };
  const box = (a) => [a.minX, a.maxX, a.minY, a.maxY, a.minZ, a.maxZ].map((v) => +v.toFixed(2));
  // The capsule overlap test the vertical move refuses a step with, so a held walker can name its holder.
  const overlapping = () =>
    p.aabbs.filter(
      (a) =>
        p.position.x + r > a.minX && p.position.x - r < a.maxX &&
        p.position.y + r > a.minY && p.position.y - r < a.maxY &&
        p.position.z + r > a.minZ && p.position.z - r < a.maxZ,
    );
  /** Every collider standing in the head's own plane, i.e. the run's box and any twin of it. */
  const head = p.aabbs
    .filter((a) => 16.21 > a.minX && 16.21 < a.maxX && -0.46 > a.minZ && -0.46 < a.maxZ)
    .map(box);
  const out = [];
  for (const [name, start, yaw, frames, posture] of ${JSON.stringify(RUNS)}) {
    // Posture first: setCrouch re-seats the standing height off the controller's own groundY, which
    // would overwrite the start pose if it ran after the position were set.
    p.setRun(posture.run === true);
    p.setCrouch(posture.crouch === true);
    p.position.set(start[0], start[1], start[2]);
    p.velocity.set(0, 0, 0);
    p.onGround = true;
    // The crouch changes the eye height, so a crouched run's start y is the crouched one — see RUNS.
    p.look(yaw, 0);
    const trace = [];
    let floatFrom = null, floatTo = null, maxFloat = 0, maxFloatGround = 0;
    const holders = new Map();
    for (let i = 0; i < frames; i++) {
      p.move(0, 1, 1 / 60);
      // Read the eye per frame, not once: a crouched run's eye is 1.1 and the difference is the whole
      // reading — a crouched walker held 0.6 m up would otherwise report as standing on the floor.
      const eyeNow = p.currentEyeHeight ? p.currentEyeHeight() : 1.7;
      const feet = p.position.y - eyeNow;
      const g = p.groundYAt(p.position.x, p.position.z);
      const float = feet - g;
      if (float > 0.03) {
        if (floatFrom === null) floatFrom = +p.position.x.toFixed(2);
        floatTo = +p.position.x.toFixed(2);
        if (float > maxFloat) {
          maxFloat = float;
          maxFloatGround = g;
        }
        if (p.onGround) {
          const key = JSON.stringify(overlapping().map(box));
          const rec = holders.get(key) ?? { key, frames: 0, x: [+p.position.x.toFixed(2), +p.position.x.toFixed(2)], feet: [+feet.toFixed(3), +feet.toFixed(3)] };
          rec.frames++;
          rec.x[1] = +p.position.x.toFixed(2);
          rec.feet[1] = +feet.toFixed(3);
          holders.set(key, rec);
        }
      }
      if (i % 20 === 0 || i === frames - 1) {
        trace.push([+p.position.x.toFixed(2), +feet.toFixed(3), +g.toFixed(3), p.onGround ? 1 : 0]);
      }
    }
    out.push({
      name, trace, floatFrom, floatTo, maxFloat: +maxFloat.toFixed(3), maxFloatGround: +maxFloatGround.toFixed(2),
      end: [+p.position.x.toFixed(2), +(p.position.y - (p.currentEyeHeight ? p.currentEyeHeight() : 1.7)).toFixed(3)],
      held: [...holders.values()],
    });
  }
  p.setRun(false);
  p.setCrouch(false);
  p.position.set(keep.x, keep.y, keep.z);
  p.velocity.set(0, 0, 0);
  p.look(keep.fy, keep.fx);
  return JSON.stringify({ eye: +eye.toFixed(2), radius: r, head, out });
})()`;

const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
if (res.result?.exceptionDetails) {
  console.error('eval failed:', res.result.exceptionDetails.text, res.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
const o = JSON.parse(res.result.result.value);
console.log(`eye ${o.eye}  radius ${o.radius}`);
console.log(`colliders crossing the head's own plane (x 16.21, well centre) — one per run standing there:`);
for (const h of o.head) console.log(`    [minX ${h[0]}, maxX ${h[1]}]  y ${h[2]}..${h[3]}  z ${h[4]}..${h[5]}`);
for (const r of o.out) {
  console.log(`\n${r.name}`);
  for (const [x, feet, g, on] of r.trace) {
    console.log(`    x ${String(x).padStart(6)}  feet ${String(feet).padStart(7)}  ground ${String(g).padStart(7)}  ${on ? 'onGround' : 'falling '}`);
  }
  console.log(
    `    end x ${r.end[0]} feet ${r.end[1]}   ` +
      (r.floatFrom === null
        ? 'feet followed the floor the whole way'
        : `largest feet-to-floor gap ${r.maxFloat} m between x ${r.floatFrom} and ${r.floatTo}` +
          ` (a step down, or a step down run at, reads here: the floor met afterwards is ${r.maxFloatGround})`),
  );
  for (const h of r.held) {
    console.log(`    held onGround from x ${h.x[0]} to ${h.x[1]} at feet ${h.feet[0]}..${h.feet[1]} over ${h.frames} frames by ${h.key}`);
  }
}
ws.close();
