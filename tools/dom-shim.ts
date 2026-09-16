/**
 * The smallest `document` that lets the world modules load under plain Node.
 *
 * `tools/reach.ts` claims to run headless, and it did until the procedural props grew a contact shadow:
 * `makeFixtureMats` now calls `makeContactShadowTexture`, which reaches for `document.createElement`
 * and threw `ReferenceError: document is not defined` before a single anchor had been measured. The
 * same is now true of ProcTextures, which `tools/audit-tones.ts` pulls in through buildHouse.
 *
 * So: a canvas that records nothing. The reachability check only ever reads Vector3s and AABBs, so the
 * *pixels* are irrelevant and the only contract that matters is that nothing throws and `getContext`
 * does not return null — ContactShadow throws its own error on a null context, which would look like a
 * real failure. Every 2D call below is therefore a no-op that returns something of the right shape.
 *
 * Import this FIRST, before anything that reaches @/world — ES modules evaluate in import order, and a
 * shim installed second is a shim installed too late.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const gradient = {
  addColorStop: (): void => undefined,
};

const context2d = {
  canvas: null as unknown,
  fillStyle: '' as unknown,
  strokeStyle: '' as unknown,
  lineWidth: 1,
  globalAlpha: 1,
  createRadialGradient: () => gradient,
  createLinearGradient: () => gradient,
  fillRect: (): void => undefined,
  clearRect: (): void => undefined,
  strokeRect: (): void => undefined,
  beginPath: (): void => undefined,
  closePath: (): void => undefined,
  moveTo: (): void => undefined,
  lineTo: (): void => undefined,
  arc: (): void => undefined,
  // The rest of the path family, because ProcTextures draws its plank seams and its damp blooms with
  // curves rather than lines: audit-tones.ts pulls makeWoodFloor in and it died on bezierCurveTo.
  // Cheaper to no-op the whole family once than to add one method per tool that reaches a new
  // generator.
  bezierCurveTo: (): void => undefined,
  quadraticCurveTo: (): void => undefined,
  arcTo: (): void => undefined,
  ellipse: (): void => undefined,
  rect: (): void => undefined,
  clip: (): void => undefined,
  fill: (): void => undefined,
  stroke: (): void => undefined,
  save: (): void => undefined,
  restore: (): void => undefined,
  translate: (): void => undefined,
  rotate: (): void => undefined,
  scale: (): void => undefined,
  drawImage: (): void => undefined,
  // Anything that samples pixels gets opaque black at the requested size, which is a valid image.
  getImageData: (_x: number, _y: number, w: number, h: number) => ({
    width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
  }),
  putImageData: (): void => undefined,
  createImageData: (w: number, h: number) => ({
    width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
  }),
};

function makeCanvas(): unknown {
  const canvas = {
    width: 1,
    height: 1,
    style: {},
    getContext: (kind: string) => (kind === '2d' ? context2d : null),
    toDataURL: () => 'data:,',
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  };
  context2d.canvas = canvas;
  return canvas;
}

const g = globalThis as any;
if (g.document === undefined) {
  /**
   * Anything that is not a canvas. It needs the event pair as much as the canvas does: three's
   * ImageLoader builds an `img` through createElementNS and immediately addEventListener's 'load' on
   * it, so buildHouse's floor-photograph swap threw here before it could reach a single room. No-ops
   * are the correct answer rather than a stub load — headless there is no webp to fetch, and the
   * floors are already wearing makeWoodFloor's canvas, which is what the swap is a swap *from*.
   */
  const element = (): unknown => ({
    style: {},
    appendChild: (): void => undefined,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  });
  g.document = {
    createElement: (tag: string) => (tag === 'canvas' ? makeCanvas() : element()),
    createElementNS: (_ns: string, tag: string) => (tag === 'canvas' ? makeCanvas() : element()),
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
    body: { appendChild: (): void => undefined, style: {} },
  };
}
