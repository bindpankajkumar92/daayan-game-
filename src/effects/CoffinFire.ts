/**
 * The coffin fire: a small, warm, local burn built from the same visual language as the house.
 *
 * The first version was sixteen sprites looping up and down on sines. Every one pulsed on the same
 * clock, the whole bed lit at once, and the flames never changed colour, so it read as a glowing
 * decal rather than as something burning. What makes fire read as fire, and what this does instead:
 *
 * - **It catches, then spreads.** The lantern lands in the middle; flames are born only inside a
 *   footprint that grows from that point to the whole coffin over the first 1.3 s.
 * - **Every tongue lives and dies.** Each flame is born small and white-yellow at the bed, swells,
 *   rises faster as it goes, narrows, cools through orange to dull red and goes out — and a fraction
 *   of them hand over to smoke where they die. Lifetimes are random, so nothing pulses on a beat.
 * - **Smoke is dark and heavy.** Normal blending, near-black, rising slowly, widening and turning.
 *   Light grey smoke is what makes a fire look like a campfire sticker.
 * - **Sparks are many and tiny.** One `Points` draw for all of them: random lift, sideways drift,
 *   a flicker of their own, gone in about a second.
 * - **The light is restless, not rhythmic.** Its intensity chases a new random target every few
 *   frames and its position wanders a few centimetres, which is what moves the shadows on a wall.
 * - **The wood glows under it.** An additive plane on the coffin bed, so the base of the fire has a
 *   hot bed instead of flames standing on nothing.
 *
 * Budget: ~26 flame sprites + ~10 smoke sprites + 1 points draw + 1 plane, for about four seconds.
 * The fire stays inside the coffin footprint; the room's walls catch the flicker but the room does
 * not catch fire. The coffin and skeleton are already in the ritual room. This class only lights
 * them; it never moves or re-poses the skeleton.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PointLight,
  Points,
  PointsMaterial,
  Scene,
  Sprite,
  SpriteMaterial,
  type Material,
  type Object3D,
} from 'three';

const EMBER = new Color(0xff4d16);
const CHAR = new Color(0x140b07);
const LIGHT_HOT = new Color(0xffa04a);
const LIGHT_LOW = new Color(0xff6a22);

/**
 * Coffin bed half-extents the fire is allowed to occupy, metres. Long axis is z. Measured: the coffin
 * is 1.10 x 2.40 m and the skeleton in it 0.64 x 1.75 m, so this covers the whole body with a margin
 * inside the coffin's walls. The first version used 0.3 x 1.0 m, which is why only one end burned.
 */
const BED = { x: 0.32, z: 0.95 };
const SPREAD_TIME = 1.1;

const FLAMES = 44;
const SMOKES = 14;
const SPARKS = 60;

interface Flame {
  sprite: Sprite;
  material: SpriteMaterial;
  age: number;
  life: number;
  x: number;
  z: number;
  size: number;
  rise: number;
  sway: number;
  spin: number;
}

interface Smoke {
  sprite: Sprite;
  material: SpriteMaterial;
  age: number;
  life: number;
  x: number;
  z: number;
  size: number;
  drift: number;
  live: boolean;
}

interface Tintable {
  color?: Color;
  emissive?: Color;
}

interface Charred {
  material: Material;
  from: Color;
  tintable: Tintable;
}

const rand = (a: number, b: number): number => a + Math.random() * (b - a);

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D | null] {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return [c, c.getContext('2d')];
}

/**
 * One tongue of flame, white-hot at the root and tearing into two or three licks at the top. Drawn
 * in white so each sprite's colour sets its temperature; alpha carries the shape.
 */
