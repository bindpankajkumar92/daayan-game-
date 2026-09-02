/**
 * The smallest `document` that lets the world modules load under plain Node.
 *
 * `tools/reach.ts` claims to run headless, and it did until the procedural props grew a contact shadow:
 * `makeFixtureMats` now calls `makeContactShadowTexture`, which reaches for `document.createElement`
 * and threw `ReferenceError: document is not defined` before a single anchor had been measured. Same
 * story for ProcTextures if a tool ever pulls it in.
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
  g.document = {
    createElement: (tag: string) => (tag === 'canvas' ? makeCanvas() : { style: {}, appendChild: () => undefined }),
    createElementNS: (_ns: string, tag: string) => (tag === 'canvas' ? makeCanvas() : { style: {} }),
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
    body: { appendChild: (): void => undefined, style: {} },
  };
}
