/**
 * The full-screen layers the kill beat needs: blood on the lens, then black.
 *
 * Plain DOM on purpose. The house renders through a WebGL canvas that is already the most expensive
 * thing on screen; drawing these into the 3D pipeline would mean another pass for no reason. The layer
 * sits above the HUD but below the overlay card, so the death screen can still be read on the black.
 *
 * **The blood and the black are siblings, not parent and child.** The first version put the red flash
 * inside the black div and drove the *parent's* opacity — so at the moment of the hit, when the black
 * was still 0, the flash was multiplied by 0 and never appeared at all. Now the black is its own div
 * stacked over the blood, and the blood is seen for as long as the sequence holds the black off.
 *
 * **Why the blood is drawn rather than a gradient.** A red radial vignette is the look that reads as
 * "game effect": it is symmetric, evenly saturated, and the same every time. Blood on glass is none of
 * those. It is dark — arterial blood on a lens reads near-black-crimson, not red — it lands off-centre
 * from the side the blade came in, it is a few big irregular blobs with a ring of fine spray thrown
 * outward along the strike, its edges are darker than its middle where it is thinner and drier, the
 * big drops catch one wet highlight, and the heaviest of them start to run. Every hit is generated
 * fresh from those rules, so no two deaths show the same splatter.
 *
 * Drawn at half resolution: the shapes are soft and the canvas is scaled by CSS, so full resolution
 * would only cost fill rate on the phone. Only the drips are redrawn per frame, and only for the
 * second or so they are running.
 */

const Z = 8500;
const RES = 0.5;
/** How long the drips keep running after the hit. */
const DRIP_LIFE = 1.4;

interface Drip {
  x: number;
  y: number;
  w: number;
  len: number;
  tau: number;
}

const rand = (a: number, b: number): number => a + Math.random() * (b - a);

export class KillFx {
  private root: HTMLDivElement;
  private blood: HTMLCanvasElement;
  private pulse: HTMLDivElement;
  private blackDiv: HTMLDivElement;
  private style: HTMLStyleElement;
  private ctx: CanvasRenderingContext2D | null;
  /** The splatter as it landed, so the drips can be redrawn over it without regenerating it. */
  private still: HTMLCanvasElement | null = null;
  private drips: Drip[] = [];
  private dripT = -1;
  private black = 0;
  private blackTarget = 0;
  private blackRate = Infinity;
  private pulseValue = 0;

  constructor(rootId = 'kill-fx') {
    this.style = document.createElement('style');
    this.style.textContent = `
      body.kill-cinematic #crosshair { opacity: 0 !important; }
    `;
    document.head.appendChild(this.style);

    this.root = document.createElement('div');
    this.root.id = rootId;
    this.root.style.cssText = `
      position: fixed; inset: 0; z-index: ${Z}; pointer-events: none; display: none;
    `;
    document.body.appendChild(this.root);

    this.blood = document.createElement('canvas');
    this.blood.style.cssText = 'position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0;';
    this.root.appendChild(this.blood);
    this.ctx = this.blood.getContext('2d');

    // The impact itself: a dark, short-lived closing of the frame's edges. Not red-on-everything —
    // the eye reads a hit as the edges going dark, which is what a body does when it is struck.
    this.pulse = document.createElement('div');
    this.pulse.style.cssText = `
      position: absolute; inset: 0; opacity: 0;
      background: radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 38%, rgba(48,0,0,0.55) 72%, rgba(14,0,0,0.92) 100%);
    `;
    this.root.appendChild(this.pulse);

    this.blackDiv = document.createElement('div');
    this.blackDiv.style.cssText = 'position: absolute; inset: 0; background: #000; opacity: 0;';
    this.root.appendChild(this.blackDiv);
  }

  begin(): void {
    this.black = 0;
    this.blackTarget = 0;
    this.blackRate = Infinity;
    this.pulseValue = 0;
    this.clearBlood();
    this.root.style.display = 'block';
    this.apply();
    document.body.classList.add('kill-cinematic');
  }

