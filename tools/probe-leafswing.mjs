/**
 * Does the door LEAF (not the blocker) ever occupy the player's walking lane?
 *
 * Usage: node tools/probe-leafswing.mjs [portNeedle]
 *
 * Why: the blocker drops correctly and immediately — proved separately. Yet a walk that starts 3 s
 * after the press is blocked while one starting minutes later is clear. The only thing that differs
 * is the leaf: it is a rigid slab that pivots 100 deg through the doorway, and if its collider is
 * live during the swing (or settles across the lane) it will stop a step right at the threshold.
 * This samples the leaf's boxes frame by frame through the swing and asks whether any of them
 * overlaps the lane at z -0.46 with the player's radius of 0.35.
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

const expr = `(async () => {
  const g = window.__daayan, p = g.player;
  const wait = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const RADIUS = 0.35;
  // The lane the player walks: z around -0.46, radius 0.35, feet at 2.4.
  const inLane = (a) => a.maxZ > -0.46 - RADIUS && a.minZ < -0.46 + RADIUS && a.maxY > 2.42 && a.minY < 4.1 && a.maxX > 16.0 && a.minX < 19.8;
  const laneBoxes = () => (p.aabbs || []).filter(inLane).map((a) => ({
    x: [Number(a.minX.toFixed(3)), Number(a.maxX.toFixed(3))],
    y: [Number(a.minY.toFixed(3)), Number(a.maxY.toFixed(3))],
    z: [Number(a.minZ.toFixed(3)), Number(a.maxZ.toFixed(3))],
  }));
  p.warpTo(new (p.position.constructor)(19.6, 2.4 + p.currentEyeHeight(), -0.46), Math.PI / 2);
  await wait();
  const beforeSwing = laneBoxes();
  // Press to open.
  const b = document.getElementById('tc-btn-interact'), r = b.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
              pointerId: 1, pointerType: 'touch', isPrimary: true };
  b.dispatchEvent(new PointerEvent('pointerdown', o));
  b.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true }));
  b.dispatchEvent(new PointerEvent('pointerup', o));
  b.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true }));
  b.dispatchEvent(new MouseEvent('click', o));
  // Sample the lane through the whole swing (1.6 s) plus settle, at ~10 samples.
  const frames = [];
  for (let f = 0; f < 150; f++) {
    await new Promise((res) => requestAnimationFrame(res));
    if (f % 15 === 0) frames.push({ f, n: laneBoxes().length, boxes: laneBoxes() });
  }
  const afterSwing = laneBoxes();
  return JSON.stringify({ beforeSwing, afterSwing,
    swing: frames.map((x) => ({ f: x.f, inLane: x.n, boxes: x.boxes })) });
})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
if (r.result?.exceptionDetails) {
  console.error('eval failed:', r.result.exceptionDetails.text, r.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
const o = JSON.parse(r.result.result.value);
console.log('boxes overlapping the walking lane BEFORE the press:', o.beforeSwing.length);
for (const b of o.beforeSwing) console.log('  x', b.x, ' y', b.y, ' z', b.z);
console.log('\nthrough the swing:');
for (const s of o.swing) console.log(`  frame ${String(s.f).padStart(3)}: ${s.inLane} in lane`, JSON.stringify(s.boxes));
console.log('\nAFTER the swing:', o.afterSwing.length);
for (const b of o.afterSwing) console.log('  x', b.x, ' y', b.y, ' z', b.z);
ws.close();
