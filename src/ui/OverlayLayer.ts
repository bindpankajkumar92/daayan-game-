/**
 * OverlayLayer — the one full-screen surface every puzzle UI is drawn into.
 *
 * There is a single layer rather than one per overlay so that "is any overlay open?" is a single
 * boolean the game loop can check. That matters more than it sounds: while a note is open the
 * loop must stop feeding movement *and* throw away accumulated look delta, or closing the note
 * snaps the camera through however much the player dragged across the paper.
 *
 * Being a real DOM element at a higher z-index than the touch controls also means it swallows
 * touches for free — no need to disable the joystick, because the joystick never sees them.
 */

const Z = 9000;

export class OverlayLayer {
  private root: HTMLDivElement;
  private card: HTMLDivElement;
  private closeBtn: HTMLButtonElement;
  private onClosed: (() => void) | null = null;
  private open = false;
  private dismissible = true;

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'overlay-layer';
    this.root.style.cssText = `
      position: fixed; inset: 0; z-index: ${Z}; display: none;
      /* No backdrop-filter over WebGL: it forces a framebuffer readback every rendered frame. */
      background:
        radial-gradient(ellipse at center, rgba(18,13,10,0.42), rgba(2,2,4,0.88)),
        rgba(4,4,7,0.76);
      place-items: center; pointer-events: auto; touch-action: none;
      font: 400 13px/1.5 ui-monospace, monospace; color: #e6dfd2;
      user-select: none; -webkit-user-select: none;
    `;
    document.body.appendChild(this.root);

    this.card = document.createElement('div');
    this.card.style.cssText = `
      position: relative; max-width: min(86vw, 560px); max-height: 82vh; overflow: auto;
      padding: 18px 20px 20px; border-radius: 6px;
      background: #17161c; border: 1px solid rgba(255,255,255,0.14);
      box-shadow: 0 18px 50px rgba(0,0,0,0.7);
    `;
    this.root.appendChild(this.card);

    this.closeBtn = document.createElement('button');
    this.closeBtn.textContent = '✕';
    this.closeBtn.style.cssText = `
      position: absolute; right: 6px; top: 6px; width: 38px; height: 38px;
      border-radius: 50%; background: radial-gradient(circle at 50% 30%, #4a423a, #1e191a 62%, #090709);
      color: #e7d8bd; border: 1.5px solid rgba(255,206,150,0.30);
      box-shadow: 0 2px 7px rgba(0,0,0,0.72), inset 0 0 8px rgba(255,180,100,0.07);
      font: 600 14px/1 ui-monospace, monospace; cursor: pointer; touch-action: none;
      transition: transform 90ms ease-out, filter 90ms ease-out;
    `;
    this.closeBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.closeBtn.style.transform = 'scale(0.90)';
      this.closeBtn.style.filter = 'brightness(1.35)';
      this.close();
    });
    const releaseClose = (): void => {
      this.closeBtn.style.transform = '';
      this.closeBtn.style.filter = '';
    };
    this.closeBtn.addEventListener('pointerup', releaseClose);
    this.closeBtn.addEventListener('pointercancel', releaseClose);
    this.closeBtn.addEventListener('pointerleave', releaseClose);
    this.card.appendChild(this.closeBtn);

    // Tapping the dark surround closes too — the fastest gesture on a phone, and the card's own
    // pointerdown stops the event so a tap inside never counts as "outside".
    this.root.addEventListener('pointerdown', (e) => {
      if (this.dismissible && e.target === this.root) this.close();
    });
    this.card.addEventListener('pointerdown', (e) => e.stopPropagation());
    document.addEventListener('keydown', this.onKeyDown);
  }

  isOpen(): boolean {
    return this.open;
  }

  /**
   * Replace the card's contents and show it. `build` receives an empty content element; the
   * close button is preserved. `dismissible: false` is for terminal cards: the run is over and
   * there is no game state to return to behind them.
   */
  show(
    build: (content: HTMLDivElement) => void,
    onClosed?: () => void,
    options?: { dismissible?: boolean },
  ): void {
    this.card.textContent = '';
    this.card.appendChild(this.closeBtn);
    const content = document.createElement('div');
    content.style.cssText = 'padding-right: 26px;';
    this.card.appendChild(content);
    build(content);
    this.onClosed = onClosed ?? null;
    this.dismissible = options?.dismissible ?? true;
    this.closeBtn.style.display = this.dismissible ? '' : 'none';
    this.root.style.display = 'grid';
    this.open = true;
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    // pointerdown closes immediately, so the hidden button may never receive pointerup. Reset the
    // transient press state here or the preserved close button reopens scaled and over-bright.
    this.closeBtn.style.transform = '';
    this.closeBtn.style.filter = '';
    this.root.style.display = 'none';
    const cb = this.onClosed;
    this.onClosed = null;
    if (cb) cb();
  }

  dispose(): void {
    document.removeEventListener('keydown', this.onKeyDown);
    this.root.remove();
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.open || !this.dismissible) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    }
  };
}

/** Shared heading, used by every overlay so they read as one interface. */
export function overlayTitle(text: string, sub?: string): HTMLDivElement {
  const h = document.createElement('div');
  h.style.cssText = 'margin-bottom: 12px;';
  const t = document.createElement('div');
  t.style.cssText = 'font: 600 14px/1.3 ui-monospace, monospace; letter-spacing: 0.06em; color: #f0e8d8;';
  t.textContent = text;
  h.appendChild(t);
  if (sub !== undefined) {
    const s = document.createElement('div');
    s.style.cssText = 'margin-top: 3px; font-size: 11px; color: rgba(230,223,210,0.5);';
    s.textContent = sub;
    h.appendChild(s);
  }
  return h;
}

/** A tap target that behaves the same under touch, mouse and pen. */
export function overlayButton(label: string, onTap: () => void, css = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = `
    min-height: 44px; border-radius: 4px;
    background: linear-gradient(180deg, rgba(74,56,36,0.72), rgba(27,21,19,0.90));
    color: #f0dfc1; border: 1.5px solid rgba(255,206,150,0.26);
    box-shadow: 0 2px 7px rgba(0,0,0,0.62), inset 0 0 10px rgba(255,180,100,0.06);
    font: 650 15px/1 ui-monospace, monospace; letter-spacing: 0.04em;
    cursor: pointer; touch-action: none; padding: 12px 0;
    transition: transform 90ms ease-out, filter 90ms ease-out; ${css}
  `;
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    b.style.transform = 'scale(0.96)';
    b.style.filter = 'brightness(1.30)';
    onTap();
  });
  const release = (): void => {
    b.style.transform = '';
    b.style.filter = '';
  };
  b.addEventListener('pointerup', release);
  b.addEventListener('pointercancel', release);
  b.addEventListener('pointerleave', release);
  return b;
}
