/**
 * Fixtures — the geometry for everything the player interacts with.
 *
 * Strictly dumb: every function here returns meshes and the handles needed to animate them, and
 * knows nothing about keys, codes or progress. The rule is that a fixture can be looked at and
 * moved, and only HouseScene decides when. Keeping it that way is what lets the gate be built
 * before the puzzles exist, and re-tuned afterwards without touching game logic.
 *
 * Colliders are returned separately rather than added to the scene as invisible boxes, because
 * the controller's AABB list is flat and world-space — see FPController.collidesAabb.
 */

import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshPhongMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { AABB } from '@/player/FPController';
import { makeContactShadowMaterial, makeContactShadowTexture } from '@/world/ContactShadow';

export interface FixtureMats {
  iron: MeshLambertMaterial;
  brass: MeshPhongMaterial;
  wood: MeshLambertMaterial;
  door: MeshLambertMaterial;
  cloth: MeshLambertMaterial;
  bone: MeshLambertMaterial;
  dark: MeshLambertMaterial;
  glow: MeshBasicMaterial;
  paper: MeshLambertMaterial;
  /**
   * The hidden door's lock plate.
   *
   * The one deliberately saturated surface in the house. Everything else here is desaturated on
   * purpose — the palette's reds are `0x4a1418` cloth and nothing else — so this is the only object
   * that reads as a colour rather than a tone, which is the point: it is a lock the player has to
   * notice across a dark corridor, and it is meant to look wrong in the room it is in.
   */
  red: MeshLambertMaterial;
  /**
   * The contact-shadow multiply. In here rather than built where it is used because both users are
   * elsewhere — the procedural dressing merges its shadows through Batch, the imported models add one
   * quad each — and they have to be the *same* material instance or the merge stops being one draw.
   */
  shadow: MeshBasicMaterial;
}

export function makeFixtureMats(
  wood: MeshLambertMaterial,
  door: MeshLambertMaterial,
  track: <T extends { dispose: () => void }>(x: T) => T,
): FixtureMats {
  return {
    wood,
    door,
    iron: track(new MeshLambertMaterial({ color: 0x35353c })),
    brass: track(new MeshPhongMaterial({ color: 0x8a7038, specular: 0xffe9a8, shininess: 60 })),
    cloth: track(new MeshLambertMaterial({ color: 0x4a1418 })),
    bone: track(new MeshLambertMaterial({ color: 0xd8cfb4 })),
    dark: track(new MeshLambertMaterial({ color: 0x14131a })),
    glow: track(new MeshBasicMaterial({ color: 0xffb457 })),
    paper: track(new MeshLambertMaterial({ color: 0xcdc3a8 })),
    red: track(new MeshLambertMaterial({ color: 0xa8201c })),
    // Both tracked: Material.dispose() does not touch its map, so the texture needs its own entry or
    // the canvas and its GPU copy outlive the scene.
    shadow: track(makeContactShadowMaterial(track(makeContactShadowTexture()))),
  };
}

/**
 * Largest edge, in metres, allowed on a box's *triangle* — the same number and the same reason as
 * Batch's QUAD and HouseBuilder's SLAB_SEG: a triangle big enough to put a vertex on the camera
 * plane loses its 1/w interpolation and its depth comes out metres wrong, punching a black wedge
 * through the surface. A casing jamb is 2.1-2.45 m tall and a lintel spans the opening, so every
 * doorway's frame was two-triangle-tall and wide enough to fail. Merged into one mesh by
 * `mergeStaticChildren`, they were the one family of procedural geometry that never passed through
 * the bound — Batch.box subdivides, but these were built with a bare BoxGeometry.
 *
 * The sqrt(2) is the quad diagonal, same as in Batch: the bound that matters is the triangle's
 * longest edge, and a quad's diagonal is sqrt(2) times its side.
 */
const QUAD = 1;
const segs = (n: number): number => Math.max(1, Math.ceil((n * Math.SQRT2) / QUAD));

/** Box helper: a mesh at a world position, with the AABB that matches it if one is wanted. */
export function boxMesh(
  mat: Material,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
): Mesh {
  const m = new Mesh(new BoxGeometry(w, h, d, segs(w), segs(h), segs(d)), mat);
  m.position.set(x, y, z);
  return m;
}

export function aabbOf(x: number, y0: number, z: number, hw: number, hd: number, y1: number): AABB {
  return { minX: x - hw, maxX: x + hw, minY: y0, maxY: y1, minZ: z - hd, maxZ: z + hd };
}

