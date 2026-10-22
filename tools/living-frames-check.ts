import {
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshPhongMaterial,
  Vector3,
} from 'three';
import { type FixtureMats } from '@/world/Fixtures';
import { buildProps } from '@/world/HouseProps';

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

const props = buildProps(mats);
props.group.updateMatrixWorld(true, true);
const p = new Vector3();
let wallVertices = 0;
props.group.traverse((o) => {
  const mesh = o as Mesh;
  if (!mesh.isMesh) return;
  const pos = mesh.geometry.getAttribute('position');
  if (!pos) return;
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    if (p.x >= 8.78 && p.x <= 8.86 && p.y >= 1.2 && p.y <= 1.8 && p.z >= 4.8 && p.z <= 7.2) {
      wallVertices++;
    }
  }
});

if (wallVertices !== 0) {
  throw new Error(`living-room wall still contains ${wallVertices} frame vertices`);
}

console.log('PASS living-room wall frames removed');
