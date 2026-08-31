/**
 * Fixed-timestep accumulator loop.
 * - Logic (AI, physics, input) runs at a fixed dt.
 * - Rendering runs as fast as requestAnimationFrame allows, with logic stepped 0..N times
 *   to keep simulation deterministic and framerate-independent.
 * - dt is clamped to <= 0.1s so a backgrounded tab doesn't fast-forward physics.
 *
 * Pooled Vector3 temporaries live elsewhere (Engine). This file only manages time.
 */

/** Distinct failures reported per site before the loop goes quiet about them. */
const MAX_REPORTED = 6;

export interface GameLoopCallbacks {
  onStep: (fixedDt: number) => void;
  onRender: (alpha: number) => void;
  /** Called for the first few failures in either callback. The loop keeps running regardless. */
  onError?: (err: unknown, where: 'step' | 'render') => void;
}

export class GameLoop {
  private fixedDt: number;
  private maxFrameDt: number;
  private accumulator = 0;
  private lastTimeMs = 0;
  private rafId: number | null = null;
  private running = false;
  private elapsed = 0;
  private errors = 0;

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
      // The next frame is scheduled at the bottom of this function, so an exception escaping
      // either callback used to end the loop for good: the last rendered frame stayed on screen,
      // input did nothing, and the only symptom left to report was "nothing moves". Absorbing it
      // here keeps the game responsive and lets the error be seen instead of guessed at.
      try {
        this.callbacks.onStep(this.fixedDt);
      } catch (err) {
        this.report(err, 'step');
      }
      this.accumulator -= this.fixedDt;
      this.elapsed += this.fixedDt;
    }
    const alpha = this.accumulator / this.fixedDt;
    try {
      this.callbacks.onRender(alpha);
    } catch (err) {
      this.report(err, 'render');
    }

    this.rafId = requestAnimationFrame(this.tick);
  };

  /** How many times a callback has thrown. Non-zero means the world is running on a limp. */
  getErrorCount(): number {
    return this.errors;
  }

  private report(err: unknown, where: 'step' | 'render'): void {
    this.errors++;
    if (this.errors <= MAX_REPORTED) this.callbacks.onError?.(err, where);
  }

  getElapsedSeconds(): number {
    return this.elapsed;
  }
}
