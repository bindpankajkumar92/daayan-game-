/**
 * Hud — the interaction prompt, the key ring, and transient toasts.
 *
 * Deliberately thin. The brief (§8) rules out floating markers, glowing objects and arrows, so
 * the HUD's whole job is to answer one question the player already has: "can I use the thing I
 * am looking at?" Everything else — what a room means, where to go next — is the environment's
 * job, not this file's.
 *
 * Plain DOM over canvas: at 809x393 CSS pixels the text has to be crisp, and the browser's own
 * text rasteriser is both sharper and cheaper than anything drawn into a WebGL overlay.
 */

import { localize } from '@/ui/Strings';
import { NoiseSystem } from '@/game/NoiseSystem';
import { STARTING_LIVES } from '@/game/GameState';

const Z = 7500;

/**
 * The band boundaries of the noise bar, in the bar's own 0–1 units.
 *
 * `MAX` is imported from `NoiseSystem` rather than written as a literal, because it is *the* level at
 * which the alert fires: the bar's full red band and "the Daayan heard you" have to be the same
 * statement. When they were independent literals the bar read as full from 0.75 while the alert waited
 * for exactly 1.0, and a player looking at a red, pulsing bar could reasonably conclude they had maxed
 * it when the game had registered nothing. Sharing the constant makes that impossible to reintroduce.
 */
const NOISE_BAND = { WARM: 0.4, MAX: NoiseSystem.ALERT_LEVEL };

export class Hud {
  private root: HTMLDivElement;
  private prompt: HTMLDivElement;
  private keyRow: HTMLDivElement;
  private noiseContainer: HTMLDivElement;
  private noiseFill: HTMLDivElement;
  private noiseLevel = 0;
  private noisePulseTime = 0;
  private toast: HTMLDivElement;
  private toastTimer = 0;
  /** Life beads, one per `STARTING_LIVES`, dimmed as they are spent. */
  private livesRow: HTMLDivElement;
  private lifePips: HTMLDivElement[] = [];
  private readonly touchVerb: boolean;
  private keySlots = new Map<string, HTMLDivElement>();

