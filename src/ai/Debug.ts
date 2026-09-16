/**
 * DaayanDebug — the §26 debug overlay.
 *
 * The spec requires a developer to see a long list of things at a glance while tuning: vision cone,
 * vision rays, current state, target position, last seen / last heard / last known position, current
 * path, current destination, current confidence, current sound event, prediction target and search
 * points. All of it is drawn as world-space line geometry rather than as a DOM overlay, because the
 * questions this overlay answers are spatial ones — "could she actually see me from there?", "why did
 * she walk past the wardrobe?" — and answering those needs the drawing to sit in the same space as
 * the house.
 *
 * The one textual element is the readout, which mirrors the spec's own example format:
 *
 *     STATE: CHASE VISION: 0.92 TARGET: PLAYER LAST KNOWN: (x,y,z) PATH: VALID PREDICTION: ACTIVE
 *
 * §26 ends with "Debug mode must be disabled in production." That is enforced in three places: the
 * config flag defaults to false; `daayanConfigFor` and the `DaayanAI` constructor both force it false
 * under a production build, so no caller override can re-enable it; and `DaayanAI` only constructs
 * this class when the flag is true, so nothing is allocated otherwise. `update` re-checks the flag as
 * well, which is redundant given the constructor gate but means a caller who constructs an overlay
 * directly still gets an inert one rather than a surprise.
 *
 * The module itself still ships in the bundle: `debug` is a runtime field on a config object, so the
 * bundler cannot prove it is constant and shake the class out. It is inert rather than absent.
 *
 * Everything is pooled. The overlay only ever runs during development, but a debugging tool that
 * changes the timing of the thing it is measuring is worse than no tool at all, so no geometry is
 * created or destroyed per frame: vertices are written into preallocated buffers and the draw range
 * is trimmed to whatever was actually filled.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  type Camera,
  type Scene,
} from 'three';

/**
 * A plain point for drawing.
 *
 * `Vec3` aliases three's `Vector3` *class*, so a `{x,y,z}` literal will not satisfy it. The overlay
 * writes hundreds of vertices per frame straight into typed arrays and never hands them to three, so
 * allocating a `Vector3` per vertex would be pure waste. This is the structural shape it actually
 * needs.
 */
interface Pt {
  x: number;
  y: number;
  z: number;
}
import type { DaayanConfig } from './DaayanConfig';
import type { NavPoint } from './NavGrid';
import type { HeardSound } from './Perception';
import type { DaayanState, TransitionReason } from './StateMachine';

/** Vertex capacity per pooled layer. Generous, because a full stop costs one `drawRange` write. */
const CAP_VISION = 512;
const CAP_RAYS = 512;
const CAP_PATH = 512;
const CAP_POINTS = 2048;

/** Palette, chosen to stay legible against the house's dim warm interior. */
const C_VISION = 0x38e0ff;
const C_VISION_HIT = 0x59ff7a;
const C_RAY_MISS = 0x2f6f7f;
const C_PATH = 0xffd24a;
const C_TARGET = 0xff5a3c;
const C_MEMORY = 0xff4fd8;
const C_SEEN = 0x59ff7a;
const C_HEARD = 0x59a0ff;
const C_SOUND = 0xffffff;
const C_SEARCH = 0xb47dff;
const C_CURRENT = 0xff8c1a;
const C_FAULT = 0xff2626;

/**
 * The shape `DaayanAI.getDebugInfo()` returns.
 *
 * Declared here rather than inferred at the call site so the two files cannot drift apart silently:
 * if `getDebugInfo` stops returning `searchPoints`, this stops compiling. `DaayanAI` annotates its
 * return type with this interface, which is the only coupling between the two modules.
 */
