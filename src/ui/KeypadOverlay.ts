/**
 * KeypadOverlay — the four-digit box in the bedroom (brief §5).
 *
 * The box shows four slots, not a free-text field, because the number of slots is itself the
 * clue's other half: the diary gives a time, the clock confirms it, and four slots tell the
 * player that "11:40" is meant to be entered as 1140 rather than typed as text. That is the
 * difference between deduction and guessing, which §9 makes a hard rule.
 *
 * Wrong codes clear the entry and say so. There is no lockout and no attempt counter — the brief
 * forbids arbitrary punishment, and a cooldown here would only make a player who mistyped one
 * digit sit and wait.
 */

import { OverlayLayer, overlayButton, overlayTitle } from './OverlayLayer';

export interface KeypadOptions {
  title: string;
  sub?: string;
  /** Return true to accept. The overlay closes itself on success. */
  onSubmit: (code: string) => boolean;
  onClosed?: () => void;
}

export function showKeypad(layer: OverlayLayer, opts: KeypadOptions): void {
  let entry = '';

  layer.show((content) => {
    content.appendChild(opts.sub === undefined ? overlayTitle(opts.title) : overlayTitle(opts.title, opts.sub));

    const display = document.createElement('div');
    display.style.cssText = `
      display: flex; gap: 8px; justify-content: center; margin: 4px 0 14px;
    `;
    const slots: HTMLDivElement[] = [];
    for (let i = 0; i < 4; i++) {
      const s = document.createElement('div');
      s.style.cssText = `
        width: 42px; height: 52px; border-radius: 4px; display: grid; place-items: center;
        background: rgba(0,0,0,0.45); border: 1px solid rgba(255,255,255,0.2);
        font: 600 24px/1 ui-monospace, monospace; color: #ffd9a0;
      `;
      display.appendChild(s);
      slots.push(s);
    }
    content.appendChild(display);

    const status = document.createElement('div');
    status.style.cssText = `
      min-height: 16px; margin-bottom: 10px; text-align: center;
      font: 400 11px/1.4 ui-monospace, monospace; color: rgba(255,150,140,0.9);
    `;
    content.appendChild(status);

    const render = (): void => {
      for (let i = 0; i < 4; i++) {
        const slot = slots[i];
        if (slot) slot.textContent = entry[i] ?? '';
      }
    };

    const submit = (): void => {
      if (entry.length < 4) {
        status.textContent = 'Four digits.';
        return;
      }
      if (opts.onSubmit(entry)) {
        layer.close();
        return;
      }
      status.textContent = 'The dial does not turn.';
      entry = '';
      render();
    };

    const press = (d: string): void => {
      if (entry.length >= 4) return;
      status.textContent = '';
      entry += d;
      render();
      // Auto-submit on the fourth digit: on a phone, reaching for a separate ENTER after four
      // taps is one gesture too many, and the code is fixed-length so there is nothing to confirm.
      if (entry.length === 4) submit();
    };

    const pad = document.createElement('div');
    pad.style.cssText = 'display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;';
    for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      pad.appendChild(overlayButton(d, () => press(d)));
    }
    pad.appendChild(
      overlayButton('CLR', () => {
        entry = '';
        status.textContent = '';
        render();
      }, 'font-size: 12px;'),
    );
    pad.appendChild(overlayButton('0', () => press('0')));
    pad.appendChild(
      overlayButton('←', () => {
        entry = entry.slice(0, -1);
        status.textContent = '';
        render();
      }),
    );
    content.appendChild(pad);
    render();
  }, opts.onClosed);
}
