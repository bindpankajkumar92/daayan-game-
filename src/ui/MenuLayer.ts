/**
 * MenuLayer — the title screen and the pause screen, which are the same screen.
 *
 * One class for both because they differ in exactly one word: the first button reads BEGIN on the
 * title and RESUME in-game. Everything else — the frame, the flicker, the settings panel behind
 * SETTINGS — is shared, and a second implementation of it would be a second thing to keep in step.
 * Two instances are constructed, never two subclasses.
 *
 * The game keeps *rendering* behind this. It does not keep *running*: the caller freezes the
 * simulation through `onVisibility`, so what shows through the wash is a held frame of a dark hall
 * rather than a world the daayan keeps walking around in while the player reads the options.
 * Rendering a frozen scene costs the same as a live one and is what makes the title screen the house
 * instead of a black rectangle.
 *
 * Deliberately no `backdrop-filter`. Blurring what is behind a full-screen element forces the
 * compositor to read the framebuffer back every frame it is up — over a WebGL canvas that is the most
 * expensive thing on the screen — and on the Adreno this is aimed at it costs more than the scene
 * does. The wash is two flat gradients, both free.
 *
 * Layout is two columns, not a centred stack: at 809x393 CSS pixels there is far more width than
 * height, and a title that has to share the vertical with five controls ends up 11 px tall.
 *
 * Styles are written once, in the constructor. `render()` only ever touches textContent and a few
 * state-dependent style *properties* — never `cssText +=` — because this re-renders on every open and
 * every language switch, and appending to cssText is how a style string quietly grows a duplicate of
 * itself per switch until the parser is sifting kilobytes of repeated rules.
 */

import { localize, onLangChange, setLang, getLang, LANGS, type Lang } from '@/ui/Strings';

/** Above the puzzle overlays (9000), because pausing over an open note has to cover it. */
const Z = 9500;

/**
 * The sensitivity slider is geometric, not linear.
 *
 * Look sensitivity is perceived as a ratio — the step from 0.002 to 0.003 is the same *felt* change
 * as the step from 0.006 to 0.009 — so a linear slider spends most of its travel in the fast half and
 * crowds every usable slow setting into the first centimetre. It also puts the shipped default at 29%
 * of the track, which reads as "this game is configured wrong" before the player has touched anything.
 * Interpolating the logarithm fixes both: equal thumb movement is equal ratio, and the default lands
 * near the middle, which is where a default belongs.
 */
function sensToFraction(v: number, min: number, max: number): number {
  return Math.log(v / min) / Math.log(max / min);
}

function fractionToSens(f: number, min: number, max: number): number {
  return min * Math.pow(max / min, f);
}

export interface MenuDeps {
  /** Current look sensitivity, in radians per CSS pixel. */
  getSensitivity: () => number;
  /**
   * Apply a new sensitivity. `commit` is false for every frame of a drag and true once when the
   * thumb is released — so the value can be applied live without writing to storage a hundred times.
   */
  setSensitivity: (radPerPx: number, commit: boolean) => void;
  /** The range the slider spans. TouchControls.LOOK_MIN / LOOK_MAX. */
  sensRange: { min: number; max: number };
  /** Fired whenever the menu opens or closes. The caller freezes and unfreezes the simulation here. */
  onVisibility: (open: boolean) => void;
  /** Fired when the player commits — BEGIN on the title, RESUME in-game. */
  onClose: () => void;
}

const PRIMARY_CSS = `
  background: linear-gradient(180deg, #5a3a14 0%, #2a1a07 100%);
  color: #ffd79b; border: 1.5px solid rgba(255,205,150,0.42);
  font: 700 18px/1 ui-monospace, monospace; letter-spacing: 0.16em;
  box-shadow: 0 0 18px rgba(255,170,80,0.18), inset 0 0 14px rgba(255,170,80,0.12);
  transition: filter 90ms ease-out, transform 90ms ease-out;
`;

const PANEL_CSS = `
  background: rgba(20,15,12,0.62); color: #d8cfb8;
  border: 1px solid rgba(255,255,255,0.14);
  font: 600 12px/1 ui-monospace, monospace; letter-spacing: 0.12em;
`;

export class MenuLayer {
  // Assigned inside the constructor via the build* helpers, which TS cannot see through — hence the
  // definite-assignment assertions rather than null-and-cast at every use.
  private root!: HTMLDivElement;
  private primaryBtn!: HTMLButtonElement;
  private subtext!: HTMLDivElement;
  private settingsBtn!: HTMLButtonElement;
  private settingsPanel!: HTMLDivElement;
  private slider!: HTMLDivElement;
  private sliderThumb!: HTMLDivElement;
  private sliderValue!: HTMLSpanElement;
  private langButtons = new Map<Lang, HTMLButtonElement>();

