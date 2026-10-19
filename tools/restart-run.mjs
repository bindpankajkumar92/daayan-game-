/**
 * Reload the page, wait for the title screen's BEGIN button to actually exist, click it, and wait
 * for the game loop to take over.
 *
 * Usage: node tools/restart-run.mjs [portNeedle] [maxSeconds]
 *
 * Why a tool rather than a `sleep`: a fixed wait is either too short (the menu has not rendered, the
 * press is lost, and every later probe reports "nothing is interactive") or needlessly long. The
 * menu's appearance depends on asset warm-up, so it is polled, and the click is retried until the
 * scene reports itself live — which is `__daayan.player` existing with a non-zero ground height.
 */
const [NEEDLE = '5174', MAX_S = '60'] = process.argv.slice(2);
const PORT = process.env.CDP_PORT ?? '9222';
const deadline = Date.now() + Number(MAX_S) * 1000;

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
const evalJs = async (expression, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Page.enable');
await send('Page.reload', { ignoreCache: true });

// Poll to the title screen.
let beginSeen = false;
while (Date.now() < deadline) {
  await sleep(1000);
  const state = await evalJs(`(() => {
    const b = [...document.querySelectorAll('.menu-primary')].find((x) => x.textContent.trim() === 'BEGIN');
    const hasPlayer = !!window.__daayan?.player;
    return JSON.stringify({ btn: !!b && b.getBoundingClientRect().width > 0, hasPlayer });
  })()`);
  if (!state) continue;
  const s = JSON.parse(state);
  if (s.btn) {
    beginSeen = true;
    break;
  }
}

if (!beginSeen) {
  console.error('BEGIN never appeared within the budget');
  ws.close();
  process.exit(1);
}

// Click, then wait for the loop to actually be running the scene.
while (Date.now() < deadline) {
  await evalJs(`(() => { const b = [...document.querySelectorAll('.menu-primary')].find((x) => x.textContent.trim() === 'BEGIN'); if (b) b.click(); return 'ok'; })()`);
  await sleep(1500);
  const live = await evalJs(`(() => {
    const g = window.__daayan;
    const menuGone = ![...document.querySelectorAll('.menu-primary')].some((x) => x.textContent.trim() === 'BEGIN' && x.getBoundingClientRect().width > 0);
    return JSON.stringify({ menuGone, hasPlayer: !!g?.player, interactCount: g?.interactables ? g.interactables().count : 0 });
  })()`);
  if (!live) continue;
  const l = JSON.parse(live);
  if (l.menuGone && l.interactCount > 0) {
    console.log(`run live — ${l.interactCount} interactables`);
    ws.close();
    process.exit(0);
  }
}

console.error('scene never reported live');
ws.close();
process.exit(1);
