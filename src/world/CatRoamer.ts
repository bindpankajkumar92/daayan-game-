/**
 * CatRoamer — the black cat that walks the whole house, and meows when it catches sight of you.
 *
 * Four things here are not obvious:
 *
 * - **It cannot be a MODEL_PLACEMENTS row.** ModelProps freezes each model's cull centre at load and
 *   re-derives visibility from it forever, so a moving model placed that way either vanishes or stays
 *   drawn from across the map. The row for cat-walk.glb was deleted; this file is the only owner of
 *   that file, which is also why it may edit its materials in place.
 *
 * - **The model hangs off a wrapper Group, and the wrapper is what moves.** fitToHeight measures in
 *   world space and writes a centring offset into the root's own `position`, so overwriting that
 *   position every frame would un-centre the model. The wrapper carries the waypoint and the heading;
 *   the root keeps its offset. It also means the fit happens once, unparented, under identity.
 *
 * - **The line of sight is a slab test, not a sampled ray.** The cat's sight line has to cross rooms,
 *   and sampling a 6 m segment finely enough not to step over a wall is both slower and still
 *   approximate. A segment-vs-AABB slab test against the array the controller already collides with
 *   is exact, costs about ten operations per box, and gets doorways for free: an open doorway is a
 *   gap in that array, and a closed door leaf is a box in it.
 *
 * - **cat-walk.glb is not actually black.** It is the only cat asset with a real leg-driven walk —
 *   cat.glb is uniformly black but its one clip is a grooming idle with no leg or root channels, and
 *   the two skeletons are unrelated, so there is no clip to retarget. Almost a fifth of this one's
 *   surface is white markings, and those live in the texture rather than the base colour, so scaling
 *   the material colour down takes the markings to a dark grey and the fur to near black.
 */

import {
  Group,
  type AnimationMixer,
  type Camera,
  type Mesh,
  type MeshLambertMaterial,
  type Object3D,
  type PositionalAudio,
  type Scene,
} from 'three';
import type { AABB } from '@/player/FPController';
import type { GameAudio } from '@/audio/AudioManager';
import { CAT_CHAINS, CAT_GATED, CAT_NODES } from '@/world/CatRoutes';
import { globalBus } from '@/core/EventBus';
import { fitToHeight, playClip, type ModelLoader } from '@/world/ModelLoader';

const CAT_FILE = 'cat-walk.glb';
const MEOW_FILE = 'cat-meow.mp3';

/**
 * Metres along the longest axis, which for this asset is nose to tail on local Z — so the fitted
 * animal comes out 0.18 wide and 0.43 tall, and 0.6 is a cat rather than a panther.
 */
const CAT_LEN = 0.6;

/** See the header: takes the white markings to dark grey and the fur to near black. */
const CAT_ALBEDO = 0.35;

/** Metres per second. A house cat's walk, and slow enough that the 0.77 s clip does not skate. */
const SPEED = 0.75;

/** Radians per second the heading may change. Without a cap the cat snaps round at every corner. */
const TURN_RATE = 4.0;

/**
 * Added to the heading. The model noses along its own +Z, which is the direction atan2(dx, dz)
 * aims, so this is zero — it exists because the sign is a property of the export and not of the
 * maths, and a re-export that faces the other way is a one-constant fix rather than a hunt.
 */
const FACE_YAW = 0;

/** Where the cat's head is above its feet, for the sight line only. */
const EYE_UP = 0.22;

/** Same radius as ModelProps' distance cull, and for the same reason: walls do not stop a frustum. */
const CULL_RADIUS_SQ = 50 * 50;

/** The cat's own half-width and standing height, for the one-off route check. */
const RADIUS = 0.15;
const BAND = 0.35;

/** Sampling pitch along an edge during the route check, and when it runs. */
const STEP = 0.15;
const CHECK_AT = 4.0;

/** How far the cat notices the player from, how often it looks, and how long until it may meow again. */
const SEE_DIST = 6.0;
const SEE_EVERY = 0.25;
const MEOW_COOLDOWN = 7.0;