function flameTexture(): CanvasTexture {
  const [c, g] = canvas(128);
  if (g) {
    g.globalCompositeOperation = 'lighter';
    const lick = (cx: number, top: number, w: number, a: number): void => {
      const grad = g.createLinearGradient(0, 124, 0, top);
      grad.addColorStop(0, `rgba(255,255,255,${a})`);
      grad.addColorStop(0.45, `rgba(255,255,255,${a * 0.7})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(cx, top);
      g.bezierCurveTo(cx + w * 0.55, top + 40, cx + w, 92, cx + w * 0.1, 124);
      g.bezierCurveTo(cx - w, 92, cx - w * 0.5, top + 40, cx, top);
      g.fill();
    };
    lick(64, 6, 30, 0.6);
    lick(52, 30, 18, 0.35);
    lick(78, 24, 16, 0.35);
    const core = g.createRadialGradient(64, 104, 2, 64, 104, 30);
    core.addColorStop(0, 'rgba(255,255,255,0.75)');
    core.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = core;
    g.fillRect(0, 60, 128, 68);
  }
  return new CanvasTexture(c);
}

/** Soft, lumpy puff: several offset blobs, so a turning sprite does not read as a disc. */
function smokeTexture(): CanvasTexture {
  const [c, g] = canvas(64);
  if (g) {
    for (let i = 0; i < 7; i++) {
      const x = 32 + rand(-10, 10);
      const y = 32 + rand(-10, 10);
      const r = rand(10, 22);
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(255,255,255,0.32)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
    }
  }
  return new CanvasTexture(c);
}

function dotTexture(): CanvasTexture {
  const [c, g] = canvas(16);
  if (g) {
    const grad = g.createRadialGradient(8, 8, 0, 8, 8, 8);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.6)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 16, 16);
  }
  return new CanvasTexture(c);
}

/** The hot bed under the fire: an elongated ember glow, brighter where the lantern landed. */
function bedTexture(): CanvasTexture {
  const [c, g] = canvas(64);
  if (g) {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.4)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }
  return new CanvasTexture(c);
}

export class CoffinFire {
  private readonly group = new Group();
  private readonly light = new PointLight(LIGHT_HOT, 0, 9, 1.6);
  private readonly flames: Flame[] = [];
  private readonly smoke: Smoke[] = [];
  private readonly charred: Charred[] = [];
  private readonly originalMaterials: { mesh: Mesh; material: Material | Material[] }[] = [];
  private readonly flameTex = flameTexture();
  private readonly smokeTex = smokeTexture();
  private readonly dotTex = dotTexture();
  private readonly bedTex = bedTexture();
  private readonly sparkGeo = new BufferGeometry();
  private readonly sparkPos = new Float32Array(SPARKS * 3);
  private readonly sparkCol = new Float32Array(SPARKS * 3);
  private readonly sparkVel = new Float32Array(SPARKS * 3);
  private readonly sparkAge = new Float32Array(SPARKS);
  private readonly sparkLife = new Float32Array(SPARKS);
  private readonly sparks: Points;
  private readonly sparkMat: PointsMaterial;
  private readonly bedGeo = new PlaneGeometry(1, 1);
  private readonly bedMat: MeshBasicMaterial;
  private readonly bed: Mesh;
  private readonly tmp = new Color();
  private elapsed = 0;
  private active = false;
  private flicker = 1;
  private flickerTarget = 1;
  private flickerWait = 0;

  constructor(scene: Scene, private readonly getSkeleton: () => Object3D | null) {
    this.group.visible = false;
    this.light.position.set(0, 0.35, 0);
    this.light.castShadow = false;
    this.group.add(this.light);

    this.sparkGeo.setAttribute('position', new BufferAttribute(this.sparkPos, 3));
    this.sparkGeo.setAttribute('color', new BufferAttribute(this.sparkCol, 3));
    this.sparkMat = new PointsMaterial({
      map: this.dotTex,
      size: 0.022,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.sparks = new Points(this.sparkGeo, this.sparkMat);
    this.sparks.frustumCulled = false;
    this.sparks.renderOrder = 2;
    this.group.add(this.sparks);

    this.bedMat = new MeshBasicMaterial({
      map: this.bedTex,
      color: 0xff5a1c,
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.bed = new Mesh(this.bedGeo, this.bedMat);
    this.bed.rotation.x = -Math.PI / 2;
    this.bed.position.y = 0.01;
    this.bed.renderOrder = 1;
    this.group.add(this.bed);

    scene.add(this.group);
  }

  ignite(at: { x: number; y: number; z: number }): void {
    this.active = true;
    this.elapsed = 0;
    this.flicker = 1;
    this.flickerTarget = 1;
    this.flickerWait = 0;
    this.group.visible = true;
    this.group.position.set(at.x, at.y, at.z);
    this.clearSprites();
    for (let i = 0; i < FLAMES; i++) this.addFlame();
    for (let i = 0; i < SMOKES; i++) this.addSmoke();
    for (let i = 0; i < SPARKS; i++) this.respawnSpark(i, true);
    this.light.intensity = 0;
    this.charSkeleton(this.getSkeleton());
  }

  update(dt: number): void {
    if (!this.active) return;
    const h = Math.min(Math.max(dt, 0), 0.1);
    this.elapsed += h;
    const t = this.elapsed;
    const spread = Math.min(0.12 + t / SPREAD_TIME, 1);
    // Whoosh: the lamp oil goes up at once, then the fire settles onto the wood and burns lower.
    const burst = t < 0.35 ? 1 + 0.9 * (1 - t / 0.35) : 1;
    const settle = 1 - Math.min(Math.max((t - 2.8) / 1.4, 0), 1) * 0.3;
    const heat = spread * burst * settle;

    for (const f of this.flames) {
      f.age += h;
      if (f.age >= f.life) this.respawnFlame(f, spread);
      const u = f.age / f.life;
      // Rises faster as it goes, the way hot gas accelerates off the bed.
      const y = 0.015 + f.rise * (u * 0.55 + u * u * 0.45) * burst;
      f.sprite.position.set(
        f.x + Math.sin(t * 7 + f.sway) * 0.012 * u,
        y,
        f.z + Math.cos(t * 5.3 + f.sway) * 0.012 * u,
      );
      // Swell quickly, then narrow and stretch as the tongue tears away.
      const grow = Math.sin(Math.min(u * 1.6, 1) * Math.PI * 0.5);
      const w = f.size * grow * (1 - u * 0.55) * Math.max(heat, 0.35);
      f.sprite.scale.set(w, w * (1.7 + u * 1.1), 1);
      f.material.rotation = f.spin * u;
      // Temperature: white-yellow at birth, orange, then a dull red that goes out.
      this.tmp.setHSL(0.13 - u * 0.11, 1, 0.62 - u * 0.3);
      f.material.color.copy(this.tmp);
      f.material.opacity = Math.min(1, heat) * (u < 0.1 ? u / 0.1 : 1) * Math.pow(1 - u, 0.7);
    }

    for (const s of this.smoke) {
      if (!s.live) {
        // Smoke starts once the fire has something to burn, not at the spark.
        if (t > 0.45 && Math.random() < h * 3) this.respawnSmoke(s, spread);
        continue;
      }
      s.age += h;
      if (s.age >= s.life) {
        s.live = false;
        s.material.opacity = 0;
        continue;
      }
      const u = s.age / s.life;
      s.sprite.position.set(s.x + s.drift * u, 0.55 + u * 1.6, s.z + Math.sin(u * 3 + s.drift * 9) * 0.05);
      s.sprite.scale.setScalar(s.size * (0.8 + u * 2.4));
      s.material.rotation = s.drift * 4 * u;
      s.material.opacity = (u < 0.2 ? u / 0.2 : 1) * (1 - u) * 0.42 * spread;
    }

    for (let i = 0; i < SPARKS; i++) {
      this.sparkAge[i] = (this.sparkAge[i] ?? 0) + h;
      const life = this.sparkLife[i] ?? 1;
      if ((this.sparkAge[i] ?? 0) >= life) this.respawnSpark(i, false, spread);
      const u = (this.sparkAge[i] ?? 0) / (this.sparkLife[i] ?? 1);
      const k = i * 3;
      // Buoyant, slowing as it cools, with a little turbulence sideways.
      this.sparkVel[k + 1] = (this.sparkVel[k + 1] ?? 0) * (1 - h * 0.8);
      this.sparkVel[k] = (this.sparkVel[k] ?? 0) + (Math.random() - 0.5) * h * 0.8;
      this.sparkPos[k] = (this.sparkPos[k] ?? 0) + (this.sparkVel[k] ?? 0) * h;
      this.sparkPos[k + 1] = (this.sparkPos[k + 1] ?? 0) + (this.sparkVel[k + 1] ?? 0) * h;
      this.sparkPos[k + 2] = (this.sparkPos[k + 2] ?? 0) + (this.sparkVel[k + 2] ?? 0) * h;
      const glow = (1 - u) * (0.6 + 0.4 * Math.random()) * Math.min(heat, 1);
      this.sparkCol[k] = glow;
      this.sparkCol[k + 1] = glow * (0.55 - u * 0.35);
      this.sparkCol[k + 2] = glow * 0.12;
    }
    (this.sparkGeo.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (this.sparkGeo.getAttribute('color') as BufferAttribute).needsUpdate = true;

    this.bed.scale.set(BED.x * 2.6 * spread, BED.z * 2.4 * spread, 1);
    this.bedMat.opacity = Math.min(1, heat) * (0.55 + 0.15 * this.flicker);

    // Restless light: chase a new random level every few frames, and let the source wander.
    this.flickerWait -= h;
    if (this.flickerWait <= 0) {
      this.flickerWait = rand(0.04, 0.11);
      this.flickerTarget = rand(0.7, 1.15);
    }
    this.flicker += (this.flickerTarget - this.flicker) * Math.min(1, h * 18);
    this.light.intensity = (t < 0.15 ? 6.5 : 3.0) * heat * this.flicker;
    this.light.color.lerpColors(LIGHT_LOW, LIGHT_HOT, Math.min(1, Math.max(0, (this.flicker - 0.7) / 0.45)));
    this.light.position.set(
      Math.sin(t * 3.7) * 0.04,
      0.3 + (this.flicker - 0.9) * 0.12,
      Math.cos(t * 2.9) * 0.08,
    );

    const charT = Math.min(t / 2.4, 1);
    for (const c of this.charred) {
      c.tintable.color?.lerpColors(c.from, CHAR, charT);
      // Bone does not glow like a coal; a faint ember tint is all it takes before it chars.
      c.tintable.emissive?.copy(EMBER).multiplyScalar(Math.sin(charT * Math.PI) * 0.18 * this.flicker);
    }
  }

  dispose(): void {
    this.clearSprites();
    for (const { mesh, material } of this.originalMaterials) mesh.material = material;
    this.originalMaterials.length = 0;
    for (const c of this.charred) c.material.dispose();
    this.charred.length = 0;
    this.group.removeFromParent();
    this.light.dispose();
    this.sparkGeo.dispose();
    this.sparkMat.dispose();
    this.bedGeo.dispose();
    this.bedMat.dispose();
    this.flameTex.dispose();
    this.smokeTex.dispose();
    this.dotTex.dispose();
    this.bedTex.dispose();
    this.active = false;
  }

  /** A point inside the part of the bed that has caught, biased to the middle where it is thickest. */
  private bedPoint(spread: number): [number, number] {
    const r = Math.sqrt(Math.random());
    const a = Math.random() * Math.PI * 2;
    return [Math.cos(a) * r * BED.x * spread, Math.sin(a) * r * BED.z * spread];
  }

  private addFlame(): void {
    const material = new SpriteMaterial({
      map: this.flameTex,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      opacity: 0,
      fog: false,
    });
    const sprite = new Sprite(material);
    sprite.center.set(0.5, 0.06);
    sprite.renderOrder = 1;
    this.group.add(sprite);
    const f: Flame = { sprite, material, age: 0, life: 1, x: 0, z: 0, size: 0, rise: 0, sway: 0, spin: 0 };
    this.respawnFlame(f, 0.12);
    // Stagger the first generation so they do not all die on the same frame.
    f.age = Math.random() * f.life;
    this.flames.push(f);
  }

  private respawnFlame(f: Flame, spread: number): void {
    const [x, z] = this.bedPoint(spread);
    f.x = x;
    f.z = z;
    f.age = 0;
    f.life = rand(0.45, 0.95);
    // Tongues in the middle of the bed burn taller than the ones at its edge.
    const centre = 1 - Math.hypot(x / BED.x, z / BED.z) * 0.45;
    f.size = rand(0.16, 0.32) * centre;
    f.rise = rand(0.35, 0.75) * centre;
    f.sway = Math.random() * Math.PI * 2;
    f.spin = rand(-0.35, 0.35);
  }

  private addSmoke(): void {
    const material = new SpriteMaterial({
      map: this.smokeTex,
      color: 0x0e0b09,
      transparent: true,
      depthWrite: false,
      opacity: 0,
      fog: false,
    });
    const sprite = new Sprite(material);
    sprite.renderOrder = 0;
    this.group.add(sprite);
    this.smoke.push({ sprite, material, age: 0, life: 1, x: 0, z: 0, size: 0, drift: 0, live: false });
  }

  private respawnSmoke(s: Smoke, spread: number): void {
    const [x, z] = this.bedPoint(spread);
    s.x = x;
    s.z = z;
    s.age = 0;
    s.life = rand(1.8, 2.8);
    s.size = rand(0.22, 0.36);
    s.drift = rand(-0.12, 0.12);
    s.live = true;
  }

  private respawnSpark(i: number, first: boolean, spread = 0.12): void {
    const [x, z] = this.bedPoint(spread);
    const k = i * 3;
    this.sparkPos[k] = x;
    this.sparkPos[k + 1] = rand(0.05, 0.2);
    this.sparkPos[k + 2] = z;
    this.sparkVel[k] = rand(-0.12, 0.12);
    this.sparkVel[k + 1] = rand(0.35, 1.0);
    this.sparkVel[k + 2] = rand(-0.12, 0.12);
    this.sparkLife[i] = rand(0.5, 1.3);
    this.sparkAge[i] = first ? rand(0, 1.3) : 0;
  }

  private charSkeleton(root: Object3D | null): void {
    if (!root) return;
    root.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      const original = mesh.material;
      const source = Array.isArray(original) ? original : [original];
      const copies = source.map((material) => {
        const copy = material.clone();
        const tintable = copy as unknown as Tintable;
        if (tintable.color) {
          this.charred.push({ material: copy, from: tintable.color.clone(), tintable });
        }
        return copy;
      });
      mesh.material = Array.isArray(original) ? copies : copies[0]!;
      this.originalMaterials.push({ mesh, material: original });
    });
  }

  private clearSprites(): void {
    for (const f of this.flames) {
      f.material.dispose();
      f.sprite.removeFromParent();
    }
    this.flames.length = 0;
    for (const s of this.smoke) {
      s.material.dispose();
      s.sprite.removeFromParent();
    }
    this.smoke.length = 0;
  }
}
