/**
 * Count the damaged-wall facing meshes in the live scene, grouped by the run they came from.
 *
 * Usage: node tools/probe-panels.mjs [substring] [portNeedle]
 *
 * Why: a facing is the same scan texture the room's plaster already resembles, so a screenshot cannot
 * settle whether the rows were placed — the change can be nearly invisible in a still. Counting the
 * meshes by name does settle it, and the names carry the room id, so a missing run is obvious.
 */
const [filter = 'up-hidden', NEEDLE = '5174'] = process.argv.slice(2);
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
  const g = window.__daayan;
  const scene = (g.engine && g.engine.scene) || g.scene;
  if (!scene || !scene.traverse) return JSON.stringify({ error: 'no scene' });
  const found = [];
  scene.traverse((o) => {
    if (!o.name) return;
    let n = o, tag = '';
    while (n) { if (n.name) tag = n.name + '/' + tag; n = n.parent; }
    if (tag.toLowerCase().includes(${JSON.stringify(filter.toLowerCase())}) && /wall/i.test(tag)) {
      const p = o.position;
      found.push({ name: tag.slice(0, 70),
        at: [Number(p.x.toFixed(2)), Number(p.y.toFixed(2)), Number(p.z.toFixed(2))] });
    }
  });
  // Deduplicate by name, since a clone shares its node names with its siblings.
  const byName = {};
  for (const f of found) byName[f.name] = (byName[f.name] || 0) + 1;
  return JSON.stringify({ matches: found.length, distinct: Object.keys(byName).length,
    sample: found.slice(0, 10), names: Object.keys(byName).slice(0, 10) });
})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
if (r.result?.exceptionDetails) {
  console.error('eval failed:', r.result.exceptionDetails.text, r.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
const o = JSON.parse(r.result.result.value);
if (o.error) {
  console.error(o.error);
  process.exit(1);
}
console.log(`nodes matching "${filter}" + wall: ${o.matches}  (${o.distinct} distinct names)`);
for (const n of o.names) console.log('   ', n);
console.log('\nfirst few with world positions:');
for (const f of o.sample) console.log(`   ${f.at.join(', ')}   ${f.name}`);
ws.close();