  /** The blade lands: splatter the lens and close the edges. */
  flash(): void {
    this.pulseValue = 1;
    this.splatter();
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
    if (this.pulseValue > 0) this.pulseValue = Math.max(0, this.pulseValue - dt / 0.45);
    if (this.black !== this.blackTarget) {
      const step = this.blackRate * dt;
      this.black = this.black < this.blackTarget
        ? Math.min(this.blackTarget, this.black + step)
        : Math.max(this.blackTarget, this.black - step);
    }
    if (this.dripT >= 0) {
      this.dripT += dt;
      this.drawDrips();
      if (this.dripT > DRIP_LIFE) this.dripT = -1;
    }
    // Once the screen is fully black the blood has done its job; drop it so the fade-in after a
    // respawn comes up on a clean frame rather than on the last death.
    if (this.black >= 1 && this.blackTarget >= 1 && this.still) this.clearBlood();
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
    this.pulseValue = 0;
    this.clearBlood();
    document.body.classList.remove('kill-cinematic');
  }

  dispose(): void {
    this.reset();
    this.root.remove();
    this.style.remove();
  }

  private apply(): void {
    this.blackDiv.style.opacity = String(this.black);
    this.pulse.style.opacity = String(this.pulseValue);
  }

  private clearBlood(): void {
    this.still = null;
    this.drips = [];
    this.dripT = -1;
    this.blood.style.opacity = '0';
    this.ctx?.clearRect(0, 0, this.blood.width, this.blood.height);
  }

  private splatter(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const W = Math.max(2, Math.round(window.innerWidth * RES));
    const H = Math.max(2, Math.round(window.innerHeight * RES));
    this.blood.width = W;
    this.blood.height = H;
    ctx.clearRect(0, 0, W, H);
    const s = Math.min(W, H);

    // The blade comes in from her right, which is the player's left-to-centre. Spray travels away
    // from that point, so the heavy blobs sit near it and the fine spray is thrown across the frame.
    const ox = W * rand(0.28, 0.46);
    const oy = H * rand(0.3, 0.5);
    const sweep = rand(-0.5, 0.25);

    // A few big drops, stretched along the strike: blood thrown at glass lands as smears with a
    // direction, not as round beads.
    const blobs: { x: number; y: number; r: number }[] = [];
    const nBig = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < nBig; i++) {
      const ang = sweep + rand(-0.6, 0.6);
      const d = s * rand(0.0, 0.2) * (i === 0 ? 0.25 : 1);
      const b = { x: ox + Math.cos(ang) * d, y: oy + Math.sin(ang) * d * 0.8, r: s * rand(0.03, 0.08) * (i === 0 ? 1.5 : 1) };
      blobs.push(b);
      this.blob(ctx, b.x, b.y, b.r, sweep + rand(-0.3, 0.3), rand(1.3, 2.2));
    }
    // Secondary drops thrown *forward* of each blob along the strike, elongated, never a ring.
    for (const b of blobs.slice()) {
      const n = 2 + Math.floor(Math.random() * 4);
      for (let i = 0; i < n; i++) {
        const ang = sweep + rand(-0.35, 0.35);
        const d = b.r * rand(1.4, 4.5);
        const r = b.r * rand(0.08, 0.22);
        this.blob(ctx, b.x + Math.cos(ang) * d, b.y + Math.sin(ang) * d, r, ang, rand(1.6, 3.2));
      }
    }