/**
 * A door leaf's keep-out, as `segs` boxes stepped along the leaf's own width.
 *
 * This is the collider half of the wedge described above QUAD. Bounding a triangle's edge cannot help
 * once the eye is *inside* the slab, because then the near plane cuts the triangle whatever its edge
 * length: measured live, a 0.55 m triangle spanning w 0.000..0.427 — a 10554x ratio — fails exactly
 * as a 5 m one would, with the eye 0.070 m from the nearest vertex and 0.401 m past the front face.
 * Hiding the leaf takes the flicker from 494 flipped pixels to 0, so the leaf is the whole of it.
 *
 * The house never kept a head out of its leaves. ModelProps states the policy — "ajar, no blocker, no
 * interaction" — and both swinging doors state it again: "a swinging leaf has no collider of its own".
 * Thirteen of the fourteen leaves let a collision-legal eye reach 0.000-0.003 m of a triangle, 53 to
 * 76 grid points each inside the 0.1 m near plane. Doors are the only geometry in the house a player
 * can walk into, which is why every report of this artefact was at a doorway.
 *
 * Why not one box. A leaf standing ~57 degrees across its opening has a 0.71 x 0.99 m footprint, and
 * collidesAabb inflates a box by the player's radius on each axis independently, so one box round that
 * leaves 0.14 m of lateral freedom in a 1.4 m doorway — passable on paper and horrible to walk
 * through. Stepping the same slab along its own length keeps the box narrow at the hinge end, which is
 * where the player crosses the wall plane.
 *
 * Measured off world vertices rather than off the placement row, for the reason wallColliders is: a
 * row says a yaw and a height, and what those become after the fit is a question for matrixWorld.
 * Which also means this can be re-run on a leaf that has swung, and the boxes will follow it.
 */
export function leafBoxes(parts: Object3D[], segs = 4): AABB[] {
  const pts: number[] = [];
  const v = new Vector3();
  for (const part of parts) {
    part.updateWorldMatrix(true, true);
    part.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const pos = mesh.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        pts.push(v.x, v.y, v.z);
      }
    });
  }
  const n = pts.length / 3;
  if (n < 3) return [];
  // `?? 0` on every read, as wallColliders does with its own flat run of coordinates: the index is
  // always in range here, and noUncheckedIndexedAccess does not know that.
  const at = (i: number, k: number): number => pts[i * 3 + k] ?? 0;
  let yLo = Infinity, yHi = -Infinity, cx = 0, cz = 0;
  for (let i = 0; i < n; i++) {
    cx += at(i, 0);
    cz += at(i, 2);
    const y = at(i, 1);
    if (y < yLo) yLo = y;
    if (y > yHi) yHi = y;
  }
  cx /= n;
  cz /= n;
  // Two passes for the planar diameter — farthest from the centroid, then farthest from that. The axis
  // to step along is the leaf's own long one, and on these rows it is never a world axis: the yaws are
  // 1.0 rad and its reflections, so the slab lies about 57 degrees across its opening.
  const far = (fx: number, fz: number): number => {
    let best = -1, hit = 0;
    for (let i = 0; i < n; i++) {
      const dx = at(i, 0) - fx, dz = at(i, 2) - fz;
      const d2 = dx * dx + dz * dz;
      if (d2 > best) { best = d2; hit = i; }
    }
    return hit;
  };
  const a = far(cx, cz);
  const ax = at(a, 0), az = at(a, 2);
  const b = far(ax, az);
  const bx = at(b, 0), bz = at(b, 2);
  const len = Math.hypot(bx - ax, bz - az);
  if (!(len > 1e-4)) return [];
  const ux = (bx - ax) / len, uz = (bz - az) / len;

  const step = len / segs;
  // Overlapping windows. A step whose extent came only from the vertices strictly inside it would leave
  // a gap wherever the slab is sparsely tessellated, and a keep-out with a gap in it is not one.
  const pad = step * 0.2;
  const out: AABB[] = [];
  for (let k = 0; k < segs; k++) {
    const t0 = k * step - pad, t1 = (k + 1) * step + pad;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const px = at(i, 0), pz = at(i, 2);
      const t = (px - ax) * ux + (pz - az) * uz;
      if (t < t0 || t > t1) continue;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (pz < z0) z0 = pz;
      if (pz > z1) z1 = pz;
    }
    if (x0 > x1) continue;
    out.push({ minX: x0, maxX: x1, minY: yLo, maxY: yHi, minZ: z0, maxZ: z1 });
  }
  return out;
}

