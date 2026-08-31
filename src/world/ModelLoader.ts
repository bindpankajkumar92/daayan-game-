/**
 * ModelLoader — the only path by which an external .glb enters this game.
 *
 * Everything it does beyond calling GLTFLoader exists to keep imported art inside the rules the
 * hand-built house already follows:
 *
 * - **Meshopt.** tools/optimize-models.mjs writes EXT_meshopt_compression, so the decoder is not
 *   optional; without it every load fails with "no DRACOLoader instance"-style opacity.
 * - **Lambert, or Phong where there is a normal map.** Sketchfab art arrives as
 *   MeshStandardMaterial, which measured 3.5x the cost of Lambert on the target phone, so it never
 *   survives the door. But *dropping* Standard used to mean dropping its normal map with it, and
 *   that is the single reason the imported art read as painted rather than moulded: in a house whose
 *   only real light swings in the player's hand, the normal map is what makes plaster, bed frames and
 *   the gate's mouldings move as the lantern moves. Phong is Lambert's diffuse term plus a Blinn
 *   highlight — nothing like Standard's full BRDF — so a material that ships a normal map now becomes
 *   Phong and samples it, and everything else still becomes Lambert. 21 of the 28 shipped files carry
 *   one; the three big room interiors do not, which is the cheap outcome, since those are the surfaces
 *   with the largest share of the screen.
 * - **Anisotropy, and something for it to work on.** Every imported texture used to sample at aniso 1 while
 *   the procedural house asked for 4, and grazing floors and walls are exactly where that shows: a corridor
 *   receding from the eye goes to mush a couple of metres out no matter how much resolution the map has. It
 *   costs extra taps only on the fragments whose footprint is actually stretched. The same loop now also
 *   guarantees a mipmapped minification filter, because anisotropy on a texture that is not minified through a
 *   mip chain is paid for and discarded, and one shipped file arrives asking for exactly that — see the
 *   comment at the loop, including why magnification is left alone.
 * - **Cutout, not blend.** Alpha-blended hair cards are both a fill-rate cost and a sort-order bug
 *   (strands drawn in the wrong order against each other). alphaTest gives the same silhouette for
 *   one texture fetch and no sorting — see convert() for when this is and is not safe.
 * - **Unknown units.** These files are not authored to a shared scale: measured raw, the daayan is
 *   0.039 units tall and the knife is 2.0. Nothing here trusts a file's units; callers ask for a
 *   height in metres and fitToHeight() computes the factor from the actual bounding box.
 */

import {
  AnimationMixer,
  Box3,
  Color,
  LinearMipmapLinearFilter,
  Mesh,
  MeshLambertMaterial,
  MeshPhongMaterial,
  Vector3,
  type AnimationClip,
  type Group,
  type Material,
  type MeshStandardMaterial,
  type Object3D,
  type Texture,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/** Where the optimised output of tools/optimize-models.mjs is served from. */
export const MODEL_DIR = '/assets/models/';

export interface LoadedModel {
  /** The glTF scene root, already converted and ready to add. */
  root: Group;
  clips: AnimationClip[];
}

/**
 * Anisotropy ceiling for imported art. The device reports 16; asking for all of it buys nothing a
 * player would see and doubles the worst-case tap count again, whereas 8 is where a receding corridor
 * stops smearing. HouseScene caps the procedural house by the same number so the two halves of the
 * house filter alike — a floor that changes sharpness at the seam between them is worse than either.
 */
export const ANISOTROPY_CAP = 8;

/**
 * Phong's specular for converted art, deliberately dim and broad.
 *
 * The metallic-roughness maps were stripped in the texture pass, so whatever is set here applies
 * uniformly across a material — and a uniform *bright* highlight is what makes plaster look like
 * plastic. 0x0f0f10 is about 6% grey and shininess 22 spreads it into a wide sheen, so the lantern
 * reveals the relief the normal map describes instead of putting a hard dot on it. The one genuinely
 * specular surface in the house, the brass, is a hand-authored material in Fixtures and comes nowhere
 * near this path.
 */
const SPECULAR = 0x0f0f10;
const SHININESS = 22;

/** What imported materials are allowed to become. */
type Shaded = MeshLambertMaterial | MeshPhongMaterial;

/**
 * Copy a glTF material onto a Lambert one, or onto a Phong one when it carries a normal map.
 *
 * The transparency rule is the part worth reading. A material that is transparent *and* textured is
 * almost always a cutout — hair cards, foliage, a lantern's pierced metal — so it becomes alphaTest
 * and stops paying for blending and sorting. A material that is transparent with no texture is
 * transparent because someone set opacity, and turning that into a cutout would either do nothing
 * or make the whole mesh vanish, so it keeps real blending.
 *
 * No tangents are needed for the normal map: without a TANGENT attribute three.js builds the frame
 * from screen-space derivatives, which is just as well, since the geometry pass does not preserve one.
 */
function convert(src: Material, aniso: number): Shaded {
  const std = src as MeshStandardMaterial;
  const m: Shaded = std.normalMap
    ? new MeshPhongMaterial({ specular: SPECULAR, shininess: SHININESS })
    : new MeshLambertMaterial();
  m.name = src.name;
  if (std.color instanceof Color) m.color.copy(std.color);
  if (std.map) m.map = std.map;
  if (std.emissive instanceof Color) m.emissive.copy(std.emissive);
  if (std.emissiveMap) m.emissiveMap = std.emissiveMap;
  if (std.emissiveIntensity !== undefined) m.emissiveIntensity = std.emissiveIntensity;
  if (std.alphaMap) m.alphaMap = std.alphaMap;
  if (std.normalMap && m instanceof MeshPhongMaterial) {
    m.normalMap = std.normalMap;
    // glTF's normalTexture.scale, which GLTFLoader has already written into both components.
    if (std.normalScale) m.normalScale.copy(std.normalScale);
  }
  m.side = src.side;
  m.vertexColors = src.vertexColors;
  m.opacity = src.opacity;

  for (const tex of [m.map, m.emissiveMap, m.alphaMap, (m as MeshPhongMaterial).normalMap]) {
    if (!tex) continue;
    const t = tex as Texture;
    t.anisotropy = aniso;
    // Anisotropy is meaningless on a texture that is not being minified through a mip chain, and one shipped
    // file arrives that way: painting-sus.glb's 64x64 emissiveMap asks for NearestMipLinear/Nearest. So the
    // minification filter is conformed here, next to where aniso is set, rather than left to whatever each
    // artist's exporter happened to write -- otherwise the ANISOTROPY_CAP above is paid for and does nothing.
    //
    // Magnification is deliberately *not* touched. It is the one filter an artist can mean: this file is a
    // 64x64 Minecraft painting, 7.8 x 14 mm per texel over its 0.50 x 0.90 m canvas, and pixel art forced to
    // LinearFilter turns to mush rather than reading as crisp. Measured on the phone, LinearFilter cuts the
    // canvas's hardest adjacent-pixel step from 198 luminance levels to 72; whether that is a fix or a
    // smudge is a decision about the art, so it is made where the art is placed, not for every import here.
    t.minFilter = LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
  }

  if (src.transparent && (std.map ?? std.alphaMap)) {
    m.alphaTest = 0.35;
    m.transparent = false;
    m.depthWrite = true;
  } else if (src.transparent) {
    m.transparent = true;
    m.depthWrite = false;
  }
  return m;
}

/** Rewrite every material under `root` and switch shadows off, since the renderer has none. */
function conform(root: Object3D, aniso: number): void {
  const replaced = new Map<Material, Shaded>();
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    const swap = (mat: Material): Shaded => {
      const hit = replaced.get(mat);
      if (hit) return hit;
      const made = convert(mat, aniso);
      replaced.set(mat, made);
      mat.dispose();
      return made;
    };
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(swap)
      : swap(mesh.material);
  });
}

