/**
 * Walk the controller along a path in small steps and report where it stops moving.
 *
 * Usage: node tools/probe-walk.mjs <x0> <z0> <x1> <z1> <y> <steps> [portNeedle]
 *
 * Why: `groundYAt` says what the floor *is*; it does not say whether the player can actually get
 * from A to B. "Stuck" is almost always a collider, and a collider stops a *step*, not a query —
 * so this drives the controller's own move path one small increment at a time and reports the last
 * point that advanced. That point is the wall.
 *
 * `y` is the floor height to start on; the controller re-seats itself as it goes.
 */
const [x0, z0, x1, z1, yStart, steps, NEEDLE = '5174'] = process.argv.slice(2);
if (NEEDLE === undefined || steps === undefined) {
  console.error('usage: node tools/probe-walk.mjs <x0> <z0> <x1> <z1> <y> <steps> [portNeedle]');
  process.exit(2);
}
const PORT = process.env.CDP_PORT ?? '9222';
/** Per-increment travel. Under the player radius so no step can tunnel through a thin collider. */
const STEP = 0.06;

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
  const Y0 = ${Number(yStart)};
  const N = ${Number(steps)};
  const dx = (X1 - X0) / N, dz = (Z1 - Z0) / N;
  p.warpTo(new (p.position.constructor)(X0, Y0 + eye, Z0), 0);
  p.onGround = true;
  const trace = [];
  let stuckAt = null;
  let prevX = X0, prevZ = Z0;
  for (let i = 1; i <= N; i++) {
    const tx = X0 + dx * i, tz = Z0 + dz * i;
    // Step toward the target by a fixed increment, so a thin collider cannot be tunnelled.
    const len = Math.hypot(tx - p.position.x, tz - p.position.z) || 1;
    const ux = (tx - p.position.x) / len, uz = (tz - p.position.z) / len;
    const adv = Math.min(${STEP}, len);
    // move(strafe, forward, dt) is FACING-relative AND speed-scaled: the inputs are a direction of
    // magnitude <= 1, and the controller multiplies by walkSpeed and by dt. So to travel a fixed
    // world increment, divide by (speed * dt) — passing the increment directly moves ~0.002 m and
    // reads as "instantly stuck".
    const sinY = Math.sin(p.facing.y), cosY = Math.cos(p.facing.y);
    const strafe = ux * cosY - uz * sinY;
    const forward = -ux * sinY - uz * cosY;
    const DT = 1 / 60;
    const speed = p.opts.walkSpeed;
    const mag = adv / (speed * DT);
    p.move(strafe * mag, forward * mag, DT);
    const moved = Math.hypot(p.position.x - prevX, p.position.z - prevZ);
    prevX = p.position.x; prevZ = p.position.z;
    trace.push([Number(p.position.x.toFixed(3)), Number(p.position.y.toFixed(3)), Number(p.position.z.toFixed(3)), Number(moved.toFixed(4))]);
    if (moved < 0.002 && stuckAt === null) stuckAt = [Number(p.position.x.toFixed(3)), Number(p.position.z.toFixed(3)), Number(p.position.y.toFixed(3))];
  }
  return JSON.stringify({ eye, final: [p.position.x, p.position.y, p.position.z].map((n) => Number(n.toFixed(3))), stuckAt, trace: trace.slice(0, 16) });
})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
if (r.result?.exceptionDetails) {
  console.error('eval failed:', r.result.exceptionDetails.text, r.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
const o = JSON.parse(r.result.result.value);
console.log('eye:', o.eye, ' final:', o.final);
console.log('first point that stopped advancing:', o.stuckAt ?? 'none — the whole path was walkable');
console.log('last steps (x, y, z, moved):');
for (const t of o.trace) console.log('  ', t.join('  '));
ws.close();