/**
 * The same keep-out, on a leaf that swings. Pushes the boxes for where the leaf is now and returns the
 * tick to call while it turns: it re-measures and writes the new numbers into the boxes already pushed,
 * because FPController holds the array by reference and splicing it mid-frame is worse. Returns true
 * from that tick once every box has caught up.
 *
 * The guard is why this is not just "call leafBoxes again on each tween step". FPController has no
 * depenetration — moveAxis rejects a move that ends inside a box and there is nothing that pushes a
 * player out of one — so a box that appears around someone already standing there rejects every
 * direction they try and they are stuck in a doorway. A door swings through exactly the spot the player
 * who opened it is standing in. So a box that would land on the player is left where it was and tried
 * again on the next tick, and the caller keeps ticking until this returns true.
 */
export function trackLeaf(
  parts: Object3D[],
  aabbs: AABB[],
  player: { position: Vector3; getRadius(): number },
  segs = 4,
): () => boolean {
  const live = leafBoxes(parts, segs);
  for (const b of live) aabbs.push(b);
  return (): boolean => {
    const next = leafBoxes(parts, segs);
    if (next.length !== live.length) return true;
    const r = player.getRadius();
    const px = player.position.x, pz = player.position.z;
    let done = true;
    for (let i = 0; i < live.length; i++) {
      const a = live[i], b = next[i];
      if (a === undefined || b === undefined) continue;
      if (a.minX === b.minX && a.maxX === b.maxX && a.minZ === b.minZ && a.maxZ === b.maxZ) continue;
      // Horizontal only, and deliberately conservative: the leaf spans the whole doorway height, so
      // anyone on this storey is within its y band, and erring toward not moving the box costs a frame
      // of lag while erring the other way costs the player their freedom of movement.
      if (px + r > b.minX && px - r < b.maxX && pz + r > b.minZ && pz - r < b.maxZ) {
        done = false;
        continue;
      }
      Object.assign(a, b);
    }
    return done;
  };
}

/** Free every geometry under a group. Materials are shared and disposed by their owner. */
export function disposeGroup(g: Group): void {
  g.traverse((o) => {
    const m = o as Mesh;
    if (m.isMesh) m.geometry.dispose();
  });
}

/**
 * Merge every non-preserved mesh below `root` into one mesh per material, in `root` local space.
 *
 * Fixtures are assembled from small primitives because that makes their dimensions and animation
 * handles readable, but leaving every primitive as a Mesh made the fixture group roughly 150 draw
 * calls. The important distinction is not "interactive versus static": a door or shelf may move as
 * a whole and its children can still be merged safely. What must remain separate are subtrees with an
 * independently animated handle — a bolt, lid, key or flame. Passing those roots in `preserve` skips
 * the whole subtree while everything else is baked relative to `root`.
 *
 * Source geometries in this module are unique to their mesh, so they are disposed as soon as their
 * transformed copies have been merged. The merged buffers remain under `root` and are released by the
 * scene's normal disposeGroup traversal.
 */
function mergeStaticChildren(root: Group, preserve: readonly Object3D[] = []): void {
  const keep = new Set<Object3D>(preserve);
  const buckets = new Map<Material, BufferGeometry[]>();
  const remove: Mesh[] = [];
  const invRoot = new Matrix4();
  const relative = new Matrix4();

  root.updateWorldMatrix(true, true);
  invRoot.copy(root.matrixWorld).invert();

  const visit = (node: Object3D): void => {
    if (keep.has(node)) return;
    if ((node as Mesh).isMesh) {
      const mesh = node as Mesh;
      // Fixture primitives always carry one material. If that changes, leaving the mesh separate is
      // safer than flattening its geometry groups into the wrong material slots.
      if (Array.isArray(mesh.material)) return;
      relative.multiplyMatrices(invRoot, mesh.matrixWorld);
      const baked = mesh.geometry.clone().applyMatrix4(relative);
      let list = buckets.get(mesh.material);
      if (list === undefined) {
        list = [];
        buckets.set(mesh.material, list);
      }
      list.push(baked);
      remove.push(mesh);
      return;
    }
    for (const child of node.children) visit(child);
  };

  for (const child of root.children) visit(child);
  for (const mesh of remove) {
    mesh.removeFromParent();
    mesh.geometry.dispose();
  }

  let i = 0;
  for (const [material, geos] of buckets) {
    const merged = mergeGeometries(geos, false);
    for (const geo of geos) geo.dispose();
    if (merged === null) continue;
    const mesh = new Mesh(merged, material);
    mesh.name = `${root.name || 'fixture'}:batch:${i++}`;
    root.add(mesh);
  }
}

