/**
 * Probe `groundYAt` at named points and print a table.
 *
 * Why a file and not `act.mjs --evaluate '<expr>'`: `act.mjs` rejoins argv with single spaces, so any
 * expression containing quoted strings with spaces gets mangled into a syntax error. Compound probes
 * belong in a file.
 *
 * Usage: node tools/probe-floor.mjs [port]      (default 5174)
 *
 * The feet are seeded at the height under test before each probe. That matters: `groundYAt` falls
 * through to `bestAny` (the highest floor below the feet) when nothing is within step-up range, so a
 * probe fired from an unrelated pose returns a plausible number that means nothing.
 */
const PORT = process.env.CDP_PORT ?? '9222';
const NEEDLE = process.argv[2] ?? '5174';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list
  .filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  .find((t) => t.url.includes(NEEDLE));
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
  const fc = window.__daayan.player;
  const eh = fc.currentEyeHeight();
  const probe = (name, x, z, y) => {
    fc.position.set(x, y + eh, z);
    const g = fc.groundYAt(x, z);
    return { name, x, z, asked: y, got: Math.round(g * 1000) / 1000 };
  };
  const rows = [
    probe('in front of door', 18.9, -0.46, 2.4),
    probe('door threshold', 18.61, -0.46, 2.4),
    probe('east of door', 19.6, -0.46, 2.4),
    probe('north of well', 18.9, 1.6, 2.4),
    probe('south of well', 18.9, -1.7, 2.4),
    probe('entry room mid', 21.5, 2.0, 2.4),
    probe('far corner', 23.5, 7.0, 2.4),
    probe('stairwell 1', 18.5, -0.46, 2.4),
    probe('stairwell 2', 18.2, -0.46, 1.8),
    probe('stairwell 3', 17.6, -0.46, 1.5),
    probe('room below', 17.0, -3.0, 0.2),
    probe('room below 2', 16.0, -5.5, 0.2)
  ];
  return JSON.stringify(rows);
})()`;

const out = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
if (out.result?.exceptionDetails) {
  console.error('eval failed:', out.result.exceptionDetails.text, out.result.exceptionDetails.exception?.description ?? '');
  process.exit(1);
}
const rows = JSON.parse(out.result.result.value);

const W = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) {
  const mark = Math.abs(r.got - r.asked) < 0.001 ? 'on-floor ' : 'DIFFERS  ';
  console.log(
    `${r.name.padEnd(W)}  (${String(r.x).padStart(6)}, ${String(r.z).padStart(6)})  ` +
      `asked ${r.asked.toFixed(2)}  got ${r.got.toFixed(3)}  ${mark}`,
  );
}
ws.close();
