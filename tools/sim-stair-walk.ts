import './dom-shim';
import { FPController } from '../src/player/FPController';
import { buildHouse } from '../src/world/HouseBuilder';
import { Vector3, PerspectiveCamera } from 'three';

const house = buildHouse(1);
const mockEngine = {
  camera: new PerspectiveCamera(),
  getTempVec3A: (() => { const v = new Vector3(); return () => v; })(),
  getTempVec3B: (() => { const v = new Vector3(); return () => v; })(),
};
const controller = new FPController(mockEngine as any, {
  radius: 0.35,
  walkSpeed: 2.2,
  eyeHeight: 1.7,
  crouchEyeHeight: 1.1,
  stepUpHeight: 0.35,
});

controller.setAabbs(house.aabbs);
controller.setFloors(house.floors);

console.log('=== TEST 1: Walking UP the stair (West to East) ===');
// Warp to foot of stair: x=16.5, y=0.2+1.7=1.9, z=-0.46, facing East (+x, yaw = -Math.PI / 2)
controller.warpTo(new Vector3(16.5, 1.9, -0.46), -Math.PI / 2);
for (let frame = 0; frame <= 100; frame++) {
  if (frame % 20 === 0) {
    const pos = controller.getPosition();
    console.log(`Frame ${String(frame).padStart(3)}: x=${pos.x.toFixed(3)}, y=${pos.y.toFixed(3)}, z=${pos.z.toFixed(3)}, feet=${(pos.y - 1.7).toFixed(3)}`);
  }
  controller.move(0, 1, 1 / 60);
}

console.log('\n=== TEST 2: Walking DOWN the stair (East to West) ===');
// Warp to top of stair: x=18.6, y=2.4+1.7=4.1, z=-0.46, facing West (-x, yaw = Math.PI / 2)
controller.warpTo(new Vector3(18.6, 4.1, -0.46), Math.PI / 2);
for (let frame = 0; frame <= 100; frame++) {
  if (frame % 20 === 0) {
    const pos = controller.getPosition();
    console.log(`Frame ${String(frame).padStart(3)}: x=${pos.x.toFixed(3)}, y=${pos.y.toFixed(3)}, z=${pos.z.toFixed(3)}, feet=${(pos.y - 1.7).toFixed(3)}`);
  }
  controller.move(0, 1, 1 / 60);
}

console.log('\n=== TEST 3: Walking North into elevated stairs at x=17.5 (MUST BE BLOCKED) ===');
// Facing North (+z, yaw = Math.PI)
controller.warpTo(new Vector3(17.5, 1.9, -2.0), Math.PI);
for (let frame = 0; frame <= 60; frame++) {
  if (frame % 20 === 0) {
    const pos = controller.getPosition();
    console.log(`Frame ${String(frame).padStart(3)}: x=${pos.x.toFixed(3)}, y=${pos.y.toFixed(3)}, z=${pos.z.toFixed(3)}, feet=${(pos.y - 1.7).toFixed(3)}`);
  }
  controller.move(0, 1, 1 / 60);
}
const finalZBlocked = controller.getPosition().z;
if (finalZBlocked < -1.15) {
  console.log(`SUCCESS: Player was stopped at z=${finalZBlocked.toFixed(3)} by south cheek wall! Cannot pass under stairs.`);
} else {
  console.error(`FAILURE: Player bypassed wall and reached z=${finalZBlocked.toFixed(3)}!`);
  process.exit(1);
}

console.log('\n=== TEST 4: Walking North into landing opening at x=16.5 (MUST SUCCEED) ===');
controller.warpTo(new Vector3(16.5, 1.9, -2.0), Math.PI);
for (let frame = 0; frame <= 60; frame++) {
  if (frame % 20 === 0) {
    const pos = controller.getPosition();
    console.log(`Frame ${String(frame).padStart(3)}: x=${pos.x.toFixed(3)}, y=${pos.y.toFixed(3)}, z=${pos.z.toFixed(3)}, feet=${(pos.y - 1.7).toFixed(3)}`);
  }
  controller.move(0, 1, 1 / 60);
}
const finalZOpen = controller.getPosition().z;
if (finalZOpen > -0.6) {
  console.log(`SUCCESS: Player walked cleanly through opening onto landing at z=${finalZOpen.toFixed(3)}!`);
} else {
  console.error(`FAILURE: Player was blocked from entering landing at z=${finalZOpen.toFixed(3)}!`);
  process.exit(1);
}

console.log('\nALL 4 WALKING SIMULATION TESTS PASSED!');