export interface CasingSpec {
  x: number;
  z: number;
  /** 'x' for an opening in an east-west wall, 'z' for one in a north-south wall. */
  axis: 'x' | 'z';
  half: number;
  /** Bottom and top of the clear opening. */
  y0: number;
  y1: number;
  thickness: number;
  /**
   * Draw the threshold box under the opening. Defaults to true for any opening that starts clear of
   * the floor, which is what a window wants; pass false for a doorway you walk through.
   *
   * It exists because the alternative callers reached for was to sink the sill out of sight by pulling
   * `y0` down by exactly the sill's own height. That lands its top face *on* the floor plane rather
   * than under it — measured at the upper wing's doorways it was 0 um from `up-store-floor` and
   * `up-child-floor`, three upward faces at 2.40000 exactly — and two coincident planes are the one
   * case a depth buffer cannot call, so which of them showed changed with the camera. A 1.4 x 0.34 m
   * box of `mats.wood` flickering in and out of the floorboards is the brown band across the
   * threshold in the report. Not drawing it is cheaper than hiding it and cannot come back.
   */
  sill?: boolean;
}

/**
 * Jambs and a lintel around an opening. Purely visual, and worth every one of its five boxes:
 * a hole in a plaster wall reads as a missing chunk of geometry, while the same hole with a
 * lined frame reads as a door. This is the cheapest believability win in the house.
 */
export function makeCasing(mats: FixtureMats, s: CasingSpec): Group {
  const g = new Group();
  const t = s.thickness + 0.06;
  const jw = 0.075;
  const h = s.y1 - s.y0;
  const sill = s.sill !== false && s.y0 > 0.02;
  if (s.axis === 'x') {
    for (const dx of [-(s.half - jw / 2), s.half - jw / 2]) {
      g.add(boxMesh(mats.wood, jw, h, t, s.x + dx, s.y0 + h / 2, s.z));
    }
    g.add(boxMesh(mats.wood, s.half * 2, 0.12, t, s.x, s.y1 - 0.06, s.z));
    if (sill) g.add(boxMesh(mats.wood, s.half * 2, 0.1, t + 0.16, s.x, s.y0 + 0.05, s.z));
  } else {
    for (const dz of [-(s.half - jw / 2), s.half - jw / 2]) {
      g.add(boxMesh(mats.wood, t, h, jw, s.x, s.y0 + h / 2, s.z + dz));
    }
    g.add(boxMesh(mats.wood, t, 0.12, s.half * 2, s.x, s.y1 - 0.06, s.z));
    if (sill) g.add(boxMesh(mats.wood, t + 0.16, 0.1, s.half * 2, s.x, s.y0 + 0.05, s.z));
  }
  mergeStaticChildren(g);
  return g;
}

/*
 * makeDoorLeaf() and its Hinged return stood here. Every doorway in the house that has a leaf now hangs
 * an imported one — door-inner.glb in the bedroom, the living room and the flat's partition, door.glb
 * minus its frame at the cellar and basement — so the last caller went with HouseScene's doorLeaves
 * array. makeCasing above is untouched: an imported leaf is a leaf, and the frame around every one of
 * them is still built here.
 */

export interface BuiltGate {
  group: Group;
  /** One per lock, in the order the keys are declared. Slide these to show a lock has turned. */
  bolts: Mesh[];
  /** Where the prompt for each lock should be picked up from. */
  lockAnchors: Vector3[];
}

/**
 * The main gate's ironmongery: three locks down the centre line of the hall's south wall.
 *
 * The locks are *visibly* three, at three heights, before the player has any key — that is the
 * brief's opening statement (§2) and it has to land in the first two seconds of the game, from
 * the spawn point, with no text.
 *
 * The leaf itself is not here any more. It used to be two welded sets of bars, chosen so the player
 * could see the night outside and still not reach it; it is gate-main.glb now, a studded slab, and
 * MainGate.hingeMainGate() swings it. What stayed behind is exactly the part the puzzle reads from:
 * the locks hold the leaf to the jamb, so they never belonged to the leaf and never moved with it.
 */
export function makeGate(mats: FixtureMats, x: number, z: number): BuiltGate {
  const group = new Group();

  const bolts: Mesh[] = [];
  const lockAnchors: Vector3[] = [];
  for (const ly of [0.62, 1.34, 2.06]) {
    group.add(boxMesh(mats.iron, 0.3, 0.26, 0.07, x, ly, z + 0.06));
    const bolt = new Mesh(new BoxGeometry(0.42, 0.075, 0.06), mats.brass);
    bolt.position.set(x, ly, z + 0.11);
    group.add(bolt);
    bolts.push(bolt);
    // Padlock hasp, so a locked lock reads as locked from across the hall.
    const hasp = new Mesh(new TorusGeometry(0.055, 0.014, 5, 10, Math.PI), mats.iron);
    hasp.position.set(x, ly + 0.13, z + 0.11);
    group.add(hasp);
    lockAnchors.push(new Vector3(x, ly, z + 0.4));
  }

  // The brass bolts slide independently when their keys turn; plates and hasps do not.
  mergeStaticChildren(group, bolts);
  return { group, bolts, lockAnchors };
}

