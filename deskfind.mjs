/** Where the readable clues sit, straight out of the graph: they are the control, at reach 2.0. */
const PORT = process.argv[2] ?? '9222', WANT = process.argv[3] ?? '5178';
const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = l.find((t) => t.type === 'page' && t.url.includes(WANT) && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const send = (m, p) => new Promise((r) => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'threw'); return r.result?.result?.value; };
console.log(JSON.stringify(await ev(`(() => {
  const D = window.__daayan, V = D.engine.camera.position.constructor, out = [];
  D.engine.scene.traverse((o) => {
    if (!/lock|altar|panel|shelf|dial|breaker|symbol|gate/i.test(o.name)) return;
    const v = new V(); o.getWorldPosition(v);
    out.push(o.name + ' @ ' + [v.x, v.y, v.z].map((n) => +n.toFixed(2)).join(','));
  });
  return out.slice(0, 24);
})()`), null, 1));
ws.close();
