import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshPhongMaterial,
  Vector3,
} from 'three';
import { makeAltar, type FixtureMats } from '@/world/Fixtures';
import { buildProps, PLACE } from '@/world/HouseProps';
import { BASE_Y } from '@/world/HouseLayout';

const mats: FixtureMats = {
  iron: new MeshLambertMaterial(),
  brass: new MeshPhongMaterial(),
  wood: new MeshLambertMaterial(),
  door: new MeshLambertMaterial(),
  cloth: new MeshLambertMaterial(),
  bone: new MeshLambertMaterial(),
  dark: new MeshLambertMaterial(),
  glow: new MeshBasicMaterial(),
  paper: new MeshLambertMaterial(),
  red: new MeshLambertMaterial(),
  shadow: new MeshBasicMaterial(),
};

const altar = makeAltar(mats, PLACE.altar.x, PLACE.altar.z, BASE_Y, [
  'moon',
  'cross',
  'eye',
  'skull',
]);
if (altar.symbolAnchors.length !== 0) {
  throw new Error(`ritual still publishes ${altar.symbolAnchors.length} procedural symbols`);
}
if (altar.flames.length !== 0) {
  throw new Error(`ritual still builds ${altar.flames.length} procedural candle flames`);
}

const props = buildProps(mats);
props.group.updateMatrixWorld(true, true);
const p = new Vector3();
let nearbyLowVertices = 0;
const nearbyByMesh = new Map<string, number>();
props.group.traverse((o) => {
  const mesh = o as Mesh;
  if (!mesh.isMesh) return;
  const pos = mesh.geometry.getAttribute('position');
  if (!pos) return;
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    const radius = Math.hypot(p.x - PLACE.altar.x, p.z - PLACE.altar.z);
    if (radius < 1.9 && p.y >= BASE_Y - 0.05 && p.y <= BASE_Y + 0.5) {
      nearbyLowVertices++;
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const kind = (Object.entries(mats) as Array<[string, unknown]>).find(([, value]) => value === material)?.[0] ?? 'unknown';
      const label = `${mesh.name}:${kind}`;
      nearbyByMesh.set(label, (nearbyByMesh.get(label) ?? 0) + 1);
    }
  }
});
if (nearbyLowVertices !== 0) {
  throw new Error(
    `ritual circle still contains ${nearbyLowVertices} low procedural vertices: ${JSON.stringify([...nearbyByMesh])}`,
  );
}

if (props.anchors['ritual.rite'] !== undefined) {
  throw new Error('ritual pinned page still publishes an interaction anchor');
}
let pinnedPageVertices = 0;
props.group.traverse((o) => {
  const mesh = o as Mesh;
  if (!mesh.isMesh) return;
  const pos = mesh.geometry.getAttribute('position');
  if (!pos) return;
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    if (
      p.x >= -25.65 && p.x <= -25.15 &&
      p.y >= BASE_Y + 1.2 && p.y <= BASE_Y + 1.8 &&
      p.z >= -0.9 && p.z <= -0.7
    ) {
      pinnedPageVertices++;
    }
  }
});
if (pinnedPageVertices !== 0) {
  throw new Error(`ritual pinned page still contains ${pinnedPageVertices} vertices`);
}

const sceneSource = readFileSync(join(process.cwd(), 'src/scenes/HouseScene.ts'), 'utf8');
const directAutoOpen = /coffinLid\s*=\s*armRitualCoffin\([\s\S]*?\);\s*coffinLid\?\.open\(\);/.test(sceneSource);
if (directAutoOpen) throw new Error('coffin still opens automatically when its model is armed');
if (!sceneSource.includes("id: 'coffin.lid'")) throw new Error('coffin has no player interaction');
if (!sceneSource.includes("'Open the coffin'")) throw new Error('coffin interaction prompt is missing');
if (!/if \(coffinOpenRequested\) coffinLid\?\.open\(\);/.test(sceneSource)) {
  throw new Error('coffin does not preserve an interaction made before its animation handle is armed');
}

console.log('PASS ritual cleanup: coffin stands alone and opens only after interaction');