export interface BuiltHiddenLock {
  group: Group;
  /** The red plate, returned so the unlock can swing it aside. */
  plate: Mesh;
  /** Where the interaction anchors, standing off the plate along the way it faces. */
  anchor: Vector3;
}

/**
 * The red lock on the hidden door.
 *
 * One plate rather than the gate's three bolts, because the whole of what makes this read is that
 * there is exactly one of it and it is the only red thing in the house. It is also larger than the
 * gate's 0.3 x 0.26: those are seen across the hall with the porch light behind them, while this one is
 * seen from a metre away in a corridor with no window in it, and a lock nobody notices is not a lock.
 *
 * The iron frame behind the plate is not decoration. A flat saturated quad on a dark leaf reads as a
 * missing texture — which is exactly how the door was reported before this existed — so the red is
 * inset into something with an edge and a thickness, and that edge is what says "object".
 *
 * `yaw` is the direction the plate faces, so the anchor can be derived from it rather than stated
 * twice: the interaction has to stand in front of the lock, not inside the door.
 */
export function makeHiddenLock(
  mats: FixtureMats,
  x: number,
  y: number,
  z: number,
  yaw: number,
): BuiltHiddenLock {
  const group = new Group();

  const frame = boxMesh(mats.iron, 0.44, 0.44, 0.055, 0, 0, -0.035);
  group.add(frame);

  const plate = boxMesh(mats.red, 0.34, 0.34, 0.075, 0, 0, 0.005);
  group.add(plate);

  // A hasp hanging under the plate, so the lock reads as fastened rather than as a sign.
  const hasp = new Mesh(new TorusGeometry(0.07, 0.017, 5, 12, Math.PI), mats.iron);
  hasp.position.set(0, -0.245, 0.02);
  hasp.rotation.z = Math.PI;
  group.add(hasp);

  group.position.set(x, y, z);
  group.rotation.y = yaw;
  // Facing yaw maps +z to (sin, 0, cos), so the stand-off follows the same two numbers the group does.
  const anchor = new Vector3(x + Math.sin(yaw) * 0.45, y, z + Math.cos(yaw) * 0.45);

  mergeStaticChildren(group, [plate]);
  return { group, plate, anchor };
}

export type SymbolKind = 'moon' | 'eye' | 'cross' | 'skull';

/**
 * One ritual symbol, built from primitives at a size that still reads at lantern range.
 *
 * These are carved objects, not icons: no emissive glow and no outline, because §8 forbids
 * glowing puzzle objects. What tells the player a symbol is active is the candle beside it
 * catching light — a change in the room, not a change in the object.
 */
export function makeSymbol(kind: SymbolKind, mats: FixtureMats): Group {
  const g = new Group();
  if (kind === 'moon') {
    const m = new Mesh(new TorusGeometry(0.085, 0.026, 5, 12, Math.PI * 1.25), mats.bone);
    m.rotation.z = -Math.PI * 0.62;
    g.add(m);
  } else if (kind === 'eye') {
    const ball = new Mesh(new SphereGeometry(0.1, 10, 7), mats.bone);
    ball.scale.set(1.25, 0.62, 0.4);
    g.add(ball);
    const iris = new Mesh(new SphereGeometry(0.042, 8, 6), mats.dark);
    iris.position.z = 0.03;
    iris.scale.set(1, 1, 0.5);
    g.add(iris);
  } else if (kind === 'cross') {
    g.add(boxMesh(mats.wood, 0.045, 0.24, 0.045, 0, 0.02, 0));
    g.add(boxMesh(mats.wood, 0.16, 0.045, 0.045, 0, 0.055, 0));
  } else {
    const skull = new Mesh(new SphereGeometry(0.088, 10, 8), mats.bone);
    skull.scale.set(1, 1.05, 0.9);
    g.add(skull);
    for (const dx of [-0.035, 0.035]) {
      const socket = new Mesh(new SphereGeometry(0.027, 6, 5), mats.dark);
      socket.position.set(dx, 0.015, 0.07);
      g.add(socket);
    }
    g.add(boxMesh(mats.bone, 0.075, 0.05, 0.06, 0, -0.085, 0.035));
  }
  return g;
}

export interface BuiltAltar {
  group: Group;
  /** Prompt pick-up points, in the order the symbols stand — not the solution order. */
  symbolAnchors: Vector3[];
  /** Candle flames beside each symbol. Hidden until that symbol is activated. */
  flames: Mesh[];
  /** Key 1, revealed inside the opened coffin. */
  key: Group;
  keyAnchor: Vector3;
  aabbs: AABB[];
}

