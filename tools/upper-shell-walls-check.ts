import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MirroredRepeatWrapping, SRGBColorSpace, Texture } from 'three';
import { adoptWallScan } from '@/world/HouseBuilder';

const target = new Texture();
target.image = { width: 1024, height: 1024 } as unknown as CanvasImageSource;
const loaded = new Texture();
const scan = { width: 2048, height: 1024 } as unknown as CanvasImageSource;
loaded.image = scan;
loaded.colorSpace = SRGBColorSpace;
loaded.wrapS = MirroredRepeatWrapping;
loaded.wrapT = MirroredRepeatWrapping;

const version = target.version;
adoptWallScan(target, loaded, 8);

if (target.image !== scan) throw new Error('wall texture kept the procedural canvas instead of the scan');
if (target.wrapS !== MirroredRepeatWrapping || target.wrapT !== MirroredRepeatWrapping) {
  throw new Error('wall texture did not adopt the scan wrap mode');
}
if (target.colorSpace !== SRGBColorSpace) throw new Error('wall texture did not adopt the scan colour space');
if (target.anisotropy !== 8) throw new Error('wall texture did not adopt the scan anisotropy');
if (target.version === version) throw new Error('wall texture was not flagged for upload');

const builder = readFileSync(join(process.cwd(), 'src/world/HouseBuilder.ts'), 'utf8');
for (const token of ['adoptWallScan(texWallWarm, tex, anisotropy)', 'm.map = texWallWarm']) {
  if (!builder.includes(token)) throw new Error(`the wall scan is not adopted in place: missing ${token}`);
}

const props = readFileSync(join(process.cwd(), 'src/world/ModelProps.ts'), 'utf8');
if (!props.includes('dressShell(root, wallMap)')) throw new Error('the sealed shell is no longer dressed at install');
if (!props.includes('worldUv(mesh.geometry, WALL_TILE_U, WALL_TILE_V, mesh.matrixWorld)')) {
  throw new Error('the sealed shell still uses the square procedural UV pitch');
}

const scene = readFileSync(join(process.cwd(), 'src/scenes/HouseScene.ts'), 'utf8');
if (!scene.includes('house.mats.wallWarm.map')) {
  throw new Error('the sealed shell is no longer handed the stable wall texture');
}

console.log('PASS upper shell adopts the damaged wall scan');
