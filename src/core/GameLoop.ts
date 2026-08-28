/**
 * Fixed-timestep accumulator loop.
 * - Logic (AI, physics, input) runs at a fixed dt.
 * - Rendering runs as fast as requestAnimationFrame allows, with logic stepped 0..N times
 *   to keep simulation deterministic and framerate-independent.
 * - dt is clamped to <= 0.1s so a backgrounded tab doesn't fast-forward physics.
 *
 * Pooled Vector3 temporaries live elsewhere (Engine). This file only manages time.
 */

export interface GameLoopCallbacks {
  onStep: (fixedDt: number) => void;
  onRender: (alpha: number) => void;
}

export class GameLoop {
  private fixedDt: number;
  private maxFrameDt: number;
  private accumulator = 0;
  private lastTimeMs = 0;
  private rafId: number | null = null;
  private running = false;
  private elapsed = 0;

  constructor(
    private callbacks: GameLoopCallbacks,
    options: { fixedDt?: number; maxFrameDt?: number } = {},
  ) {
    this.fixedDt = options.fixedDt ?? 1 / 60; // 60 Hz logic tick
    this.maxFrameDt = options.maxFrameDt ?? 0.1; // clamp big jumps
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTimeMs = performance.now();
    this.accumulator = 0;
    this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private tick = (): void => {
    if (!this.running) return;
    const now = performance.now();
    let frameDt = (now - this.lastTimeMs) / 1000;
    this.lastTimeMs = now;
    if (frameDt > this.maxFrameDt) frameDt = this.maxFrameDt;

    this.accumulator += frameDt;
    let safetyBudget = 8; // never run more than 8 fixed steps in a single frame
    while (this.accumulator >= this.fixedDt && safetyBudget-- > 0) {
      this.callbacks.onStep(this.fixedDt);
      this.accumulator -= this.fixedDt;
      this.elapsed += this.fixedDt;
    }
    const alpha = this.accumulator / this.fixedDt;
    this.callbacks.onRender(alpha);

    this.rafId = requestAnimationFrame(this.tick);
  };

  getElapsedSeconds(): number {
    return this.elapsed;
  }
}