/** A small key: bow, shaft and two teeth. Read at arm's length, so five primitives is plenty. */
export function makeKey(mats: FixtureMats): Group {
  const g = new Group();
  const bow = new Mesh(new TorusGeometry(0.032, 0.009, 5, 10), mats.brass);
  bow.rotation.y = Math.PI / 2;
  g.add(bow);
  const shaft = new Mesh(new CylinderGeometry(0.008, 0.008, 0.12, 6), mats.brass);
  shaft.position.y = -0.075;
  g.add(shaft);
  g.add(boxMesh(mats.brass, 0.008, 0.016, 0.032, 0, -0.108, 0.018));
  g.add(boxMesh(mats.brass, 0.008, 0.016, 0.022, 0, -0.078, 0.013));
  return g;
}

/**
 * The ritual altar's dressing: four symbols on stone stubs on the floor, a candle beside each, and the
 * key that waits inside the coffin beside them.
 *
 * The coffin itself is coffin.glb — placed by ModelProps and opened by Coffin.ts, which drives the
 * file's own lid clip. What is *not* the coffin is any of this. The old plinth had a drop-front that
 * fell open and presented the key on it; the animated coffin's lid hinges on a vertical axis and
 * swings ~173° sideways off the west end, so nothing can rest on it and there is no front to drop.
 * The symbols therefore stand to the coffin's *east* — the side the player enters from, and the one
 * side the westward swing never reaches — and the key is revealed *inside* the opened coffin, where
 * the swing exposes it.
 *
 * They stood on a ledge until the player asked for it gone; that they stand east of the coffin is the
 * part of the arrangement the lid's swing dictates and the part that did not change with it.
 *
 * The symbols are given in *display* order, left to right as the player sees them. The solution
 * order is deliberately not this order and lives with the puzzle, so the arrangement on the floor
 * gives nothing away and the written clue in the room is the only route in.
 */
export function makeAltar(
  mats: FixtureMats,
  x: number,
  z: number,
  floorY: number,
  kinds: SymbolKind[],
): BuiltAltar {
  const group = new Group();
  /*
   * The ledge is gone — the player asked for the coffin to stand alone in its circle, and the 0.42 x 2.4
   * slab with an iron top that stood beside it was the thing they pointed at. What is left is the four
   * symbols, each on its own stone stub on the floor, on the same line the ledge held them on: LX is that
   * ledge's centre, so every offset below and the chalk ring HouseProps draws around all of this still
   * land where they were authored. The coffin body is 1.10 m wide and lies along z, so its east face is
   * at x + 0.55 and the stubs stand 0.40 m clear of it.
   *
   * East is not a choice the ledge leaving reopens. See Coffin: the lid hinges on a vertical axis and
   * sweeps ~173 deg *west*, so anything standing on the lid — or west of the body — is in its path. East
   * is the safe side and the side the player walks in on.
   */
  const LX = x + 0.95;
  /*
   * Stub height, and it is a reachability number rather than a styling one. Each symbol's prompt sits on
   * top of its stub with a reach of 1.9 m measured from the eye at 1.7: laid on the bare floor a symbol
   * is already 1.58 m from a player standing over it, 0.32 m of slack in a check that flags anything
   * under 0.35 as tight, and that is before the player has to stand anywhere in particular. 0.3 m of
   * stub buys the slack back and keeps four small carvings told apart at a glance, which was the other
   * half of what the ledge and its pedestals were doing.
   */
  const STUB = 0.3;
  const TOP = floorY + STUB;

  const symbolAnchors: Vector3[] = [];
  const flames: Mesh[] = [];
  const offsets = [-0.93, -0.31, 0.31, 0.93];
  for (let i = 0; i < kinds.length; i++) {
    const oz = z + (offsets[i] ?? 0);
    const kind = kinds[i];
    if (!kind) continue;
    // The stub, standing on the floor where a pedestal on a ledge used to stand on a ledge.
    group.add(boxMesh(mats.dark, 0.18, STUB, 0.18, LX, floorY + STUB / 2, oz));
    const sym = makeSymbol(kind, mats);
    sym.position.set(LX, TOP + 0.12, oz);
    sym.rotation.y = -Math.PI / 2;
    group.add(sym);
    symbolAnchors.push(new Vector3(LX, TOP + 0.12, oz));

    // Candles on the floor beside their stubs. 0.24 m east clears the 18 cm stub by 12 cm and leaves
    // the flame where the player's eye already is when the symbol beside it is the thing under the
    // prompt, so lighting one still reads as this symbol's candle rather than as the next one's.
    const candle = new Mesh(new CylinderGeometry(0.024, 0.028, 0.13, 6), mats.paper);
    candle.position.set(LX + 0.24, floorY + 0.065, oz);
    group.add(candle);
    const flame = new Mesh(new CylinderGeometry(0.001, 0.016, 0.06, 5), mats.glow);
    flame.position.set(LX + 0.24, floorY + 0.16, oz);
    flame.visible = false;
    group.add(flame);
    flames.push(flame);
  }

  // The key waits inside the coffin, laid on its floor at the body's centre. It is invisible until
  // the sequence is solved and the lid swings off; then it lies in the open shell, facing up at the
  // player who is standing east of it. A key lying in a shadowed hole with nothing glowing on it (§8)
  // is a key nobody finds on a phone screen — so it is presented by the opening, not hidden by it.
  const key = makeKey(mats);
  key.position.set(x, floorY + 0.3, z);
  key.rotation.x = Math.PI / 2;
  key.visible = false;
  group.add(key);

  // Flames toggle individually and the key is revealed later. Everything else is rigid dressing and
  // may collapse to one draw per material.
  mergeStaticChildren(group, [...flames, key]);
  return {
    group,
    symbolAnchors,
    flames,
    key,
    keyAnchor: new Vector3(x, floorY + 0.32, z),
    // Nothing here is collided any more. The ledge's box was the only entry, and four 18 cm stubs 0.3 m
    // tall do not want one each: they stand inside the chalk ring the player has to walk into to reach
    // them, so a collider there would push the player back out of their own reach. The coffin body still
    // gets its own from the placement row.
    aabbs: [],
  };
}

