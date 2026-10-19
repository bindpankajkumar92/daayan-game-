/**
 * Start or stop the headless Chrome the live probes drive, on a port of its own.
 *
 *   node tools/_cdplive.mjs dev              start the dev server (vite.config pins 5174) if it is down
 *   node tools/_cdplive.mjs open  [url]      launch, wait for the page, print where it landed
 *   node tools/_cdplive.mjs close            shut that browser down over the protocol
 *   node tools/_cdplive.mjs pause            freeze the page — see the CPU note below
 *   node tools/_cdplive.mjs resume           unfreeze it, for the tool that runs next
 *   node tools/_cdplive.mjs stop             close the browser *and* the dev server: the whole session
 *
 * **A live page here is expensive, and idle is the worst case.** Headless has no vsync and no display to
 * pace a frame against, so `requestAnimationFrame` is called back as fast as the software rasterizer can
 * finish a frame — and with `--use-angle=swiftshader` every one of those frames is drawn on the CPU. A
 * page sitting on the menu with nobody touching it measured at 1089% of one core, about eleven cores of
 * a twelve-core box, for 12518 s of accumulated CPU before it was noticed. `pause` freezes the page
 * (`Page.setWebLifecycleState`), which stops the frame loop and every timer dead — the same page then
 * measures flat. So: `pause` when stepping away from a session, `resume` before a probe that needs the
 * game to tick, and `close` when the session is over.
 *
 * And when the task manager says a `--type=gpu-process` row is the hog, ending it is what does *not*
 * work: that process is a child, the browser process is watching for its exit and starts a replacement
 * immediately, so the row comes back a second later at the same load. `close` here asks the browser
 * itself to quit over the protocol — the whole tree goes, and the profile's own processes are the only
 * ones named in the ask, so the user's own browser is never touched.
 *
 * Why this exists: every other tool in this folder assumes a browser is already listening, and on a
 * Windows box the shell is the wrong place to start one — `Start-Process` under a non-interactive
 * profile reports success and then no Chrome appears at all, which reads exactly like a tool bug.
 * Node's own `spawn` detached has no such trouble, and the wait-for-page poll turns "did it come up?"
 * from a guess into a result.
 *
 * It also refuses to fight over the port, which is the specific way this loop used to break: a
 * headless Chrome left over from an earlier session holds 9222 for as long as it lives, so a second
 * `--remote-debugging-port=9222` browser starts *without* a debugging port and every probe then talks
 * to the stale instance's stale tabs. Hence 9223 by default, `DevToolsActivePort` written into the
 * profile as the proof of what was actually bound, and `close` here rather than a taskkill that would
 * take the player's own browser down with it.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [MODE = 'open', URL_ARG] = process.argv.slice(2);
const PORT = process.env.CDP_PORT ?? '9223';
const DEV_URL = process.env.DEV_URL ?? 'http://127.0.0.1:5174/';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Absolute, because a relative one is resolved against the *process* cwd, which is not always the
// directory PowerShell is sitting in — the profile then lands somewhere nobody looks.
const PROFILE = resolve(process.env.CDP_PROFILE ?? '.chromeprof-live');
const CHROME = process.env.CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PAGE_URL = URL_ARG ?? 'http://127.0.0.1:5174/';
const NEEDLE = process.env.CDP_MATCH ?? '5174';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pages = async () => {
  try {
    return (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === 'page');
  } catch {
    return [];
  }
};

if (MODE === 'dev') {
  // Vite directly, not `npm run dev`: npm on Windows is a .cmd, and Node refuses to spawn those without
  // a shell, which would put a `cmd.exe` between the tool and the server that outlives nothing.
  const log = openSync(resolve(ROOT, 'dev-5174.log'), 'a');
  const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  // Written down because `stop` needs it: vite has no shutdown endpoint, and the alternative is a shell
  // round-trip through tasklist to guess which `node.exe` is the server. Overwritten on every `dev`.
  writeFileSync(resolve(ROOT, '.vite-live.pid'), String(child.pid));
  console.log(`launched vite pid ${child.pid} — log ${ROOT}/dev-5174.log`);
  let up = false;
  for (let i = 0; i < 30 && !up; i++) {
    await sleep(1000);
    up = await fetch(DEV_URL).then(
      (r) => r.ok,
      () => false,
    );
  }
  console.log(up ? `${DEV_URL} answering` : `${DEV_URL} never answered — check the log`);
  process.exit(up ? 0 : 1);
}

/** Ask the browser holding the debug port to quit. False when nothing is listening. */
const closeBrowser = async () => {
  const v = await fetch(`http://127.0.0.1:${PORT}/json/version`).then(
    (r) => r.json(),
    () => null,
  );
  if (!v?.webSocketDebuggerUrl) return false;
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  await sleep(600);
  return true;
};

