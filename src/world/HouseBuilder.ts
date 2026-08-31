/**
 * HouseBuilder — turns the HouseRooms data into meshes, colliders and walkable floors.
 *
 * Two deliberate choices:
 *
 * - **Merged per room, per material.** Every wall in a room becomes one BufferGeometry. Seven
 *   rooms of individual boxes would be ~150 draw calls; merged it is closer to 25, and merging
 *   per *room* rather than per house keeps frustum culling useful — the ritual room costs nothing
 *   while you are upstairs.
 * - **World-anchored UVs, baked.** Every vertex's UV is computed from where it ends up in the
 *   world, so the plaster runs continuously through corners and door jambs instead of restarting
 *   at every segment. Combined with the seamless textures in ProcTextures, that is what stops a
 *   long wall reading as a grid of identical panels — and see worldUv for the second, larger
 *   thing it buys.
 *
 * Materials are Lambert, not Standard: a physical BRDF per fragment measured 3.5x the frame time
 * on the 4 GB target for detail that is invisible in a house lit by one lantern.
 */

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
  type Material,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { AABB, FloorRect } from '@/player/FPController';
import { makeCeilingBoards, makePlaster, makeWoodFloor, makeWoodPanel } from './ProcTextures';
import { expandRun, segmentBox, type Box, type Segment } from './HouseLayout';
import { ROOMS, UPPER_PATCH, houseFloors, stairTreads } from './HouseRooms';

/** World size one texture repeat covers. Wall plaster at 2.4 m ≈ 210 px/m from a 512 px map. */
const WALL_TILE = 2.4;
const FLOOR_TILE = 1.6;
const TRIM_TILE = 0.9;
const SKIRT_H = 0.14;

/**
 * Largest edge, in metres, allowed on a floor, ceiling or wall triangle.
 *
 * Not a texture or lighting concern — a depth one. A room slab drawn as two triangles is up to
 * 10x7 m, and when the player stands beside one of its corners that corner's view depth passes
 * through zero: the vertex lands on the camera plane, w -> 0, and the projected triangle runs off
 * to infinity. The near-plane clip still produces the right silhouette, but 1/w interpolation
 * across the survivor is worthless, and the slab's depth comes out metres wrong — enough for a
 * ceiling 4.4 m away to win the depth test against a solid wall at 1.8 m. On screen that is a
 * black wedge punched through the wall, moving and reshaping as the player walks past, which is
 * exactly the reported glitch. It only bites on diagonal views, because only there does a corner
 * sit exactly on the camera plane.
 *
 * Splitting the slab into metre quads bounds the damage to the one small triangle that owns the
 * degenerate corner. Measured on the worst view: 5958 flipped pixels -> 70. Costs ~2k triangles
 * across the whole house and not one extra draw call.
 *
 * This used to apply to slabPlane() alone, which was half a fix: the house's largest single face is
 * not a floor but a wall — 27.0 m2 of hallway drawn as two triangles — and a wall is the surface the
 * player stands closest to, so it is *more* likely to put a corner on the camera plane, not less.
 * worldBox subdivides on the same number now.
 */
const SLAB_SEG = 1;

/** Segments needed along an edge of `n` metres so no quad is wider than SLAB_SEG. */
const segs = (n: number): number => Math.max(1, Math.ceil(n / SLAB_SEG));

/** A floor/ceiling plane subdivided so no triangle is large enough to break depth interpolation. */
function slabPlane(w: number, d: number): PlaneGeometry {
  return new PlaneGeometry(w, d, segs(w), segs(d));
}

export interface BuiltHouse {
  group: Group;
  aabbs: AABB[];
  floors: FloorRect[];
  /** Shared materials, exposed so props can reuse them instead of allocating more. */
  mats: {
    trim: MeshLambertMaterial;
    door: MeshLambertMaterial;
    wallWarm: MeshLambertMaterial;
    wallCool: MeshLambertMaterial;
  };
  dispose: () => void;
}

/**
 * Scale a geometry's UVs so one texture repeat covers `tile` world units, then shift them by a
 * world offset so neighbouring pieces continue the same pattern.
 */
function anchorUv(geo: BufferGeometry, su: number, sv: number, ou: number, ov: number): void {
  const uv = geo.getAttribute('uv') as BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * su + ou, uv.getY(i) * sv + ov);
  }
  uv.needsUpdate = true;
}