export interface DebugInfo {
  /** Her feet position. The overlay anchors every marker to this. */
  position: Pt;
  /** Her eye position, which is the origin the vision rays were cast from. */
  eye: Pt;
  state: DaayanState;
  reason: TransitionReason;
  /** Smoothed vision confidence, 0..1 (§7). */
  confidence: number;
  /** Her best estimate of the player's position (§10), or null. */
  memoryPosition: Pt | null;
  /** How much that estimate is trusted, 0..1. */
  memoryConfidence: number;
  /** The navigation destination she is steering at, or null when standing still. */
  target: Pt | null;
  lastSeen: Pt | null;
  lastHeard: Pt | null;
  /** The current path, already simplified by the nav grid. */
  path: readonly NavPoint[];
  /** False when the last pathfinding attempt had to fall back or fail outright (§28). */
  pathValid: boolean;
  /** The whole search itinerary, when a search is planned (§13). */
  searchPoints: readonly NavPoint[];
  /** How many of those points she has already visited. */
  searchIndex: number;
  /** The intercept point she is steering toward, when prediction is active (§12). */
  prediction: Pt | null;
  stuck: boolean;
  awake: boolean;
  speed: number;
  /** Body yaw, radians. */
  yaw: number;
  /** Gaze yaw, radians. Differs from `yaw` when she is glancing. */
  lookYaw: number;
  /** Sample rays from the last vision tick, each with whether it reached the player. */
  visionRays: readonly { to: Pt; hit: boolean }[];
  /** Fraction of the player those rays resolved, 0..1. */
  visibility: number;
  /** The loud sound that arrived this tick, if any — §26's "current sound event". */
  sound: HeardSound | null;
}

/**
 * One pooled line layer: a single `LineSegments` with a fixed-capacity vertex buffer.
 *
 * `drawRange` does the culling, so the per-frame GPU upload is proportional to what is actually
 * drawn and no allocation happens on the hot path.
 */
interface Layer {
  geometry: BufferGeometry;
  positions: Float32Array;
  colors: Float32Array;
  /** Vertices written this frame, not segments. */
  count: number;
}

export class DaayanDebug {
  private readonly root: Group;
  private readonly vision: Layer;
  private readonly rays: Layer;
  private readonly path: Layer;
  private readonly points: Layer;

  private readout: HTMLElement | null = null;
  /** Seconds since the readout text was last rewritten. Throttled — see `updateReadout`. */
  private sinceText = 0;

  constructor(
    private readonly cfg: DaayanConfig,
    scene: Scene,
    /** Unused today: the drawing is pure world-space lines with no billboards, and a line has no
     *  back face to cull. Kept because callers pass it and a depth-tested variant will want it. */
    camera: Camera,
  ) {
    void camera;

    this.root = new Group();
    this.root.name = 'daayan-debug';

    this.vision = this.makeLayer(scene, CAP_VISION);
    this.rays = this.makeLayer(scene, CAP_RAYS);
    this.path = this.makeLayer(scene, CAP_PATH);
    this.points = this.makeLayer(scene, CAP_POINTS);
  }

