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

const Z = 7500;

export class Hud {
  private root: HTMLDivElement;
  private prompt: HTMLDivElement;
  private keyRow: HTMLDivElement;
  private toast: HTMLDivElement;
  private toastTimer = 0;
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

    this.toast = document.createElement('div');
    this.toast.style.cssText = `
      position: absolute; left: 50%; top: 46px; transform: translateX(-50%);
      padding: 5px 11px; border-radius: 4px; white-space: nowrap;
      background: rgba(8,8,12,0.6); border: 1px solid rgba(255,210,138,0.35);
      color: #ffd9a0; opacity: 0; transition: opacity 0.25s ease-out;
    `;
    this.root.appendChild(this.toast);
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

  update(dt: number): void {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toast.style.opacity = '0';
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
