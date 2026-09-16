/**
 * Feasibility scene — Phase 0 gate, now dressed as an actual room.
 *
 * Two rooms joined by a real doorway (frame + hinged door), a window with a moonlight
 * shaft, plank floor, plastered walls with skirting boards, beamed ceiling, and enough
 * furniture to read as a lived-in house rather than a grey box.
 *
 * The important structural change: walls and collision AABBs are generated from ONE
 * `WALL_SEGMENTS` array. The previous version hand-wrote both and they disagreed — the
 * collider sealed the doorway the geometry left open, so the player could not walk through.
 * A single source of truth makes that class of bug impossible, and this is the seed of the
 * data-driven HouseBuilder that Phase 1 needs anyway.
 */

import {
  BoxGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  FogExp2,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshPhongMaterial,
  PlaneGeometry,
  PointLight,
  Scene,
  SkinnedMesh,
  SphereGeometry,
  Bone,
  Skeleton,
  BufferAttribute,
  Vector3,
  AmbientLight,
  type Material,
  type Object3D,
} from 'three';
import type { Engine } from '@/core/Engine';
import type { FPController } from '@/player/FPController';
import type { TouchControls } from '@/player/TouchControls';
import type { AABB } from '@/player/FPController';
import { makeWoodFloor, makePlaster, makeWoodPanel, makeCeilingBoards, makeRug } from '@/world/ProcTextures';

export interface FeasibilityHandles {
  rigged: SkinnedMesh;
  update: (dt: number) => void;
  dispose: () => void;
}

/** Axis-aligned wall segment in metres. Centre-line from (x1,z1) to (x2,z2). */
interface WallSegment {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  /** Bottom of the wall piece. Non-zero for the panel above a doorway. */
  y0?: number;
  /** Top of the wall piece. Defaults to WALL_H. */
  y1?: number;
}

const WALL_H = 3.2;
const WALL_T = 0.2;
const ROOM_MIN_X = -6;
const ROOM_MAX_X = 6;
const ROOM_MIN_Z = -5;
const ROOM_MAX_Z = 5;
/**
 * Openings are given as *clear* width, and each segment end is nudged by half the wall
 * thickness so `segmentBox()`'s corner padding lands the inner faces exactly on the edge of
 * the opening. Without that nudge every run stole 0.1 m from the doorway, leaving a 0.4 m
 * slot the 0.35 m-radius player could not squeeze through.
 */
const HALF_T = WALL_T / 2;
/** Doorway in the partition: centred on x=0, 1.6 m clear, 2.1 m tall. */
const DOOR_HALF_W = 0.8;
const DOOR_H = 2.1;
const PARTITION_Z = -1;
/** Window on the east wall, centred on z=2.5, 1.8 m clear. */
const WIN_HALF_W = 0.9;
const WIN_Y0 = 1.0;
const WIN_Y1 = 2.3;
const WIN_Z = 2.5;

const WALL_SEGMENTS: WallSegment[] = [
  // North and south outer walls.
  { x1: ROOM_MIN_X, z1: ROOM_MIN_Z, x2: ROOM_MAX_X, z2: ROOM_MIN_Z },
  { x1: ROOM_MIN_X, z1: ROOM_MAX_Z, x2: ROOM_MAX_X, z2: ROOM_MAX_Z },
  // West outer wall.
  { x1: ROOM_MIN_X, z1: ROOM_MIN_Z, x2: ROOM_MIN_X, z2: ROOM_MAX_Z },
  // East outer wall, split around the window opening.
  { x1: ROOM_MAX_X, z1: ROOM_MIN_Z, x2: ROOM_MAX_X, z2: WIN_Z - WIN_HALF_W - HALF_T },
  { x1: ROOM_MAX_X, z1: WIN_Z + WIN_HALF_W + HALF_T, x2: ROOM_MAX_X, z2: ROOM_MAX_Z },
  { x1: ROOM_MAX_X, z1: WIN_Z - WIN_HALF_W + HALF_T, x2: ROOM_MAX_X, z2: WIN_Z + WIN_HALF_W - HALF_T, y0: 0, y1: WIN_Y0 },
  { x1: ROOM_MAX_X, z1: WIN_Z - WIN_HALF_W + HALF_T, x2: ROOM_MAX_X, z2: WIN_Z + WIN_HALF_W - HALF_T, y0: WIN_Y1, y1: WALL_H },
  // Partition with the doorway gap, plus the panel above the door.
  { x1: ROOM_MIN_X, z1: PARTITION_Z, x2: -DOOR_HALF_W - HALF_T, z2: PARTITION_Z },
  { x1: DOOR_HALF_W + HALF_T, z1: PARTITION_Z, x2: ROOM_MAX_X, z2: PARTITION_Z },
  { x1: -DOOR_HALF_W + HALF_T, z1: PARTITION_Z, x2: DOOR_HALF_W - HALF_T, z2: PARTITION_Z, y0: DOOR_H, y1: WALL_H },
];

