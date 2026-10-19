import './dom-shim';
import { houseFloors, HID_STAIR_WELL, UP_HIDDEN, UP_HIDDEN_FLOOR, UP_HIDDEN_Y, UP_Y, hiddenStairFloors, ROOMS } from '../src/world/HouseRooms';
import { MODEL_PLACEMENTS } from '../src/world/ModelProps';
import { buildHouse } from '../src/world/HouseBuilder';

console.log('=== HID_STAIR_WELL ===');
console.log(HID_STAIR_WELL);

console.log('=== HIDDEN STAIR TREADS ===');
const treads = hiddenStairFloors();
treads.forEach((t, i) => {
  console.log(`Tread ${i}: x: [${t.x0.toFixed(3)}, ${t.x1.toFixed(3)}], z: [${t.z0.toFixed(3)}, ${t.z1.toFixed(3)}], y: ${t.y.toFixed(3)}`);
});

console.log('=== HIDDEN ROOM FLOOR ===');
console.log('UP_HIDDEN_FLOOR:', UP_HIDDEN_FLOOR, 'UP_HIDDEN_Y:', UP_HIDDEN_Y);

const house = buildHouse(1);
console.log('Total aabbs:', house.aabbs.length, 'Total floors:', house.floors.length);

const hiddenFloors = house.floors.filter(f => f.x1 >= 15.6 && f.x0 <= 21.6 && f.z1 >= -6.2 && f.z0 <= 0.61);
console.log('=== FLOORS IN HIDDEN ROOM / STAIR AREA ===');
hiddenFloors.forEach((f, i) => {
  console.log(`Floor ${i}: x: [${f.x0.toFixed(2)}, ${f.x1.toFixed(2)}], z: [${f.z0.toFixed(2)}, ${f.z1.toFixed(2)}], y: ${f.y.toFixed(3)}`);
});

console.log('=== MODEL PLACEMENTS FOR STAIR AND WARDROBE ===');
const stairPlacement = MODEL_PLACEMENTS.find(m => m.id === 'hidden-stair.glb');
console.log('stairPlacement:', stairPlacement);

const wardrobePlacement = MODEL_PLACEMENTS.find(m => m.id === 'hidden-wardrobe.glb');
console.log('wardrobePlacement:', wardrobePlacement);

const motherPlacement = MODEL_PLACEMENTS.find(m => m.id === 'hidden-mother.glb');
console.log('motherPlacement:', motherPlacement);

const necklacePlacement = MODEL_PLACEMENTS.find(m => m.id === 'hidden-necklace.glb');
console.log('necklacePlacement:', necklacePlacement);

// Check colliders
const collidersNearStair = house.aabbs.filter(a =>
  a.maxX > 15.5 && a.minX < 19.5 && a.maxZ > -2.0 && a.minZ < 1.0
);
console.log('=== COLLIDERS NEAR STAIR ===');
collidersNearStair.forEach((c, i) => {
  console.log(`Collider ${i}: x: [${c.minX.toFixed(2)}, ${c.maxX.toFixed(2)}], y: [${c.minY.toFixed(2)}, ${c.maxY.toFixed(2)}], z: [${c.minZ.toFixed(2)}, ${c.maxZ.toFixed(2)}]`);
});