    // Fine spray: elongated specks along the strike, longer the further they flew.
    const nSpray = 70 + Math.floor(Math.random() * 60);
    for (let i = 0; i < nSpray; i++) {
      const ang = sweep + rand(-1.1, 1.1);
      const d = s * Math.pow(Math.random(), 0.7) * 0.75;
      const x = ox + Math.cos(ang) * d;
      const y = oy + Math.sin(ang) * d * 0.85;
      const r = s * rand(0.002, 0.009) * (1 - d / (s * 0.9));
      if (r <= 0.4) continue;
      const stretch = 1 + (d / s) * rand(1.5, 4);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(ang);
      ctx.fillStyle = `rgba(${60 + Math.floor(Math.random() * 30)},0,${Math.floor(Math.random() * 4)},${rand(0.75, 0.95)})`;
      ctx.beginPath();
      ctx.ellipse(0, 0, r * stretch, r, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    this.still = document.createElement('canvas');
    this.still.width = W;
    this.still.height = H;
    this.still.getContext('2d')?.drawImage(this.blood, 0, 0);

    // The heaviest drops run. Start each drip at the bottom edge of its blob.
    this.drips = blobs
      .filter((b) => b.r > s * 0.05)
      .slice(0, 4)
      .map((b) => ({
        x: b.x + rand(-0.4, 0.4) * b.r,
        y: b.y + b.r * 0.75,
        w: b.r * rand(0.18, 0.3),
        len: s * rand(0.08, 0.26),
        tau: rand(0.35, 0.7),
      }));
    this.dripT = 0;
    this.blood.style.opacity = '1';
  }

  /**
   * One irregular drop on the lens, stretched by `stretch` along `ang`.
   *
   * Out of focus, because it is on glass a centimetre from the eye: a sharp edge is what made the
   * first version read as stickers. Translucent, because a film of blood on a lens tints the scene
   * behind it rather than hiding it; only the thick middle of a big drop is near-opaque. No glossy
   * highlight — that was the single most "rendered" thing about it.
   */
  private blob(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    ang: number,
    stretch: number,
  ): void {
    const harm = Array.from({ length: 6 }, (_, k) => ({ k: k + 2, a: rand(0.03, 0.18) / (1 + k * 0.35), p: rand(0, Math.PI * 2) }));
    const shape = (scale: number): void => {
      ctx.beginPath();
      const N = 48;
      for (let i = 0; i <= N; i++) {
        const t = (i / N) * Math.PI * 2;
        let k = 1;
        for (const h of harm) k += h.a * Math.sin(h.k * t + h.p);
        // Teardrop: the leading end (cos t > 0) is longer than the tail.
        const lead = Math.cos(t) > 0 ? stretch : 1 + (stretch - 1) * 0.35;
        const px = Math.cos(t) * r * k * scale * lead;
        const py = Math.sin(t) * r * k * scale * 0.9;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    };
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.filter = `blur(${Math.max(0.6, r * 0.09).toFixed(1)}px)`;
    // Thin film first, wider than the drop, so the edge fades into a tint instead of stopping.
    ctx.fillStyle = 'rgba(70,4,6,0.38)';
    shape(1.12);
    ctx.fill();
    const g = ctx.createRadialGradient(-r * 0.2, 0, r * 0.05, 0, 0, r * stretch);
    g.addColorStop(0, 'rgba(78,2,5,0.9)');
    g.addColorStop(0.5, 'rgba(62,1,4,0.82)');
    g.addColorStop(1, 'rgba(40,0,2,0.55)');
    ctx.fillStyle = g;
    shape(0.82);
    ctx.fill();
    ctx.restore();
  }

  private drawDrips(): void {
    const ctx = this.ctx;
    if (!ctx || !this.still) return;
    ctx.clearRect(0, 0, this.blood.width, this.blood.height);
    ctx.drawImage(this.still, 0, 0);
    for (const d of this.drips) {
      // Fast at first, then slowing as the drop thins and sticks: an exponential approach.
      const l = d.len * (1 - Math.exp(-this.dripT / d.tau));
      if (l < 1) continue;
      const g = ctx.createLinearGradient(0, d.y, 0, d.y + l);
      g.addColorStop(0, 'rgba(88,3,6,0.95)');
      g.addColorStop(1, 'rgba(62,0,3,0.95)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(d.x - d.w * 0.5, d.y);
      ctx.quadraticCurveTo(d.x - d.w * 0.32, d.y + l * 0.6, d.x - d.w * 0.28, d.y + l);
      ctx.lineTo(d.x + d.w * 0.28, d.y + l);
      ctx.quadraticCurveTo(d.x + d.w * 0.32, d.y + l * 0.6, d.x + d.w * 0.5, d.y);
      ctx.closePath();
      ctx.fill();
      // The bead the drip carries at its leading edge.
      ctx.beginPath();
      ctx.ellipse(d.x, d.y + l, d.w * 0.42, d.w * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
