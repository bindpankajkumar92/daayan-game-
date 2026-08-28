/**
 * DebugOverlay v1 — toggleable FPS + 1%-lows + draw calls + triangles + render scale.
 * Lives in a CSS-positioned <div>; no canvas dependency.
 *
 * Toggle: back-tick on desktop, triple-tap top-right corner on touch (handled by TouchControls).
 */

import type { WebGLRenderer } from 'three';

interface FrameSample {
  dt: number; // ms
  t: number; // performance.now ms
}

export class DebugOverlay {
  private el: HTMLDivElement;
  private samples: FrameSample[] = [];
  private maxSamples = 240; // ~4s at 60fps
  private visible = false;
  private toggleListeners: Array<(visible: boolean) => void> = [];
  private lastDrawCalls = 0;
  private lastTriangles = 0;
  private renderScale = 1.0;
  private qualityTier: 'low' | 'mid' | 'high' = 'low';

  constructor(private renderer: WebGLRenderer, parent: HTMLElement = document.body) {
    this.el = document.createElement('div');
    this.el.style.cssText = `
      position: fixed; top: 8px; left: 8px; z-index: 9000;
      padding: 8px 10px; background: rgba(0,0,0,0.55); color: #9f9;
      font: 12px/1.35 ui-monospace, Menlo, Consolas, monospace;
      border-radius: 4px; pointer-events: none; white-space: pre;
      display: none; backdrop-filter: blur(2px);
    `;
    parent.appendChild(this.el);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.el.style.display = v ? 'block' : 'none';
    this.toggleListeners.forEach((fn) => fn(v));
  }

  isVisible(): boolean {
    return this.visible;
  }

  onToggle(fn: (visible: boolean) => void): void {
    this.toggleListeners.push(fn);
  }

  setStats(drawCalls: number, triangles: number): void {
    this.lastDrawCalls = drawCalls;
    this.lastTriangles = triangles;
  }

  setRenderScale(scale: number): void {
    this.renderScale = scale;
  }

  setQualityTier(t: 'low' | 'mid' | 'high'): void {
    this.qualityTier = t;
  }

  /** Call once per frame. */
  recordFrame(dtMs: number): void {
    this.samples.push({ dt: dtMs, t: performance.now() });
    if (this.samples.length > this.maxSamples) this.samples.shift();
    if (this.visible) this.render();
  }

  private render(): void {
    const n = this.samples.length;
    if (n === 0) return;
    let sum = 0;
    let min = Infinity;
    let max = 0;
    for (const s of this.samples) {
      sum += s.dt;
      if (s.dt < min) min = s.dt;
      if (s.dt > max) max = s.dt;
    }
    const avg = sum / n;
    const avgFps = 1000 / avg;
    // 1% lows: average of the slowest 1% of frames in the window.
    const sorted = [...this.samples].map((s) => s.dt).sort((a, b) => b - a);
    const lowCount = Math.max(1, Math.floor(n * 0.01));
    let lowSum = 0;
    for (let i = 0; i < lowCount; i++) lowSum += sorted[i] ?? 0;
    const low1Fps = 1000 / (lowSum / lowCount);

    const r = this.renderer;
    this.el.textContent =
      `FPS avg  ${avgFps.toFixed(1)}\n` +
      `FPS 1%l  ${low1Fps.toFixed(1)}\n` +
      `frame    ${avg.toFixed(2)} ms\n` +
      `draws    ${this.lastDrawCalls}\n` +
      `tris     ${(this.lastTriangles / 1000).toFixed(1)}k\n` +
      `tier     ${this.qualityTier}\n` +
      `scale    ${this.renderScale.toFixed(2)}x\n` +
      `size     ${r.domElement.width}x${r.domElement.height}`;
  }

  dispose(): void {
    this.el.remove();
  }
}