  constructor() {
    // Touch devices get "INTERACT" (the on-screen button's own label); anything with a real
    // keyboard gets the key. Reading maxTouchPoints once is enough — the device does not change.
    // The *word* is not cached, though: it is translated per call, since the language can change
    // from the pause menu while the prompt is on screen. See Strings.localize.
    this.touchVerb = navigator.maxTouchPoints > 0;

    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.style.cssText = `
      position: fixed; inset: 0; pointer-events: none; z-index: ${Z};
      font: 500 13px/1.4 ui-monospace, monospace; color: #e8e2d8;
      text-shadow: 0 1px 3px rgba(0,0,0,0.95);
      transition: opacity 0.12s linear;
    `;
    document.body.appendChild(this.root);

    this.prompt = document.createElement('div');
    this.prompt.style.cssText = `
      position: absolute; left: 50%; bottom: 15%; transform: translateX(-50%);
      padding: 6px 12px; border-radius: 4px; white-space: nowrap;
      background: rgba(8,8,12,0.55); border: 1px solid rgba(255,255,255,0.14);
      opacity: 0; transition: opacity 0.1s linear;
    `;
    this.root.appendChild(this.prompt);

    // Key ring, top-centre. Three slots always present: an empty slot is information too —
    // it tells the player how many keys the gate wants without a tutorial saying so.
    this.keyRow = document.createElement('div');
    this.keyRow.style.cssText = `
      position: absolute; left: 50%; top: 10px; transform: translateX(-50%);
      display: flex; gap: 6px;
    `;
    this.root.appendChild(this.keyRow);

    // Noise detection bar, top-centre directly under the keys
    this.noiseContainer = document.createElement('div');
    this.noiseContainer.id = 'hud-noise-meter';
    this.noiseContainer.style.cssText = `
      position: absolute; left: 50%; top: 42px; transform: translateX(-50%);
      display: flex; align-items: center; gap: 8px;
      padding: 4px 9px; border-radius: 6px;
      background: rgba(10,10,14,0.72); border: 1px solid rgba(255,255,255,0.12);
      box-shadow: 0 2px 10px rgba(0,0,0,0.65); backdrop-filter: blur(4px);
    `;

    const noiseLabel = document.createElement('span');
    noiseLabel.style.cssText = `
      font: 700 9px/1 ui-monospace, monospace; letter-spacing: 1.5px;
      color: rgba(220,215,205,0.75); text-transform: uppercase;
      user-select: none;
    `;
    noiseLabel.textContent = 'NOISE';
    this.noiseContainer.appendChild(noiseLabel);

    const noiseTrack = document.createElement('div');
    noiseTrack.style.cssText = `
      width: 130px; height: 6px; border-radius: 3px;
      background: rgba(255,255,255,0.08); border: 1px solid rgba(0,0,0,0.6);
      overflow: hidden; position: relative;
    `;
    this.noiseContainer.appendChild(noiseTrack);

    this.noiseFill = document.createElement('div');
    this.noiseFill.style.cssText = `
      height: 100%; width: 0%; border-radius: 3px;
      background: linear-gradient(90deg, #62788c, #94adc2);
      transition: width 0.08s ease-out, background 0.2s ease, box-shadow 0.2s ease;
    `;
    noiseTrack.appendChild(this.noiseFill);

    this.root.appendChild(this.noiseContainer);

    this.toast = document.createElement('div');
    this.toast.style.cssText = `
      position: absolute; left: 50%; top: 72px; transform: translateX(-50%);
      padding: 5px 11px; border-radius: 4px; white-space: nowrap;
      background: rgba(8,8,12,0.6); border: 1px solid rgba(255,210,138,0.35);
      color: #ffd9a0; opacity: 0; transition: opacity 0.25s ease-out;
    `;
    this.root.appendChild(this.toast);

    // Lives, top-left. Deliberately not part of the key ring: keys are *progress* and lives are
    // *risk*, and putting them in the same cluster would make "how close am I to escaping" and "how
    // close am I to dying" read as one number. Top-left also keeps it clear of the toast at
    // `top: 72px`, which is centred and would otherwise collide on a narrow phone.
    this.livesRow = document.createElement('div');
    this.livesRow.id = 'hud-lives';
    this.livesRow.style.cssText = `
      position: absolute; left: 12px; top: 10px;
      display: flex; align-items: center; gap: 5px;
      padding: 4px 9px; border-radius: 6px;
      background: rgba(10,10,14,0.72); border: 1px solid rgba(255,255,255,0.12);
      box-shadow: 0 2px 10px rgba(0,0,0,0.65); backdrop-filter: blur(4px);
      user-select: none;
    `;
    const livesLabel = document.createElement('span');
    livesLabel.style.cssText = `
      font: 700 9px/1 ui-monospace, monospace; letter-spacing: 1.5px;
      color: rgba(220,215,205,0.75); text-transform: uppercase;
    `;
    livesLabel.textContent = 'LIFE';
    this.livesRow.appendChild(livesLabel);

    for (let i = 0; i < STARTING_LIVES; i++) {
      const pip = document.createElement('div');
      // A soft glowing bead rather than a number: at a glance, in the dark, a count of shapes is
      // read faster than a digit, and this HUD is only ever glanced at.
      pip.style.cssText = `
        width: 9px; height: 9px; border-radius: 50%;
        background: radial-gradient(circle at 35% 30%, #ffd9a0, #b8791f);
        box-shadow: 0 0 6px rgba(255, 190, 110, 0.55);
        transition: background 0.3s ease, box-shadow 0.3s ease, opacity 0.3s ease;
      `;
      this.livesRow.appendChild(pip);
      this.lifePips.push(pip);
    }
    this.root.appendChild(this.livesRow);
  }

  /**
   * Spend a life: the rightmost lit bead goes dark.
   *
   * Spent from the *right* so the remaining lit beads keep their positions — a row that shifts left as
   * it empties makes the player re-count from scratch every time, which is the opposite of what a
   * glanceable risk indicator is for.
   */
  /**
   * Hide the HUD for a camera-locked beat. The prompt and lives are meaningless while the player is
   * not in control, and leaving them over a kill close-up breaks the shot.
   */
  setCinematic(on: boolean): void {
    this.root.style.opacity = on ? '0' : '1';
  }

