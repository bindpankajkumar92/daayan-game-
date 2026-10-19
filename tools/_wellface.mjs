/**
 * Where does the head's drawn face actually begin and end? Eastward rays along a grid, one per z and one
 * per y, each reporting what the game's own `look()` hits and where.
 *
 * `_wellsight` says a stance sees into the well and `_wellwalk` says where a walker is stopped, and
 * neither can say *through what*. That gap matters here: the head meets the parapet at a corner, and a ray
 * that crosses the lip's line a few millimetres outside either box goes straight over the joint into the
 * flight. This prints that as a number instead of leaving it to be re-derived from `segmentBox`.
 *
 * Usage: node tools/_wellface.mjs [needle] [scanY] [scanStep] [z0] [z1]
 *
 * The second scan — y at a fixed z — walks the face's height, which is what says whether the head is
 * drawn down to the storey's floor line or stops short of it.
 */
const [NEEDLE = '5174', SCAN_Y = '3.5', SCAN_STEP = '0.05', Z0 = '-1.5', Z1 = '0.65'] = process.argv.slice(2);
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
  const d = window.__daayan, p = d.player;
  const keep = { x: p.position.x, y: p.position.y, z: p.position.z, fy: p.facing.y, fx: p.facing.x };
  const at = (k) => { const m = /at\\(([^)]*)\\)/.exec(k); return m ? m[1].split(',').map(Number) : null; };
  const name = (k) => (k.replace(/^chain=/, '').split(' at ')[0] || '').slice(0, 46);
  // Along +x: forward is -z rotated by yaw, so yaw -pi/2 faces +x and pitch 0 keeps the ray level.
  const row = (x0, y, z) => {
    p.position.set(x0, y, z);
    p.look(-Math.PI / 2, 0);
    const raw = String(d.look());
    const h = at(raw);
    return { y: +y.toFixed(2), z: +z.toFixed(2), hx: h ? +h[0].toFixed(3) : null, chain: name(raw) };
  };
  const scan = (label, points) => ({ label, rows: points.map(([y, z]) => row(15.2, y, z)) });
  const out = [];
  const zScan = [];
  const step = ${Number(SCAN_STEP)};
  for (let i = 0; i * step <= ${Number(Z1)} - ${Number(Z0)} + 1e-9; i++) zScan.push([${Number(SCAN_Y)}, ${Number(Z0)} + i * step]);
  out.push(scan('z-scan at y ' + ${Number(SCAN_Y)} + ', z ' + ${Number(Z0)} + '..' + ${Number(Z1)} + ' step ' + step, zScan));
  const yScan = [];
  for (let y = 2.3; y <= 4.3 + 1e-9; y += 0.1) yScan.push([y, -0.46]);
  out.push(scan('y-scan at z -0.46, the well centre', yScan));
  p.position.set(keep.x, keep.y, keep.z);
  p.look(keep.fy, keep.fx);
  return JSON.stringify({ from: 15.2, out });
})()`;

const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
if (res.result?.exceptionDetails) {
  console.error('eval failed:', res.result.exceptionDetails.text, res.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
const o = JSON.parse(res.result.result.value);
console.log(`eastward rays from x = ${o.from}. A fight-or-flight hit lands on the head's face at 16.11; beyond that the ray went past it.`);
for (const s of o.out) {
  console.log(`\n${s.label}`);
  for (const r of s.rows) {
    console.log(`   y ${String(r.y).padStart(4)}  z ${String(r.z).padStart(5)}  first hit x ${String(r.hx).padStart(6)}  ${r.chain}`);
  }
}
ws.close();
