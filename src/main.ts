/**
 * Bootstrap: wire Engine + GameLoop + DebugOverlay + FPController + TouchControls + the house.
 */

import { Engine } from '@/core/Engine';
import { GameLoop } from '@/core/GameLoop';
import { DebugOverlay } from '@/core/DebugOverlay';
import { QualityManager } from '@/core/QualityManager';
import { globalBus } from '@/core/EventBus';
import { FPController } from '@/player/FPController';
import { TouchControls } from '@/player/TouchControls';
import { buildHouseScene } from '@/scenes/HouseScene';
import { Capacitor } from '@capacitor/core';
import { ScreenOrientation } from '@capacitor/screen-orientation';
import { StatusBar } from '@capacitor/status-bar';

function hideLoading(): void {
  const el = document.getElementById('loading');
  if (el) {
    el.classList.add('hidden');
    setTimeout(() => el.remove(), 500);
  }
}

/**
 * How long the boot will wait for the native window to reach its final shape.
 *
 * Neither of these calls may be allowed to stop the game from starting: both are round trips over the
 * Capacitor bridge, and a bridge that never answers would leave a permanently black screen. So the
 * wait below is raced against this deadline and the engine is built regardless of which side wins —
 * losing the race costs a resize, not a launch.
 */
const NATIVE_CHROME_TIMEOUT_MS = 1200;

/** Resolves when `p` settles or `ms` elapses, whichever comes first. Never rejects. */
function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    void p.then(done, done);
  });
}

/**
 * Lock to landscape and hide the system UI on native (Android) — no-op on web.
 *
 * This is awaited *before* the Engine exists, which is the whole reason it is a separate function.
 * The manifest's screenOrientation already stops the activity from ever being portrait, but hiding
 * the status bar still changes the viewport: the WebView came up 809x355 with the bar and ends at
 * 809x393 without it. A canvas measured before that happens is 38 px short, and the correction a
 * second or two later is exactly the "portrait then landscape" flash the player reported. Measuring
 * once, afterwards, costs a few frames of black at boot and removes the resize entirely.
 *
 * The two extra frames at the end are not superstition: StatusBar.hide() resolves when the *native*
 * call returns, and the new viewport only reaches the WebView on the layout pass after that.
 */
