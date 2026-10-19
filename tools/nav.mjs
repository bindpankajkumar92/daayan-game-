/** Navigate the headless browser to a URL. `node tools/nav.mjs <url>` */
const url = process.argv[2];
if (!url) { console.error('usage: node tools/nav.mjs <url>'); process.exit(2); }
const list = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  .find((t) => t.url.startsWith('http'));
if (!page) { console.error('no http page target'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pend = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); const e = pend.get(m.id); if (e) { pend.delete(m.id); e(m); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable');
await send('Page.navigate', { url });
console.log('navigated to', url);
ws.close();