/**
 * UVs straight from world position, so two faces that meet — or coincide — sample the same texel at
 * the same point in the world.
 *
 * This replaced a scale-and-offset of BoxGeometry's own UVs, which could not do that however the
 * offset was chosen. BoxGeometry lays out its `nz` and `px` faces with udir = -1, i.e. u increasing
 * the other way, so an offset that lined one face up left its mirror running backwards: at world
 * x = -1.0 the bedroom's face sampled u = -3.750 where the living room's sampled u = +1.167, a
 * 4.9-tile jump at one point in the world. That is a hard seam at every segment join.
 *
 * It is also what made this house's coplanar overlaps *visible*, which is the bigger half. segmentBox
 * pads every wall segment by HALF_T at both ends so corners close without a gap, so wherever two
 * rooms both claim the wall between them the two pieces overlap in a 0.2 x 0.2 column and their outer
 * faces are exactly coincident — 0.000 m apart, so no near-plane or depth-format change can separate
 * them. Walls merge per room, so each such pair is two draw calls, and the opaque sort is by
 * bounding-sphere view depth: the winner flips as the player walks past, which is precisely the
 * "glitch pe alag alag dekhta hai" in the report. Feed both faces the same texel and it stops
 * mattering who wins. Measured: of 163 cross-batch coplanar overlaps in the shell, this silences
 * every one whose two sides share a material — 140 of them.
 *
 * Per vertex from the face normal rather than from the box's long axis, so ends and tops are anchored
 * as well as sides. Positions must already be in world space.
 */
function worldUv(geo: BufferGeometry, tile: number): void {
  const pos = geo.getAttribute('position') as BufferAttribute;
  const nor = geo.getAttribute('normal') as BufferAttribute;
  const uv = geo.getAttribute('uv') as BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const ax = Math.abs(nor.getX(i));
    const ay = Math.abs(nor.getY(i));
    const az = Math.abs(nor.getZ(i));
    // A horizontal face reads x across and z up the image; a vertical one reads whichever horizontal
    // axis it runs along, and y up. No ties to break: every normal on a box is a world axis.
    const flat = ay > ax && ay > az;
    const u = flat || az > ax ? pos.getX(i) : pos.getZ(i);
    const v = flat ? pos.getZ(i) : pos.getY(i);
    uv.setXY(i, u / tile, v / tile);
  }
  uv.needsUpdate = true;
}

/** A wall/prop box, subdivided against depth error and UV-anchored to where it sits in the world. */
function worldBox(b: Box, tile: number): BufferGeometry {
  const geo = new BoxGeometry(b.w, b.h, b.d, segs(b.w), segs(b.h), segs(b.d));
  geo.translate(b.cx, b.cy, b.cz);
  worldUv(geo, tile);
  return geo;
}

function boxToAabb(b: Box): AABB {
  return {
    minX: b.cx - b.w / 2,
    maxX: b.cx + b.w / 2,
    minY: b.cy - b.h / 2,
    maxY: b.cy + b.h / 2,
    minZ: b.cz - b.d / 2,
    maxZ: b.cz + b.d / 2,
  };
}

/**
 * Metres the skirting stops short of its wall segment at each end.
 *
 * Without it the skirting is exactly as long as the wall, so its end cap is coplanar with the wall's
 * end cap over the full 0.2 x 0.14 of it — trim against plaster, in two different merged meshes, which
 * is the flickering-patch case again and it happens at all 26 segment ends. 2 mm is invisible where the
 * end is buried in a corner, reads as the skirting stopping at the reveal where it is not, and still
 * leaves 98 mm of overlap with the skirting round the corner.
 */
const SKIRT_END = 0.004;

/** Skirting board: the same footprint as the wall, slightly proud of it and ankle-high. */
function skirtBox(b: Box): Box {
  const alongX = b.w > b.d;
  return {
    cx: b.cx,
    cy: b.cy - b.h / 2 + SKIRT_H / 2,
    cz: b.cz,
    w: alongX ? b.w - SKIRT_END : b.w + 0.03,
    h: SKIRT_H,
    d: alongX ? b.d + 0.03 : b.d - SKIRT_END,
  };
}

