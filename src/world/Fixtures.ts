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
    // Both tracked: Material.dispose() does not touch its map, so the texture needs its own entry or
    // the canvas and its GPU copy outlive the scene.
    shadow: track(makeContactShadowMaterial(track(makeContactShadowTexture()))),
  };
}

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
  const m = new Mesh(new BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

export function aabbOf(x: number, y0: number, z: number, hw: number, hd: number, y1: number): AABB {
  return { minX: x - hw, maxX: x + hw, minY: y0, maxY: y1, minZ: z - hd, maxZ: z + hd };
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
  if (s.axis === 'x') {
    for (const dx of [-(s.half - jw / 2), s.half - jw / 2]) {
      g.add(boxMesh(mats.wood, jw, h, t, s.x + dx, s.y0 + h / 2, s.z));
    }
    g.add(boxMesh(mats.wood, s.half * 2, 0.12, t, s.x, s.y1 - 0.06, s.z));
    if (s.y0 > 0.02) g.add(boxMesh(mats.wood, s.half * 2, 0.1, t + 0.16, s.x, s.y0 + 0.05, s.z));
  } else {
    for (const dz of [-(s.half - jw / 2), s.half - jw / 2]) {
      g.add(boxMesh(mats.wood, t, h, jw, s.x, s.y0 + h / 2, s.z + dz));
    }
    g.add(boxMesh(mats.wood, t, 0.12, s.half * 2, s.x, s.y1 - 0.06, s.z));
    if (s.y0 > 0.02) g.add(boxMesh(mats.wood, t + 0.16, 0.1, s.half * 2, s.x, s.y0 + 0.05, s.z));
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
  /** Slides down into the plinth when the sequence is solved. */
  lid: Group;
  /** Key 1, revealed inside the compartment. */
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
 * The ritual altar: a stone plinth, four symbols standing on it, a candle beside each, and a
 * compartment in the front face that drops open when the sequence is right.
 *
 * The symbols are given in *display* order, left to right as the player sees them. The solution
 * order is deliberately not this order and lives with the puzzle, so the arrangement on the
 * altar gives nothing away and the written clue in the room is the only route in.
 */
export function makeAltar(
  mats: FixtureMats,
  x: number,
  z: number,
  floorY: number,
  kinds: SymbolKind[],
): BuiltAltar {
  const group = new Group();
  const TOP = floorY + 0.95;
  group.add(boxMesh(mats.dark, 0.9, 0.86, 2.4, x, floorY + 0.43, z));
  group.add(boxMesh(mats.iron, 1.02, 0.09, 2.52, x, TOP - 0.045, z));

  const symbolAnchors: Vector3[] = [];
  const flames: Mesh[] = [];
  const offsets = [-0.93, -0.31, 0.31, 0.93];
  for (let i = 0; i < kinds.length; i++) {
    const oz = z + (offsets[i] ?? 0);
    const kind = kinds[i];
    if (!kind) continue;
    // Short pedestal so each symbol sits clear of the slab and can be told apart at a glance.
    group.add(boxMesh(mats.dark, 0.14, 0.11, 0.14, x - 0.06, TOP + 0.055, oz));
    const sym = makeSymbol(kind, mats);
    sym.position.set(x - 0.06, TOP + 0.22, oz);
    sym.rotation.y = Math.PI / 2;
    group.add(sym);
    symbolAnchors.push(new Vector3(x - 0.06, TOP + 0.22, oz));

    const candle = new Mesh(new CylinderGeometry(0.024, 0.028, 0.13, 6), mats.paper);
    candle.position.set(x + 0.26, TOP + 0.065, oz);
    group.add(candle);
    const flame = new Mesh(new CylinderGeometry(0.001, 0.016, 0.06, 5), mats.glow);
    flame.position.set(x + 0.26, TOP + 0.16, oz);
    flame.visible = false;
    group.add(flame);
    flames.push(flame);
  }

  // Compartment: a drop-front in the plinth's face, hinged along its bottom edge, so `lid` sits on
  // the hinge and the panel hangs above it. Rotating -PI/2 about z lays it out flat like a bureau
  // front, and the key is placed where that flat surface ends up.
  //
  // The plinth is solid, so the key cannot sit *inside* it — and it should not. A key lying in a
  // shadowed hole, with nothing glowing on it (§8), is a key nobody finds on a phone screen. The
  // front drops open and presents it.
  const lid = new Group();
  lid.position.set(x + 0.455, floorY + 0.28, z);
  lid.add(boxMesh(mats.iron, 0.05, 0.44, 0.92, 0, 0.22, 0));
  lid.add(boxMesh(mats.brass, 0.03, 0.04, 0.12, 0.04, 0.22, 0));
  group.add(lid);

  const key = makeKey(mats);
  key.position.set(x + 0.675, floorY + 0.31, z);
  key.rotation.x = Math.PI / 2;
  key.visible = false;
  group.add(key);

  // Flames toggle individually, the compartment lid rotates, and the key is revealed later. Everything
  // else is rigid altar dressing and may collapse to one draw per material.
  mergeStaticChildren(group, [...flames, lid, key]);
  return {
    group,
    symbolAnchors,
    flames,
    lid,
    key,
    keyAnchor: new Vector3(x + 0.675, floorY + 0.33, z),
    aabbs: [aabbOf(x, floorY, z, 0.52, 1.28, TOP)],
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
 * The bedroom code box: a strongbox with a four-digit dial, sitting on top of the dressing table.
 *
 * Placed at chest height on purpose. A box on the floor is something the player walks past; a box
 * at eye level next to the stopped clock puts the puzzle and half its clue in the same glance,
 * which is what §9's "minimal backtracking" rule is really asking for.
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
