/**
 * Which way does `player.facing.y = <yaw>` actually point?
 *
 * Placement work keeps needing this and keeps guessing it: `lookshot` takes a yaw in radians of
 * `facing._y`, and a shot that comes back facing the wrong wall says nothing about the thing being
 * looked at. This prints the camera's own forward vector for a few yaws — the camera, not a
 * hand-rolled trig table, because the point is to read back what the game does.
 *
 * Usage: node tools/_yawdir.mjs [portNeedle]
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
  const keep = p.facing.clone();
  const out = [];
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    p.facing.set(0, yaw, 0);
    c.quaternion.setFromEuler(p.facing);
    const v = new V(0, 0, -1).applyQuaternion(c.quaternion);
    out.push({ yaw: Number(yaw.toFixed(3)), fwd: [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)] });
  }
  p.facing.copy(keep);
  c.quaternion.setFromEuler(p.facing);
  return JSON.stringify(out);
})()`;

const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
if (res.result?.exceptionDetails) {
  console.error('eval failed:', res.result.exceptionDetails.text);
  process.exit(1);
}
for (const r of JSON.parse(res.result.result.value)) {
  console.log(`yaw ${String(r.yaw).padStart(7)}  forward (x ${r.fwd[0]}, y ${r.fwd[1]}, z ${r.fwd[2]})`);
}
ws.close();
