/**
 * Bootstrap: wire Engine + GameLoop + DebugOverlay + FPController + TouchControls +
 * feasibility scene. This is the Phase 0 entry point.
 */

import { Engine } from '@/core/Engine';
import { GameLoop } from '@/core/GameLoop';
import { DebugOverlay } from '@/core/DebugOverlay';
import { QualityManager } from '@/core/QualityManager';
import { globalBus } from '@/core/EventBus';
import { FPController } from '@/player/FPController';
import { TouchControls } from '@/player/TouchControls';
import { buildFeasibilityScene } from '@/scenes/dev/feasibility';
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

/** Lock to landscape and hide the system UI on native (Android) — no-op on web. */
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
}

function main(): void {
  const container = document.getElementById('app');
  if (!container) throw new Error('Missing #app container');

  const engine = new Engine(container);
  const debug = new DebugOverlay(engine.renderer);
  const quality = new QualityManager();

  // Default FPS cap (if WebGL has a swap interval API we can hook it in; for now we throttle
  // by sleeping in the loop when cap is set).
  const fpsCap = quality.getSettings().fpsCap;

  // Player + input
  const player = new FPController(engine);
  const touch = new TouchControls(player, debug);
  touch.setOnToggleDebug(() => {
    debug.setVisible(!debug.isVisible());
    globalBus.emit('debug:toggle', undefined as never);
  });

  // Feasibility scene
  const scene = buildFeasibilityScene(engine.scene, player, touch, engine);
  debug.setQualityTier(quality.getSettings().tier);
  debug.setRenderScale(quality.getRenderScale());

  // Wire quality tier changes back to debug overlay.
  globalBus.on('quality:change', ({ tier }) => debug.setQualityTier(tier));
  globalBus.on('resolution:change', ({ scale }) => debug.setRenderScale(scale));

  // Apply render scale to the renderer (resolution scaler hook).
  function applyRenderScale(): void {
    const scale = quality.getRenderScale();
    const w = window.innerWidth;
    const h = window.innerHeight;
    engine.renderer.setSize(Math.floor(w * scale), Math.floor(h * scale), false);
    engine.camera.aspect = w / h;
    engine.camera.updateProjectionMatrix();
  }
  applyRenderScale();
  window.addEventListener('resize', applyRenderScale);

  // Main loop
  const loop = new GameLoop({
    onStep: (dt) => {
      // Input -> movement
      const m = touch.getMove();
      player.setRun(m.run);
      player.setCrouch(m.crouch);
      player.move(m.strafe, m.forward, dt);
      // Look
      const d = touch.consumeLookDelta();
      if (d.yaw !== 0 || d.pitch !== 0) player.addLookDelta(d.yaw, d.pitch);
      // Scene update
      scene.update(dt);
    },
    onRender: (_alpha) => {
      const dt = engine.beginFrame();
      quality.update(dt);
      engine.renderer.info.reset();
      engine.endFrame();
      // Stats: after render so counts are populated.
      debug.setStats(engine.renderer.info.render.calls, engine.renderer.info.render.triangles);
      debug.recordFrame(dt * 1000);

      // FPS cap throttle: a soft cap by sleeping until the next frame budget.
      if (fpsCap > 0) {
        const targetMs = 1000 / fpsCap;
        const remaining = targetMs - performance.now() % targetMs;
        if (remaining > 1) {
          // Use a microtask-skip: we don't actually sleep here, but a small wait is fine.
        }
      }
    },
  });

  // Signal ready
  globalBus.emit('engine:ready', undefined as never);
  hideLoading();
  loop.start();
  // Fire-and-forget — won't block the first frame.
  void applyNativeChrome();

  // Expose handles on window for the on-device perf gate to inspect.
  (window as unknown as { __daayan: unknown }).__daayan = {
    engine,
    debug,
    quality,
    player,
    scene,
  };

  // Surface uncaught errors so the gate can catch them.
  window.addEventListener('error', (e) => {
    // eslint-disable-next-line no-console
    console.error('[daayan] uncaught:', e.error ?? e.message);
  });
}

main();