export interface BuiltContainer {
  group: Group;
  /** Hinges or slides open when the puzzle is solved. */
  lid: Group;
  key: Group;
  anchor: Vector3;
  keyAnchor: Vector3;
  aabbs: AABB[];
}

/**
 * The bedroom code box: a strongbox with a four-digit dial, standing on the floor under the stopped clock.
 *
 * It was built for chest height, on top of a dressing table, on the argument that a box on the floor is
 * something the player walks past while a box beside the clock puts the puzzle and half its clue in the
 * same glance. The dressing table was procedural furniture and has been removed; the box is the puzzle and
 * stayed, so `y` is the floor now (PLACE.codeBox). The glance survives — the clock still hangs directly
 * above it on the same wall, which is exactly where the diary sends the player to look — and the dial's
 * reach in HouseScene was raised to cover the longer drop from a standing eye.
 */
export function makeCodeBox(mats: FixtureMats, x: number, y: number, z: number): BuiltContainer {
  const group = new Group();
  const W = 0.44;
  const H = 0.3;
  const D = 0.32;
  group.add(boxMesh(mats.iron, W, H, D, x, y + H / 2, z));
  // Dial plate on the front (+z) face.
  const dial = new Mesh(new CylinderGeometry(0.058, 0.058, 0.018, 12), mats.brass);
  dial.rotation.x = Math.PI / 2;
  dial.position.set(x, y + H / 2, z + D / 2 + 0.01);
  group.add(dial);
  group.add(boxMesh(mats.brass, 0.13, 0.03, 0.02, x, y + H / 2 - 0.1, z + D / 2 + 0.01));

  const lid = new Group();
  lid.position.set(x, y + H, z - D / 2);
  lid.add(boxMesh(mats.iron, W, 0.035, D, 0, 0.018, D / 2));
  group.add(lid);

  // On the body's top face, not inside it: the box is a solid block, and by the time the key is
  // visible the lid has already swung up and back out of the way.
  const key = makeKey(mats);
  key.position.set(x, y + H + 0.022, z);
  key.rotation.set(Math.PI / 2, 0, 0.3);
  key.visible = false;
  group.add(key);

  // Body and dial never move. The lid hinges and the key appears independently.
  mergeStaticChildren(group, [lid, key]);
  return {
    group,
    lid,
    key,
    anchor: new Vector3(x, y + H / 2, z + D / 2),
    keyAnchor: new Vector3(x, y + H + 0.02, z),
    aabbs: [aabbOf(x, y, z, W / 2, D / 2, y + H)],
  };
}

/**
 * The basement breaker panel and the wall hatch it powers.
 *
 * The hatch is a separate object from the panel and sits an arm's length away, so throwing the
 * breakers has a visible consequence somewhere else in the room. A compartment inside the panel
 * itself would make the puzzle a box that opens itself.
 */