/** Convert a segment's centre-line into the box dimensions and the matching collider. */
function segmentBox(s: WallSegment): { cx: number; cy: number; cz: number; w: number; h: number; d: number } {
  const y0 = s.y0 ?? 0;
  const y1 = s.y1 ?? WALL_H;
  const horizontal = Math.abs(s.x2 - s.x1) >= Math.abs(s.z2 - s.z1);
  const w = horizontal ? Math.abs(s.x2 - s.x1) + WALL_T : WALL_T;
  const d = horizontal ? WALL_T : Math.abs(s.z2 - s.z1) + WALL_T;
  return {
    cx: (s.x1 + s.x2) / 2,
    cy: (y0 + y1) / 2,
    cz: (s.z1 + s.z2) / 2,
    w,
    h: y1 - y0,
    d,
  };
}

export function buildFeasibilityScene(
  scene: Scene,
  controller: FPController,
  touch: TouchControls,
  engine: Engine,
): FeasibilityHandles {
  scene.background = new Color(0x07070c);
  // Exponential fog gives cheap depth falloff and hides the room boundary in the dark —
  // the single biggest "this looks like a real space" win for zero draw calls.
  scene.fog = new FogExp2(0x0a0a12, 0.055);

  const disposables: Array<{ dispose: () => void }> = [];
  const track = <T extends { dispose: () => void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  // --- Textures (procedural: no asset downloads, ~0.7 s total on device at the current 1024) ---
  const anis = engine.renderer.capabilities.getMaxAnisotropy();
  const floorTex = makeWoodFloor(1337, 8);
  const wallTex = makePlaster(4242, 'warm');
  const trimTex = makeWoodPanel(909, 0.75);
  const doorTex = makeWoodPanel(515, 0.9);
  const ceilTex = makeCeilingBoards(7171);
  const rugTex = makeRug(2468);
  for (const t of [floorTex, wallTex, trimTex, doorTex, ceilTex, rugTex]) {
    t.anisotropy = Math.min(anis, 4);
    track(t);
  }
  // The generators no longer return a bump half to release here: nothing ever set bumpMap, and it
  // measured as a third of a 58 ms frame on the 4 GB target for detail the colour maps already carry.
  floorTex.repeat.set(6, 5);
  ceilTex.repeat.set(4, 3);

  // Lambert, not Standard: a full physical BRDF per fragment is what dropped the first
  // textured build to 17 FPS. Nothing in this house is metal or glossy, so in near-darkness
  // the physical model buys nothing over a diffuse term — and it costs roughly 3x.
  const wallMat = track(new MeshLambertMaterial({ map: wallTex }));
  const floorMat = track(new MeshLambertMaterial({ map: floorTex }));
  const ceilMat = track(new MeshLambertMaterial({ map: ceilTex }));
  const trimMat = track(new MeshLambertMaterial({ map: trimTex }));
  const doorMat = track(new MeshLambertMaterial({ map: doorTex }));
  const shadowMat = track(
    new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.42, depthWrite: false }),
  );

  // --- Lighting: fill + player lantern + moonlight through the window ---
  // Ambient plus hemisphere: a flat term and a sky/ground gradient. Neither needs a shadow
  // pass, and the gradient alone keeps the ceiling cool and the floor warm for free.
  scene.add(new AmbientLight(0x8a8296, 0.32));
  scene.add(new HemisphereLight(0x3d4a68, 0x2b2119, 0.38));

  const lantern = new PointLight(0xffc27a, 2.2, 16, 1.5);
  lantern.position.set(-0.25, -0.15, 0.1); // slightly left and below the eye, like a held lamp
  engine.camera.add(lantern);
  scene.add(engine.camera);
  // The LANTERN button is gone from TouchControls, so there is nothing left to toggle here either.
  // This dev scene only ever used it to eyeball the unlit fallback, which the game no longer has.

  const moon = new DirectionalLight(0x8fb0ff, 0.55);
  moon.position.set(14, 6, WIN_Z + 3);
  moon.target.position.set(0, 0.5, WIN_Z);
  scene.add(moon);
  scene.add(moon.target);

  // --- Shell: floor, ceiling, walls. Geometry AND colliders come from WALL_SEGMENTS. ---
  const shell = new Group();
  scene.add(shell);
  const aabbs: AABB[] = [];

  const ROOM_W = ROOM_MAX_X - ROOM_MIN_X;
  const ROOM_D = ROOM_MAX_Z - ROOM_MIN_Z;
  const MID_X = (ROOM_MIN_X + ROOM_MAX_X) / 2;
  const MID_Z = (ROOM_MIN_Z + ROOM_MAX_Z) / 2;

  const floor = new Mesh(track(new PlaneGeometry(ROOM_W, ROOM_D)), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(MID_X, 0, MID_Z);
  shell.add(floor);

  const ceiling = new Mesh(track(new PlaneGeometry(ROOM_W, ROOM_D)), ceilMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(MID_X, WALL_H, MID_Z);
  shell.add(ceiling);

  // Box geometries are cached by size — the four 12 m runs share one buffer. `tile` is the
  // world size one texture repeat should cover; a 12 m wall with default UVs stretches a
  // single 512 px texture to 43 px/m, which is exactly the smeared look that reads as fake.
  const boxCache = new Map<string, BoxGeometry>();
  const boxFor = (w: number, h: number, d: number, tile = 0): BoxGeometry => {
    const key = `${w.toFixed(3)}|${h.toFixed(3)}|${d.toFixed(3)}|${tile}`;
    let g = boxCache.get(key);
    if (!g) {
      g = track(new BoxGeometry(w, h, d));
      if (tile > 0) retileUv(g, w / tile, h / tile);
      boxCache.set(key, g);
    }
    return g;
  };

  /**
   * Wall box whose UVs are anchored to world position, not to the mesh. Retiling from 0 per
   * mesh restarts the texture at every segment join, and because the plaster has soft damp
   * patches each restart shows up as a brightness step — which is what made the walls read as
   * separate wallpapered panels. Offsetting by the segment's world origin makes the pattern run
   * continuously through jambs, corners and the strips above the window.
   */
  const WALL_TILE = 2.4;
  const wallBoxCache = new Map<string, BoxGeometry>();
  const wallBox = (w: number, h: number, d: number, ou: number, ov: number): BoxGeometry => {
    const key = `${w.toFixed(3)}|${h.toFixed(3)}|${d.toFixed(3)}|${ou.toFixed(3)}|${ov.toFixed(3)}`;
    let g = wallBoxCache.get(key);
    if (!g) {
      g = track(new BoxGeometry(w, h, d));
      retileUv(g, w / WALL_TILE, h / WALL_TILE, ou / WALL_TILE, ov / WALL_TILE);
      wallBoxCache.set(key, g);
    }
    return g;
  };

  // One pass: every segment becomes a box plus the AABB that exactly matches it. The
  // controller already ignores colliders sitting above eye height, so the panel over the
  // doorway blocks nothing and the 1.6 m opening stays walkable.
  for (const s of WALL_SEGMENTS) {
    const b = segmentBox(s);
    const alongX = b.w > b.d;
    const ou = alongX ? b.cx - b.w / 2 : b.cz - b.d / 2;
    const m = new Mesh(wallBox(b.w, b.h, b.d, ou, b.cy - b.h / 2), wallMat);
    m.position.set(b.cx, b.cy, b.cz);
    shell.add(m);
    aabbs.push({
      minX: b.cx - b.w / 2,
      maxX: b.cx + b.w / 2,
      minY: b.cy - b.h / 2,
      maxY: b.cy + b.h / 2,
      minZ: b.cz - b.d / 2,
      maxZ: b.cz + b.d / 2,
    });
  }

  // --- Dressing helpers ---
  const addProp = (
    geo: BoxGeometry | CylinderGeometry,
    mat: Material,
    x: number,
    y: number,
    z: number,
    ry = 0,
  ): Mesh => {
    const m = new Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    shell.add(m);
    return m;
  };
  const addBlocker = (x: number, z: number, hw: number, hd: number, y0: number, y1: number): void => {
    aabbs.push({ minX: x - hw, maxX: x + hw, minY: y0, maxY: y1, minZ: z - hd, maxZ: z + hd });
  };
  // Fake contact shadow: a soft dark disc on the floor. A real shadow map would cost an
  // extra render pass per light, and at this light level nobody can tell the difference.
  const shadowGeo = track(new CircleGeometry(1, 12));
  const addShadow = (x: number, z: number, rx: number, rz: number): void => {
    const m = new Mesh(shadowGeo, shadowMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.012, z);
    m.scale.set(rx, rz, 1);
    shell.add(m);
  };

  // --- Skirting boards along the base of every full-height wall run ---
  const SKIRT_H = 0.16;
  for (const s of WALL_SEGMENTS) {
    if ((s.y0 ?? 0) > 0) continue;
    const b = segmentBox(s);
    const horizontal = b.w > b.d;
    const sw = horizontal ? b.w : WALL_T + 0.05;
    const sd = horizontal ? WALL_T + 0.05 : b.d;
    addProp(boxFor(sw, SKIRT_H, sd, 0.9), trimMat, b.cx, SKIRT_H / 2, b.cz);
  }

  // --- Ceiling beams: five runs across X, clear of the partition ---
  for (const bz of [-4.1, -2.5, 0.3, 2.1, 3.9]) {
    addProp(boxFor(ROOM_W, 0.2, 0.24, 1.1), trimMat, MID_X, WALL_H - 0.1, bz);
  }

  // --- Doorway: lined jambs, lintel, and a real hinged door ---
  const JAMB_W = 0.07;
  const jambGeo = track(new BoxGeometry(JAMB_W, DOOR_H, WALL_T + 0.06));
  addProp(jambGeo, trimMat, -(DOOR_HALF_W - JAMB_W / 2), DOOR_H / 2, PARTITION_Z);
  addProp(jambGeo, trimMat, DOOR_HALF_W - JAMB_W / 2, DOOR_H / 2, PARTITION_Z);
  addProp(
    track(new BoxGeometry(DOOR_HALF_W * 2, 0.12, WALL_T + 0.06)),
    trimMat,
    0,
    DOOR_H - 0.06,
    PARTITION_Z,
  );

  // Hinged on the west jamb, and deliberately collider-free: a swinging AABB is exactly the
  // kind of thing that sealed this doorway last time, and an open door needs no collision.
  const DOOR_W = DOOR_HALF_W * 2 - JAMB_W * 2 - 0.02;
  const DOOR_LEAF_H = DOOR_H - 0.14;
  const doorPivot = new Group();
  doorPivot.position.set(-(DOOR_HALF_W - JAMB_W), 0, PARTITION_Z);
  shell.add(doorPivot);
  const doorPanel = new Mesh(track(new BoxGeometry(DOOR_W, DOOR_LEAF_H, 0.055)), doorMat);
  doorPanel.position.set(DOOR_W / 2, DOOR_LEAF_H / 2, 0);
  doorPivot.add(doorPanel);

  // Phong for the brass only: three tiny meshes, and a specular highlight is the one thing
  // that reads as metal. One extra shader program is a fair price for that.
  const brassMat = track(new MeshPhongMaterial({ color: 0x8a7038, specular: 0xffe9a8, shininess: 60 }));
  const handle = new Mesh(track(new CylinderGeometry(0.035, 0.035, 0.09, 8)), brassMat);
  handle.rotation.x = Math.PI / 2;
  handle.position.set(DOOR_W - 0.13, 0.98, 0.07);
  doorPivot.add(handle);
  const hingeGeo = track(new BoxGeometry(0.05, 0.12, 0.03));
  for (const hy of [0.42, DOOR_LEAF_H - 0.42]) {
    const h = new Mesh(hingeGeo, brassMat);
    h.position.set(0.03, hy, 0.05);
    doorPivot.add(h);
  }

  // Starts open so the doorway reads as passable at a glance; INTERACT / E swings it.
  const DOOR_OPEN_ANGLE = -1.75;
  let doorOpen = true;
  let doorAngle = DOOR_OPEN_ANGLE;
  doorPivot.rotation.y = doorAngle;
  touch.setOnInteract(() => {
    doorOpen = !doorOpen;
  });

  // --- Window: casing, mullions, glass, sill, and the pool of moonlight it throws ---
  const WIN_H = WIN_Y1 - WIN_Y0;
  const WIN_MID_Y = (WIN_Y0 + WIN_Y1) / 2;
  const glassMat = track(
    new MeshBasicMaterial({
      color: 0x9dbcff,
      transparent: true,
      opacity: 0.14,
      side: DoubleSide,
      depthWrite: false,
    }),
  );
  const glass = new Mesh(track(new PlaneGeometry(WIN_HALF_W * 2, WIN_H)), glassMat);
  glass.rotation.y = -Math.PI / 2;
  glass.position.set(ROOM_MAX_X - 0.03, WIN_MID_Y, WIN_Z);
  shell.add(glass);
  // Cross mullions read as old joinery for two boxes.
  addProp(track(new BoxGeometry(0.06, WIN_H, 0.07)), trimMat, ROOM_MAX_X - 0.06, WIN_MID_Y, WIN_Z);
  addProp(track(new BoxGeometry(0.06, 0.07, WIN_HALF_W * 2)), trimMat, ROOM_MAX_X - 0.06, WIN_MID_Y, WIN_Z);
  // Sill and head casing.
  addProp(
    track(new BoxGeometry(0.3, 0.08, WIN_HALF_W * 2 + 0.34)),
    trimMat,
    ROOM_MAX_X - 0.14,
    WIN_Y0 - 0.04,
    WIN_Z,
  );
  addProp(
    track(new BoxGeometry(0.12, 0.1, WIN_HALF_W * 2 + 0.3)),
    trimMat,
    ROOM_MAX_X - 0.08,
    WIN_Y1 + 0.05,
    WIN_Z,
  );
  // Light pool on the boards. Cheaper than any volumetric trick and it sells the window.
  const poolMat = track(
    new MeshBasicMaterial({ color: 0x8fb2ff, transparent: true, opacity: 0.1, depthWrite: false }),
  );
  const pool = new Mesh(track(new PlaneGeometry(2.4, WIN_HALF_W * 2 + 0.6)), poolMat);
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(ROOM_MAX_X - 1.5, 0.015, WIN_Z - 0.3);
  shell.add(pool);

  // --- Room A (spawn side, z < PARTITION_Z): rug, table, chairs, a lit candle ---
  const rugMat = track(new MeshLambertMaterial({ map: rugTex }));
  const rug = new Mesh(track(new PlaneGeometry(3.4, 2.6)), rugMat);
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(-0.6, 0.008, -3.1);
  shell.add(rug);

  const TABLE_Y = 0.74;
  const TABLE_X = -3.4;
  const TABLE_Z = -3.2;
  const legGeo = track(new CylinderGeometry(0.055, 0.045, TABLE_Y, 8));
  addProp(track(new BoxGeometry(1.7, 0.09, 0.95)), doorMat, TABLE_X, TABLE_Y + 0.045, TABLE_Z);
  for (const dx of [-0.72, 0.72]) {
    for (const dz of [-0.36, 0.36]) {
      addProp(legGeo, trimMat, TABLE_X + dx, TABLE_Y / 2, TABLE_Z + dz);
    }
  }
  addBlocker(TABLE_X, TABLE_Z, 0.85, 0.48, 0, TABLE_Y + 0.09);
  addShadow(TABLE_X, TABLE_Z, 1.05, 0.66);

  const seatGeo = track(new BoxGeometry(0.46, 0.07, 0.46));
  const backGeo = track(new BoxGeometry(0.46, 0.6, 0.06));
  const chairLegGeo = track(new CylinderGeometry(0.03, 0.026, 0.44, 6));
  const addChair = (x: number, z: number, ry: number): void => {
    const g = new Group();
    g.position.set(x, 0, z);
    g.rotation.y = ry;
    const seat = new Mesh(seatGeo, doorMat);
    seat.position.y = 0.47;
    g.add(seat);
    const back = new Mesh(backGeo, doorMat);
    back.position.set(0, 0.78, -0.2);
    g.add(back);
    for (const dx of [-0.18, 0.18]) {
      for (const dz of [-0.18, 0.18]) {
        const l = new Mesh(chairLegGeo, trimMat);
        l.position.set(dx, 0.22, dz);
        g.add(l);
      }
    }
    shell.add(g);
    addBlocker(x, z, 0.28, 0.28, 0, 0.52);
    addShadow(x, z, 0.34, 0.34);
  };
  addChair(-3.4, -2.05, 0.2);
  addChair(-3.4, -4.35, Math.PI - 0.15);

  // Candle: wax stub plus an unlit-shaded flame quad. No third point light — the lantern and
  // the moon are the whole budget — so the flame is emissive geometry only.
  const CANDLE_X = TABLE_X + 0.45;
  const CANDLE_Z = TABLE_Z - 0.12;
  const CANDLE_TOP = TABLE_Y + 0.09 + 0.16;
  addProp(
    track(new CylinderGeometry(0.035, 0.042, 0.16, 8)),
    track(new MeshLambertMaterial({ color: 0xe8dcc0 })),
    CANDLE_X,
    CANDLE_TOP - 0.08,
    CANDLE_Z,
  );
  const flameMat = track(new MeshBasicMaterial({ color: 0xffc061 }));
  const flame = new Mesh(track(new CylinderGeometry(0.001, 0.022, 0.08, 6)), flameMat);
  flame.position.set(CANDLE_X, CANDLE_TOP + 0.05, CANDLE_Z);
  shell.add(flame);

  // --- Room B (through the doorway): cabinet, barrel, crates ---
  addProp(track(new BoxGeometry(0.55, 1.85, 1.3)), doorMat, ROOM_MIN_X + 0.42, 0.93, 1.6);
  addBlocker(ROOM_MIN_X + 0.42, 1.6, 0.3, 0.68, 0, 1.85);
  addShadow(ROOM_MIN_X + 0.62, 1.6, 0.5, 0.8);

  addProp(track(new CylinderGeometry(0.34, 0.3, 0.9, 12)), trimMat, 4.2, 0.45, -0.1, 0.4);
  addBlocker(4.2, -0.1, 0.36, 0.36, 0, 0.9);
  addShadow(4.2, -0.1, 0.42, 0.42);

  const crateGeo = track(new BoxGeometry(0.62, 0.62, 0.62));
  addProp(crateGeo, doorMat, 2.4, 0.31, 3.9, 0.3);
  addProp(crateGeo, doorMat, 2.95, 0.31, 4.2, -0.5);
  addProp(crateGeo, doorMat, 2.5, 0.93, 4.0, 0.15);
  addBlocker(2.68, 4.05, 0.62, 0.62, 0, 1.24);
  addShadow(2.68, 4.05, 0.78, 0.78);

  // --- Framed pictures: frame box plus a darker canvas standing slightly proud ---
  const canvasMat = track(new MeshLambertMaterial({ color: 0x2a2430 }));
  const addPicture = (x: number, y: number, z: number, w: number, h: number, ry: number): void => {
    const g = new Group();
    g.position.set(x, y, z);
    g.rotation.y = ry;
    g.add(new Mesh(boxFor(w, h, 0.05), trimMat));
    g.add(new Mesh(boxFor(w - 0.12, h - 0.12, 0.07), canvasMat));
    shell.add(g);
  };
  addPicture(-2.2, 1.95, ROOM_MIN_Z + 0.12, 0.8, 1.0, 0);
  addPicture(1.9, 1.85, ROOM_MIN_Z + 0.12, 0.6, 0.75, 0);
  addPicture(ROOM_MIN_X + 0.12, 1.9, -2.6, 0.9, 1.1, Math.PI / 2);
  addPicture(ROOM_MIN_X + 0.12, 1.85, 3.4, 0.7, 0.9, Math.PI / 2);

  // --- Creature: the Phase 0 skinning gate. Framed by the open doorway from spawn, so the
  // first thing the player sees is a silhouette in the next room rather than a bare wall. ---
  const rigged = makeSkinnedCreature();
  rigged.position.set(0.35, 0, 1.1);
  scene.add(rigged);
  track(rigged.material as Material);
  addShadow(0.35, 1.1, 0.38, 0.38);

  controller.setAabbs(aabbs);
  // Backed off and turned slightly toward the table so the opening frame holds the doorway,
  // the lit candle and the furniture instead of one flat stretch of plaster.
  controller.warpTo(new Vector3(0.55, 1.7, -4.1), Math.PI - 0.34);

  const bones = rigged.skeleton.bones;
  let t = 0;
  const update = (dt: number): void => {
    t += dt;
    // Lantern flicker: two out-of-phase sines gutter like a flame without needing noise.
    lantern.intensity = 2.2 + Math.sin(t * 11.3) * 0.16 + Math.sin(t * 4.1) * 0.1;
    flame.scale.set(1, 1 + Math.sin(t * 17) * 0.18, 1);
    // Door eases to its target over roughly a third of a second.
    const doorTarget = doorOpen ? DOOR_OPEN_ANGLE : 0;
    doorAngle += (doorTarget - doorAngle) * Math.min(1, dt * 6);
    doorPivot.rotation.y = doorAngle;
    // Bone sway — the gate itself: bones must visibly drive vertices on the device.
    for (let i = 0; i < bones.length; i++) {
      const b = bones[i];
      if (!b) continue;
      b.rotation.z = Math.sin(t * 1.6 + i * 0.7) * 0.16;
      b.rotation.x = Math.cos(t * 1.1 + i * 0.5) * 0.08;
    }
  };

  const dispose = (): void => {
    engine.camera.remove(lantern);
    scene.remove(shell, rigged, moon, moon.target);
    scene.fog = null;
    const freeGeo = (o: Object3D): void => {
      if ((o as Mesh).isMesh) (o as Mesh).geometry.dispose();
    };
    shell.traverse(freeGeo);
    rigged.traverse(freeGeo);
    for (const d of disposables) d.dispose();
    disposables.length = 0;
  };

  return { rigged, update, dispose };
}

/**
 * Rescale a box's UVs so its texture repeats every `su`/`sv` units instead of once per face.
 * BoxGeometry gives every face a 0..1 map, so a long wall smears one texture across its whole
 * length; this is what keeps texel density roughly constant across pieces of different size.
 *
 * `ou`/`ov` shift the result, which is how neighbouring wall segments continue one pattern
 * instead of each restarting it at their own edge.
 */
function retileUv(geo: BoxGeometry, su: number, sv: number, ou = 0, ov = 0): void {
  const uv = geo.getAttribute('uv') as BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * su + ou, uv.getY(i) * sv + ov);
  }
  uv.needsUpdate = true;
}

