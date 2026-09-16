/**
 * NoiseSystem — tracks acoustic disturbance in the house and scales noise accumulation
 * dynamically based on the player's proximity to the Daayan.
 *
 * Requirements:
 * - Increases when the player sprints, knocks over glass/bottles/plates, or when the cat meows.
 * - Distance scaling: If Daayan is close, noise causes a large rise up to maximum; if far away,
 *   the noise impact is dampened.
 * - Smoothly decays back to zero when quiet.
 * - Emits 'noise:alert' when hitting 1.0 for future AI integration (Daayan AI untouched).
 */

import { globalBus } from '@/core/EventBus';
import type { FPController } from '@/player/FPController';
import type { Vec3 } from '@/core/types';

export interface NoiseSystemDeps {
  player: FPController;
  getDaayanPos: () => Vec3;
}
export class NoiseSystem {
  private level = 0;
  private readonly player: FPController;
  private readonly getDaayanPos: () => Vec3;
  private unsubs: (() => void)[] = [];
  private hasAlerted = false;

  /** Distance thresholds in metres */
  private static readonly D_MIN = 8.0;
  private static readonly D_MAX = 28.0;
  private static readonly MIN_MULT = 0.25;

  /** Decay rate per second when quiet */
  private static readonly DECAY_RATE = 0.22;

  /** Continuous noise rate per second while sprinting */
  private static readonly RUN_NOISE_RATE = 0.38;

  /**
   * How long the player may stop running before decay begins, in seconds.
   *
   * Without this, decay outruns sprinting and the bar can never fill from a stuttering run. The
   * arithmetic is unforgiving: at the far distance multiplier (0.25) a sprinting frame adds
   * `0.38 × 0.25 / 60 = 0.0016`, while a non-sprinting frame subtracts `0.22 / 60 = 0.0037` — decay is
   * **2.3× the gain**. So one dropped frame erases two and a half frames of sprint, and a player whose
   * run is interrupted even occasionally (a wall corner, a hitch, releasing the key for a moment) sees
   * the bar hover and fall back instead of filling. That is the reported bug.
   *
   * Matching `FPController.RUN_MEMORY`, and for the same reason. The two must not disagree: if the
   * controller says the player is still sprinting, the noise system has to keep accumulating, and if
   * the controller has given up on the sprint the noise system has to start draining. This is the
   * *quiet* side of that pair; that constant is the *loud* side.
   */
  private static readonly DECAY_GRACE = 0.3;

  /**
   * Seconds of silence before the bar may start draining, while the player is still *trying* to run.
   *
   * Distinct from `DECAY_GRACE`, and the reason the recorded bug survived the earlier fix. A player
   * sprinting in a small room spends much of their time with the run control held and their body
   * against a wall. `FPController` now rides that out, but even so the honest reading is not "they
   * stopped" — the player is audibly still going, they are just not going anywhere.
   *
   * So while run is *intended*, the bar holds. It does not build (there is no footfall to hear) and
   * it does not drain (nobody stopped). Only once the intent itself is released does `DECAY_GRACE`
   * begin, and from there the bar drains normally. This is what makes "hold run and the bar maxes"
   * true in a room the size of a cupboard, which is where the player tried it.
   */
  private static readonly HOLD_WHILE_INTENT = true;

  /**
   * The level at which the bar counts as maxed, and therefore at which `noise:alert` fires.
   *
   * Not 1.0. The bar is drawn in three bands and the top one — red, glowing, pulsing — begins at
   * **0.75**, so a player at 0.9 is looking at a bar that reads as completely full. Waiting for the
   * level to land *exactly* on 1.0 leaves the last quarter of the bar as dead space where the UI says
   * "maxed" and the game has registered nothing, which is the other half of what the player reported.
   *
   * The honest fix is to make the visible maximum and the audible maximum the same event: the alert
   * fires when the bar enters its full band, so "the bar is red" and "she heard it" are one statement.
   * The HUD's band boundary reads this same constant, so the two can never drift apart.
   */
  public static readonly ALERT_LEVEL = 0.75;

  /**
   * Seconds without running before `hasAlerted` clears, allowing a second alert.
   *
   * Longer than `DECAY_GRACE`: the point is that the player must have genuinely gone quiet, not merely
   * dropped a frame. Below `ALERT_LEVEL` minus a margin, so the next genuine max is a fresh crossing.
   */
  private static readonly REARM_LEVEL = 0.3;

  /** Seconds the level must sit under `REARM_LEVEL` before the alert can fire again. */
  private static readonly REARM_DELAY = 0.4;

  /** Consecutive seconds without running, for both the decay grace and the re-arm delay. */
  private quietFor = 0;

  /** Consecutive seconds without run *intent*, tracked only for diagnostics. */
  private intentFor = 0;

  /**
   * Is the player holding the run control right now, displacement or not?
   *
   * Read through an optional-method guard so the headless suites' `FakePlayer`s — which only
   * implement the three methods the noise path originally needed — keep working without change.
   * Absent, it is treated as "same as `isRunning`", which is the old behaviour.
   */
  private getRunIntent(): boolean {
    const p = this.player as Partial<FPController>;
    if (typeof p.isRunIntent === 'function') return p.isRunIntent();
    if (typeof p.isRunning === 'function') return p.isRunning();
    return false;
  }

