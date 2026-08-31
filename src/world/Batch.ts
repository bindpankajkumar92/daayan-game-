/**
 * Batch — collects world-space geometry per material and merges it into one mesh each.
 *
 * The house dressing is roughly two hundred boxes and cylinders. As individual meshes that is two
 * hundred draw calls, which on the 4 GB target is the whole frame budget spent on furniture
 * nobody looks at twice. Merged by material it is six.
 *
 * The cost is that a batched prop cannot move. That is the right default here: beds, benches and
 * mantelpieces never move, and the handful of things that do — lids, the shelf, the gate leaves —
 * are built as their own meshes by Fixtures and never come through this class.
 */

import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  RingGeometry,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Largest edge, in metres, allowed on a batched box's quad — the same number and the same reason as
 * HouseBuilder's SLAB_SEG, which documents it: a triangle big enough to put a vertex on the camera
 * plane loses its 1/w interpolation and its depth comes out metres wrong. Most dressing is well under
 * a metre and subdivides into itself at no cost; it is the few long ones — the 15.6 x 1.1 m hallway
 * runner is the worst — that were drawing the artefact.
 */
const QUAD = 1;
const segs = (n: number): number => Math.max(1, Math.ceil(n / QUAD));

export class Batch {
  private buckets = new Map<Material, BufferGeometry[]>();
  private names = new Map<Material, string>();

  /** Take ownership of a geometry that has already been baked into world space. */
  add(mat: Material, geo: BufferGeometry, name?: string): void {
    let list = this.buckets.get(mat);
    if (!list) {
      list = [];
      this.buckets.set(mat, list);
      this.names.set(mat, name ?? 'props');
    }
    list.push(geo);
  }

  box(
    mat: Material,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    ry = 0,
  ): void {
    const g = new BoxGeometry(w, h, d, segs(w), segs(h), segs(d));
    if (ry !== 0) g.rotateY(ry);
    g.translate(x, y, z);
    this.add(mat, g);
  }

  /** Upright cylinder. `axis` tips it onto its side when a rail or a rolled rug is wanted. */
  cyl(
    mat: Material,
    rTop: number,
    rBot: number,
    h: number,
    seg: number,
    x: number,
    y: number,
    z: number,
    axis: 'y' | 'x' | 'z' = 'y',
  ): void {
    const g = new CylinderGeometry(rTop, rBot, h, seg);
    if (axis === 'x') g.rotateZ(Math.PI / 2);
    else if (axis === 'z') g.rotateX(Math.PI / 2);
    g.translate(x, y, z);
    this.add(mat, g);
  }

  /** Flat ring on the floor — chalk circles, scuff arcs, water stains. */
  ring(
    mat: Material,
    inner: number,
    outer: number,
    seg: number,
    x: number,
    y: number,
    z: number,
    thetaStart = 0,
    thetaLength = Math.PI * 2,
  ): void {
    const g = new RingGeometry(inner, outer, seg, 1, thetaStart, thetaLength);
    g.rotateX(-Math.PI / 2);
    g.translate(x, y, z);
    this.add(mat, g);
  }

  /**
   * Merge every bucket into the group and reset. Returns the geometries so the caller can track
   * them for disposal — merged buffers are the only thing in here that outlives the call.
   */
  flush(group: Group, prefix: string): BufferGeometry[] {
    const out: BufferGeometry[] = [];
    let i = 0;
    for (const [mat, geos] of this.buckets) {
      const merged = mergeGeometries(geos);
      for (const g of geos) g.dispose();
      if (!merged) continue;
      const mesh = new Mesh(merged, mat);
      mesh.name = `${prefix}-${this.names.get(mat) ?? 'batch'}-${i++}`;
      group.add(mesh);
      out.push(merged);
    }
    this.buckets.clear();
    this.names.clear();
    return out;
  }
}