export function buildHouse(anisotropy: number): BuiltHouse {
  const disposables: Array<{ dispose: () => void }> = [];
  const track = <T extends { dispose: () => void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  // --- Textures. 1024 procedural tiles; see ProcTextures for why they are no longer 512, and why
  // the bump halves these generators used to return are gone rather than wired up. ---
  // `anisotropy` arrives already capped by HouseScene, which caps the imported art by the same
  // number. Clamping again here is how the two drifted apart in the first place.
  const pick = (t: Texture): Texture => {
    t.anisotropy = anisotropy;
    return track(t);
  };
  const texWallWarm = pick(makePlaster(4242, 'warm'));
  const texWallCool = pick(makePlaster(1717, 'cool'));
  const texFloorWood = pick(makeWoodFloor(1337, 8));
  const texFloorStone = pick(makePlaster(2929, 'cool'));
  const texCeil = pick(makeCeilingBoards(7171));
  const texTrim = pick(makeWoodPanel(909, 0.7));
  const texDoor = pick(makeWoodPanel(515, 0.9));

  /**
   * A fixed depth bias, so that every remaining exact tie in the house has the same winner from every
   * eye position.
   *
   * World-anchored UVs make a tie invisible when both sides share a material, which is 140 of the 163
   * cross-batch coplanar pairs the shell has. The rest are cross-material, and for those the fragment
   * colours genuinely differ, so *something* has to decide — and the default, a per-object sort by
   * bounding-sphere view depth, decides differently as the player walks past. That is the flicker.
   *
   * One depth unit is all it takes: at the far plane's 60 m a 24-bit buffer still resolves well under a
   * millimetre, so this can never open a visible gap, and it is applied per fragment rather than per
   * object so it does not care which mesh drew first. What it buys is a *ladder* with the imported models
   * on the rung they should be on. They keep their own materials and so sit at offset 0, and every
   * procedural shell surface is pushed behind them: a procedural wall only ever stands where a model
   * leaves a hole, so wherever the two coincide the model is the surface that was meant to be seen. That
   * settles the one class of tie this file cannot measure at all. Above the models sits trim, because a
   * skirting board and a door casing *are* proud of their wall; below them plaster; and below that the
   * cellar tones, so at the cellar doorway — where a hallway wall and the stair shaft's own wall claim
   * the same 0.2 m column — the plaster the player is standing next to wins, from either side.
   */
  const TRIM_Z = -1;
  const WARM_Z = 1;
  const COOL_Z = 2;
  /**
   * Units only, factor 0. GL's offset is `factor * maxDepthSlope + r * units`, where r is by definition
   * the smallest value that produces a resolvable difference — so one unit is exactly enough to break a
   * tie, and the slope term is not merely unnecessary but harmful: it scales with view angle, and a wall
   * seen edge-on has an enormous depth slope, so a non-zero factor would push that wall back by far more
   * than a hair at exactly the grazing angles this house is full of. Two coincident faces share a slope,
   * so the constant term alone orders them the same way from every direction.
   */
  const bias = (units: number): { polygonOffset: true; polygonOffsetFactor: 0; polygonOffsetUnits: number } => ({
    polygonOffset: true,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: units,
  });

  const mats = {
    wallWarm: track(new MeshLambertMaterial({ map: texWallWarm, ...bias(WARM_Z) })),
    wallCool: track(new MeshLambertMaterial({ map: texWallCool, color: 0x9aa0a8, ...bias(COOL_Z) })),
    floorWood: track(new MeshLambertMaterial({ map: texFloorWood, ...bias(WARM_Z) })),
    floorStone: track(new MeshLambertMaterial({ map: texFloorStone, color: 0x8f9096, ...bias(COOL_Z) })),
    ceil: track(new MeshLambertMaterial({ map: texCeil, ...bias(WARM_Z) })),
    trim: track(new MeshLambertMaterial({ map: texTrim, ...bias(TRIM_Z) })),
    door: track(new MeshLambertMaterial({ map: texDoor, ...bias(TRIM_Z) })),
  };

  const group = new Group();
  group.name = 'house';
  const aabbs: AABB[] = [];

  const addMerged = (geos: BufferGeometry[], mat: Material, name: string): void => {
    if (geos.length === 0) return;
    const merged = mergeGeometries(geos);
    for (const g of geos) g.dispose();
    if (!merged) return;
    const mesh = new Mesh(track(merged), mat);
    mesh.name = name;
    group.add(mesh);
  };

  for (const room of ROOMS) {
    const y0 = room.floorY;
    const y1 = room.floorY + room.height;
    const wallGeos: BufferGeometry[] = [];
    const skirtGeos: BufferGeometry[] = [];

    for (const run of room.walls) {
      const segments: Segment[] = expandRun(run, y0, y1);
      for (const s of segments) {
        const b = segmentBox(s);
        // A collide-only run stands where an imported model has already drawn the wall.
        if (run.collideOnly !== true) {
          wallGeos.push(worldBox(b, WALL_TILE));
          // Skirting only where the segment actually meets the floor, and only upstairs — a
          // cellar has bare walls.
          if (room.tone === 'plaster' && Math.abs(s.y0 - y0) < 0.01) {
            skirtGeos.push(worldBox(skirtBox(b), TRIM_TILE));
          }
        }
        aabbs.push(boxToAabb(b));
      }
    }
    addMerged(wallGeos, room.tone === 'plaster' ? mats.wallWarm : mats.wallCool, `${room.id}-walls`);
    addMerged(skirtGeos, mats.trim, `${room.id}-skirt`);

    // Floor and ceiling as single planes. Their texture is scaled but not world-anchored: one
    // mesh covers the whole room, so there is no neighbour to line up with.
    const fw = room.floor.x1 - room.floor.x0;
    const fd = room.floor.z1 - room.floor.z0;
    if (room.modelled !== true) {
      const floorGeo = track(slabPlane(fw, fd));
      anchorUv(floorGeo, fw / FLOOR_TILE, fd / FLOOR_TILE, 0, 0);
      const floor = new Mesh(floorGeo, room.tone === 'plaster' ? mats.floorWood : mats.floorStone);
      floor.rotation.x = -Math.PI / 2;
      floor.position.set((room.floor.x0 + room.floor.x1) / 2, y0, (room.floor.z0 + room.floor.z1) / 2);
      floor.name = `${room.id}-floor`;
      group.add(floor);
    }

    if (room.ceiling) {
      const ceilGeo = track(slabPlane(fw, fd));
      anchorUv(ceilGeo, fw / FLOOR_TILE, fd / FLOOR_TILE, 0, 0);
      const ceil = new Mesh(ceilGeo, room.tone === 'plaster' ? mats.ceil : mats.wallCool);
      ceil.rotation.x = Math.PI / 2;
      ceil.position.set((room.floor.x0 + room.floor.x1) / 2, y1, (room.floor.z0 + room.floor.z1) / 2);
      ceil.name = `${room.id}-ceil`;
      group.add(ceil);
    }
  }

  // The two holes the imported flat leaves in its own floor and ceiling. See UPPER_PATCH: `modelled`
  // suppressed both planes for the whole room on the promise that the model brings them, and it keeps
  // that promise everywhere except the room the player walks into first. Drawn here rather than by
  // relaxing `modelled`, because a plane over the whole rect would bury the 99% the model does cover.
  for (const [i, r] of UPPER_PATCH.rects.entries()) {
    const w = r.x1 - r.x0;
    const d = r.z1 - r.z0;
    const cx = (r.x0 + r.x1) / 2;
    const cz = (r.z0 + r.z1) / 2;
    const floorGeo = track(slabPlane(w, d));
    // World-anchored, unlike the room planes above: these two abut the model's own slab, and a tiling
    // that restarts at each patch's centre would show the join as a seam in the stone.
    anchorUv(floorGeo, w / FLOOR_TILE, d / FLOOR_TILE, r.x0 / FLOOR_TILE, r.z0 / FLOOR_TILE);
    const floor = new Mesh(floorGeo, mats.floorStone);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, UPPER_PATCH.floorY, cz);
    floor.name = `upper-patch-floor-${i}`;
    group.add(floor);

    const ceilGeo = track(slabPlane(w, d));
    anchorUv(ceilGeo, w / FLOOR_TILE, d / FLOOR_TILE, r.x0 / FLOOR_TILE, r.z0 / FLOOR_TILE);
    const ceil = new Mesh(ceilGeo, mats.wallCool);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(cx, UPPER_PATCH.ceilY, cz);
    ceil.name = `upper-patch-ceil-${i}`;
    group.add(ceil);
  }

  // player walks down them instead of into them.
  addMerged(
    stairTreads().map((b) => worldBox(b, TRIM_TILE)),
    mats.trim,
    'stair-treads',
  );

  const dispose = (): void => {
    group.removeFromParent();
    for (const d of disposables) d.dispose();
    disposables.length = 0;
  };

  return { group, aabbs, floors: houseFloors(), mats, dispose };
}