export function makeBreakerPanel(
  mats: FixtureMats,
  x: number,
  y: number,
  z: number,
): BuiltContainer {
  const group = new Group();
  group.add(boxMesh(mats.iron, 0.46, 0.62, 0.13, x, y, z - 0.065));
  group.add(boxMesh(mats.dark, 0.38, 0.52, 0.02, x, y, z + 0.005));
  // Four rocker stubs, so the panel reads as a breaker box before it is ever opened.
  for (let i = 0; i < 4; i++) {
    group.add(boxMesh(mats.paper, 0.055, 0.11, 0.03, x - 0.135 + i * 0.09, y + 0.06, z + 0.02));
  }
  group.add(boxMesh(mats.brass, 0.07, 0.16, 0.035, x, y - 0.19, z + 0.02));

  // The hatch: a shallow iron box mounted *on* the wall rather than a hole cut into it. A recess
  // would put the key behind the wall's front face, where the wall itself would hide it.
  group.add(boxMesh(mats.iron, 0.44, 0.36, 0.02, x + 0.95, y - 0.34, z - 0.01));
  for (const [ox, oy, ow, oh] of [
    [0, 0.18, 0.44, 0.03],
    [0, -0.18, 0.44, 0.03],
    [-0.21, 0, 0.03, 0.36],
    [0.21, 0, 0.03, 0.36],
  ] as Array<[number, number, number, number]>) {
    group.add(boxMesh(mats.iron, ow, oh, 0.1, x + 0.95 + ox, y - 0.34 + oy, z + 0.05));
  }

  // Cover, hinged along its bottom edge: the group sits on the hinge and the panel hangs above it.
  const lid = new Group();
  lid.position.set(x + 0.95, y - 0.52, z + 0.105);
  lid.add(boxMesh(mats.iron, 0.42, 0.34, 0.025, 0, 0.17, 0));
  lid.add(boxMesh(mats.brass, 0.07, 0.03, 0.02, 0, 0.3, 0.02));
  group.add(lid);

  const key = makeKey(mats);
  key.position.set(x + 0.95, y - 0.34, z + 0.05);
  key.rotation.z = Math.PI / 2;
  key.visible = false;
  group.add(key);

  // Panel housing and rocker stubs are rigid. The hatch and key have their own animation state.
  mergeStaticChildren(group, [lid, key]);
  return {
    group,
    lid,
    key,
    anchor: new Vector3(x, y, z + 0.1),
    keyAnchor: new Vector3(x + 0.95, y - 0.34, z + 0.12),
    aabbs: [],
  };
}

/**
 * A wall clock with hands frozen at a given time.
 *
 * Angles are computed here rather than passed in so the caller states the time the way the diary
 * does — as hours and minutes — and the two can never drift apart. The hour hand carries the
 * minutes too, because a clock reading exactly 11 with the minute hand at 40 is the kind of
 * detail that quietly tells a player the puzzle prop was not thought about.
 */
export function makeClock(
  mats: FixtureMats,
  x: number,
  y: number,
  z: number,
  ry: number,
  hours: number,
  minutes: number,
): Group {
  const group = new Group();
  group.position.set(x, y, z);
  group.rotation.y = ry;
  const R = 0.17;
  const case_ = new Mesh(new CylinderGeometry(R, R, 0.06, 16), mats.wood);
  case_.rotation.x = Math.PI / 2;
  group.add(case_);
  const face = new Mesh(new CylinderGeometry(R - 0.02, R - 0.02, 0.01, 16), mats.paper);
  face.rotation.x = Math.PI / 2;
  face.position.z = 0.035;
  group.add(face);
  // Twelve ticks: cheap, and without them the hands have nothing to point at.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const tick = boxMesh(mats.dark, 0.012, i % 3 === 0 ? 0.03 : 0.02, 0.006, 0, 0, 0.042);
    tick.position.set(Math.sin(a) * (R - 0.045), Math.cos(a) * (R - 0.045), 0.042);
    tick.rotation.z = -a;
    group.add(tick);
  }
  const hand = (len: number, wide: number, angle: number): void => {
    const m = boxMesh(mats.dark, wide, len, 0.008, 0, 0, 0);
    // Pivot at the clock centre: shift the bar so one end sits on the axis, then rotate the group.
    const pivot = new Group();
    m.position.y = len / 2;
    pivot.add(m);
    pivot.position.z = 0.046;
    pivot.rotation.z = -angle;
    group.add(pivot);
  };
  hand(0.075, 0.016, ((hours % 12) + minutes / 60) * (Math.PI / 6));
  hand(0.115, 0.011, (minutes / 60) * Math.PI * 2);
  const hub = new Mesh(new CylinderGeometry(0.012, 0.012, 0.02, 8), mats.brass);
  hub.rotation.x = Math.PI / 2;
  hub.position.z = 0.05;
  group.add(hub);
  // The hands show a fixed clue and never tick, so the whole clock is one rigid fixture.
  mergeStaticChildren(group);
  return group;
}
