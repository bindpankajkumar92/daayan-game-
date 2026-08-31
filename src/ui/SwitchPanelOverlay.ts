/**
 * SwitchPanelOverlay — the basement breaker panel (brief §6).
 *
 * Four rockers plus a main lever. The lever matters: without a commit step the panel is a
 * 16-combination brute force that takes under a minute, and §9 asks for interpretation rather
 * than trial-and-error. A wrong pull sparks and drops all four rockers back to OFF, so guessing
 * costs four taps per attempt instead of one — enough that reading the diagram is plainly the
 * faster route, without taking anything from the player.
 *
 * Nothing here knows the answer. The correct configuration lives with the puzzle, and this
 * overlay only reports what the player set.
 */

import { OverlayLayer, overlayButton, overlayTitle } from './OverlayLayer';

export interface SwitchPanelOptions {
  title: string;
  sub?: string;
  labels: string[];
  /** Initial rocker positions, preserved between visits so a partial setup is not lost. */
  initial: boolean[];
  /** Called on every rocker flip so the caller can persist state. */
  onChange: (state: boolean[]) => void;
  /** Return true to accept. The overlay closes itself on success. */
  onCommit: (state: boolean[]) => boolean;
  onClosed?: () => void;
}

export function showSwitchPanel(layer: OverlayLayer, opts: SwitchPanelOptions): void {
  const state = opts.labels.map((_, i) => opts.initial[i] ?? false);

  layer.show((content) => {
    content.appendChild(opts.sub === undefined ? overlayTitle(opts.title) : overlayTitle(opts.title, opts.sub));

    const status = document.createElement('div');
    status.style.cssText = `
      min-height: 16px; margin: 0 0 12px; text-align: center;
      font: 400 11px/1.4 ui-monospace, monospace; color: rgba(255,150,140,0.9);
    `;

    const row = document.createElement('div');
    row.style.cssText = 'display: flex; gap: 10px; justify-content: center; margin-bottom: 14px;';
    const rockers: HTMLButtonElement[] = [];

    const paint = (): void => {
      for (let i = 0; i < rockers.length; i++) {
        const b = rockers[i];
        if (!b) continue;
        const on = state[i] === true;
        b.style.background = on ? 'rgba(120,200,130,0.22)' : 'rgba(0,0,0,0.42)';
        b.style.borderColor = on ? 'rgba(150,230,160,0.6)' : 'rgba(255,255,255,0.18)';
        b.style.color = on ? '#bdf0c4' : 'rgba(230,223,210,0.55)';
        // The rocker itself tilts: the label sits at the top when ON, the bottom when OFF, which
        // reads as a physical switch position rather than a checkbox.
        b.style.alignItems = on ? 'flex-start' : 'flex-end';
        b.textContent = `${opts.labels[i] ?? '?'}\n${on ? 'ON' : 'OFF'}`;
      }
    };

    for (let i = 0; i < opts.labels.length; i++) {
      const b = overlayButton(
        '',
        () => {
          state[i] = !(state[i] === true);
          status.textContent = '';
          opts.onChange([...state]);
          paint();
        },
        `width: 64px; height: 92px; display: flex; flex-direction: column; justify-content: center;
         white-space: pre-line; text-align: center; font-size: 13px; padding: 10px 0;`,
      );
      row.appendChild(b);
      rockers.push(b);
    }
    content.appendChild(row);
    content.appendChild(status);

    content.appendChild(
      overlayButton(
        'PULL MAIN LEVER',
        () => {
          if (opts.onCommit([...state])) {
            layer.close();
            return;
          }
          status.textContent = 'A hard snap, and the breakers fall back.';
          for (let i = 0; i < state.length; i++) state[i] = false;
          opts.onChange([...state]);
          paint();
        },
        'width: 100%; font-size: 13px; letter-spacing: 0.08em;',
      ),
    );

    paint();
  }, opts.onClosed);
}
