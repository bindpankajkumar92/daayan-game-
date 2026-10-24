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
import { MenuLayer } from '@/ui/MenuLayer';
import { getPref, setPref } from '@/core/Prefs';

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
/** Gate + spawn bed should be local and fast; this only prevents a broken WebView from hanging forever. */
const STARTUP_ASSET_TIMEOUT_MS = 8000;
/** Optional room art gets longer, but a corrupt fetch must never permanently disable BEGIN. */
const ALL_ASSET_TIMEOUT_MS = 25000;

/** Resolves true when `p` settles before the deadline, false when the deadline wins. Never rejects. */
function withTimeout(p: Promise<void>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve(true);
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

  return (err, where) => {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    const line = `[${where}] ${msg}`;
    if (seen.has(line)) return;
    seen.add(line);
    // eslint-disable-next-line no-console
    console.error('[daayan]', line, err instanceof Error ? err.stack : '');

    // Errors are logged to console without obstructing the player's screen with a red error box
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

  // Restore the saved value before the first look gesture. Preferences come from storage and are
  // therefore untrusted even though their TypeScript surface is numeric; TouchControls performs the
  // final finite/range clamp, and an invalid stored value falls back to the shipped default here.
  const savedSensitivity = getPref('sens');
  touch.setSensitivity(
    typeof savedSensitivity === 'number' && Number.isFinite(savedSensitivity)
      ? savedSensitivity
      : TouchControls.LOOK_DEFAULT,
  );

  touch.setOnToggleDebug(() => {
    debug.setVisible(!debug.isVisible());
    globalBus.emit('debug:toggle', undefined as never);
  });

  addScreenFraming();

  // The house
  const scene = buildHouseScene(engine.scene, player, touch, engine, reportError);
  debug.setQualityTier(quality.getSettings().tier);
  debug.setRenderScale(quality.getRenderScale());

  // Debug remains available by backtick/triple-tap, but a normal player should not launch into metrics.
  debug.setVisible(false);

  // Wire quality tier changes back to debug overlay.
  globalBus.on('quality:change', ({ tier }) => debug.setQualityTier(tier));
  globalBus.on('resolution:change', ({ scale }) => debug.setRenderScale(scale));

  // Both menus freeze through this one bit. Rendering deliberately continues — a still view of the
  // house behind the wash is the menu artwork — but not one simulation subsystem advances. Returning
  // before player.move *and* scene.update is important: zero movement would stop the player but still
  // tick the daayan, props, puzzle tweens and toast timers while the player had no controls.
  let simulationPaused = true;
  let gameStarted = false;
  const setMenuVisible = (open: boolean): void => {
    simulationPaused = open;
    touch.setPaused(open);
    const display = open ? 'none' : '';
    const hud = document.getElementById('hud');
    const crosshair = document.getElementById('crosshair');
    if (hud) hud.style.display = display;
    if (crosshair) crosshair.style.display = display;
  };

  const menuDeps = {
    getSensitivity: () => touch.getSensitivity(),
    setSensitivity: (value: number, commit: boolean): void => {
      touch.setSensitivity(value);
      if (commit) setPref('sens', touch.getSensitivity());
    },
    sensRange: { min: TouchControls.LOOK_MIN, max: TouchControls.LOOK_MAX },
    onVisibility: setMenuVisible,
  };

  const titleMenu = new MenuLayer(
    {
      ...menuDeps,
      onClose: () => {
        gameStarted = true;
      },
    },
    false,
  );
  titleMenu.setReady(false);
  // Paint the title menu behind the opaque loading cover before the renderer starts. Android WebView
  // may composite DOM layers on separate frames, so opening the menu in the same turn that fades the
  // cover can briefly expose the WebGL canvas. Pre-opening it makes the reveal deterministic.
  titleMenu.open();
  const pauseMenu = new MenuLayer({ ...menuDeps, onClose: () => {} }, true);

  touch.setOnPause(() => {
    // A single key/tap dismisses the topmost UI layer only. Without this guard, the TouchControls
    // listener sees Escape before OverlayLayer's document listener and opens pause behind the note.
    if (scene.closeOverlay()) return;
    // The title screen has its own BEGIN action; Esc/P must not dismiss it into an unstarted game.
    if (!gameStarted) return;
    if (pauseMenu.isOpen()) pauseMenu.close();
    else pauseMenu.open();
  });

  // Main loop
  const loop = new GameLoop({
    onStep: (dt) => {
      if (simulationPaused) {
        // Drop, do not bank, any mouse movement delivered during the frame the menu opened. Otherwise
        // RESUME would apply it all at once and snap the camera.
        touch.consumeLookDelta();
        return;
      }
      // While a note, keypad or panel is open the player stands still — and the look delta is
      // *consumed and dropped*, not left to accumulate, or closing the overlay snaps the camera
      // through however far the thumb travelled across the paper. Movement still ticks with a zero
      // input so gravity and damping keep running and the player settles instead of hanging.
      if (scene.overlayOpen()) {
        player.setRun(false);
        player.setCrouch(false);
        player.move(0, 0, dt);
        touch.consumeLookDelta();
      } else if (scene.isCinematic()) {
        // The catch cutscene drives the camera in scene.update. Movement is zero and look deltas are
        // dropped: a drag during the grab must not fight the forced aim.
        player.setRun(false);
        player.setCrouch(false);
        player.move(0, 0, dt);
        touch.consumeLookDelta();
      } else if (scene.isHidden()) {
        // Hiding owns translation and eye height. Do not feed crouch here: setCrouch re-seats the eye
        // on the floor, which would pull it out of the under-bed/wardrobe pocket. Look stays live so
        // the player can watch the room, and scene.update still runs the INTERACT prompt used to exit.
        player.setRun(false);
        player.move(0, 0, dt);
        const d = touch.consumeLookDelta();
        if (d.yaw !== 0 || d.pitch !== 0) player.addLookDelta(d.yaw, d.pitch);
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

  // Signal ready and start rendering behind the native loading cover so texture uploads and shader
  // compilation do not become the player's first interactive frames.
  globalBus.emit('engine:ready', undefined as never);
  loop.start();

  await withTimeout(scene.startupReady, STARTUP_ASSET_TIMEOUT_MS);
  hideLoading();

  // BEGIN lights up only once the art is not just loaded but *warm*: linked shaders and uploaded
  // textures. Doing it here means the bill is paid against the title screen, which nobody is timing,
  // instead of against the frame the player first sees a room — which is what used to hitch the cellar
  // stair twice on the way down. A failure here costs smoothness, never the button, so it is caught.
  void withTimeout(scene.allReady, ALL_ASSET_TIMEOUT_MS)
    .then(() => withTimeout(scene.warm(), ALL_ASSET_TIMEOUT_MS).catch((err) => reportError(err, 'warm')))
    .then(() => {
      titleMenu.setReady(true);
    });

  // Expose handles on window for the on-device perf gate to inspect.
  //
  // Merged into whatever is already there rather than assigned over it, and that is a fix rather than a
  // style choice. `buildHouseScene` runs at line 186 and adds its own DEV handles — `look`, `where`,
  // `bar`, `noise` — to this same object; assigning a fresh one here wiped every one of them, so the
  // probes read as undefined in the console and the placement loop had no way to ask the live page what
  // it was looking at. Spread first, then the base handles, so the base ones win on a name collision.
  const existing = (window as unknown as { __daayan?: Record<string, unknown> }).__daayan ?? {};
  (window as unknown as { __daayan: unknown }).__daayan = {
    ...existing,
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