export interface CatRoamerHandles {
  update: (dt: number) => void;
  dispose: () => void;
}

/** Scratch box for the route check, so a hundred edge samples do not allocate a hundred objects. */
const probe: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

function overlaps(a: AABB, b: AABB): boolean {
  return (
    a.minX < b.maxX &&
    a.maxX > b.minX &&
    a.minY < b.maxY &&
    a.maxY > b.minY &&
    a.minZ < b.maxZ &&
    a.maxZ > b.minZ
  );
}

/**
 * Does the segment from `o` along `d` (d spanning the whole segment, so t runs 0..1) touch `b`?
 *
 * The standard slab clip: intersect the per-axis entry/exit ranges and see whether anything is left.
 * An axis the segment does not move along degenerates to a containment test, which is the branch that
 * makes a purely horizontal sight line work against a floor-to-ceiling wall box.
 */
function segHits(b: AABB, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): boolean {
  let t0 = 0;
  let t1 = 1;
  const axis = (o: number, d: number, lo: number, hi: number): boolean => {
    if (d === 0) return o >= lo && o <= hi;
    const a = (lo - o) / d;
    const c = (hi - o) / d;
    t0 = Math.max(t0, Math.min(a, c));
    t1 = Math.min(t1, Math.max(a, c));
    return t0 <= t1;
  };
  return (
    axis(ox, dx, b.minX, b.maxX) && axis(oy, dy, b.minY, b.maxY) && axis(oz, dz, b.minZ, b.maxZ)
  );
}

/** Scale every distinct Lambert colour under `root`. Distinct matters: conform() shares instances. */
function shade(root: Object3D, k: number): void {
  const seen: MeshLambertMaterial[] = [];
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const lam = m as MeshLambertMaterial;
      if (seen.includes(lam)) continue;
      lam.color.multiplyScalar(k);
      seen.push(lam);
    }
  });
}