  private visible = false;
  private rafId = 0;
  private dragging = false;
  private dragPointerId: number | null = null;

  constructor(
    private readonly deps: MenuDeps,
    /** False renders the title screen, true the pause screen. One word differs. */
    private readonly isPause: boolean,
  ) {
    this.root = document.createElement('div');
    this.root.id = isPause ? 'pause-layer' : 'menu-layer';
    this.root.style.cssText = `
      position: fixed; inset: 0; z-index: ${Z};
      display: none; pointer-events: auto; touch-action: none;
      background:
        radial-gradient(ellipse at 50% 38%, rgba(24,14,6,0.22) 0%, rgba(6,4,3,0.58) 58%, rgba(0,0,0,0.88) 100%),
        rgba(4,3,3,0.80);
      font: 500 13px/1.5 ui-monospace, monospace; color: #e6dfd2;
      user-select: none; -webkit-user-select: none;
    `;
    document.body.appendChild(this.root);

    const col = document.createElement('div');
    col.style.cssText = `
      position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
      width: min(88vw, 560px);
      display: grid; grid-template-columns: 1fr 1fr; column-gap: 26px;
      align-items: start;
    `;
    this.root.appendChild(col);

    // --- Left column: title, subtext, primary action --------------------------------------------
    const left = document.createElement('div');
    left.style.cssText = 'display: flex; flex-direction: column; gap: 18px; padding-top: 6px;';
    col.appendChild(left);

    const title = document.createElement('div');
    title.style.cssText = `
      font: 700 26px/1.08 ui-monospace, monospace; letter-spacing: 0.18em; color: #f4e3c1;
      text-shadow: 0 0 14px rgba(255,170,80,0.30), 0 2px 4px rgba(0,0,0,0.95);
    `;
    // The name is a proper noun and reads the same in both languages; it is never localised. See Strings.
    title.textContent = "DAAYAN'S HOUSE";
    left.appendChild(title);

    this.subtext = document.createElement('div');
    this.subtext.style.cssText = `
      font-size: 11px; line-height: 1.5; color: rgba(230,223,210,0.62);
      letter-spacing: 0.04em; max-width: 30ch; min-height: 3em;
    `;
    left.appendChild(this.subtext);

    this.primaryBtn = document.createElement('button');
    this.primaryBtn.style.cssText = `
      width: 100%; padding: 16px 0; border-radius: 4px; cursor: pointer; touch-action: none;
      ${PRIMARY_CSS}
    `;
    this.primaryBtn.addEventListener('click', (e) => {
      e.preventDefault();
      this.deps.onClose();
      this.close();
    });
    left.appendChild(this.primaryBtn);

    // --- Right column: SETTINGS, then the panel it toggles --------------------------------------
    const right = document.createElement('div');
    right.style.cssText = 'display: flex; flex-direction: column; gap: 14px; padding-top: 6px;';
    col.appendChild(right);

    this.settingsBtn = document.createElement('button');
    this.settingsBtn.style.cssText = `
      width: 100%; padding: 12px 0; border-radius: 4px; cursor: pointer; touch-action: none;
      ${PANEL_CSS}
    `;
    this.settingsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      this.settingsPanel.style.display = this.settingsPanel.style.display === 'flex' ? 'none' : 'flex';
    });
    right.appendChild(this.settingsBtn);

    this.settingsPanel = document.createElement('div');
    this.settingsPanel.style.cssText = `
      display: none; flex-direction: column; gap: 16px; padding: 14px;
      border-radius: 4px; background: rgba(0,0,0,0.45);
      border: 1px solid rgba(255,255,255,0.08);
    `;
    right.appendChild(this.settingsPanel);

    this.buildSensitivityRow();
    this.buildLanguageRow();

    // --- Flicker ---------------------------------------------------------------------------------
    // A dying-bulb wash over the whole menu. Multiply-blended so it only ever darkens; one RAF tick of
    // two sines while visible, and it stops scheduling itself the moment the menu is hidden.
    const flicker = document.createElement('div');
    flicker.style.cssText = `
      position: absolute; inset: 0; pointer-events: none; mix-blend-mode: multiply;
      background: radial-gradient(ellipse at 50% 50%, rgba(42,30,16,0.14) 0%, rgba(0,0,0,0.30) 100%);
    `;
    this.root.appendChild(flicker);
    this.flickerEl = flicker;

    // Re-render whenever the language flips while the menu is alive — open or not, so a switch made
    // in one menu is already in the right words when the other is opened.
    this.revoker = onLangChange(() => this.render());
    this.render();
  }

  private revoker: () => void = () => {};

  isOpen(): boolean {
    return this.visible;
  }

  open(): void {
    if (this.visible) return;
    this.visible = true;
    this.root.style.display = 'block';
    this.startFlicker();
    this.render();
    this.deps.onVisibility(true);
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.style.display = 'none';
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.endDrag();
    this.deps.onVisibility(false);
  }

  dispose(): void {
    if (this.rafId !== 0) cancelAnimationFrame(this.rafId);
    this.revoker();
    this.endDrag();
    // The drag listeners live on the window for the lifetime of the menu; they are gated on
    // `dragging`, but a disposed menu must not leave them behind at all.
    window.removeEventListener('pointermove', this.onSliderMove);
    window.removeEventListener('pointerup', this.onSliderUp);
    window.removeEventListener('pointercancel', this.onSliderUp);
    this.root.remove();
  }

  // --- Settings: sensitivity ---------------------------------------------------------------------

  private buildSensitivityRow(): void {
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; flex-direction: column; gap: 6px;';

    const head = document.createElement('div');
    head.style.cssText = 'display: flex; justify-content: space-between; align-items: baseline;';
    const lab = document.createElement('span');
    lab.style.cssText =
      'font: 600 11px/1 ui-monospace, monospace; letter-spacing: 0.10em; color: rgba(230,223,210,0.72);';
    lab.textContent = localize('LOOK SENSITIVITY');
    this.sliderValue = document.createElement('span');
    this.sliderValue.style.cssText = 'font-size: 10px; color: rgba(230,223,210,0.45);';
    head.appendChild(lab);
    head.appendChild(this.sliderValue);
    row.appendChild(head);

    this.slider = document.createElement('div');
    this.slider.style.cssText = `
      position: relative; height: 30px; border-radius: 15px;
      background: linear-gradient(90deg, #17100a 0%, #2b1c0d 100%);
      border: 1px solid rgba(255,255,255,0.10);
      touch-action: none; cursor: pointer;
    `;

    // Three reference ticks: min, the geometric middle, max. Without them the thumb position is a
    // number with no meaning; with them "about halfway" is a sentence the player can act on.
    const { min, max } = this.deps.sensRange;
    for (const v of [min, Math.sqrt(min * max), max]) {
      const tick = document.createElement('div');
      tick.style.cssText = `
        position: absolute; top: 50%; left: ${(sensToFraction(v, min, max) * 100).toFixed(2)}%;
        width: 1px; height: 12px; background: rgba(255,255,255,0.18);
        transform: translate(-50%, -50%); pointer-events: none;
      `;
      this.slider.appendChild(tick);
    }

    this.sliderThumb = document.createElement('div');
    this.sliderThumb.style.cssText = `
      position: absolute; top: 50%; left: 50%; width: 22px; height: 22px; border-radius: 50%;
      background: radial-gradient(circle at 50% 30%, #ffd79b, #f0a544 55%, #c9761d);
      border: 1.5px solid rgba(255,255,255,0.35);
      box-shadow: 0 0 10px rgba(255,170,80,0.35);
      transform: translate(-50%, -50%);
      pointer-events: none;
    `;
    this.slider.appendChild(this.sliderThumb);

    // Move/up live on the window, not the slider: a drag that starts inside the track and travels
    // past its edge has to keep tracking. Both are gated on `dragging` + the captured pointer id, so
    // every other pointer on screen passes through untouched. The thumb itself is pointer-events:none,
    // so the track below is always the target.
    this.slider.addEventListener('pointerdown', this.onSliderDown);
    window.addEventListener('pointermove', this.onSliderMove);
    window.addEventListener('pointerup', this.onSliderUp);
    window.addEventListener('pointercancel', this.onSliderUp);
    row.appendChild(this.slider);

    const scale = document.createElement('div');
    scale.style.cssText =
      'display: flex; justify-content: space-between; font-size: 9px; color: rgba(230,223,210,0.40); letter-spacing: 0.12em;';
    const lo = document.createElement('span');
    lo.textContent = localize('SLOW');
    const hi = document.createElement('span');
    hi.textContent = localize('FAST');
    scale.appendChild(lo);
    scale.appendChild(hi);
    row.appendChild(scale);

    this.settingsPanel.appendChild(row);
  }

  private onSliderDown = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    this.dragging = true;
    this.dragPointerId = e.pointerId;
    try {
      this.slider.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that is already gone cannot be captured; the window listeners still track it.
    }
    this.applyDrag(e.clientX);
  };

  private onSliderMove = (e: PointerEvent): void => {
    if (!this.dragging || e.pointerId !== this.dragPointerId) return;
    this.applyDrag(e.clientX);
  };

  private onSliderUp = (e: PointerEvent): void => {
    if (!this.dragging || e.pointerId !== this.dragPointerId) return;
    // Commit is what persists the value. Every frame before this was live preview only, which is
    // exactly what dragging a setting wants — no storage write per pixel of thumb travel.
    this.deps.setSensitivity(this.deps.getSensitivity(), true);
    this.endDrag();
  };

  private endDrag(): void {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.dragPointerId !== null) {
      try {
        this.slider.releasePointerCapture(this.dragPointerId);
      } catch {
        // Already released — the pointer may have been lifted outside the window.
      }
      this.dragPointerId = null;
    }
  }

  private applyDrag(clientX: number): void {
    const rect = this.slider.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const v = fractionToSens(f, this.deps.sensRange.min, this.deps.sensRange.max);
    this.deps.setSensitivity(v, false);
    // The thumb follows the finger here, not through render() — render is for open and language
    // changes, and a drag must not wait for either.
    this.sliderThumb.style.left = `${(f * 100).toFixed(2)}%`;
    this.sliderValue.textContent = v.toFixed(4);
  }

  // --- Settings: language --------------------------------------------------------------------------

  private buildLanguageRow(): void {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display: flex; flex-direction: column; gap: 6px;';
    const lab = document.createElement('div');
    lab.style.cssText =
      'font: 600 11px/1 ui-monospace, monospace; letter-spacing: 0.10em; color: rgba(230,223,210,0.72);';
    lab.textContent = localize('LANGUAGE');
    wrap.appendChild(lab);

    const row = document.createElement('div');
    row.style.cssText = 'display: flex; gap: 8px;';
    for (const l of LANGS) {
      const b = document.createElement('button');
      // Each option is labelled in its own language, always — an ENGLISH row labelled "अंग्रेज़ी"
      // would beunreadable to the player who needs it, and the reverse for HINGLISH.
      b.style.cssText = `
        flex: 1; padding: 10px 0; border-radius: 3px; cursor: pointer; touch-action: none;
        ${PANEL_CSS}
      `;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        setLang(l.id);
        this.render();
      });
      this.langButtons.set(l.id, b);
      row.appendChild(b);
    }
    wrap.appendChild(row);
    this.settingsPanel.appendChild(wrap);
  }

  // --- Flicker ---------------------------------------------------------------------------------------

  private startFlicker(): void {
    if (this.rafId !== 0) return;
    const start = performance.now();
    const tick = (): void => {
      if (!this.visible) {
        // Hidden: stop scheduling entirely rather than ticking through the off frames.
        this.rafId = 0;
        return;
      }
      const t = (performance.now() - start) / 1000;
      // Two out-of-phase sines — one fast enough to read as flicker, one slow enough to read as the
      // bulb warming. Biased so the band is 0.66..0.94: lower than that and it strobes, higher and
      // the eye reads a steady overlay and stops seeing it.
      const flick = 0.09 * Math.sin(t * 7.3) + 0.05 * Math.sin(t * 17.9 + 1.3);
      this.flickerEl.style.opacity = (0.80 + flick).toFixed(3);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private flickerEl!: HTMLDivElement;

  // --- Render -----------------------------------------------------------------------------------------

  /** Text and state only — every style string was written once in the constructor. See the header. */
  private render(): void {
    this.primaryBtn.textContent = localize(this.isPause ? 'RESUME' : 'BEGIN');
    this.subtext.textContent = localize(
      this.isPause ? 'Tap PAUSE any time to come back here.' : 'The house is awake. Get out.',
    );
    this.settingsBtn.textContent = localize('SETTINGS');

    const v = this.deps.getSensitivity();
    this.sliderThumb.style.left = `${(sensToFraction(v, this.deps.sensRange.min, this.deps.sensRange.max) * 100).toFixed(2)}%`;
    this.sliderValue.textContent = v.toFixed(4);

    const active = getLang();
    for (const l of LANGS) {
      const btn = this.langButtons.get(l.id);
      if (btn === undefined) continue;
      btn.textContent = l.label;
      const on = l.id === active;
      btn.style.background = on ? 'rgba(255,170,80,0.18)' : 'rgba(20,15,12,0.62)';
      btn.style.color = on ? '#ffd79b' : '#d8cfb8';
      btn.style.borderColor = on ? 'rgba(255,205,150,0.55)' : 'rgba(255,255,255,0.14)';
    }
  }
}
