/**
 * Press a touch control on the live page, or evaluate an expression in it.
 *
 *   node tools/act.mjs --begin                  start the game
 *   node tools/act.mjs --evaluate <expr>        run JS in the page
 *   node tools/act.mjs <css-selector>           press that control
 *
 * Why this exists: a plain `.click()` does not fire the touch controls and neither does a bare
 * `pointerdown`. The handlers listen for a full touch sequence, so `fire()` below sends all five in
 * order — which is what a finger actually produces. Without this, `#tc-btn-interact` silently does
 * nothing and the door never opens, while every screenshot still looks plausible.
 *
 * The target is picked by port, not by index. `pages[0]` is a coin flip: Chrome keeps a `chrome://newtab`
 * target around and whichever sorts first changes, so an index-based tool sometimes drives the wrong page,
 * which looks exactly like a bug in the game.
 */
const argv = process.argv.slice(2);

const PORT = process.env.CDP_PORT ?? '9222';
const NEEDLE = process.env.CDP_MATCH ?? '5174';

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list
  .filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  .find((t) => t.url.includes(NEEDLE));
if (!page) {
  const open = list.filter((t) => t.type === 'page').map((t) => t.url);
  console.error(`no page matching ${NEEDLE} — open: ${open.join(', ') || 'none'}`);
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
const send = (method, params) =>
  new Promise((res) => {
    const n = ++id;
    pend.set(n, res);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const ev = async (expression) => {
  const out = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (out.result?.exceptionDetails) throw new Error(out.result.exceptionDetails.text + ' :: ' + (out.result.exceptionDetails.exception?.description ?? ''));
  return out.result?.result?.value;
};

const FIRE = `
  const fire = (el) => {
    const opts = { bubbles: true, cancelable: true, composed: true };
    for (const t of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click']) {
      const e = t.startsWith('touch') ? new TouchEvent(t, opts)
        : new PointerEvent(t, { ...opts, isPrimary: true, pointerType: 'touch' });
      el.dispatchEvent(e);
    }
    return true;
  };
`;

if (argv[0] === '--evaluate') {
  console.log(await ev(argv.slice(1).join(' ')));
} else if (argv[0] === '--begin') {
  console.log(
    await ev(`(() => { ${FIRE}
      const b = [...document.querySelectorAll('button')].find((x) => /BEGIN/i.test(x.textContent || ''));
      if (!b) return 'no BEGIN button';
      fire(b);
      return 'fired BEGIN';
    })()`),
  );
} else if (argv[0]) {
  const sel = JSON.stringify(argv[0]);
  console.log(
    await ev(`(() => { ${FIRE}
      const el = document.querySelector(${sel});
      if (!el) return 'no element for ' + ${sel};
      fire(el);
      return 'fired ' + ${sel};
    })()`),
  );
} else {
  console.error('usage: node tools/act.mjs --begin | --evaluate <expr> | <css-selector>');
  process.exit(2);
}

ws.close();
