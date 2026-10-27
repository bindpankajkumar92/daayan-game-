/**
 * The two full-screen layers the kill beat needs.
 *
 * Both are plain DOM on purpose. The house renders through a WebGL canvas that is already the most
 * expensive thing on screen; a red flash and a black fade are solid colours, and drawing them into
 * the 3D pipeline would mean another pass for no reason. The layer sits above the HUD but below the
 * overlay card, so the death screen can still be read on top of the black.
 *
 * `update` is driven by the sequence rather than CSS transitions because the sequence has to know
 * exactly when the screen is black: that is the frame it warps the player or opens the death card.
 */

const Z = 8500;

export class KillFx {
  private root: HTMLDivElement;
  private red: HTMLDivElement;
  private style: HTMLStyleElement;
  private black = 0;
  private blackTarget = 0;
  private blackRate = Infinity;
  private redValue = 0;

  constructor(rootId = 'kill-fx') {
    this.style = document.createElement('style');
    this.style.textContent = `
      body.kill-cinematic #crosshair { opacity: 0 !important; }
    `;
    document.head.appendChild(this.style);

    this.root = document.createElement('div');
    this.root.id = rootId;
    this.root.style.cssText = `
      position: fixed; inset: 0; z-index: ${Z}; pointer-events: none;
      display: none; background: #000; opacity: 0;
    `;
    document.body.appendChild(this.root);

    this.red = document.createElement('div');
    this.red.style.cssText = `
      position: absolute; inset: 0; opacity: 0;
      background: radial-gradient(circle at 50% 45%,
        rgba(210, 40, 20, 0.95), rgba(60, 0, 0, 0.6) 58%, rgba(0, 0, 0, 0) 100%);
    `;
    this.root.appendChild(this.red);
  }

  begin(): void {
    this.black = 0;
    this.blackTarget = 0;
    this.blackRate = Infinity;
    this.redValue = 0;
    this.root.style.display = 'block';
    this.apply();
    document.body.classList.add('kill-cinematic');
  }

  flash(): void {
    this.redValue = 0.9;
    this.apply();
  }

  /** Move the black layer toward `value` over `seconds`; 0 is clear, 1 is fully black. */
  setBlack(value: number, seconds: number): void {
    this.blackTarget = Math.min(Math.max(value, 0), 1);
    this.blackRate = seconds > 0 ? Math.abs(this.blackTarget - this.black) / seconds : Infinity;
  }

  update(dt: number): void {
    // Nothing to drive before the first catch, and the layer is display:none then anyway.
    if (this.root.style.display === 'none') return;
    if (this.redValue > 0) this.redValue = Math.max(0, this.redValue - dt / 0.25);
    if (this.black !== this.blackTarget) {
      const step = this.blackRate * dt;
      this.black = this.black < this.blackTarget
        ? Math.min(this.blackTarget, this.black + step)
        : Math.max(this.blackTarget, this.black - step);
    }
    this.apply();
  }

  /** The camera is the player's again; put the crosshair back even while the last black fades. */
  endCinematic(): void {
    document.body.classList.remove('kill-cinematic');
  }

  reset(): void {
    this.root.style.display = 'none';
    this.black = 0;
    this.blackTarget = 0;
    this.redValue = 0;
    document.body.classList.remove('kill-cinematic');
  }

  dispose(): void {
    this.reset();
    this.root.remove();
    this.style.remove();
  }

  private apply(): void {
    this.root.style.opacity = String(this.black);
    this.red.style.opacity = String(this.redValue);
  }
}