export class ModelLoader {
  private readonly loader = new GLTFLoader();
  private readonly cache = new Map<string, Promise<LoadedModel>>();
  private readonly aniso: number;

  /**
   * `maxAnisotropy` comes from the renderer's capabilities, the same value HouseScene hands
   * buildHouse. Defaulted so a test or a tool can construct one without a GL context; the default is
   * the old behaviour, not the good one, so callers with a renderer should always pass it.
   */
  constructor(maxAnisotropy = 1) {
    this.aniso = Math.max(1, Math.min(maxAnisotropy, ANISOTROPY_CAP));
    this.loader.setMeshoptDecoder(MeshoptDecoder);
  }

  /** Load `<MODEL_DIR><name>`, converting materials on the way through. Cached per name. */
  load(name: string): Promise<LoadedModel> {
    const hit = this.cache.get(name);
    if (hit) return hit;
    const p = this.loader.loadAsync(MODEL_DIR + name).then((gltf) => {
      conform(gltf.scene, this.aniso);
      return { root: gltf.scene, clips: gltf.animations };
    });
    this.cache.set(name, p);
    return p;
  }

  /** Free the GPU resources of everything this loader produced. */
  dispose(): void {
    for (const p of this.cache.values()) {
      void p.then(({ root }) => {
        root.traverse((o) => {
          const mesh = o as Mesh;
          if (!mesh.isMesh) return;
          mesh.geometry.dispose();
          for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.dispose();
        });
      }, () => undefined);
    }
    this.cache.clear();
  }
}

const box = new Box3();
const size = new Vector3();
const centre = new Vector3();

/**
 * Scale `root` so its tallest axis measures `metres`, then sit it on the floor at (x, z).
 *
 * Returns the world-space footprint, which is what a collider wants: guessing a collider box from
 * the placement table means it drifts every time the scale is retuned.
 *
 * Both measurements pass `precise = false` on purpose. Box3 already special-cases a rig — a
 * SkinnedMesh carries its own `boundingBox`, posed through the bone matrices — so the cheap path
 * measures the daayan just as correctly as the precise one, which would additionally push all 30k of
 * her vertices through `applyBoneTransform`, twice, on the load path. For an unskinned mesh the
 * cheap path transforms the geometry's AABB rather than its vertices, so a rotated model can measure
 * slightly large; a collider that errs outward is the harmless direction, and the inset below eats
 * most of it anyway.
 */
export function fitToHeight(
  root: Object3D,
  metres: number,
  x: number,
  y: number,
  z: number,
): { width: number; depth: number; height: number } {
  root.updateWorldMatrix(false, true);
  box.setFromObject(root);
  box.getSize(size);
  const tallest = Math.max(size.x, size.y, size.z);
  const k = tallest > 1e-6 ? metres / tallest : 1;
  root.scale.multiplyScalar(k);

  // Re-measure rather than multiplying the old numbers: the box is only axis-aligned after any
  // rotation the caller has already applied, so the scaled extents are not simply size * k.
  root.updateWorldMatrix(false, true);
  box.setFromObject(root);
  box.getSize(size);
  box.getCenter(centre);
  root.position.set(
    root.position.x + (x - centre.x),
    root.position.y + (y - box.min.y),
    root.position.z + (z - centre.z),
  );
  return { width: size.x, depth: size.z, height: size.y };
}

/** Start `clip` looping on `root`. The caller must tick the returned mixer. */
export function playClip(root: Object3D, clip: AnimationClip, speed = 1): AnimationMixer {
  const mixer = new AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.timeScale = speed;
  action.play();
  return mixer;
}
