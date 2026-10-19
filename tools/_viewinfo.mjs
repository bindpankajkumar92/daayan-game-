/**
 * Throwaway: the render size and image size a shot came back at, so a pixel outline on a screenshot can
 * be turned into a screen coordinate.
 *
 *   node tools/_viewinfo.mjs [needle]
 */
const [NEEDLE = '5174'] = process.argv.slice(2);
const PORT = process.env.CDP_PORT ?? '9222';
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl).find((t) => t.url.includes(NEEDLE));
if (!page) {
  console.error('no page');
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
const r = await send('Runtime.evaluate', {
  expression: `(() => {
    const d = window.__daayan;
    const size = d.engine.renderer.getSize(new (d.engine.camera.position.constructor)());
    return JSON.stringify({
      inner: [window.innerWidth, window.innerHeight],
      dpr: window.devicePixelRatio,
      drawingBuffer: [d.engine.renderer.getContext().drawingBufferWidth, d.engine.renderer.getContext().drawingBufferHeight],
      drawingBufferSize: [size.x, size.y],
      aspect: +d.engine.camera.aspect.toFixed(4),
      fov: d.engine.camera.fov,
      resolutionScale: d.engine.resolutionScale,
    });
  })()`,
  returnByValue: true,
});
console.log(r.result?.result?.value ?? JSON.stringify(r.result));
ws.close();