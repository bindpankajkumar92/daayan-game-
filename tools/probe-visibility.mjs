/**
 * Is the page visible, and is requestAnimationFrame actually ticking?
 *
 * Usage: node tools/probe-visibility.mjs [portNeedle]
 *
 * Why this matters more than it looks: every pose in the other probes waits with
 * `requestAnimationFrame`, and Chrome throttles rAF to a near-stop for a tab that is not the
 * visible one. When that happens a "settle" wait returns almost immediately in game time while the
 * harness believes seconds have passed — so a probe can walk into a door leaf that has not finished
 * swinging and report the *game* as broken. Check the clock before trusting any timing-sensitive
 * probe result.
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

// Count rAF ticks over one second of wall time. Healthy is ~60; throttled is single digits or zero.
const expr = `(async () => {
  let ticks = 0, running = true;
  const bump = () => { if (running) { ticks++; requestAnimationFrame(bump); } };
  requestAnimationFrame(bump);
  await new Promise((r) => setTimeout(r, 1000));
  running = false;
  return JSON.stringify({ hidden: document.hidden, state: document.visibilityState, rafPerSecond: ticks });
})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
if (r.result?.exceptionDetails) {
  console.error('eval failed:', r.result.exceptionDetails.text, r.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
const o = JSON.parse(r.result.result.value);
console.log(o);
console.log(o.rafPerSecond >= 30 ? 'rAF healthy — timing-based probes are trustworthy.' : 'rAF THROTTLED — rAF-based settle waits are not measuring game time. Bring the tab to the front.');
ws.close();