/**
 * Minimal skinned mesh: a tapered cylinder bound to a 4-bone spine, weighted by height with
 * a linear blend between neighbouring bones. Phase 0 only has to prove that GPU skinning
 * runs on the target device — the real Daayan model arrives in Phase 3.
 */
function makeSkinnedCreature(): SkinnedMesh {
  const H = 1.7;
  const SEG = 4;
  const geo = new CylinderGeometry(0.17, 0.31, H, 10, SEG);
  geo.translate(0, H / 2, 0); // feet at y = 0, so the mesh can sit on the floor plane

  const pos = geo.getAttribute('position') as BufferAttribute;
  const idx = new Uint16Array(pos.count * 4);
  const wgt = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const f = Math.max(0, Math.min(1, pos.getY(i) / H)) * SEG;
    const b0 = Math.min(SEG - 1, Math.floor(f));
    const blend = f - b0;
    idx[i * 4] = b0;
    idx[i * 4 + 1] = Math.min(SEG - 1, b0 + 1);
    wgt[i * 4] = 1 - blend;
    wgt[i * 4 + 1] = blend;
  }
  geo.setAttribute('skinIndex', new BufferAttribute(idx, 4));
  geo.setAttribute('skinWeight', new BufferAttribute(wgt, 4));

  const bones: Bone[] = [];
  for (let i = 0; i < SEG; i++) {
    const b = new Bone();
    b.position.y = i === 0 ? 0 : H / SEG;
    bones[i - 1]?.add(b);
    bones.push(b);
  }

  const mat = new MeshLambertMaterial({ color: 0x332d38 });
  const mesh = new SkinnedMesh(geo, mat);
  const root = bones[0];
  if (root) mesh.add(root);
  // bind() with no explicit bind matrix updates the world matrices first, so the bone
  // inverses come out right for a chain that was only just parented.
  mesh.bind(new Skeleton(bones));
  // A head parented to the top bone: it inherits the sway for free and turns a bare cylinder
  // into a silhouette that reads as a figure. Shares the body material, so no extra upload.
  const top = bones[SEG - 1];
  if (top) {
    const head = new Mesh(new SphereGeometry(0.18, 10, 8), mat);
    head.position.y = H - (SEG - 1) * (H / SEG) + 0.08;
    top.add(head);
  }
  // Bone animation moves vertices outside the static bounding sphere; without this the
  // creature pops out of existence when the camera edge clips its rest pose.
  mesh.frustumCulled = false;
  return mesh;
}
