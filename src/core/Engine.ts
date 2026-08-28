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

export class Engine {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  private container: HTMLElement;
  private clock = new Clock();
  private resizeHandler: () => void;

  // Pooled temporaries so the hot loop can avoid per-frame allocations.
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new WebGLRenderer({
      antialias: false, // off for perf; we rely on FXAA/lighting instead
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
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
  }

  private handleResize(): void {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  beginFrame(): number {
    // Returns the frame delta in seconds (clamped to a sane value).
    const dt = this.clock.getDelta();
    return Math.min(dt, 0.1);
  }

  endFrame(): void {
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
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
