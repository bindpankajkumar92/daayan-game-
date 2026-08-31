/**
 * Engine — owns the renderer, scene, camera, and resize handling.
 * Renders to the #app element. No game logic here, just the GL plumbing.
 */

import {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  Clock,
  ACESFilmicToneMapping,
  SRGBColorSpace,
  PCFSoftShadowMap,
  Vector3,
} from 'three';
import { installFilmGrade, type FilmGrade } from '@/core/FilmGrade';

export class Engine {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  /**
   * The display grade. Engine-level rather than scene-level because it grades the *frame*, so every
   * scene including the dev harness gets the same one, and because endFrame is the only place that
   * knows a frame is about to be produced. See FilmGrade: it is one blended quad, not a pass.
   */
  readonly grade: FilmGrade;
  private container: HTMLElement;
  private clock = new Clock();
  private resizeHandler: () => void;
  /** Last delta handed out by beginFrame, so endFrame can tick the grade without being passed it. */
  private lastDt = 0;

  /** Multiplier applied on top of the capped device pixel ratio. Driven by QualityManager. */
  private resolutionScale = 1.0;
  /**
   * Hard ceiling on device pixel ratio. A 440 dpi phone reports ~2.75; rendering a 3D scene
   * at that density is pure waste — 2.0 is already past the point the eye resolves detail,
   * and the pixel count scales quadratically.
   */
  private pixelRatioCap = 2.0;

  // Pooled temporaries so the hot loop can avoid per-frame allocations.
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new WebGLRenderer({
      // On. The comment this replaces said "off for perf; we rely on FXAA/lighting instead" — there
      // was never an FXAA pass, so nothing was anti-aliasing anything, and the house is full of the
      // geometry that punishes that: baluster edges, gate mouldings, the hair cards' alphaTest rim.
      // The target phone is a tiled Adreno, where MSAA resolves inside tile memory rather than by
      // re-reading a full-size buffer, which is why it is the one quality switch that costs closer to
      // nothing than to a pass. Measured against the 13.2 ms of a 33.3 ms budget the finished house
      // was drawing in before this; if a device ever cannot hold the 30 FPS floor, QualityManager's
      // dynamic resolution gives ground first and this is the next thing to take away.
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    // The baseline grade for the whole game. ACES is doing the heavy lifting on a lantern-lit scene —
    // it rolls the flame's near field off instead of clipping it — but its toe also crushes the
    // shadows, and on a phone in a lit room that read as a black screen. HouseScene lifts this
    // further per storey; see the `up` term in its frame loop.
    this.renderer.toneMappingExposure = 1.35;
    this.renderer.shadowMap.enabled = false; // disabled by default; mid/high tier may opt in
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.setClearColor(0x000000, 1);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';

    this.scene = new Scene();

    this.camera = new PerspectiveCamera(70, 1, 0.1, 200);
    this.camera.position.set(0, 1.7, 0); // eye height
    this.camera.lookAt(0, 1.7, -1);

    this.resizeHandler = () => this.handleResize();
    window.addEventListener('resize', this.resizeHandler);
    window.addEventListener('orientationchange', this.resizeHandler);
    this.handleResize();

    // Last, because it parents itself to the camera and wants the renderer's buffer size.
    this.grade = installFilmGrade(this.renderer, this.camera);
  }

  /**
   * Set the dynamic-resolution multiplier. This is the ONLY place render resolution is
   * decided: it goes through setPixelRatio so the CSS size of the canvas always stays at
   * 100% of the container. Scaling via setSize() instead (the previous approach) shrank the
   * drawing buffer while leaving the canvas stretched across the full screen, which is why
   * the scene looked soft — it was being upscaled ~2x by the compositor.
   */
  setResolutionScale(scale: number): void {
    this.resolutionScale = scale;
    this.handleResize();
  }

  getEffectivePixelRatio(): number {
    const dpr = window.devicePixelRatio || 1;
    return Math.min(dpr, this.pixelRatioCap) * this.resolutionScale;
  }

  /** CSS pixel size of the canvas — useful for the debug overlay. */
  getCssSize(): { width: number; height: number } {
    return {
      width: this.container.clientWidth || window.innerWidth,
      height: this.container.clientHeight || window.innerHeight,
    };
  }

  private handleResize(): void {
    const { width, height } = this.getCssSize();
    this.renderer.setPixelRatio(this.getEffectivePixelRatio());
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  beginFrame(): number {
    // Returns the frame delta in seconds (clamped to a sane value).
    const dt = this.clock.getDelta();
    this.lastDt = Math.min(dt, 0.1);
    return this.lastDt;
  }

  endFrame(): void {
    // Before the render, not after: the grade's uniforms have to be current for the draw they affect.
    this.grade.update(this.lastDt);
    this.renderer.render(this.scene, this.camera);
  }

  /** Accessors for pooled Vector3s — use these in the hot loop to avoid GC. */
  getTempVec3A(): Vector3 {
    return this.tmpA;
  }
  getTempVec3B(): Vector3 {
    return this.tmpB;
  }

  dispose(): void {
    window.removeEventListener('resize', this.resizeHandler);
    window.removeEventListener('orientationchange', this.resizeHandler);
    this.grade.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
