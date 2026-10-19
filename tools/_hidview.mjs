/**
 * What is on screen from one pose, named — a ray per cell of a 2D grid across the frame.
 *
 * A screenshot cannot say what it is a picture of, and "the wall on the right" is not a thing the code
 * has a name for. This fires the game's own `__daayan.look()` once per screen cell, aiming the camera
 * at that cell first, so every answer is a real surface the player is looking at from that stance.
 *
 * Usage:
 *   node tools/_hidview.mjs <needle> <x> <eyeY> <z> <hudYaw> <pitchRad> [cols=9] [rows=7]
 *
 * `eyeY` is the controller's own `position.y`, which is the EYE — the readout's `pos(...)` value, and
 * the one `lookshot.mjs` takes too. Feet are that minus the 1.7 eye height, so standing on the upper
 * storey is 4.10 and not 2.40; passing 2.40 puts the head inside the stairwell instead.
 *
 * Columns run -1 (left) .. +1 (right) of the frame, rows +1 (top) .. -1 (bottom). `hudYaw` is the
 * readout's own `yaw(...)` — `atan2(dir.x, dir.z)` — not the controller's `facing.y`, which is the same
 * angle minus pi. Getting that wrong points every ray at the opposite wall and reads as "nothing there".
 */
const [NEEDLE = '5174', X = '16.84', EYE_Y = '4.1', Z = '1.29', HY = '3.11', P = '0', COLS = '9', ROWS = '7'] =
  process.argv.slice(2);
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
  const d = window.__daayan, p = d.player, cam = d.engine.camera;
  const keep = { x: p.position.x, y: p.position.y, z: p.position.z, fy: p.facing.y, fx: p.facing.x };
  const eye = p.currentEyeHeight ? p.currentEyeHeight() : 1.7;
  const tanV = Math.tan((cam.fov * Math.PI) / 360);
  const tanH = tanV * cam.aspect;
  const baseYaw = ${Number(HY)} - Math.PI;
  const pitch0 = ${Number(P)};
  const COLS = ${Number(COLS)}, ROWS = ${Number(ROWS)};
  const out = [];
  for (let r = 0; r < ROWS; r++) {
    const fy = 1 - (2 * r) / (ROWS - 1);
    for (let c = 0; c < COLS; c++) {
      const fx = -1 + (2 * c) / (COLS - 1);
      const yaw = baseYaw + Math.atan(fx * tanH);
      const pitch = pitch0 + Math.atan(fy * tanV);
      p.position.set(${Number(X)}, ${Number(EYE_Y)}, ${Number(Z)});
      p.look(yaw, pitch);
      out.push({ c, r, fx: +fx.toFixed(2), fy: +fy.toFixed(2), s: d.look() });
    }
  }
  p.position.set(keep.x, keep.y, keep.z);
  p.look(keep.fy, keep.fx);
  return JSON.stringify({ fov: cam.fov, aspect: +cam.aspect.toFixed(3), eye, out });
})()`;

const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
if (res.result?.exceptionDetails) {
  console.error('eval failed:', res.result.exceptionDetails.text, res.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
const o = JSON.parse(res.result.result.value);
console.log(`fov ${o.fov}  aspect ${o.aspect}  eye ${o.eye}`);
const cell = (x) => {
  const m = /chain=([^ ]+(?: *< *[^ ]+)*) *at\\(([^)]*)\\) *d=([0-9.]+)/.exec(x);
  return m ? { chain: m[1], at: m[2], d: m[3] } : { chain: x.trim(), at: '', d: '' };
};
for (let r = 0; r < Number(ROWS); r++) {
  const row = o.out.filter((q) => q.r === r);
  console.log(`\n--- row ${r}  (fy ${row[0].fy}) ---`);
  for (const q of row) {
    const k = cell(q.s);
    console.log(`  fx ${String(q.fx).padStart(5)}  d ${String(k.d).padStart(5)}  at ${k.at.padEnd(22)}  ${k.chain}`);
  }
}
ws.close();