  setLives(remaining: number): void {
    for (let i = 0; i < this.lifePips.length; i++) {
      const lit = i < remaining;
      const pip = this.lifePips[i] as HTMLDivElement;
      pip.style.background = lit
        ? 'radial-gradient(circle at 35% 30%, #ffd9a0, #b8791f)'
        : 'rgba(255,255,255,0.07)';
      pip.style.boxShadow = lit ? '0 0 6px rgba(255, 190, 110, 0.55)' : 'none';
      pip.style.opacity = lit ? '1' : '0.5';
    }
  }

  /** Declare the key slots up front, in gate order, so their positions never shuffle. */
  setKeySlots(ids: string[]): void {
    this.keyRow.textContent = '';
    this.keySlots.clear();
    for (const id of ids) {
      const el = document.createElement('div');
      el.style.cssText = `
        width: 26px; height: 26px; border-radius: 3px;
        border: 1px solid rgba(255,255,255,0.16); background: rgba(0,0,0,0.35);
        display: grid; place-items: center; font-size: 15px; line-height: 1;
        color: rgba(255,255,255,0.12);
      `;
      el.textContent = '⚷';
      this.keyRow.appendChild(el);
      this.keySlots.set(id, el);
    }
  }

  setKeyHeld(id: string, held: boolean): void {
    const el = this.keySlots.get(id);
    if (!el) return;
    el.style.color = held ? '#ffcf8a' : 'rgba(255,255,255,0.12)';
    el.style.borderColor = held ? 'rgba(255,207,138,0.55)' : 'rgba(255,255,255,0.16)';
    el.style.background = held ? 'rgba(70,48,16,0.5)' : 'rgba(0,0,0,0.35)';
  }

  /** Mark a lock as turned: the slot dims to "spent" rather than disappearing. */
  setKeyUsed(id: string): void {
    const el = this.keySlots.get(id);
    if (!el) return;
    el.style.color = 'rgba(140,255,160,0.75)';
    el.style.borderColor = 'rgba(140,255,160,0.4)';
    el.style.background = 'rgba(14,40,20,0.5)';
  }

  /**
   * `null` hides the prompt. Anything else shows "[VERB]  text".
   *
   * The text arrives in English from wherever the interactable was declared and is translated here —
   * at the sink — so the puzzle code can go on writing readable prose. See Strings.
   */
  setPrompt(text: string | null): void {
    if (text === null) {
      this.prompt.style.opacity = '0';
      return;
    }
    const verb = this.touchVerb ? localize('INTERACT') : 'E';
    this.prompt.textContent = `${verb}   ${localize(text)}`;
    this.prompt.style.opacity = '1';
  }

  showToast(text: string, seconds = 2.4): void {
    this.toast.textContent = localize(text);
    this.toast.style.opacity = '1';
    this.toastTimer = seconds;
  }

  setNoiseLevel(level: number): void {
    this.noiseLevel = Math.max(0, Math.min(1.0, level));
    const pct = (this.noiseLevel * 100).toFixed(1);
    this.noiseFill.style.width = `${pct}%`;

    if (this.noiseLevel < NOISE_BAND.WARM) {
      this.noiseFill.style.background = 'linear-gradient(90deg, #62788c, #94adc2)';
      this.noiseFill.style.boxShadow = 'none';
      this.noiseContainer.style.borderColor = 'rgba(255, 255, 255, 0.12)';
    } else if (this.noiseLevel < NOISE_BAND.MAX) {
      this.noiseFill.style.background = 'linear-gradient(90deg, #d87c10, #f8a820)';
      this.noiseFill.style.boxShadow = '0 0 6px rgba(248, 168, 32, 0.5)';
      this.noiseContainer.style.borderColor = 'rgba(248, 168, 32, 0.35)';
    } else {
      this.noiseFill.style.background = 'linear-gradient(90deg, #b01010, #ff2a2a)';
      this.noiseFill.style.boxShadow = '0 0 10px rgba(255, 42, 42, 0.85)';
      this.noiseContainer.style.borderColor = 'rgba(255, 50, 50, 0.55)';
    }
  }

  update(dt: number): void {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toast.style.opacity = '0';
    }

    if (this.noiseLevel >= NOISE_BAND.MAX) {
      this.noisePulseTime += dt * 7.0;
      const pulse = 0.5 + 0.5 * Math.sin(this.noisePulseTime);
      const glow = (6 + pulse * 8).toFixed(1);
      this.noiseFill.style.boxShadow = `0 0 ${glow}px rgba(255, 35, 35, ${(0.6 + pulse * 0.4).toFixed(2)})`;
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
