import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

for (const id of ['hall.notice', 'hall.photo', 'basement.diagram', 'basement.draught']) {
  if (props.anchors[id] !== undefined) throw new Error(`${id} still publishes an interaction anchor`);
}

const probes: Array<{ name: string; x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }> = [
  { name: 'hall notice', x0: 1.7, x1: 2.1, y0: 1.2, y1: 1.7, z0: -6.9, z1: -6.75 },
  { name: 'hall photograph', x0: 4.78, x1: 4.88, y0: 1.3, y1: 2.05, z0: -3.95, z1: -3.25 },
  { name: 'basement diagram', x0: -20.95, x1: -20.3, y0: -2.05, y1: -1.2, z0: -1.9, z1: -1.75 },
  { name: 'basement note', x0: -16.65, x1: -16.15, y0: -1.85, y1: -1.25, z0: -1.9, z1: -1.75 },
];
const p = new Vector3();
const counts = new Map<string, number>();
props.group.traverse((o) => {
  const mesh = o as Mesh;
  if (!mesh.isMesh) return;
  const pos = mesh.geometry.getAttribute('position');
  if (!pos) return;
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    for (const probe of probes) {
      if (p.x >= probe.x0 && p.x <= probe.x1 && p.y >= probe.y0 && p.y <= probe.y1 && p.z >= probe.z0 && p.z <= probe.z1) {
        counts.set(probe.name, (counts.get(probe.name) ?? 0) + 1);
      }
    }
  }
});
if (counts.size !== 0) throw new Error(`wall props still have vertices: ${JSON.stringify([...counts])}`);

const scene = readFileSync(join(process.cwd(), 'src/scenes/HouseScene.ts'), 'utf8');
for (const token of ['makeBreakerPanel', 'panel.rockers', 'showSwitchPanel']) {
  if (scene.includes(token)) throw new Error(`breaker panel is still wired through ${token}`);
}

console.log('PASS wall notes, photograph, diagram and breaker panel removed');