if (MODE === 'close') {
  console.log((await closeBrowser()) ? `asked the browser on ${PORT} to close` : `nothing listening on ${PORT}`);
  process.exit(0);
}

if (MODE === 'stop') {
  // Both halves of a session in one word, because the expensive half is the one nobody thinks about: the
  // browser is the CPU, and a probe session that is over but still open keeps drawing the house for hours.
  console.log((await closeBrowser()) ? `browser on ${PORT} asked to close` : `no browser on ${PORT}`);
  const pidFile = resolve(ROOT, '.vite-live.pid');
  if (!existsSync(pidFile)) {
    // The pid file only exists for a server this tool started. Rather than hunt for a stray one — which
    // would mean a WMI round-trip to tell one `node.exe` from another — say the command that does it.
    console.log(
      'no vite pid on file (server started outside this tool?). To stop it:\n' +
        `  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*vite*bin*vite.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId }`,
    );
    process.exit(0);
  }
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  try {
    process.kill(pid);
    console.log(`stopped vite pid ${pid}`);
  } catch (e) {
    console.log(`vite pid ${pid} was already gone (${e.code ?? e.message})`);
  }
  rmSync(pidFile, { force: true });
  process.exit(0);
}

if (MODE === 'pause' || MODE === 'resume') {
  // The page's *web socket*, not the browser's: lifecycle is per-page, and `/json/version` would have
  // frozen whichever tab Chrome liked. Waiters are keyed the way the probe tools key theirs.
  const target = (await pages())
    .filter((t) => t.webSocketDebuggerUrl)
    .find((t) => t.url.includes(NEEDLE));
  if (!target) {
    console.error(`no page matching ${NEEDLE} on ${PORT} — nothing to ${MODE}`);
    process.exit(1);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
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
  await send('Page.enable');
  const state = MODE === 'pause' ? 'frozen' : 'active';
  const got = await Promise.race([send('Page.setWebLifecycleState', { state }), sleep(4000).then(() => null)]);
  if (!got) console.error(`${MODE}: no answer in 4 s — the page may already be gone`);
  else if (got.error) console.error(`${MODE}: refused — ${got.error.message}`);
  else console.log(`page at ${target.url} is now ${state}`);
  ws.close();
  process.exit(0);
}

const portFile = `${PROFILE}/DevToolsActivePort`;
if (existsSync(portFile)) {
  console.error(`note: ${portFile} already exists — an instance may still be live on ${PORT}`);
}

// Chrome is silent about a launch that dies before it owns a window, so its stderr is kept; the log is
// the only place the reason (a bad flag, a profile held by another process) ever shows up.
const LOG = `${PROFILE}.log`;
mkdirSync(PROFILE, { recursive: true });
rmSync(LOG, { force: true });
const log = openSync(LOG, 'a');

const child = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--window-size=1600,900',
    '--no-first-run',
    '--no-default-browser-check',
    PAGE_URL,
  ],
  { detached: true, stdio: ['ignore', log, log] },
);
child.unref();
const closed = new Promise((r) => child.on('close', (code, signal) => r({ code, signal })));
console.log(`launched chrome pid ${child.pid} -> ${PAGE_URL}`);
console.log(`log: ${LOG}`);

let page = null;
for (let i = 0; i < 40 && !page; i++) {
  await sleep(1000);
  page = (await pages()).find((t) => t.url.includes(NEEDLE));
}
const open = (await pages()).map((t) => `${t.url}  [${t.title}]`);
if (!page) {
  const exit = await Promise.race([closed, sleep(1500).then(() => null)]);
  console.error(
    `no page matching ${NEEDLE} after 40 s — open: ${open.join(', ') || 'none'}` +
      (exit ? `; chrome exited code=${exit.code} signal=${exit.signal}` : '; chrome still running'),
  );
  console.error(`chrome log tail:\n${readFileSync(LOG, 'utf8').split('\n').slice(-15).join('\n')}`);
  process.exit(1);
}
console.log(`page ready: ${page.url}  [${page.title}]`);
console.log(`bound port (from the profile): ${existsSync(portFile) ? readFileSync(portFile, 'utf8').split('\n')[0] : 'none written'}`);
