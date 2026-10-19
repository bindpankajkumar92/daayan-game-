/**
 * How long after the door press does the blocker box actually drop? Sample it every frame.
 *
 * Usage: node tools/probe-doortiming.mjs [portNeedle]
 *
 * Why: the chain probe walks 3 s after the press and was still blocked once, but walked fine on a
 * run where the door had been opened minutes earlier. That points at the blocker dropping on a
 * tween tick, not on the press. This measures it instead of guessing: press, then read the blocker's
 * minY every frame for a second and report the frame it went negative.
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
  // Match every box in the doorway column and pick the one whose *bottom* is at the upper floor
  // (minY ~ 2.4). The header lintel sits at y 4.45..5.29 and matches a laxer test, and Array.find
  // would return that one first — which is how a working door reads as a door that never opens.
  const findBlocker = () => (p.aabbs || []).find((a) =>
    Math.abs(a.minX - 18.47) < 0.05 && Math.abs(a.maxX - 18.75) < 0.05 && a.maxZ > 0 && a.minY < 2.5);
  const allInColumn = () => (p.aabbs || []).filter((a) =>
    Math.abs(a.minX - 18.47) < 0.05 && Math.abs(a.maxX - 18.75) < 0.05 && a.maxZ > 0);
  p.warpTo(new (p.position.constructor)(19.6, 2.4 + p.currentEyeHeight(), -0.46), Math.PI / 2);
  await wait();
  const before = findBlocker();
  const near = g.interactables().nearest;
  // Press.
  const b = document.getElementById('tc-btn-interact'), r = b.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
              pointerId: 1, pointerType: 'touch', isPrimary: true };
  b.dispatchEvent(new PointerEvent('pointerdown', o));
  b.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true }));
  b.dispatchEvent(new PointerEvent('pointerup', o));
  b.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true }));
  b.dispatchEvent(new MouseEvent('click', o));
  // Sample the blocker every frame for ~1.5 s.
  const samples = [];
  for (let f = 0; f < 90; f++) {
    await new Promise((res) => requestAnimationFrame(res));
    const blk = findBlocker();
    samples.push(blk ? Number(blk.minY.toFixed(3)) : 'gone');
  }
  // First frame it went below the world.
  const dropFrame = samples.findIndex((v) => v === 'gone' || (typeof v === 'number' && v < 0));
  return JSON.stringify({
    promptBefore: near ? near.label : null,
    beforeMinY: before ? Number(before.minY.toFixed(3)) : 'gone',
    dropFrame, dropSeconds: Number((dropFrame / 60).toFixed(3)),
    candidatesBefore: allInColumn().map((a) => ({
      y: [Number(a.minY.toFixed(3)), Number(a.maxY.toFixed(3))],
      z: [Number(a.minZ.toFixed(3)), Number(a.maxZ.toFixed(3))],
    })),
    samples: samples.slice(0, 12),
  });
})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
if (r.result?.exceptionDetails) {
  console.error('eval failed:', r.result.exceptionDetails.text, r.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
console.log(r.result.result.value);
ws.close();
