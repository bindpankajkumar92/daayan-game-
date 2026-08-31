/**
 * CarveBox — subtract an axis-aligned box from an imported model's triangles, at load.
 *
 * The upper flat arrives as a cutaway diorama, and one of its rooms is sealed: the panel between the
 * room the stair opens into and the corridor beyond it is 3.45 x 2.92 m of unbroken wall, drawn on both
 * faces, with no doorway anywhere along it. Measured on the live scene, that walls off 43.8 m2 of a
 * 59 m2 flat — every room the player was supposed to be able to enter.
 *
 * A collider gap alone is not an answer. ModelPlacement.walls builds the flat's colliders *from* the
 * model's own faces precisely so that what stops the player is what is drawn, and deleting a box out of
 * that set would put the player back to walking through a visible wall. So the hole has to be cut in
 * the geometry, and then the colliders follow for free.
 *
 * Dropping whole triangles is not an answer either. This file is coarse where it is flat: the panel is
 * 64 triangles for 10.7 m2, with single triangles spanning 2.5 m, so culling by overlap would take the
 * wall out from floor to ceiling and halfway along the room. What is needed is a real cut, which means
 * splitting the triangles that straddle the opening.
 *
 * The cut is a boolean subtraction done the cheap way that is exact for this case. A box is the
 * intersection of six half-spaces, so a point is *outside* the box exactly when it is outside at least
 * one of them. Clip each triangle against the six planes in turn: whatever falls outside the plane is
 * outside the box and is kept, and whatever falls inside is passed to the next plane. What survives all
 * six is the part inside the box, and that is the part that goes. Every piece kept is a convex polygon,
 * fanned back into triangles.
 *
 * Two details that matter:
 *
 * - **The decision is made in world space, the output is written in local space.** The boxes are
 *   authored as world rects because that is where the floor plan lives, but a vertex has to go back
 *   into the mesh it came from. Both transforms are affine, so the parameter t at which an edge crosses
 *   a plane is the same in either space: t is solved on world positions and then applied to the local
 *   position and to every other attribute unchanged.
 * - **Geometry is shared and cached.** ModelLoader hands the same Group to every caller, so a carve is
 *   flagged per geometry and skipped on a second pass, exactly as brighten() and curveAlbedo() flag
 *   their materials.
 */

import { BufferAttribute, Vector3, type BufferGeometry, type Mesh, type Object3D } from 'three';

/** A world-space rectangular hole to subtract. */
export interface CarveBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

/** One clipped vertex: its local position and every other attribute, all interpolated together. */
interface Vtx {
  /** World position, for the plane tests. */
  w: [number, number, number];
  /** Local position and every other attribute, in the geometry's own order. */
  a: Float32Array;
}

/** What carveBoxes did, for the caller to report rather than assume. */
export interface CarveReport {
  meshes: number;
  removed: number;
  added: number;
}

/** Half-space count. The six faces of a box, as [axis, sign, value]. */
type Plane = [0 | 1 | 2, 1 | -1, number];

const planesOf = (b: CarveBox): Plane[] => [
  [0, 1, b.x0],
  [0, -1, b.x1],
  [1, 1, b.y0],
  [1, -1, b.y1],
  [2, 1, b.z0],
  [2, -1, b.z1],
];

/**
 * Signed distance to a half-space, positive *outside* the box.
 *
 * For the low face of an axis the outside is below the value, so the sign flips; `s` carries that.
 */
const dist = (p: Plane, w: [number, number, number]): number => p[1] * (p[2] - w[p[0]]);

/**
 * Split `poly` by one plane into the part outside the box and the part inside it.
 *
 * Sutherland-Hodgman run twice over the same edge walk, so a crossing produces one interpolated vertex
 * that both halves share and the cut edge cannot open a seam.
 */
function split(poly: Vtx[], p: Plane, out: Vtx[], keep: Vtx[]): void {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i] as Vtx;
    const b = poly[(i + 1) % n] as Vtx;
    const da = dist(p, a.w);
    const db = dist(p, b.w);
    if (da >= 0) out.push(a);
    if (da <= 0) keep.push(a);
    if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
      const t = da / (da - db);
      const m: Vtx = {
        w: [
          a.w[0] + (b.w[0] - a.w[0]) * t,
          a.w[1] + (b.w[1] - a.w[1]) * t,
          a.w[2] + (b.w[2] - a.w[2]) * t,
        ],
        a: new Float32Array(a.a.length),
      };
      for (let k = 0; k < a.a.length; k++) {
        m.a[k] = (a.a[k] as number) + ((b.a[k] as number) - (a.a[k] as number)) * t;
      }
      out.push(m);
      keep.push(m);
    }
  }
}

/**
 * The parts of `poly` that lie outside `b`, as convex polygons. Empty when the polygon was entirely
 * inside the box, i.e. entirely cut away.
 */
function subtract(poly: Vtx[], b: CarveBox): Vtx[][] {
  const out: Vtx[][] = [];
  let remaining: Vtx[][] = [poly];
  for (const p of planesOf(b)) {
    const next: Vtx[][] = [];
    for (const piece of remaining) {
      const outside: Vtx[] = [];
      const inside: Vtx[] = [];
      split(piece, p, outside, inside);
      if (outside.length >= 3) out.push(outside);
      if (inside.length >= 3) next.push(inside);
    }
    remaining = next;
    if (remaining.length === 0) break;
  }
  return out;
}

