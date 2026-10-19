/**
 * Print the URL the game is actually being served on right now.
 *
 * Vite auto-increments when a port is taken, and this project has had half a dozen dead servers left
 * listening over a session, so "the app is on 5173" is not a fact — it is a guess that has been wrong
 * repeatedly. Guessing wrong costs a full debugging loop, because the failure looks like a code bug:
 * the page loads a stale build or a 502, and the screenshot shows old behaviour.
 *
 * So: probe the ports, and confirm it is *this* app by asking for a module it must contain.
 *
 *   node tools/liveurl.mjs          # prints the url, or exits 1
 */
const PORTS = [5174, 5173, 5175, 5176, 5177, 5178, 5179, 5180];

/**
 * Probe one candidate port once. Returns the base URL if it is this app and carries the current
 * geometry, else null.
 *
 * Both fetches must succeed *in the same attempt*: a half-live server (root up, module 404) is a
 * different build and must not be trusted.
 */
async function probe(p) {
  const base = `http://127.0.0.1:${p}/`;
  try {
    const r = await fetch(base, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    if (!(await r.text()).includes("Daayan's House")) return null;
    // Confirm the build carries the current geometry, not a stale bundle on a dead port.
    const m = await fetch(`${base}src/world/HouseRooms.ts`, { signal: AbortSignal.timeout(2500) });
    if (!m.ok) return null;
    if (!(await m.text()).includes('HID_STAIR_WELL')) return null;
    return base;
  } catch {
    return null;
  }
}

/**
 * Retry the whole sweep.
 *
 * The first version gave up after a single pass and exited 1 immediately. That sounds harmless and
 * is not: Vite takes several seconds to boot, so a probe fired just after a restart reports "no live
 * server" while the server is in fact coming up. The caller then either restarts a healthy server or
 * concludes the build is broken. A false negative here is *worse* than a slow success, because the
 * whole point of this tool is to stop the URL from being a guess.
 */
const ATTEMPTS = Number(process.env.LIVEURL_ATTEMPTS ?? 8);
const GAP_MS = Number(process.env.LIVEURL_GAP_MS ?? 1500);
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  for (const p of PORTS) {
    const base = await probe(p);
    if (base) {
      console.log(base);
      process.exit(0);
    }
  }
  if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, GAP_MS));
}

console.error(
  `no live Daayan dev server found on ${PORTS.join(', ')} after ${ATTEMPTS} attempts ` +
    `(${((ATTEMPTS * (GAP_MS + 2500)) / 1000).toFixed(0)}s budget). ` +
    'If Vite printed a URL, it is not answering HTTP — check the dev-server task output.',
);
process.exit(1);
