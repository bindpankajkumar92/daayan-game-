import './dom-shim.js';
import { buildHouse } from '../src/world/HouseBuilder.js';
import { DaayanAI } from '../src/ai/DaayanAI.js';
import type { AABB, FPController } from '../src/player/FPController.js';
import type { Vec3 } from '../src/core/types.js';
import { globalBus } from '../src/core/EventBus.js';

const h = buildHouse(1);
const v = (x:number,y:number,z:number)=> ({x,y,z} as Vec3);
const player = {
  pos: v(-15,-3,4.3),
  velocity: v(0,0,0),
  getPosition(){return this.pos;},
  isRunning(){return false;}, isCrouching(){return false;}, getRadius(){return .32;},
} as unknown as FPController;

const ai = new DaayanAI({
  getRoot: () => null, getClips: () => [],
  player, obstacles: h.aabbs as AABB[], floors: h.floors, hidingSpots: [],
  start: { position: v(-28.4,-3,4.3), yaw: 2.41 },
  difficulty: 'normal', overrides: { wakeOnTrigger: false, debug: false },
});

// Force her awake and inspect.
for (let i=0;i<5;i++) ai.update(1/60);
console.log('state', ai.getState(), 'pos', ai.getPosition());
const info = ai.getDebugInfo();
console.log('target', info.target, 'pathLen', info.path.length, 'pathValid', info.pathValid);
console.log('reason', info.reason);

globalBus.emit('noise:emitted', { pos: v(-28.4,-3,4.3), radius: 8, kind: 'door' });
for (let i=0;i<1500;i++) ai.update(1/60);
const i2 = ai.getDebugInfo();
console.log('after 200 ticks:', ai.getState(), 'pos', ai.getPosition());
console.log('target', i2.target, 'pathLen', i2.path.length, 'pathValid', i2.pathValid, 'reason', i2.reason, 'stuck', i2.stuck);