/** Does a triangle's world box reach into `b` at all? Conservative: a false yes only costs a re-fan. */
function touches(a: Vtx, b2: Vtx, c: Vtx, b: CarveBox): boolean {
  return (
    Math.max(a.w[0], b2.w[0], c.w[0]) > b.x0 &&
    Math.min(a.w[0], b2.w[0], c.w[0]) < b.x1 &&
    Math.max(a.w[1], b2.w[1], c.w[1]) > b.y0 &&
    Math.min(a.w[1], b2.w[1], c.w[1]) < b.y1 &&
    Math.max(a.w[2], b2.w[2], c.w[2]) > b.z0 &&
    Math.min(a.w[2], b2.w[2], c.w[2]) < b.z1
  );
}

/**
 * Cut `boxes` out of one mesh. Returns null when the geometry cannot be carved or has been already.
 *
 * Attributes are read back through getComponent and rewritten as plain floats, which denormalises
 * anything meshopt packed as a normalised integer. That is a size cost on the handful of meshes a
 * doorway touches and it is what makes the interpolation above type-blind.
 */
function carveMesh(mesh: Mesh, boxes: CarveBox[]): { removed: number; added: number } | null {
  const geo = mesh.geometry as BufferGeometry;
  if (geo.userData['carved'] === true) return null;
  // Draw groups index into the index buffer, and the index buffer is exactly what is rebuilt below;
  // morph targets are a second copy of the positions that no longer matches. Neither is in this file.
  if (geo.groups.length > 0 || Object.keys(geo.morphAttributes).length > 0) return null;
  const pos = geo.getAttribute('position');
  if (pos === undefined) return null;
  geo.userData['carved'] = true;

  const names = Object.keys(geo.attributes);
  const sizes = names.map((n) => geo.getAttribute(n).itemSize);
  const stride = sizes.reduce((s, x) => s + x, 0);
  let posOff = -1;
  for (let k = 0, o = 0; k < names.length; k++) {
    if (names[k] === 'position') posOff = o;
    o += sizes[k] as number;
  }
  if (posOff < 0) return null;

  const base = pos.count;
  const idx = geo.getIndex();
  const triCount = Math.floor((idx ? idx.count : base) / 3);
  const m = mesh.matrixWorld;
  const v = new Vector3();
  const read = (i: number): Vtx => {
    const a = new Float32Array(stride);
    for (let k = 0, o = 0; k < names.length; k++) {
      const at = geo.getAttribute(names[k] as string);
      const size = sizes[k] as number;
      for (let c = 0; c < size; c++) a[o + c] = at.getComponent(i, c);
      o += size;
    }
    v.set(a[posOff] as number, a[posOff + 1] as number, a[posOff + 2] as number).applyMatrix4(m);
    return { w: [v.x, v.y, v.z], a };
  };

  const newIndex: number[] = [];
  const extra: Float32Array[] = [];
  let removed = 0;
  let added = 0;
  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    const a = read(i0);
    const b = read(i1);
    const c = read(i2);
    if (!boxes.some((x) => touches(a, b, c, x))) {
      newIndex.push(i0, i1, i2);
      continue;
    }
    let pieces: Vtx[][] = [[a, b, c]];
    for (const box of boxes) {
      const next: Vtx[][] = [];
      for (const p of pieces) next.push(...subtract(p, box));
      pieces = next;
      if (pieces.length === 0) break;
    }
    removed++;
    for (const p of pieces) {
      // Fan from the first vertex. Every piece is convex, so a fan is a valid triangulation.
      for (let k = 2; k < p.length; k++) {
        extra.push((p[0] as Vtx).a, (p[k - 1] as Vtx).a, (p[k] as Vtx).a);
        newIndex.push(base + extra.length - 3, base + extra.length - 2, base + extra.length - 1);
        added++;
      }
    }
  }
  if (removed === 0) return { removed: 0, added: 0 };

  const total = base + extra.length;
  for (let k = 0, o = 0; k < names.length; k++) {
    const name = names[k] as string;
    const at = geo.getAttribute(name);
    const size = sizes[k] as number;
    const arr = new Float32Array(total * size);
    for (let i = 0; i < base; i++) for (let cc = 0; cc < size; cc++) arr[i * size + cc] = at.getComponent(i, cc);
    for (let e = 0; e < extra.length; e++) {
      const src = extra[e] as Float32Array;
      for (let cc = 0; cc < size; cc++) arr[(base + e) * size + cc] = src[o + cc] as number;
    }
    geo.setAttribute(name, new BufferAttribute(arr, size));
    o += size;
  }
  geo.setIndex(newIndex);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return { removed, added };
}

/**
 * Cut every box out of every mesh under `root`, in world space. Call after the fit and after the model
 * is in the scene graph, and before ModelPlacement.walls slices it — the collider gap is a consequence
 * of the hole rather than a second thing to keep in step with it.
 */
export function carveBoxes(root: Object3D, boxes: CarveBox[]): CarveReport {
  root.updateWorldMatrix(true, true);
  const targets: Mesh[] = [];
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (mesh.isMesh) targets.push(mesh);
  });
  const rep: CarveReport = { meshes: 0, removed: 0, added: 0 };
  for (const mesh of targets) {
    const r = carveMesh(mesh, boxes);
    if (r === null || r.removed === 0) continue;
    rep.meshes++;
    rep.removed += r.removed;
    rep.added += r.added;
  }
  return rep;
}