  constructor(deps: NoiseSystemDeps) {
    this.player = deps.player;
    this.getDaayanPos = deps.getDaayanPos;

    const offNoise = globalBus.on('noise:emitted', (e) => {
      this.handleNoiseImpulse(e.kind);
    });
    this.unsubs.push(offNoise);
  }

  /**
   * Distance multiplier M(D) in [0.25, 1.0].
   * Close to Daayan (<= 8m): returns 1.0 (loudest/max impact).
   * Far from Daayan (>= 28m): returns 0.25 (dampened impact).
   */
  public getDistanceMultiplier(): number {
    const daayan = this.getDaayanPos();
    const pPos = this.player.getPosition();
    const dx = pPos.x - daayan.x;
    const dy = pPos.y - daayan.y;
    const dz = pPos.z - daayan.z;
    const dist = Math.hypot(dx, dy, dz);

    if (dist <= NoiseSystem.D_MIN) return 1.0;
    if (dist >= NoiseSystem.D_MAX) return NoiseSystem.MIN_MULT;

    const t = (dist - NoiseSystem.D_MIN) / (NoiseSystem.D_MAX - NoiseSystem.D_MIN);
    return 1.0 - t * (1.0 - NoiseSystem.MIN_MULT);
  }

  private handleNoiseImpulse(kind: 'footstep' | 'door' | 'object' | 'impact' | 'cat'): void {
    const mult = this.getDistanceMultiplier();
    let baseImpulse = 0;

    switch (kind) {
      case 'object': // glass, bottles, plates
        baseImpulse = 0.55;
        break;
      case 'cat': // cat meowing
        baseImpulse = 0.50;
        break;
      case 'footstep':
        if (this.player.isRunning()) {
          baseImpulse = 0.12;
        } else if (!this.player.isCrouching()) {
          baseImpulse = 0.02;
        }
        break;
      case 'door':
      case 'impact':
        baseImpulse = 0.25;
        break;
    }

    if (baseImpulse > 0) {
      this.addNoise(baseImpulse * mult);
    }
  }

  private addNoise(amount: number): void {
    this.level = Math.min(1.0, this.level + amount);
    // Crossing the alert level, not landing on 1.0. See `ALERT_LEVEL`: the bar reads as full from the
    // moment it enters its red band, so that is the moment the alert has to fire or the UI is lying.
    if (this.level >= NoiseSystem.ALERT_LEVEL && !this.hasAlerted) {
      this.hasAlerted = true;
      globalBus.emit('noise:alert', {
        pos: this.player.getPosition(),
        level: this.level,
      });
    }
  }

  public update(dt: number, isRunning: boolean): void {
    const mult = this.getDistanceMultiplier();

    if (isRunning) {
      // Continuous sprint noise buildup scaled by Daayan proximity
      this.quietFor = 0;
      this.intentFor = 0;
      this.addNoise(NoiseSystem.RUN_NOISE_RATE * mult * dt);
      return;
    }

    // Not displaced this frame. If the control is still held, this is a wall or a corner, not a
    // decision — see `HOLD_WHILE_INTENT`. The bar neither rises nor falls; it waits.
    if (NoiseSystem.HOLD_WHILE_INTENT && this.getRunIntent()) {
      this.quietFor = 0;
      this.intentFor = 0;
      return;
    }

    this.quietFor += dt;
    this.intentFor += dt;

    // Grace period: a single dropped frame is not "went quiet". See `DECAY_GRACE` for the arithmetic
    // that makes this necessary — without it, decay outruns sprinting and the bar cannot fill at all.
    if (this.quietFor < NoiseSystem.DECAY_GRACE) return;

    // Natural decay when quiet
    this.level = Math.max(0, this.level - NoiseSystem.DECAY_RATE * dt);
    // Re-arm only after genuinely going quiet, and only with a margin below the alert level, so the
    // next real max is a clean crossing rather than a flicker at the boundary.
    if (this.level < NoiseSystem.REARM_LEVEL && this.quietFor >= NoiseSystem.REARM_DELAY) {
      this.hasAlerted = false;
    }
  }

  /** Normalized noise level in [0, 1] */
  public getLevel(): number {
    return this.level;
  }

  /**
   * Has the current crossing already fired? Exposed for the dev probe so the two facts that matter
   * can be read together — the bar is at its limit *and* the alert went out — rather than inferred
   * from one of them. See `__daayan.bar()`.
   */
  public hasFiredAlert(): boolean {
    return this.hasAlerted;
  }

  /**
   * Drive the bar to its limit and fire the alert, as a sprint's last metre would.
   *
   * Exists for the dev probe (`window.__daayan.noise()`), because the reported bug — "the bar is full
   * and she still does not come" — can only be reproduced live, and walking the whole house to fill the
   * bar by hand is not a reasonable way to test it. The alert it fires is the real one, through
   * `addNoise` and therefore through the real emitter, so what is tested is the actual production path
   * rather than a second one that merely resembles it.
   *
   * Returns the level, so a caller can print it in one line.
   */
  public fill(): number {
    this.addNoise(1.0);
    return this.level;
  }

  public dispose(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
  }
}
