/**
 * FilmGrade — the display grade, as one blended quad and no render target.
 *
 * What it does: a vignette, two-sided film grain, and a warm lift off pure black. What it is not is
 * an EffectComposer chain, and the reason is the framebuffer. The renderer now runs with MSAA, which
 * on the target phone's tiled Adreno resolves inside tile memory and costs close to nothing; routing
 * the frame through a render target instead would either throw the multisampling away or force a
 * resolve plus a full-size texture read of a 1618x786 buffer, every frame, on a device whose whole
 * frame currently costs 13.2 ms. So this grade never reads the frame at all — it *blends* against it:
 *
 *     result = dst * srcAlpha + srcRGB
 *
 * with `blendSrc = OneFactor, blendDst = SrcAlphaFactor`. That is a gain (the alpha) and a lift (the
 * rgb) — a levels adjustment, not an S-curve, because an S-curve needs to know the pixel it is bending
 * and this pass deliberately cannot. Everything below is built out of those two terms:
 *
 * - **Vignette** goes in the gain, where a falloff to 0.5 in the corners costs one length() per pixel.
 * - **Grain in the midtones** modulates that same gain, so it swings both ways for free.
 * - **Grain in the shadows** cannot: near-black pixels are unmoved by any multiplier, and the frame is
 *   mostly near-black. It rides the lift instead, which is also what stops the blacks reading as a
 *   dead panel — ACES' toe crushes them, and Engine's exposure comment describes fighting that with
 *   overall brightness. A lift is the cheaper fix: it raises the floor without washing the midtones.
 *
 * The quad hangs off the camera rather than being rendered in a second pass, so it sorts last in the
 * existing transparent queue and adds no draw beyond its own.
 */

import {
  CustomBlending,
  Mesh,
  OneFactor,
  PlaneGeometry,
  ShaderMaterial,
  SrcAlphaFactor,
  Vector2,
  Vector3,
  type PerspectiveCamera,
  type WebGLRenderer,
} from 'three';

/** Past FLAME_ORDER (20) and past anything else in the scene, so the grade lands on a finished frame. */
const ORDER = 1000;

/**
 * Vignette shape, in aspect-corrected radius from the centre. A 809x393 viewport reaches r = 1.14 in
 * the corners and 0.5 at the top and bottom edges, so `END` past 1.0 is what keeps the darkening a
 * corner effect rather than a letterbox.
 */
const VIG = { start: 0.42, end: 1.15, strength: 0.5 };

/**
 * Grain depth. `gain` is the swing applied to the multiplier — 5.5% of a midtone, which is where film
 * grain actually lives. `lift` is how hard the same noise pushes the black floor about, at 1.0 meaning
 * the floor swings between nothing and twice LIFT; the shadows are most of this game's frame, so this
 * is the number that decides whether the grain is visible at all.
 */
const GRAIN = { gain: 0.055, lift: 1.0 };

/**
 * The black floor, warm because the only light in the house is a flame. ~3.5/255 in red: below the
 * point it reads as fog and above the point an OLED panel gives up and shows nothing.
 */
const LIFT = new Vector3(0.014, 0.0105, 0.008);

/** Grain cell size relative to a device pixel. Above 1 the grain is chunkier than the pixel grid, which
 * is what film looks like and also what survives the compositor's own scaling. */
const GRAIN_PX = 1.7;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * One hash, one length, one smoothstep. `uTime` is fed in already wrapped, so the sin() argument stays
 * small enough for mediump to keep resolving distinct values — a grain that freezes after four minutes
 * of play is the classic symptom of not doing that.
 */
const FRAG = /* glsl */ `
precision mediump float;
varying vec2 vUv;
uniform float uAspect;
uniform float uTime;
uniform vec2 uGrainRes;
uniform vec3 uLift;
uniform float uVigStart;
uniform float uVigEnd;
uniform float uVigStrength;
uniform float uGrainGain;
uniform float uGrainLift;

void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float vig = 1.0 - uVigStrength * smoothstep(uVigStart, uVigEnd, length(p));

  vec2 cell = vUv * uGrainRes + uTime;
  float n = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;

  // Gain: the vignette, wobbled by the grain. Clamped because a fixed-point target clamps the factor
  // anyway and a negative one would read as a hard black speckle rather than as noise.
  gl_FragColor.a = clamp(vig * (1.0 + n * uGrainGain), 0.0, 1.0);
  // Lift: vignetted with everything else, so the corners still go down, and pushed either side of the
  // floor by the same noise. Positive only — the blend clamps a negative source to zero.
  gl_FragColor.rgb = uLift * vig * max(0.0, 1.0 + n * 2.0 * uGrainLift);
}
`;

export interface FilmGrade {
  /** Call once per frame, before the render. */
  update: (dt: number) => void;
  setEnabled: (on: boolean) => void;
  isEnabled: () => boolean;
  dispose: () => void;
}

/**
 * Hang the grade off `camera`. The quad sits just past the near plane and is sized from the camera's
 * own fov and aspect each frame, which is a handful of multiplies and means it survives an
 * orientation change without a resize listener of its own.
 */
export function installFilmGrade(renderer: WebGLRenderer, camera: PerspectiveCamera): FilmGrade {
  const buf = new Vector2();
  const mat = new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uAspect: { value: 1 },
      uTime: { value: 0 },
      uGrainRes: { value: new Vector2(960, 540) },
      uLift: { value: LIFT.clone() },
      uVigStart: { value: VIG.start },
      uVigEnd: { value: VIG.end },
      uVigStrength: { value: VIG.strength },
      uGrainGain: { value: GRAIN.gain },
      uGrainLift: { value: GRAIN.lift },
    },
    transparent: true,
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: SrcAlphaFactor,
    depthTest: false,
    depthWrite: false,
    // Nothing here is a colour to be graded; it *is* the grade. A raw ShaderMaterial gets neither the
    // tone-mapping nor the output-colour-space chunk appended, which is exactly what this needs — the
    // frame underneath is already encoded, and these factors are meant to apply to it as encoded.
    toneMapped: false,
    fog: false,
    lights: false,
  });
  const geo = new PlaneGeometry(1, 1);
  const mesh = new Mesh(geo, mat);
  mesh.name = 'grade';
  mesh.renderOrder = ORDER;
  mesh.frustumCulled = false;
  mesh.position.z = -0.2;
  camera.add(mesh);

  let clock = 0;
  let enabled = true;

  return {
    update: (dt) => {
      if (!enabled) return;
      // Wrapped rather than accumulated. See FRAG: the grain hash runs through sin() at mediump, and a
      // clock that keeps counting stops changing the low bits long before the player stops playing.
      clock = (clock + dt * 60) % 1024;
      mat.uniforms['uTime']!.value = clock;
      mat.uniforms['uAspect']!.value = camera.aspect;
      renderer.getDrawingBufferSize(buf);
      (mat.uniforms['uGrainRes']!.value as Vector2).set(buf.x / GRAIN_PX, buf.y / GRAIN_PX);
      // Sized from the camera each frame so a fov or orientation change needs no listener. 1.02 rather
      // than 1.0 because a quad that lands exactly on the frustum edge leaves a seam when the
      // projection is nudged by dynamic resolution.
      const h = 2 * 0.2 * Math.tan((camera.fov * Math.PI) / 360) * 1.02;
      mesh.scale.set(h * camera.aspect, h, 1);
    },
    setEnabled: (on) => {
      enabled = on;
      mesh.visible = on;
    },
    isEnabled: () => enabled,
    dispose: () => {
      camera.remove(mesh);
      geo.dispose();
      mat.dispose();
    },
  };
}