/** Shortest signed angle from `a` to `b`, so a turn never takes the long way round. */
function shortest(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Put the cat in the house. Resolves nothing: the model arrives over the next few frames and until it
 * does the update is a no-op, exactly like the rest of the imported art. `ritualOpen` is read every
 * frame rather than taken once — it is the one puzzle flag that changes where the cat may go, and it
 * only ever turns on, so the gated edge is added at the moment it does.
 */
export function installCat(
  loader: ModelLoader,
  audio: GameAudio,
  scene: Scene,
  eye: Camera,
  aabbs: readonly AABB[],
  ritualOpen: () => boolean,
  onError: (err: unknown, where: string) => void,
): CatRoamerHandles {
  const index = new Map<string, number>();
  CAT_NODES.forEach((n, i) => index.set(n.name, i));
  const adj: number[][] = CAT_NODES.map(() => []);

  const link = (an: string, bn: string): void => {
    const a = index.get(an);
    const b = index.get(bn);
    if (a === undefined || b === undefined) {
      onError(new Error(`unknown node ${a === undefined ? an : bn}`), 'cat:routes');
      return;
    }
    const la = adj[a];
    const lb = adj[b];
    if (!la || !lb) return;
    if (!la.includes(b)) la.push(b);
    if (!lb.includes(a)) lb.push(a);
  };

  const unlink = (a: number, b: number): void => {
    const la = adj[a];
    const lb = adj[b];
    if (la) {
      const i = la.indexOf(b);
      if (i >= 0) la.splice(i, 1);
    }
    if (lb) {
      const i = lb.indexOf(a);
      if (i >= 0) lb.splice(i, 1);
    }
  };

  for (const chain of CAT_CHAINS) {
    const names = chain.split(' ');
    for (let i = 1; i < names.length; i++) link(names[i - 1] ?? '', names[i] ?? '');
  }

  /**
   * Fewest hops, not shortest metres. The edges are all roughly a room or less and the cat has
   * nowhere it needs to be, so a priority queue would buy a slightly straighter wander and nothing
   * else. Returns the nodes after `from`, or null if `to` is unreachable — which the gated ritual
   * room genuinely is until the shelf moves.
   */
  const route = (from: number, to: number): number[] | null => {
    if (from === to) return null;
    const prev = new Int32Array(CAT_NODES.length).fill(-1);
    prev[from] = from;
    const queue = [from];
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      if (cur === undefined) break;
      for (const nb of adj[cur] ?? []) {
        if ((prev[nb] ?? -1) !== -1) continue;
        prev[nb] = cur;
        if (nb === to) {
          const path = [to];
          let p = to;
          while (p !== from) {
            p = prev[p] ?? from;
            path.push(p);
          }
          path.reverse();
          return path.slice(1);
        }
        queue.push(nb);
      }
    }
    return null;
  };

  /** Would a cat standing here be inside something? Feet lifted 2 cm so the floor slab is not a hit. */
  const blockedAt = (x: number, y: number, z: number): boolean => {
    probe.minX = x - RADIUS;
    probe.maxX = x + RADIUS;
    probe.minZ = z - RADIUS;
    probe.maxZ = z + RADIUS;
    probe.minY = y + 0.02;
    probe.maxY = y + BAND;
    for (const b of aabbs) if (overlaps(probe, b)) return true;
    return false;
  };

  /**
   * Walk every edge at the cat's own width and drop the ones that are blocked, once, a few seconds in.
   *
   * Late on purpose: ModelProps pushes the bed's and the table's colliders into this same array as
   * their files land, so a check at startup would pass edges that are about to become walls. What it
   * catches is a regression — furniture moved, a room re-cut — and dropping the edge is a better
   * answer than a log, because the cat then routes round the new obstacle instead of through it.
   */
  const checkRoutes = (): void => {
    const bad: string[] = [];
    for (let a = 0; a < CAT_NODES.length; a++) {
      for (const b of [...(adj[a] ?? [])]) {
        if (b < a) continue;
        const na = CAT_NODES[a];
        const nb = CAT_NODES[b];
        if (!na || !nb) continue;
        const dx = nb.x - na.x;
        const dy = nb.y - na.y;
        const dz = nb.z - na.z;
        const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / STEP));
        let hit = false;
        for (let i = 0; i <= n && !hit; i++) {
          const t = i / n;
          hit = blockedAt(na.x + dx * t, na.y + dy * t, na.z + dz * t);
        }
        if (hit) {
          unlink(a, b);
          bad.push(`${na.name}-${nb.name}`);
        }
      }
    }
    if (bad.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[cat:routes] unlinked blocked edges: ${bad.join(' ')}`);
    }
  };

  // The wrapper is what moves; see the header. Starting in the living room rather than the hallway
  // keeps it away from cat.glb, which is grooming itself two metres from the hallway's midpoint.
  const cat = new Group();
  cat.name = 'cat.roam';
  let from = index.get('lv_c') ?? 0;
  const home = CAT_NODES[from];
  if (home) cat.position.set(home.x, home.y, home.z);
  scene.add(cat);

  let mixer: AnimationMixer | undefined;
  let meow: PositionalAudio | undefined;
  let ready = false;

  void (async () => {
    try {
      const { root, clips } = await loader.load(CAT_FILE);
      fitToHeight(root, CAT_LEN, 0, 0, 0);
      shade(root, CAT_ALBEDO);
      cat.add(root);
      const clip = clips[0];
      if (clip) mixer = playClip(root, clip, 1);
      ready = true;
    } catch (err) {
      onError(err, `cat:${CAT_FILE}`);
    }
    // Hung on the wrapper, so the pan follows the animal rather than wherever it started.
    meow = await audio.attach(cat, MEOW_FILE);
  })();

  /** Nodes still to visit; queue[0] is where the cat is walking now. */
  let queue: number[] = [];
  let to = -1;
  /** Metres covered along the current leg, and the heading actually being displayed. */
  let along = 0;
  let yaw = 0;

  /** Somewhere else in the house, reachable from here. Eight tries covers a closed ritual room. */
  const retarget = (): void => {
    for (let tries = 0; tries < 8; tries++) {
      const t = Math.floor(Math.random() * CAT_NODES.length);
      if (t === from) continue;
      const p = route(from, t);
      if (p && p.length > 0) {
        queue = p;
        return;
      }
    }
  };

  /**
   * One step of walking. There is deliberately no pause at a waypoint: the only clip on this asset is
   * a 0.77 s stride with no idle to fall back on, so a cat that stopped would freeze mid-step.
   */
  const walk = (dt: number): void => {
    if (to < 0) {
      if (queue.length === 0) retarget();
      const next = queue.shift();
      if (next === undefined) return;
      to = next;
      along = 0;
    }
    const a = CAT_NODES[from];
    const b = CAT_NODES[to];
    if (!a || !b) {
      to = -1;
      return;
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.max(Math.hypot(dx, dz), 1e-4);
    along += SPEED * dt;
    const u = Math.min(along / len, 1);
    cat.position.set(a.x + dx * u, a.y + dy * u, a.z + dz * u);

    const turn = TURN_RATE * dt;
    const d = shortest(yaw, Math.atan2(dx, dz) + FACE_YAW);
    yaw += Math.max(-turn, Math.min(turn, d));
    cat.rotation.y = yaw;

    if (u >= 1) {
      from = to;
      to = -1;
    }
  };

  /** Head height to eye height, and nothing in the collision array in between. */
  const canSee = (): boolean => {
    const ox = cat.position.x;
    const oy = cat.position.y + EYE_UP;
    const oz = cat.position.z;
    const dx = eye.position.x - ox;
    const dy = eye.position.y - oy;
    const dz = eye.position.z - oz;
    if (dx * dx + dy * dy + dz * dz > SEE_DIST * SEE_DIST) return false;
    for (const b of aabbs) if (segHits(b, ox, oy, oz, dx, dy, dz)) return false;
    return true;
  };

  let age = 0;
  let checked = false;
  let opened = false;
  /** Time to the next sight test, whether it could see the player last time, and the meow's cooldown. */
  let look = 0;
  let saw = false;
  let cool = 0;

  return {
    update: (dt) => {
      age += dt;
      if (!opened && ritualOpen()) {
        opened = true;
        for (const pair of CAT_GATED) link(pair[0], pair[1]);
        // Re-run the check once the screen is open. Its blocker does not slide out of the way, it drops
        // below the world, so the doorway simply stops being blocked and nothing new starts being.
        checked = false;
        age = 0;
      }
      if (!checked && age >= CHECK_AT) {
        checked = true;
        checkRoutes();
      }
      if (!ready) return;

      // Walking continues off screen — the cat should be somewhere plausible when next seen, not
      // parked where the player last looked. Only the clip is skipped at distance, as in ModelProps.
      const near = cat.position.distanceToSquared(eye.position) < CULL_RADIUS_SQ;
      cat.visible = near;
      walk(dt);
      if (near) mixer?.update(dt);

      if (cool > 0) cool -= dt;
      look -= dt;
      if (look > 0) return;
      look = SEE_EVERY;
      const sees = canSee();
      // Edge-triggered: one meow per time it comes into view, and then a cooldown, so a player who
      // stands still in a doorway is not meowed at four times a second.
      if (sees && !saw && cool <= 0 && meow?.buffer) {
        if (meow.isPlaying) meow.stop();
        meow.play();
        cool = MEOW_COOLDOWN;
        globalBus.emit('noise:emitted', {
          pos: cat.position.clone(),
          radius: 6.0,
          kind: 'cat',
        });
      }
      saw = sees;
    },
    // The geometry and materials belong to the ModelLoader cache and the sound to AudioManager, both
    // of which HouseScene disposes on their own lines. Detaching is all this owns.
    dispose: () => {
      mixer?.stopAllAction();
      scene.remove(cat);
      cat.clear();
    },
  };
}


