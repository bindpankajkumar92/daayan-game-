/**
 * QualityManager — picks an initial tier from device hints, exposes a render-scale
 * dynamic resolution scaler that protects the 30 FPS promise on low-end devices.
 *
 * Hooks: call `update(dt)` once per rendered frame, call `getRenderScale()` to feed
 * into the renderer.setSize() resolution adjustment.
 *
 * Heuristic: 4 GB RAM devices default to 'low' (per user requirement).
 */

import type { QualitySettings, QualityTier } from './types';

interface DeviceHints {
  hardwareConcurrency: number;
  deviceMemory: number; // GB (0 if not available)
  gpuRenderer: string;
  screenWidth: number;
  screenHeight: number;
}

function readGpuRenderer(): string {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (!ext) return '';
    return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '');
  } catch {
    return '';
  }
}

function readDeviceHints(): DeviceHints {
  const nav = navigator as unknown as {
    hardwareConcurrency?: number;
    deviceMemory?: number;
  };
  return {
    hardwareConcurrency: nav.hardwareConcurrency ?? 4,
    deviceMemory: nav.deviceMemory ?? 4,
    gpuRenderer: readGpuRenderer(),
    screenWidth: window.innerWidth,
    screenHeight: window.innerHeight,
  };
}

function pickInitialTier(h: DeviceHints): QualityTier {
  const r = h.gpuRenderer.toLowerCase();
  const isAdreno6xx = /adreno\s*6\d{2}/i.test(r);
  const isMaliG57Plus = /mali-g(5[7-9]|[6-9]\d)/i.test(r);
  const isAdreno5xx = /adreno\s*5\d{2}/i.test(r);
  const isMaliG31 = /mali-g31/i.test(r);
  const ram = h.deviceMemory || 4;

  // High: strong GPU, lots of RAM.
  if ((isAdreno6xx || isMaliG57Plus) && ram >= 6) return 'high';
  // Mid: decent modern GPU or 6+ GB RAM.
  if (ram >= 6 && h.hardwareConcurrency >= 6) return 'mid';
  // Low: anything that looks weak or RAM <= 4 GB.
  if (ram <= 4 || isAdreno5xx || isMaliG31) return 'low';
  return 'low';
}

const TIER_PRESETS: Record<QualityTier, QualitySettings> = {
  low: {
    tier: 'low',
    // Start at full (pixel-ratio-capped) resolution and let the scaler walk it down only if
    // the device actually struggles. Starting below 1.0 made every launch look soft even on
    // hardware that had the headroom to spare.
    renderScale: 1.0,
    maxRealTimeLights: 2,
    shadowMapEnabled: false, // fake contact shadows instead — no extra render pass
    textureMaxSize: 512,
    fpsCap: 0, // uncapped; the device is free to run above 30 if it can
    dynamicResolutionEnabled: true,
  },
  mid: {
    tier: 'mid',
    renderScale: 1.0,
    maxRealTimeLights: 3,
    shadowMapEnabled: false,
    textureMaxSize: 1024,
    fpsCap: 0,
    dynamicResolutionEnabled: true,
  },
  high: {
    tier: 'high',
    renderScale: 1.0,
    maxRealTimeLights: 4,
    shadowMapEnabled: true,
    textureMaxSize: 1024,
    fpsCap: 0,
    dynamicResolutionEnabled: true,
  },
};

export class QualityManager {
  private settings: QualitySettings;
  private frameTimeEma = 1 / 60; // optimistic start; the EMA corrects within ~10 frames
  private readonly targetFrameTime = 1 / 30; // 30 FPS floor
  private readonly recoverFrameTime = 1 / 45; // when to step scale back up
  private readonly minScale = 0.65;
  /** 1.0 == the Engine's capped device pixel ratio. Going above that just burns fill rate. */
  private readonly maxScale = 1.0;
  private onScaleChange: ((scale: number) => void) | null = null;
  /** Frames to wait between scale adjustments so the EMA can settle after each change. */
  private cooldown = 0;

  constructor(override?: { tier?: QualityTier; renderScale?: number }) {
    const hints = readDeviceHints();
    const detected = pickInitialTier(hints);
    const tier = override?.tier ?? detected;
    this.settings = { ...TIER_PRESETS[tier] };
    if (override?.renderScale !== undefined) {
      this.settings.renderScale = clamp(override.renderScale, this.minScale, this.maxScale);
    }
  }

  /** Register the sink that applies a new scale (normally Engine.setResolutionScale). */
  setScaleSink(fn: (scale: number) => void): void {
    this.onScaleChange = fn;
    fn(this.settings.renderScale);
  }

  getSettings(): QualitySettings {
    return this.settings;
  }

  getRenderScale(): number {
    return this.settings.renderScale;
  }

  /** Call once per rendered frame with the measured frame time in seconds. */
  update(frameTimeSec: number): void {
    // EMA smoothing (alpha = 0.1 -> smooth over ~10 frames).
    this.frameTimeEma = this.frameTimeEma * 0.9 + frameTimeSec * 0.1;
    if (!this.settings.dynamicResolutionEnabled) return;
    if (this.cooldown > 0) {
      this.cooldown--;
      return;
    }

    const before = this.settings.renderScale;
    if (this.frameTimeEma > this.targetFrameTime * 1.05) {
      // Sustained slow: drop scale by 10%.
      this.settings.renderScale = Math.max(this.minScale, before - 0.1);
    } else if (this.frameTimeEma < this.recoverFrameTime) {
      // Sustained fast: step scale back up.
      this.settings.renderScale = Math.min(this.maxScale, before + 0.05);
    }
    if (this.settings.renderScale !== before) {
      this.cooldown = 30;
      this.onScaleChange?.(this.settings.renderScale);
    }
  }

  setTier(t: QualityTier): void {
    this.settings = { ...TIER_PRESETS[t] };
    this.onScaleChange?.(this.settings.renderScale);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