async function applyNativeChrome(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await ScreenOrientation.lock({ orientation: 'landscape' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[daayan] ScreenOrientation.lock failed (probably already landscape):', err);
  }
  try {
    await StatusBar.hide();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[daayan] StatusBar.hide failed:', err);
  }
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}

/**
 * Screen-space framing that costs no GPU time: a CSS vignette and a small crosshair.
 * A real post-processing vignette would mean a full-screen pass; a radial-gradient div
 * composites for free and reads the same at these intensities.
 *
 * The stops are not the obvious ones. A `radial-gradient(ellipse ...)` is sized to the farthest
 * *corner*, so on a 2.1:1 landscape frame the left and right mid-edges sit at 1/sqrt(2) = 71% of the
 * gradient, not at 100%: the first version's `0.35 at 78%` therefore put barely 0.28 of black down
 * each side, over walls a lantern already leaves dark, and read as no vignette at all even though
 * removing the element visibly lightened the edges. Pulling the clear centre in to 30% and steepening
 * the tail is what makes it land — the mid-edges now sit between the 0.30 and 0.62 stops, about 0.42,
 * and the corners reach 0.94, while the middle third of the screen is still untouched.
 *
 * It can be this strong because of the stacking order and only because of it: #hud (7500), the
 * joystick and buttons (#touch-controls, 8000) and every overlay (9000) paint above 7000, so none of
 * the text or controls the player needs is dimmed by any of this.
 */
function addScreenFraming(): void {
  const vignette = document.createElement('div');
  vignette.id = 'vignette';
  vignette.style.cssText = `
    position: fixed; inset: 0; pointer-events: none; z-index: 7000;
    background: radial-gradient(ellipse at center,
      rgba(0,0,0,0) 30%, rgba(0,0,0,0.10) 48%, rgba(0,0,0,0.30) 64%,
      rgba(0,0,0,0.62) 82%, rgba(0,0,0,0.94) 100%);
  `;
  document.body.appendChild(vignette);

  const dot = document.createElement('div');
  dot.id = 'crosshair';
  dot.style.cssText = `
    position: fixed; left: 50%; top: 50%; width: 5px; height: 5px;
    margin: -2.5px 0 0 -2.5px; border-radius: 50%;
    background: rgba(255,255,255,0.55); box-shadow: 0 0 3px rgba(0,0,0,0.9);
    pointer-events: none; z-index: 7001;
  `;
  document.body.appendChild(dot);
}

/**
 * A visible error line, deduped by message.
 *
 * The loop absorbs exceptions so the game stays playable, but silently absorbing them just moves
 * the mystery: a player whose world half-works can only report "it stopped". One line on screen
 * turns that into something readable off a photo of the phone.
 */
function makeErrorSink(): (err: unknown, where: string) => void {
  const seen = new Set<string>();
  let box: HTMLDivElement | null = null;

  return (err, where) => {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const line = `[${where}] ${msg}`;
    if (seen.has(line)) return;
    seen.add(line);
    // eslint-disable-next-line no-console
    console.error('[daayan]', line, err instanceof Error ? err.stack : '');

    if (!box) {
      box = document.createElement('div');
      box.id = 'error-log';
      box.style.cssText = `
        position: fixed; left: 8px; bottom: 8px; max-width: 46vw; z-index: 7600;
        pointer-events: none; padding: 5px 8px; border-radius: 4px;
        background: rgba(60,8,8,0.82); border: 1px solid rgba(255,120,120,0.5);
        font: 500 10px/1.35 ui-monospace, monospace; color: #ffd6d6;
        white-space: pre-wrap; word-break: break-word;
      `;
      document.body.appendChild(box);
    }
    const row = document.createElement('div');
    row.textContent = line;
    box.appendChild(row);
    while (box.childElementCount > 4) box.firstElementChild?.remove();
  };
}

async function main(): Promise<void> {
  const container = document.getElementById('app');
  if (!container) throw new Error('Missing #app container');

  const reportError = makeErrorSink();
  // Registered before anything else can throw.
  window.addEventListener('error', (e) => reportError(e.error ?? e.message, 'window'));
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason, 'promise'));

  // Settle the native window first, so the renderer is sized once and correctly. See
  // applyNativeChrome; the #loading card stays up for the handful of frames this takes.
  await withTimeout(applyNativeChrome(), NATIVE_CHROME_TIMEOUT_MS);

  const engine = new Engine(container);
  const debug = new DebugOverlay(engine.renderer);
  const quality = new QualityManager();

  // Resolution is owned by the Engine; QualityManager only decides the multiplier.
  quality.setScaleSink((scale) => engine.setResolutionScale(scale));

  // Player + input
  const player = new FPController(engine);
  const touch = new TouchControls(player, debug);
  touch.setOnToggleDebug(() => {
    debug.setVisible(!debug.isVisible());
    globalBus.emit('debug:toggle', undefined as never);
  });

  addScreenFraming();

  // The house
  const scene = buildHouseScene(engine.scene, player, touch, engine, reportError);
  debug.setQualityTier(quality.getSettings().tier);
  debug.setRenderScale(quality.getRenderScale());

  // Phase 0 on-device gate: show the debug overlay by default so the user can
  // read FPS / draws / tris / scale without having to find a corner to tap.
  debug.setVisible(true);

  // Wire quality tier changes back to debug overlay.
  globalBus.on('quality:change', ({ tier }) => debug.setQualityTier(tier));
  globalBus.on('resolution:change', ({ scale }) => debug.setRenderScale(scale));

  // Main loop
  const loop = new GameLoop({
    onStep: (dt) => {
      // While a note, keypad or panel is open the player stands still — and the look delta is
      // *consumed and dropped*, not left to accumulate, or closing the overlay snaps the camera
      // through however far the thumb travelled across the paper. Movement still ticks with a zero
      // input so gravity and damping keep running and the player settles instead of hanging.
      if (scene.overlayOpen()) {
        player.setRun(false);
        player.setCrouch(false);
        player.move(0, 0, dt);
        touch.consumeLookDelta();
      } else {
        const m = touch.getMove();
        player.setRun(m.run);
        player.setCrouch(m.crouch);
        player.move(m.strafe, m.forward, dt);
        const d = touch.consumeLookDelta();
        if (d.yaw !== 0 || d.pitch !== 0) player.addLookDelta(d.yaw, d.pitch);
      }
      scene.update(dt);
    },
    onRender: (_alpha) => {
      const dt = engine.beginFrame();
      quality.update(dt);
      debug.setRenderScale(quality.getRenderScale());
      engine.renderer.info.reset();
      engine.endFrame();
      // Stats: after render so counts are populated.
      debug.setStats(engine.renderer.info.render.calls, engine.renderer.info.render.triangles);
      debug.recordFrame(dt * 1000);
    },
    onError: reportError,
  });

  // Signal ready
  globalBus.emit('engine:ready', undefined as never);
  hideLoading();
  loop.start();

  // Expose handles on window for the on-device perf gate to inspect.
  (window as unknown as { __daayan: unknown }).__daayan = {
    engine,
    debug,
    quality,
    player,
    touch,
    loop,
    scene,
  };
}

// main() is async now (it waits for the native window), so a bootstrap failure would surface as an
// unhandled rejection with nothing on screen. Route it through the same red box everything else uses.
void main().catch((err) => makeErrorSink()(err, 'bootstrap'));
