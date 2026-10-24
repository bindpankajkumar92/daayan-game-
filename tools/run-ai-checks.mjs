/**
 * Run every headless check in `tools/` against the real house data.
 *
 * Each check is bundled the same way and run under Node with `tools/dom-shim.ts` imported first, so
 * the AI's `window`/`document` assumptions are satisfied without a browser. The bundling settings
 * matter:
 *
 *   bundle + platform:node + format:esm
 *       The checks import from `src/` by path, so everything has to be linked into one file.
 *   alias '@' -> src
 *       Mirrors the tsconfig path alias the source itself uses.
 *   define 'import.meta.env'
 *       Vite replaces `import.meta.env` at build time; Node does not provide it, so a test that runs
 *       `daayanConfigFor` (which reads `import.meta.env.PROD` to force debug off in release builds)
 *       throws on `undefined.PROD` without this. DEV=true here means the checks exercise the same
 *       branch the dev server does.
 *
 * The build goes through esbuild's JS API rather than `npx esbuild`: on Windows, spawning the
 * `npx.cmd` shim from Node fails with `EINVAL` (Node refuses to exec a `.cmd` without a shell), which
 * presents as "did not build" for every suite. Calling `buildSync` skips the shim entirely and is
 * several times faster besides.
 *
 * Usage: node tools/run-ai-checks.mjs   (or: npm run check:ai)
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(here, '.tmp');
mkdirSync(out, { recursive: true });

const require = createRequire(import.meta.url);
const esbuild = require(join(root, 'node_modules', 'esbuild', 'lib', 'main.js'));

/** Every suite, in the order they should run: cheap structural checks before the full soak. */
const CHECKS = [
  ['nav', 'nav-check.ts'],
  ['perception', 'perception-check.ts'],
  ['patrol', 'patrol-check.ts'],
  // The bar itself, before the AI that reacts to it: every other noise suite is downstream of the
  // alert this one proves is actually emitted.
  ['noise-bar', 'noise-bar-check.ts'],
  // Then whether the bar can be *filled* at all, driving the real controller in a room the size the
  // game actually uses. `noise-bar` feeds `update()` a synthetic `isRunning`; this one makes the
  // controller produce that flag from real movement, which is the half that was wrong in play.
  ['small-room', 'small-room-check.ts'],
  ['ai-integration', 'ai-integration-check.ts'],
  ['recovery', 'recovery-check.ts'],
  // The consequence of a catch, and that a respawn leaves her able to hunt again: the two things the
  // `game:caught` wiring has to get right, in either direction.
  ['caught', 'caught-check.ts'],
  // The catch cutscene: the clip must bind to the shipped rig before its timing is worth testing.
  ['kill-clip', 'kill-clip-check.mjs'],
  ['kill', 'kill-check.ts'],
  // Scene-content regressions found in play: the ritual coffin must not auto-open, and its screen
  // must keep offering a way to close after it has been slid open.
  ['ritual-cleanup', 'ritual-cleanup-check.ts'],
  ['ritual-doors', 'ritual-doors-check.ts'],
  ['wall-props', 'wall-props-check.ts'],
  // The upper flat's imported shell takes the wall texture at install, before the scan has loaded;
  // this pins the in-place adoption that keeps those walls off the procedural canvas.
  ['upper-shell-walls', 'upper-shell-walls-check.ts'],
  // The hidden door's leaf must swing, not vanish, and the south cheek that swallowed it is gone.
  ['hidden-door', 'hidden-door-check.ts'],
  // Last: it is the slowest (several 90-240 s scripted sessions), and it is the suite that guards the
  // specific faults found in play rather than the spec's general properties.
  ['playtest', 'playtest-check.ts'],
];

let failed = 0;

for (const [name, file] of CHECKS) {
  const bundle = join(out, `${name}.mjs`);
  process.stdout.write(`\n${'='.repeat(64)}\n=== ${name}\n${'='.repeat(64)}\n`);

  try {
    esbuild.buildSync({
      entryPoints: [join(here, file)],
      bundle: true,
      platform: 'node',
      format: 'esm',
      alias: { '@': join(root, 'src') },
      // Keys must be a syntactically valid object literal, because esbuild parses this as JS source.
      define: { 'import.meta.env': '{"PROD":false,"DEV":true}' },
      outfile: bundle,
      logLevel: 'silent',
    });
  } catch (err) {
    console.log(`FAIL  ${name} did not build`);
    for (const e of err.errors ?? []) {
      const loc = e.location ? `${e.location.file}:${e.location.line}:${e.location.column}` : '';
      console.log(`      ${loc} ${e.text}`);
    }
    if (!err.errors?.length) console.log(`      ${String(err.message).slice(0, 400)}`);
    failed++;
    continue;
  }

  try {
    const outText = execFileSync(process.execPath, [bundle], { cwd: root, encoding: 'utf8' });
    process.stdout.write(outText);
  } catch (err) {
    // A non-zero exit means the check itself reported failures; its output is still worth showing.
    if (err.stdout) process.stdout.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
    failed++;
  }
}

console.log(`\n${failed === 0 ? 'ALL SUITES PASS' : `${failed} SUITE(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
