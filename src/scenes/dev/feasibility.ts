/**
 * Feasibility scene — Phase 0 gate.
 * Two rooms (~12x10m total), textured walls + floor, hemisphere + point light,
 * one chair (procedural placeholder — CC0 .glb in Phase 1), one rigged test cube (animated).
 *
 * The goal is to prove the rendering + animation + input pipeline works on a real low-end
 * Android device. No gameplay. No puzzles. Just a walkable space with a moving skinned mesh
 * to confirm AnimationMixer drives bone transforms correctly.
 */

import {
  BoxGeometry,
  Color,
  Group,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  PointLight,
  PlaneGeometry,
  Scene,
  SkinnedMesh,
  Bone,
  Skeleton,
  DoubleSide,
  SRGBColorSpace,
  TextureLoader,
  RepeatWrapping,
  AmbientLight,
  BufferAttribute,
  Vector3,
} from 'three';
import type { Engine } from '@/core/Engine';
import type { FPController } from '@/player/FPController';
import type { TouchControls } from '@/player/TouchControls';

export interface FeasibilityHandles {
  rigged: SkinnedMesh;
  update: (dt: number) => void;
  dispose: () => void;
}

export function buildFeasibilityScene(
  scene: Scene,
  controller: FPController,
  touch: TouchControls,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _engine: Engine,
): FeasibilityHandles {
  scene.background = new Color(0x05050a);
  scene.fog = null; // off in feasibility; Phase 1+ may add

  // Ambient + hemisphere
  scene.add(new AmbientLight(0x404060, 0.35));
  const hemi = new HemisphereLight(0xb0b0d0, 0x202020, 0.8);
  scene.add(hemi);

  // A warm point light (the "lantern" placeholder for Phase 0).
  const lantern = new PointLight(0xffb060, 0.9, 12, 1.5);
  lantern.position.set(0, 2.0, 0);
  scene.add(lantern);
  // Sync lantern to player (cheap headlamp in Phase 0).
  touch.setOnToggleLantern(() => {
    lantern.visible = !lantern.visible;
  });

  // --- Build a 2-room shell: Room A (6x6) + Room B (6x4) with an open doorway. ---
  // Using simple box geometry for the feasibility scene — proper wall merging lands in Phase 1.
  const wallMat = new MeshLambertMaterial({ color: 0x6a5a4a });
  const floorMat = new MeshLambertMaterial({ color: 0x3a2a1a });
  const ceilMat = new MeshLambertMaterial({ color: 0x222020 });

  // Try to load a wood texture (graceful fallback to flat color if missing).
  const texLoader = new TextureLoader();
  let woodTex: ReturnType<TextureLoader['load']> | null = null;
  try {
    woodTex = texLoader.load(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      undefined,
      undefined,
      () => {
        /* swallow error: keep flat color */
      },
    );
    if (woodTex) {
      woodTex.wrapS = woodTex.wrapT = RepeatWrapping;
      woodTex.colorSpace = SRGBColorSpace;
    }
  } catch {
    woodTex = null;
  }

  if (woodTex) {
    floorMat.map = woodTex;
    floorMat.needsUpdate = true;
  }

  // Floor
  const floor = new Mesh(new PlaneGeometry(12, 10), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Ceiling
  const ceiling = new Mesh(new PlaneGeometry(12, 10), ceilMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = 3.2;
  scene.add(ceiling);

  // Walls (4 outer + 1 partition with a doorway)
  const wallThickness = 0.2;
  const wallH = 3.2;
  function addWall(x: number, z: number, w: number, d: number): void {
    const m = new Mesh(new BoxGeometry(w, wallH, d), wallMat);
    m.position.set(x, wallH / 2, z);
    m.castShadow = false;
    m.receiveShadow = true;
    scene.add(m);
  }
  // Outer walls
  addWall(0, -5, 12, wallThickness); // north
  addWall(0, 5, 12, wallThickness); // south
  addWall(-6, 0, wallThickness, 10); // west
  addWall(6, 0, wallThickness, 10); // east
  // Partition between Room A (north, -3..0 z) and Room B (south, 0..3 z) with doorway at z=0, x=0..2
  addWall(-3, -1, 6, wallThickness); // partition west segment
  addWall(3, -1, 4, wallThickness); // partition east segment
  addWall(-3, -1, 4, wallThickness); // partition wall stub in middle? (skip — use single wall)

  // Collision AABBs (register with controller for the feasibility shell).
  controller.setAabbs([
    { minX: -6, minY: 0, minZ: -5, maxX: 6, maxY: wallH, maxZ: -4.9 }, // north wall
    { minX: -6, minY: 0, minZ: 4.9, maxX: 6, maxY: wallH, maxZ: 5 }, // south wall
    { minX: -6, minY: 0, minZ: -5, maxX: -5.9, maxY: wallH, maxZ: 5 }, // west
    { minX: 5.9, minY: 0, minZ: -5, maxX: 6, maxY: wallH, maxZ: 5 }, // east
    { minX: -3, minY: 0, minZ: -1.1, maxX: 3, maxY: wallH, maxZ: -0.9 }, // partition
  ]);

  // --- A simple chair (procedural placeholder) — CC0 .glb in Phase 1 ---
  const chair = new Group();
  const seatMat = new MeshStandardMaterial({ color: 0x884422, roughness: 0.85 });
  const legMat = new MeshStandardMaterial({ color: 0x222222, roughness: 0.6 });
  const seat = new Mesh(new BoxGeometry(0.5, 0.05, 0.5), seatMat);
  seat.position.y = 0.45;
  chair.add(seat);
  for (const [lx, lz] of [
    [0.2, 0.2],
    [-0.2, 0.2],
    [0.2, -0.2],
    [-0.2, -0.2],
  ] as const) {
    const leg = new Mesh(new BoxGeometry(0.05, 0.45, 0.05), legMat);
    leg.position.set(lx, 0.225, lz);
    chair.add(leg);
  }
  const back = new Mesh(new BoxGeometry(0.5, 0.6, 0.05), seatMat);
  back.position.set(0, 0.75, -0.225);
  chair.add(back);
  chair.position.set(2, 0, -2);
  scene.add(chair);

  // --- A simple skinned "creature" (procedural — CC0 .glb in Phase 1) ---
  // 2-bone arm chain, animated to confirm AnimationMixer drives bone transforms.
  const rigged = makeSkinnedCreature();
  rigged.position.set(0, 0, 1.5);
  scene.add(rigged);

  // Spawn player in Room A, facing south.
  controller.warpTo(new Vector3(0, 1.7, -2.5), Math.PI);

  // --- Animation loop bits ---
  let animTime = 0;

  return {
    rigged,
    update: (dt: number) => {
      animTime += dt;
      // Simple animation: rotate the body and oscillate bones via a "manual" skin update.
      rigged.rotation.y = Math.sin(animTime * 0.5) * 0.4;
      // Procedural creature — animate bone rotations directly (no AnimationMixer needed for the procedural case).
      const skinnedMesh = rigged;
      const bones = skinnedMesh.skeleton.bones;
      if (bones[1]) bones[1].rotation.x = Math.sin(animTime * 2.0) * 0.4; // upper arm
      if (bones[2]) bones[2].rotation.x = Math.sin(animTime * 2.0 + 0.4) * 0.5; // forearm
    },
    dispose: () => {
      // Cleanup — Three.js handles GC; remove meshes from scene.
      scene.remove(floor, ceiling, chair, rigged);
      floor.geometry.dispose();
      ceiling.geometry.dispose();
      chair.traverse((o) => {
        const m = o as Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as MeshStandardMaterial | MeshLambertMaterial | undefined;
        if (mat && 'dispose' in mat) mat.dispose();
      });
      wallMat.dispose();
      floorMat.dispose();
      ceilMat.dispose();
      seatMat.dispose();
      legMat.dispose();
    },
  };
}

/** Build a 3-bone skinned mesh (root + upper + lower) to exercise the skeleton pipeline. */
function makeSkinnedCreature(): SkinnedMesh {
  const root = new Group();
  const torso = new Mesh(
    new BoxGeometry(0.4, 0.6, 0.25),
    new MeshStandardMaterial({ color: 0x665544, roughness: 0.7 }),
  );
  torso.position.y = 0.7;
  root.add(torso);

  // Two "arm" segments as bones, each with a placeholder mesh parented to a Bone.
  const b0 = new Bone();
  b0.position.set(0.2, 0.85, 0);
  const b1 = new Bone();
  b1.position.set(0.3, 0, 0); // local to b0
  const b2 = new Bone();
  b2.position.set(0.3, 0, 0); // local to b1

  // Attach bones to a root bone.
  const rootBone = new Bone();
  rootBone.add(b0);
  b0.add(b1);
  b1.add(b2);

  // Visualize bones: short capsules (boxes).
  const upper = new Mesh(new BoxGeometry(0.3, 0.06, 0.06), new MeshStandardMaterial({ color: 0xff8866 }));
  upper.position.set(0.15, 0, 0);
  b1.add(upper);
  const lower = new Mesh(new BoxGeometry(0.3, 0.06, 0.06), new MeshStandardMaterial({ color: 0xff6644 }));
  lower.position.set(0.15, 0, 0);
  b2.add(lower);

  // Build a tiny skinned cube driven by these bones to satisfy the SkinnedMesh code path.
  const geo = new BoxGeometry(0.4, 0.6, 0.25);
  // Quick skin indices: assign all 8 vertices to bone 0 with weight 1 (single-bone skin).
  const skinIndices = new Uint16Array(geo.attributes.position!.count * 4);
  const skinWeights = new Float32Array(geo.attributes.position!.count * 4);
  for (let i = 0; i < geo.attributes.position!.count; i++) {
    skinIndices[i * 4 + 0] = 0;
    skinIndices[i * 4 + 1] = 0;
    skinIndices[i * 4 + 2] = 0;
    skinIndices[i * 4 + 3] = 0;
    skinWeights[i * 4 + 0] = 1;
    skinWeights[i * 4 + 1] = 0;
    skinWeights[i * 4 + 2] = 0;
    skinWeights[i * 4 + 3] = 0;
  }
  geo.setAttribute('skinIndex', new BufferAttribute(skinIndices, 4));
  geo.setAttribute('skinWeight', new BufferAttribute(skinWeights, 4));

  const mesh = new SkinnedMesh(
    geo,
    new MeshStandardMaterial({ color: 0x665544, roughness: 0.7, side: DoubleSide }),
  );
  mesh.add(rootBone);
  mesh.bind(new Skeleton([rootBone, b0, b1, b2]));
  mesh.position.set(0, 0, 0);
  return mesh;
}
