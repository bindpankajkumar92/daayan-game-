/**
 * The coffin fire: a small, warm, local burn built from the same visual language as the house.
 *
 * It is deliberately not a particle system. Sixteen additive flame sprites, a few embers, a little
 * smoke, one flickering point light and the skeleton's materials darkening are enough for the four
 * seconds the player sees it, and every one of those costs a draw or a uniform rather than a
 * simulation. The fire stays inside the coffin footprint; the room's walls catch the flicker but the
 * room does not catch fire.
 *
 * The coffin and skeleton are already in the ritual room. This class only lights them; it never
 * moves or re-poses the skeleton.
 */

import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  Group,
  Mesh,
  PointLight,
  Scene,
  Sprite,
  SpriteMaterial,
  type Material,
  type Object3D,
} from 'three';

const FIRE_COLOR = 0xff8a3d;
const EMBER = new Color(0xff4d16);
const CHAR = new Color(0x1c100a);

interface Flame {
  sprite: Sprite;
  material: SpriteMaterial;
  phase: number;
  x: number;
  z: number;
  size: number;
  speed: number;
}

interface Smoke {
  sprite: Sprite;
  material: SpriteMaterial;
  phase: number;
  x: number;
  z: number;
  size: number;
}

interface Ember {
  sprite: Sprite;
  material: SpriteMaterial;
  phase: number;
  x: number;
  z: number;
  size: number;
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

function radialTexture(inner: string, mid: string, outer: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(32, 36, 2, 32, 36, 31);
    g.addColorStop(0, inner);
    g.addColorStop(0.45, mid);
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  }
  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/**
 * A teardrop rather than a radial dot. A soft round gradient reads as a glowing bulb when several
 * sprites overlap; the tapered silhouette is what makes the same additive sprites read as flame.
 */
function flameTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createLinearGradient(0, 60, 0, 4);
    g.addColorStop(0, 'rgba(255,238,190,0.95)');
    g.addColorStop(0.3, 'rgba(255,170,60,0.9)');
    g.addColorStop(0.7, 'rgba(255,96,16,0.45)');
    g.addColorStop(1, 'rgba(255,60,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(32, 3);
    ctx.bezierCurveTo(45, 24, 53, 42, 32, 61);
    ctx.bezierCurveTo(11, 42, 19, 24, 32, 3);
    ctx.closePath();
    ctx.fill();
    const glow = ctx.createRadialGradient(32, 52, 1, 32, 52, 22);
    glow.addColorStop(0, 'rgba(255,220,150,0.5)');
    glow.addColorStop(1, 'rgba(255,90,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 30, 64, 34);
  }
  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

export class CoffinFire {
  private readonly group = new Group();
  private readonly light = new PointLight(FIRE_COLOR, 0, 7, 2);
  private readonly flames: Flame[] = [];
  private readonly embers: Ember[] = [];
  private readonly smoke: Smoke[] = [];
  private readonly charred: Charred[] = [];
  private readonly originalMaterials: { mesh: Mesh; material: Material | Material[] }[] = [];
  private readonly flameTexture = flameTexture();
  private readonly emberTexture = radialTexture('rgba(255,228,170,1)', 'rgba(255,130,30,0.75)', 'rgba(255,60,0,0)');
  private readonly smokeTexture = radialTexture('rgba(90,80,70,0.55)', 'rgba(50,44,38,0.28)', 'rgba(20,18,16,0)');
  private elapsed = 0;
  private active = false;

  constructor(scene: Scene, private readonly getSkeleton: () => Object3D | null) {
    this.group.visible = false;
    this.light.position.set(0, 0.35, 0);
    this.light.castShadow = false;
    this.group.add(this.light);
    scene.add(this.group);
  }

  ignite(at: { x: number; y: number; z: number }): void {
    this.active = true;
    this.elapsed = 0;
    this.group.visible = true;
    this.group.position.set(at.x, at.y, at.z);
    this.clearSprites();
    for (let i = 0; i < 16; i++) this.addFlame(i);
    for (let i = 0; i < 5; i++) this.addEmber(i);
    for (let i = 0; i < 8; i++) this.addSmoke(i);
    this.light.intensity = 0;
    this.charSkeleton(this.getSkeleton());
  }

  update(dt: number): void {
    if (!this.active) return;
    this.elapsed += Math.min(Math.max(dt, 0), 0.1);
    const ramp = Math.min(this.elapsed / 0.18, 1);
    const settle = 1 - Math.min(Math.max((this.elapsed - 2.8) / 1.4, 0), 1) * 0.35;

    for (const f of this.flames) {
      const t = (this.elapsed * f.speed + f.phase) % 1;
      const flicker = 0.72 + 0.28 * Math.sin(this.elapsed * 9.1 + f.phase) * Math.cos(this.elapsed * 5.3 + f.phase * 1.7);
      f.sprite.position.set(
        f.x + Math.sin(this.elapsed * 6.5 + f.phase) * 0.014,
        0.02 + t * 0.34,
        f.z + Math.cos(this.elapsed * 5.1 + f.phase) * 0.014,
      );
      const width = f.size * (0.75 + flicker * 0.5);
      f.sprite.scale.set(width, width * 1.9, 1);
      f.material.opacity = ramp * settle * (0.26 + flicker * 0.3) * (1 - t * 0.55);
    }

    for (const e of this.embers) {
      const t = (this.elapsed * 0.52 + e.phase) % 1;
      e.sprite.position.set(
        e.x + Math.sin(this.elapsed * 3.1 + e.phase) * 0.035,
        0.12 + t * 0.9,
        e.z,
      );
      e.sprite.scale.setScalar(e.size * (1 - t * 0.6));
      e.material.opacity = ramp * (1 - t) * 0.8;
    }

    for (const s of this.smoke) {
      const t = (this.elapsed * 0.24 + s.phase) % 1;
      s.sprite.position.set(
        s.x + Math.sin(this.elapsed * 1.7 + s.phase) * 0.04,
        0.3 + t * 1.25,
        s.z,
      );
      s.sprite.scale.setScalar(s.size * (0.7 + t * 1.8));
      s.material.opacity = ramp * 0.26 * (1 - t);
    }

    this.light.intensity = (this.elapsed < 0.16 ? 5.5 : 2.6) * ramp * settle
      * (0.86 + 0.14 * Math.sin(this.elapsed * 15.7) * Math.sin(this.elapsed * 4.9 + 0.8));

    const charT = Math.min(this.elapsed / 2.4, 1);
    for (const c of this.charred) {
      c.tintable.color?.lerpColors(c.from, CHAR, charT);
      c.tintable.emissive?.copy(EMBER).multiplyScalar(Math.sin(charT * Math.PI) * 0.45);
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
    this.flameTexture.dispose();
    this.emberTexture.dispose();
    this.smokeTexture.dispose();
    this.active = false;
  }

  private addFlame(i: number): void {
    const material = new SpriteMaterial({
      map: this.flameTexture,
      color: new Color().setHSL(0.055 + Math.random() * 0.03, 1, 0.52 + Math.random() * 0.1),
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const sprite = new Sprite(material);
    sprite.center.set(0.5, 0.12);
    sprite.renderOrder = 1;
    const x = (Math.random() - 0.5) * 0.3;
    const z = (Math.random() - 0.5) * 1.0;
    sprite.position.set(x, 0.02, z);
    this.group.add(sprite);
    this.flames.push({
      sprite,
      material,
      phase: (i * 1.618 + Math.random() * 0.7) % (Math.PI * 2),
      x,
      z,
      size: 0.1 + Math.random() * 0.08,
      speed: 0.45 + Math.random() * 0.5,
    });
  }

  private addEmber(i: number): void {
    const material = new SpriteMaterial({
      map: this.emberTexture,
      color: 0xffb066,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      opacity: 0,
      fog: false,
    });
    const sprite = new Sprite(material);
    sprite.renderOrder = 2;
    const x = (Math.random() - 0.5) * 0.24;
    const z = (Math.random() - 0.5) * 0.85;
    sprite.position.set(x, 0.12, z);
    this.group.add(sprite);
    this.embers.push({
      sprite,
      material,
      phase: (i * 0.37 + Math.random() * 0.2) % 1,
      x,
      z,
      size: 0.02 + Math.random() * 0.018,
    });
  }

  private addSmoke(i: number): void {
    const material = new SpriteMaterial({
      map: this.smokeTexture,
      color: 0x2a2420,
      transparent: true,
      depthWrite: false,
      opacity: 0,
      fog: false,
    });
    const sprite = new Sprite(material);
    sprite.renderOrder = 0;
    const x = (Math.random() - 0.5) * 0.22;
    const z = (Math.random() - 0.5) * 0.8;
    sprite.position.set(x, 0.3, z);
    this.group.add(sprite);
    this.smoke.push({
      sprite,
      material,
      phase: (i * 0.29 + Math.random() * 0.16) % 1,
      x,
      z,
      size: 0.26 + Math.random() * 0.18,
    });
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
    for (const e of this.embers) {
      e.material.dispose();
      e.sprite.removeFromParent();
    }
    this.embers.length = 0;
    for (const s of this.smoke) {
      s.material.dispose();
      s.sprite.removeFromParent();
    }
    this.smoke.length = 0;
  }
}