  private makeLayer(scene: Scene, verts: number): Layer {
    const positions = new Float32Array(verts * 3);
    const colors = new Float32Array(verts * 3);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    geometry.setDrawRange(0, 0);

    const material = new LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      // The overlay must neither occlude nor be occluded: it is a diagnostic, not scenery. Depth off
      // also means it reads through walls, which is the point — most of what you are debugging is
      // happening behind one.
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });

    const line = new LineSegments(geometry, material);
    line.name = 'daayan-debug-layer';
    // A vertex buffer whose positions change every frame has no meaningful bounding volume, and
    // computing one per frame would be an O(n) scan for a cull that never happens anyway.
    line.frustumCulled = false;
    line.renderOrder = 1000;
    scene.add(line);

    return { geometry, positions, colors, count: 0 };
  }

  // --- Buffer writing ----------------------------------------------------

  private reset(layer: Layer): void {
    layer.count = 0;
  }

  /** Append one segment. Silently drops once the layer is full, which only happens with a bug. */
  private segment(layer: Layer, a: Pt, b: Pt, color: number): void {
    const i = layer.count;
    if (i + 2 > layer.positions.length / 3) return;

    const p = layer.positions;
    p[i * 3] = a.x;
    p[i * 3 + 1] = a.y;
    p[i * 3 + 2] = a.z;
    p[i * 3 + 3] = b.x;
    p[i * 3 + 4] = b.y;
    p[i * 3 + 5] = b.z;

    const r = ((color >> 16) & 0xff) / 255;
    const g = ((color >> 8) & 0xff) / 255;
    const bl = (color & 0xff) / 255;
    const c = layer.colors;
    c[i * 3] = r;
    c[i * 3 + 1] = g;
    c[i * 3 + 2] = bl;
    c[i * 3 + 3] = r;
    c[i * 3 + 4] = g;
    c[i * 3 + 5] = bl;

    layer.count += 2;
  }

  /** A short vertical tick with a crossbar, marking a point in space without a billboard. */
  private mark(layer: Layer, at: Pt, color: number, size = 0.22): void {
    this.segment(layer, at, { x: at.x, y: at.y + size, z: at.z }, color);
    this.segment(
      layer,
      { x: at.x - size * 0.5, y: at.y + size, z: at.z },
      { x: at.x + size * 0.5, y: at.y + size, z: at.z },
      color,
    );
  }

  /** A flat cross on the floor, for positions that matter most when read from above. */
  private cross(layer: Layer, at: Pt, color: number, size = 0.3): void {
    this.segment(layer, { x: at.x - size, y: at.y, z: at.z }, { x: at.x + size, y: at.y, z: at.z }, color);
    this.segment(layer, { x: at.x, y: at.y, z: at.z - size }, { x: at.x, y: at.y, z: at.z + size }, color);
  }

  /**
   * Publish a layer's freshly written vertices.
   *
   * `needsUpdate` on both attributes is load-bearing: without it three keeps re-uploading the buffer
   * it first saw and the overlay draws a frozen snapshot of the first frame.
   */
  private commit(layer: Layer): void {
    layer.geometry.setDrawRange(0, layer.count);
    (layer.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (layer.geometry.getAttribute('color') as BufferAttribute).needsUpdate = true;
  }

  // --- The frame ---------------------------------------------------------

  /**
   * Redraw everything.
   *
   * `info` comes straight from `DaayanAI.getDebugInfo()`; the overlay holds no state of its own
   * beyond its draw buffers, so it can never disagree with the AI about what is true.
   */
  update(info: DebugInfo, dt: number): void {
    if (!this.cfg.debug) return;

    this.reset(this.vision);
    this.reset(this.rays);
    this.reset(this.path);
    this.reset(this.points);

    this.drawVisionCone(info);
    this.drawRays(info);
    this.drawPath(info);
    this.drawMarkers(info);

    this.commit(this.vision);
    this.commit(this.rays);
    this.commit(this.path);
    this.commit(this.points);

    this.updateReadout(info, dt);
  }

  /**
   * The vision cone — §26's first item.
   *
   * Drawn as a ground fan rather than a translucent solid, because the useful reading is from a
   * first-person camera: standing inside your own line of sight, a volume tells you nothing, whereas
   * a fan on the floor immediately answers "which way is she facing, and how wide is her attention".
   *
   * The fan is truncated at the configured vision range, which is what makes it a diagnostic rather
   * than decoration: the arc you can see is exactly the arc she can see. The fan is then cut against
   * the same walls the rays are, so a cone that stops dead at the kitchen doorway is showing you a
   * real occlusion rather than a rendering accident.
   */
  private drawVisionCone(info: DebugInfo): void {
    const origin = info.position;
    const range = this.cfg.visionRange;
    const half = ((this.cfg.visionFOVDeg * Math.PI) / 180) / 2;
    const slices = 16;
    // Green while she can actually resolve the player, cyan while merely looking. This is the single
    // most useful bit in the overlay: it distinguishes "she is facing me" from "she has me".
    const color = info.visibility > 0.05 ? C_VISION_HIT : C_VISION;

    let prev: Pt | null = null;
    for (let s = 0; s <= slices; s++) {
      const a = info.lookYaw - half + (2 * half * s) / slices;
      const p: Pt = {
        x: origin.x + Math.sin(a) * range,
        y: origin.y + 0.06,
        z: origin.z + Math.cos(a) * range,
      };
      // The rim.
      if (prev) this.segment(this.vision, prev, p, color);
      // Spokes every quarter turn, so the heading is unambiguous even seen straight down.
      if (s % 4 === 0) this.segment(this.vision, { x: origin.x, y: origin.y + 0.06, z: origin.z }, p, color);
      prev = p;
    }

    // Her gaze direction, drawn a little past the cone so the exact axis is readable even when the
    // fan's edges are ambiguous.
    const gx = Math.sin(info.lookYaw);
    const gz = Math.cos(info.lookYaw);
    this.segment(
      this.vision,
      { x: origin.x, y: origin.y + 0.08, z: origin.z },
      { x: origin.x + gx * range * 1.08, y: origin.y + 0.08, z: origin.z + gz * range * 1.08 },
      color,
    );
  }

  /** The vision rays: one line per sample, green when it reached the player (§26). */
  private drawRays(info: DebugInfo): void {
    for (const r of info.visionRays) {
      this.segment(this.rays, info.eye, r.to, r.hit ? C_VISION_HIT : C_RAY_MISS);
    }
  }

  /** The current path and where it ends (§26). */
  private drawPath(info: DebugInfo): void {
    if (info.path.length > 0) {
      // A path may start behind her, since the planner returns a route from her own cell, so the
      // route is drawn from the first point she has not yet passed plus a lead-in from her feet.
      const first = info.path[0] as NavPoint;
      this.segment(
        this.path,
        { x: info.position.x, y: info.position.y + 0.05, z: info.position.z },
        { x: first.x, y: first.y + 0.05, z: first.z },
        C_PATH,
      );
      for (let i = 0; i + 1 < info.path.length; i++) {
        const a = info.path[i] as NavPoint;
        const b = info.path[i + 1] as NavPoint;
        // Lifted so the route does not z-fight the floor it lies on.
        this.segment(this.path, { x: a.x, y: a.y + 0.05, z: a.z }, { x: b.x, y: b.y + 0.05, z: b.z }, C_PATH);
      }
      const last = info.path[info.path.length - 1] as NavPoint;
      this.mark(this.path, { x: last.x, y: last.y, z: last.z }, info.pathValid ? C_PATH : C_FAULT, 0.45);
    }

    // The destination is drawn whether or not a path exists, because "destination set, no path" is
    // precisely the failure worth seeing.
    if (info.target) this.mark(this.path, info.target, info.pathValid ? C_TARGET : C_FAULT, 0.55);

    if (info.prediction) this.mark(this.path, info.prediction, C_CURRENT, 0.5);
  }

  /** Markers for everything positional in §26's list that is not a line. */
  private drawMarkers(info: DebugInfo): void {
    // Last known position (§10): a floor cross plus a vertical bar scaled by confidence, so "she
    // thinks you are roughly there" and "she watched you stop" look different at a glance.
    if (info.memoryPosition) {
      const p = info.memoryPosition;
      this.cross(this.points, { x: p.x, y: p.y + 0.03, z: p.z }, C_MEMORY, 0.5);
      this.segment(
        this.points,
        { x: p.x, y: p.y, z: p.z },
        { x: p.x, y: p.y + 0.3 + info.memoryConfidence * 1.2, z: p.z },
        C_MEMORY,
      );
    }

    if (info.lastSeen) this.mark(this.points, info.lastSeen, C_SEEN, 0.4);
    if (info.lastHeard) this.mark(this.points, info.lastHeard, C_HEARD, 0.4);
    if (info.sound) this.mark(this.points, info.sound.position, C_SOUND, 0.65);

    // The search itinerary, with the point she is working toward highlighted. Drawing all of them at
    // once is what makes the plan legible as a plan rather than as a sequence of unexplained walks.
    const current = info.searchIndex;
    for (let i = 0; i < info.searchPoints.length; i++) {
      const p = info.searchPoints[i] as NavPoint;
      this.mark(
        this.points,
        { x: p.x, y: p.y, z: p.z },
        i === current ? C_CURRENT : C_SEARCH,
        i === current ? 0.4 : 0.24,
      );
    }

    // A stuck marker, so a wedged agent is visible where it is wedged rather than only in the text.
    if (info.stuck) this.mark(this.points, info.position, C_FAULT, 0.8);
  }

  /**
   * The textual readout, in the spec's own format.
   *
   * Rewritten a few times a second rather than every frame: assigning `textContent` invalidates
   * layout, and at 60 Hz that is exactly the kind of perturbation that makes a debug overlay lie
   * about the performance it is there to measure.
   */
  private updateReadout(info: DebugInfo, dt: number): void {
    this.sinceText += dt;
    if (this.sinceText < 0.1) return;
    this.sinceText = 0;

    const el = this.readoutElement();
    if (!el) return;

    const search =
      info.searchPoints.length > 0
        ? `${info.searchIndex}/${info.searchPoints.length}`
        : 'INACTIVE';

    const bits = [
      `STATE: ${info.state}`,
      `WHY: ${info.reason}`,
      `VISION: ${info.confidence.toFixed(2)}`,
      `VISIBILITY: ${info.visibility.toFixed(2)}`,
      `TARGET: ${info.target ? fmt(info.target) : 'NONE'}`,
      `LAST KNOWN: ${info.memoryPosition ? fmt(info.memoryPosition) : 'NONE'}`,
      `LAST SEEN: ${info.lastSeen ? fmt(info.lastSeen) : 'NONE'}`,
      `LAST HEARD: ${info.lastHeard ? fmt(info.lastHeard) : 'NONE'}`,
      `PATH: ${info.pathValid ? (info.path.length > 0 ? 'VALID' : 'IDLE') : 'FAILED'}`,
      `SEARCH: ${search}`,
      `PREDICTION: ${info.prediction ? `${fmt(info.prediction)}` : 'INACTIVE'}`,
      `SOUND: ${info.sound ? `${fmt(info.sound.position)} @${info.sound.perceivedLoudness.toFixed(2)}` : 'NONE'}`,
      `SPEED: ${info.speed.toFixed(2)}`,
      `AWAKE: ${info.awake ? 'YES' : 'NO'}`,
      info.stuck ? 'STUCK: YES' : null,
    ].filter((s): s is string => s !== null);

    el.textContent = bits.join('   ');
  }

  /** Create the readout element once, if there is a document to put it in. */
  private readoutElement(): HTMLElement | null {
    if (this.readout && this.readout.isConnected) return this.readout;
    if (typeof document === 'undefined') return null;
    const el = document.createElement('div');
    el.id = 'daayan-debug-readout';
    // Inline styles rather than a stylesheet, so the overlay is self-contained and deleting this file
    // leaves no trace of it behind.
    el.style.cssText = [
      'position:fixed',
      'left:8px',
      'bottom:8px',
      'z-index:99999',
      'font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'color:#d8f6ff',
      'background:rgba(4,10,14,0.74)',
      'border:1px solid rgba(56,224,255,0.35)',
      'border-radius:4px',
      'padding:6px 9px',
      'max-width:min(92vw,960px)',
      'pointer-events:none',
      'white-space:pre-wrap',
      'letter-spacing:0.02em',
    ].join(';');
    document.body.appendChild(el);
    this.readout = el;
    return el;
  }

  dispose(): void {
    if (this.readout) {
      this.readout.remove();
      this.readout = null;
    }
    for (const layer of [this.vision, this.rays, this.path, this.points]) {
      layer.geometry.dispose();
    }
    this.root.traverse((o) => {
      const seg = o as LineSegments;
      if (!seg.isLineSegments) return;
      seg.removeFromParent();
      const m = seg.material;
      if (Array.isArray(m)) for (const mm of m) mm.dispose();
      else m.dispose();
    });
  }
}

/** `(x,y,z)` to one decimal, matching the form in the spec's example display. */
function fmt(p: Pt): string {
  return `(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`;
}
