/**
 * HeldLantern — the arms the player is carrying a lantern with, and the lantern hanging off them.
 *
 * This is a viewmodel, not a prop. Both roots hang off the camera, and FPController.syncCamera()
 * writes the camera's position *and* quaternion every step, so a camera child inherits eye height,
 * yaw, pitch and crouch for nothing. HouseScene already does `scene.add(engine.camera)`, which is
 * what makes the renderer traverse the camera's children and draw them at all.
 *
 * Four things here are not obvious, and between them they are why this is a file rather than four
 * lines in HouseScene:
 *
 * - **Both models come out of MODEL_PLACEMENTS.** ModelLoader caches per file name and hands the
 *   *same* Group to every caller, so hanging a model on the camera while ModelProps still listed it
 *   would have teleported the prop out of its room instead of making a copy. Both rows were deleted;
 *   this file is the only owner of either file, which is also why it may edit their materials in
 *   place.
 *
 * - **The left hand is anchored by its grip rather than by a bounding box.**
 *   revopoint_inspire_-_strike_fist_-_767x203x154.glb (shipped as fist-left.glb) is a high-resolution
 *   3D photogrammetry scan of a clenched left fist and forearm. The grip tunnel formed by the fingers
 *   is centered at the pivot point of the lantern handle, and the forearm is oriented so it recedes
 *   into the bottom-left corner of the screen across the near plane.
 *
 * - **The lantern hangs; it is not glued on.** It is not a child of the hand. It pivots at the top of
 *   its own carry handle and is held plumb *in world space* every frame, which is the whole
 *   difference between a lantern and a decal — see the SWING block.
 *
 * - **The albedo is scaled down by a constant.** The lantern PointLight is a camera child too, so the
 *   distance from the light to the held geometry never changes: about 0.35 m, where a
 *   3.0-intensity/0.8-decay light delivers roughly four times the irradiance of a wall two metres
 *   away and any Lambert surface clips to white. Because that distance is *fixed*, one multiply on the
 *   material colour is exact rather than a fudge, and it keeps both real dot-N-L shading and the
 *   dimming the LANTERN button already gives for free. Layers cannot do this job: WebGLRenderer tests
 *   a light only against the *camera's* layers (WebGLRenderer.js:949), never per object.
 */

import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  FrontSide,
  Group,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshPhongMaterial,
  PlaneGeometry,
  PointLight,
  Quaternion,
  Vector3,
  type Camera,
  type Object3D,
} from 'three';
import { globalBus } from '@/core/EventBus';
import { fitToHeight, type ModelLoader } from '@/world/ModelLoader';

/**
 * Where the left fist sits in camera space — which is also the pendulum's pivot, and therefore the top of
 * the lantern's carry handle. Nothing is centred here: the arm reaches up to it and the lantern hangs
 * down from it.
 *
 * Situated on screen-left (x = -0.185) so the lantern hangs naturally inside the frame,
 * the base is partially cropped by the bottom edge (y = -0.065), and the forearm angles
 * across the near plane into the bottom-left corner with no cut-off stump visible.
 */
const HOLD = { x: -0.205, y: -0.068, z: -0.30 };

/**
 * Metres along the lantern's longest axis — which is what fitToHeight normalises, not the height.
 * old_lantern.glb measures 0.713 x 2.000 x 0.703, so the longest axis *is* the height and this is the
 * height too: a slim 17 cm lantern, sized to hang inside the frame from HOLD rather than to be
 * life-size, and it sets the flame's scale as well.
 */
const LANTERN_SIZE = 0.17;

/**
 * Where the hand grips the lantern, as a fraction of its fitted height above its base. fitToHeight
 * seats the box *bottom* at the y it is given, so the body then slides down by exactly this much and
 * the grip lands on the pivot.
 */
const PIVOT_FRAC = 0.95;

/**
 * Left hand viewmodel configuration:
 * Sourced from revopoint_inspire_-_strike_fist_-_767x203x154.glb (shipped as fist-left.glb).
 * A high-detail photogrammetry 3D scan of a clenched left fist and forearm in millimetre units.
 *
 * GRIP_OFFSET: The center of the cylindrical grip tunnel inside the clenched fingers in model units (mm).
 * FIST_ROTATION: Euler angles (degrees) orienting the fist so the handle runs through the curled fingers
 * and the forearm recedes down and into the screen's bottom-left corner.
 * FIST_SCALE: Scale factor from millimeters to meters (~8cm knuckles).
 */
const GRIP_OFFSET = { x: -205, y: 65, z: 24 };
const FIST_ROTATION = { x: 5, y: 72, z: -12 };
const FIST_SCALE = 0.00092;

/** Hand skin tone, albedo and subsurface lighting */
const HAND_ALBEDO = 0.34;
const HAND_SKIN_COLOR = 0xd69c80;
const HAND_EMISSIVE = 0x4a2416;
const HAND_EMISSIVE_INTENSITY = 0.10;

/**
 * The pendulum. This is the item on the list, so it is worth saying what makes a hanging lantern read
 * as hanging rather than as a sticker, because the previous version had all the geometry right and
 * still looked stuck on.
 *
 * The decisive part is not the swing at all — it is that the body is kept **plumb in world space**.
 * A lantern parented to the hand inherits camera pitch and yaw, so looking up tips the lantern up with
 * you and it reads as painted onto the screen no matter how much sway is layered on top. So every frame
 * `swing.quaternion` is written as `inverse(worldQuat(pivot)) * wanted`, which cancels whatever the
 * camera is doing and leaves the lantern's own orientation absolute. Turn your head and it stays level.
 * That single line is the fix; the spring below is what makes it look alive.
 *
 * `drive` converts the pivot's horizontal acceleration into a lean, the way a real pendulum leans into
 * the frame of its mount: the equilibrium angle of a bob whose pivot accelerates at `a` is exactly
 * atan(a/g), and this is that with a gain on it, because a hand-held lantern on a short handle has more
 * apparent lean than the point-mass answer. `hz` is a real pendulum's frequency for a bob roughly a
 * hand's length under its pivot (sqrt(g/L)/2pi is about 1.1 Hz at L = 0.2 m), which is why it needs no
 * tuning to look right. `damp` is a ratio, not a rate — 0.22 is loose enough for two or three visible
 * returns after a stop. `max` is the arm getting in the way; hitting it eats the rate rather than
 * storing it, so the lantern parks against the limit instead of buzzing on it.
 */
const SWING = { hz: 1.05, damp: 0.22, drive: 1.7, max: 0.24 };

/**
 * The vertical give, which lives in the arm rather than in the handle — see where it is applied in
 * update(). Its own spring rather than another axis of the one above because a stiff axis is much faster
 * than a swinging one: the lantern should drop and recover on a footfall while it is still finishing a
 * long lateral swing.
 *
 * `drive` is not 1. The physically exact response to a pivot accelerating at `a` is -a/w^2, which at
 * 2.6 Hz means a 30 m/s^2 landing would move the lantern 11 cm; a tenth of that is the readable amount,
 * and `max` catches the rest.
 */
const BOB = { hz: 2.6, damp: 0.4, drive: 0.1, max: 0.016 };

/**
 * What each footfall hands the springs, in rad/s and m/s. Subscribed off `noise:emitted` rather than
 * re-derived here, so the jolt lands on the same frame as the step *sound* and the two are in sync for
 * free — FPController emits one per stride and nothing else emits `footstep`.
 *
 * The lateral kick alternates sign so consecutive steps push opposite ways, which is what a walk
 * actually does to something in your hand; the same sign every step would pump one direction into a
 * resonance. 0.55 rad/s against SWING's 6.6 rad/s natural frequency is about 4.8 degrees of amplitude.
 */
const STEP_KICK = { lateral: 0.55, bob: 0.12 };

/**
 * How hard the pivot's own motion is smoothed before it is differentiated, in seconds. A position
 * difference over one frame is noise; a difference of *that* is worse. Two exponential moving averages
 * in series, written frame-rate independently as 1 - exp(-dt/tau) so a dropped frame does not change
 * the response. Acceleration is smoothed harder than velocity because it is the second difference.
 */
const VEL_TAU = 0.045;
const ACC_TAU = 0.07;

/** Longest frame the integrator will accept, so an alt-tab cannot launch the lantern. */
const DT_MAX = 1 / 20;
const G = 9.81;

/** See the header: one multiply that stops a fixed-distance point light clipping lantern to white. */
const LANTERN_ALBEDO = 0.3;

/**
 * How much of its own light the lantern shows on itself. Without this it is a dark shape hanging in
 * front of a lit room — the one object in the house that should never look unlit is the light source.
 *
 * It is applied *through the base colour map*, which is the whole difference between a lantern and a
 * yellow blob. Lambert adds `emissive * emissiveIntensity * emissiveMap` after shading and nothing else
 * modulates it, so with no map the same cream layer lands on the ironwork, the glass and the pierced
 * panels alike: at 0.26 that is a fifth of the frame's brightest value laid flat over every texel, and
 * the texture stops being visible at all. Pointed at the base colour it instead glows where the artist
 * painted light — bright glass hot, dark iron still dark.
 */
const LANTERN_GLOW = 0.5;
const LANTERN_GLOW_OFF = 0.16;
/** The flame's own colour, the same one HouseScene gives the PointLight. */
const GLOW_HEX = 0xffc27a;

/**
 * The flame inside the chimney — two additive quads, a small white-hot core and a wider halo.
 *
 * Emissive alone could not do this job. It brightens the *texels the artist painted*, so the lantern
 * lights up as an object and still reads as unlit glass: there is no wick in the file to make bright.
 * A light source with nothing burning inside it is the one thing in this house the player looks at all
 * the time, so the flame has to be geometry that was never in the file.
 *
 * y is measured *down from the pivot*, not from the body centre, because that is where the parent's
 * origin now is. On the model's own -1..+1 box the glass chimney spans y -0.32..+0.11 and the grip is
 * at +0.90, so the middle of the glass is 1.005 units below the grip out of a 2.0 box: 0.50 of the
 * fitted height, and -0.52 puts the wick in the lower half of the glass where a wick actually sits.
 * The sizes are fractions of the fitted height and were re-derived for this model, which is far slimmer
 * than the one they were first tuned against — 0.703 wide against 2.000 tall. The halo is wider than
 * the lantern on purpose: the spill onto the ironwork either side of the glass is what makes the body
 * look lit from within rather than pasted over.
 */
const FLAME = { y: -0.52, core: 0.15, halo: 0.45 };

/**
 * Drawn *over* the lantern rather than inside it — `depthTest: false` and a renderOrder past the rig.
 *
 * The honest version, a quad between the front and back glass, does not survive contact with the asset:
 * the body is opaque with depth writes (see the OPAQUE note in the loader), so a flame at the true wick
 * position is hidden by the very object it is supposed to be inside. Additive blending is what makes the
 * cheat read correctly anyway — the quads only ever *add* light, so the ironwork they cross comes out as
 * a bar with glare spilling round it instead of a bar with a decal on it.
 */
const FLAME_ORDER = 20;

/** Peak additive strength of each quad, before the flicker in update() scales it down. */
const CORE_ALPHA = 0.95;
const HALO_ALPHA = 0.5;
/** What the LANTERN button leaves burning when it is off: an ember, not a dead lantern. */
const FLAME_OFF = 0.22;

/**
 * Idle carry sway of the *arm*, in metres. Two slow out-of-phase sines so the arm is never quite still,
 * scaled up as the player walks and never all the way off, because a hand that freezes solid the instant
 * you stop reads as a still image.
 *
 * This deliberately does *not* feed the pendulum — see the anchor in update(). Its own contribution
 * would be an acceleration of about w^2 * A = 0.007 m/s^2 against gravity's 9.81, a lean of four
 * hundredths of a degree, so nothing is lost by leaving it out and a feedback loop is avoided.
 */
const SWAY_POS = 0.006;
const SWAY_IDLE = 0.45;
/** Walking speed in m/s at which the sway reaches full amplitude. */
const SWAY_FULL = 2.2;

export interface HeldLanternHandles {
  /**
   * Advance the sway and the pendulum, and follow the LANTERN button: `on` drives the self-glow, so the
   * button dims the lantern's own body along with the light it casts. Cosmetic; safe to skip, though
   * skipping it for long enough leaves the pendulum to catch up over the next half second.
   */
  update: (dt: number, on: boolean) => void;
  /**
   * Hide the viewmodel for a camera-locked beat. The lantern's lights stay where they are: this is
   * the player's own light, and putting it out would darken the room around the kill, not just remove
   * the arm from the shot.
   */
  setVisible: (on: boolean) => void;
  dispose: () => void;
}

/**
 * What ModelLoader hands back: Lambert, or Phong for the materials that ship a normal map. Both of
 * these files do, so both arrive Phong — and everything done to them here (colour multiply, emissive,
 * emissiveMap, the alpha reset) exists identically on either, which is the only reason that change did
 * not have to be threaded any further than this alias.
 */
type Shaded = MeshLambertMaterial | MeshPhongMaterial;

/**
 * Multiply every material colour under `root` down, take its meshes out of the frustum test, and hand
 * back the distinct materials so a caller can go on to light them.
 *
 * The colour multiply is the exposure fix described in the header, and the dedup is load-bearing rather
 * than tidiness: ModelLoader's conform() shares one material instance across every mesh that asked for
 * the same source material, so multiplying per mesh would darken by k to the power of the mesh count.
 * Turning frustum culling off is insurance of a different kind — a bounding sphere a hand's width from
 * the camera straddles the near plane, and for the arms it is not insurance at all but required: a
 * SkinnedMesh is culled against the *bind* pose's sphere, and this rig's bind pose is a metre wide.
 */
function dim(root: Object3D, k: number): Shaded[] {
  const mats: Shaded[] = [];
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.frustumCulled = false;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const lam = m as Shaded;
      if (mats.includes(lam)) continue;
      lam.color.multiplyScalar(k);
      mats.push(lam);
    }
  });
  return mats;
}

/**
 * A round soft falloff, drawn once and shared by both quads.
 *
 * 64px is not a compromise: the core is 3 mm of screen at arm's length and the halo is deliberately
 * blurred, so the texture is magnified far past its own detail either way. The gradient is authored in
 * *alpha* with white rgb, so each quad's own `color` sets its temperature — white-hot for the core,
 * GLOW_HEX for the halo — off one upload. The two inner stops are what keep it from looking like a fuzzy
 * ball: opaque to 18% of the radius, still half-bright at 45%, then a long tail to nothing.
 */
function flameTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.18, 'rgba(255,255,255,1)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.5)');
    grad.addColorStop(0.75, 'rgba(255,255,255,0.12)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }
  return new CanvasTexture(c);
}

/** One angle and its rate. */
interface Spring {
  p: number;
  v: number;
}

/**
 * One semi-implicit Euler step of a damped spring toward `eq`, then a hard limit that *eats* the rate
 * rather than storing it — a lantern that has hit the arm should rest against it, not vibrate. Semi-
 * implicit rather than explicit because the velocity update uses the new acceleration and the position
 * update uses the new velocity, which is unconditionally stable at these frequencies where explicit
 * Euler would grow.
 */
function stepSpring(s: Spring, eq: number, w: number, damp: number, max: number, h: number): void {
  s.v += (-(w * w) * (s.p - eq) - 2 * damp * w * s.v) * h;
  s.p += s.v * h;
  if (s.p > max) {
    s.p = max;
    if (s.v > 0) s.v = 0;
  } else if (s.p < -max) {
    s.p = -max;
    if (s.v < 0) s.v = 0;
  }
}

/**
 * Hang the lantern and the right arm off `camera`. Resolves nothing: the two models arrive over the next
 * few frames and the player starts empty-handed, exactly like the rest of the imported art. A failure is
 * reported, not thrown — an arm that never appears must not cost anyone the house.
 */
export function installHeldLantern(
  loader: ModelLoader,
  camera: Camera,
  onError: (err: unknown, where: string) => void,
): HeldLanternHandles {
  const hold = new Group();
  hold.name = 'held';
  hold.position.set(HOLD.x, HOLD.y, HOLD.z);
  camera.add(hold);

  /**
   * The lantern's pivot: the joint at the top of its carry handle. Its quaternion is overwritten every
   * frame from the orientation the body should have in *world* space, so it must stay free of rotation
   * from anywhere else, and only things that are meant to tilt with the lantern may be parented here.
   */
  const swing = new Group();
  swing.name = 'held.swing';
  hold.add(swing);

  /**
   * The arm / left fist holding the lantern. Anchored at the pivot point of `hold`.
   */
  const arms = new Group();
  arms.name = 'held.arms';
  hold.add(arms);

  /** The lantern's own materials, once it lands, so the LANTERN button can dim its self-glow. */
  let glow: Shaded[] = [];

  // Both quads share one geometry and one texture; only the material differs, because their colours do.
  // They hang off `swing` rather than off the lantern root — that root carries fitToHeight's scale, so a
  // child of it would come out at a fifth of the size these fractions describe — and off `swing` rather
  // than `hold` so the flame tilts with the body it is burning inside.
  const flameTex = flameTexture();
  const flameGeo = new PlaneGeometry(1, 1);
  const mkFlame = (size: number, hex: number, alpha: number): { mesh: Mesh; mat: MeshBasicMaterial } => {
    const mat = new MeshBasicMaterial({
      map: flameTex,
      color: hex,
      transparent: true,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      opacity: alpha,
    });
    const mesh = new Mesh(flameGeo, mat);
    mesh.scale.setScalar(LANTERN_SIZE * size);
    mesh.position.y = LANTERN_SIZE * FLAME.y;
    mesh.renderOrder = FLAME_ORDER;
    mesh.frustumCulled = false;
    // Nothing to look at until the lantern it belongs to has landed.
    mesh.visible = false;
    swing.add(mesh);
    return { mesh, mat };
  };
  const halo = mkFlame(FLAME.halo, GLOW_HEX, HALO_ALPHA);
  const core = mkFlame(FLAME.core, 0xfff0d0, CORE_ALPHA);

  /** Dedicated warm point light at the flame to illuminate the fist, fingers, handle and lantern */
  const flameLight = new PointLight(0xffbe7b, 0.75, 1.4, 1.2);
  flameLight.position.set(0.02, LANTERN_SIZE * FLAME.y, 0.03);
  swing.add(flameLight);

  /** Soft fill light on the player's side so knuckles, thumb and palm are smoothly sculpted */
  const fillLight = new PointLight(0xffeedd, 0.15, 1.2, 1.2);
  fillLight.position.set(0.08, 0.02, 0.12);
  hold.add(fillLight);

  void (async () => {
    try {
      const { root } = await loader.load('lantern.glb');
      // fitToHeight seats the box *bottom* at the y it is given (ModelLoader.ts:235 — x and z are
      // centred, y is not), so the body then slides down until its grip is on the pivot.
      const box = fitToHeight(root, LANTERN_SIZE, 0, 0, 0);
      root.position.y -= box.height * PIVOT_FRAC;
      glow = dim(root, LANTERN_ALBEDO);
      for (const m of glow) {
        m.emissive.setHex(GLOW_HEX);
        m.emissiveIntensity = LANTERN_GLOW;
        // See LANTERN_GLOW: the glow has to be textured or it flattens the model into one cream
        // silhouette. Guarded on both sides — a material with no base colour has nothing to modulate
        // by, and one that shipped its own emissive map already knows better.
        if (m.map && !m.emissiveMap) m.emissiveMap = m.map;

        // OPAQUE. This material must be forced, and the numbers are why. The source declares alphaMode
        // BLEND, so ModelLoader's transparency rule turns it into a 0.35 alpha cutout — and the base
        // colour's alpha is not incidental: it is two-level, 86.5% of the texture at 255 and 13.3% at
        // 32..47 with essentially nothing between, i.e. the artist authored the glass chimney at alpha
        // 0.16. 2.5% of the mesh's own UVs land in that band. Left alone the chimney is therefore cut
        // away completely and the lantern renders as a frame with a hole where the glass should be.
        // Blending it properly is not the alternative: one material covers the whole model, so turning
        // the glass translucent turns the ironwork translucent too, and with the source's doubleSided
        // flag the inside of the fount would show through its own front. Forced opaque, the glass reads
        // as the sooty glare-filled pane a burning lantern actually has, and FrontSide halves the
        // overdraw on the one object drawn every single frame.
        m.alphaTest = 0;
        m.transparent = false;
        m.depthWrite = true;
        m.side = FrontSide;
        m.needsUpdate = true;
      }
      swing.add(root);
      halo.mesh.visible = true;
      core.mesh.visible = true;
    } catch (err) {
      onError(err, 'held:lantern.glb');
    }

    try {
      // High-detail photogrammetry scan of the left fist (revopoint_inspire_-_strike_fist_-_767x203x154.glb / fist-left.glb).
      const { root } = await loader.load('fist-left.glb');

      // Center the grip tunnel at the origin of the pivot group (negating grip offset)
      root.position.set(-GRIP_OFFSET.x, -GRIP_OFFSET.y, -GRIP_OFFSET.z);

      const pivot = new Group();
      pivot.name = 'held.fist.pivot';
      pivot.scale.setScalar(FIST_SCALE);
      pivot.rotation.set(
        FIST_ROTATION.x * MathUtils.DEG2RAD,
        FIST_ROTATION.y * MathUtils.DEG2RAD,
        FIST_ROTATION.z * MathUtils.DEG2RAD,
      );
      pivot.add(root);

      // Create warm skin Lambert material: organic diffuse and subsurface emissive without plastic specular scratches
      const skinMat = new MeshLambertMaterial({
        color: new Color(HAND_SKIN_COLOR).multiplyScalar(HAND_ALBEDO),
        emissive: new Color(HAND_EMISSIVE),
        emissiveIntensity: HAND_EMISSIVE_INTENSITY,
        side: FrontSide,
        depthTest: true,
        depthWrite: true,
      });

      root.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        mesh.frustumCulled = false;
        mesh.material = skinMat;
      });

      arms.add(pivot);
    } catch (err) {
      onError(err, 'held:fist-left.glb');
    }
  })();

  let clock = 0;
  /** Last state written to the glow, so the toggle costs nothing on the frames it does not change. */
  let lit: boolean | undefined;

  /**
   * The pivot's rest offset, and the pendulum's own state.
   *
   * `anchor` is deliberately where the pivot *would* be with no sway on it, rebuilt from the camera each
   * frame rather than read off `hold`. Reading `hold` would feed the carry sway into the lean that the
   * sway is then layered on top of, and the two would ring against each other at 1.1 Hz. The virtual
   * anchor still carries everything that matters — walking, the yaw lever arm, crouching, stairs.
   */
  const REST = new Vector3(HOLD.x, HOLD.y, HOLD.z);
  const anchor = new Vector3();
  const prevAnchor = new Vector3();
  const camPos = new Vector3();
  const camQuat = new Quaternion();
  const qPivot = new Quaternion();
  const qWant = new Quaternion();
  const qRoll = new Quaternion();
  const AX = new Vector3(1, 0, 0);
  const AZ = new Vector3(0, 0, 1);
  const vel = new Vector3();
  const prevVel = new Vector3();
  const acc = new Vector3();
  const raw = new Vector3();
  let started = false;
  const tiltX: Spring = { p: 0, v: 0 };
  const tiltZ: Spring = { p: 0, v: 0 };
  const bob: Spring = { p: 0, v: 0 };
  /** Which way the next footfall pushes; see STEP_KICK. */
  let side = 1;

  const offStep = globalBus.on('noise:emitted', (e) => {
    if (e.kind !== 'footstep') return;
    side = -side;
    tiltZ.v += STEP_KICK.lateral * side;
    bob.v -= STEP_KICK.bob;
  });

  return {
    setVisible: (on) => {
      swing.visible = on;
      arms.visible = on;
    },
    update: (dt, on) => {
      const h = Math.min(Math.max(dt, 1e-4), DT_MAX);
      clock += h;

      // --- what the pivot is doing, in world space ---
      camera.getWorldPosition(camPos);
      camera.getWorldQuaternion(camQuat);
      anchor.copy(REST).applyQuaternion(camQuat).add(camPos);
      if (!started) {
        started = true;
        prevAnchor.copy(anchor);
      }
      raw.subVectors(anchor, prevAnchor).divideScalar(h);
      prevAnchor.copy(anchor);
      vel.lerp(raw, 1 - Math.exp(-h / VEL_TAU));
      raw.subVectors(vel, prevVel).divideScalar(h);
      prevVel.copy(vel);
      acc.lerp(raw, 1 - Math.exp(-h / ACC_TAU));

      // --- the arm's own carry sway, plus the vertical give ---
      // The bob is applied to `hold` and not to `swing`, which is a correction worth stating: the handle
      // is rigid, so the hand and the lantern rise and fall together and the spring being modelled is the
      // one in the arm. Putting it on `swing` opens a 16 mm gap between the fist and the handle on every
      // footfall, which is the same "stuck on separately" tell as parenting the lantern would have been.
      const wb = 2 * Math.PI * BOB.hz;
      stepSpring(bob, (-acc.y / (wb * wb)) * BOB.drive, wb, BOB.damp, BOB.max, h);
      const gain = SWAY_IDLE + (1 - SWAY_IDLE) * Math.min(Math.hypot(vel.x, vel.z) / SWAY_FULL, 1);
      hold.position.x = HOLD.x + Math.sin(clock * 1.1) * SWAY_POS * 0.7 * gain;
      hold.position.y = HOLD.y + Math.sin(clock * 1.7) * SWAY_POS * gain + bob.p;

      // --- the pendulum ---
      // These angles are about *world* x and z, not the camera's, which is the whole point: the lean is
      // absolute, so turning on the spot swings the lantern round the fist instead of carrying it along.
      // A bob whose pivot accelerates at `a` settles at atan(a/g), and it settles on the far side, hence
      // the sign on z: acceleration toward +x displaces the lantern toward -x, which is a negative roll.
      const w = 2 * Math.PI * SWING.hz;
      stepSpring(tiltX, Math.atan2(acc.z, G) * SWING.drive, w, SWING.damp, SWING.max, h);
      stepSpring(tiltZ, -Math.atan2(acc.x, G) * SWING.drive, w, SWING.damp, SWING.max, h);
      qWant.setFromAxisAngle(AX, tiltX.p).multiply(qRoll.setFromAxisAngle(AZ, tiltZ.p));
      // The one line that stops it being a sticker: cancel the pivot's world orientation, so whatever
      // the camera does to `hold` does not reach the lantern and `qWant` is what actually lands.
      hold.getWorldQuaternion(qPivot);
      swing.quaternion.copy(qPivot).invert().multiply(qWant);

      // --- the flame ---
      // Every frame and not gated on the toggle below. Two incommensurate rates multiplied together give
      // a signal that dips hard now and then instead of pulsing on a beat, and the core stretches
      // vertically as it brightens — a flame that only changes brightness reads as a failing bulb. The
      // halo is given a shallower swing so the spill on the ironwork stays steady while the wick jumps.
      const f = 0.72 + 0.28 * Math.sin(clock * 11.3) * Math.sin(clock * 4.7);
      const level = on ? 1 : FLAME_OFF;
      const size = LANTERN_SIZE * FLAME.core;
      core.mat.opacity = CORE_ALPHA * level * f;
      halo.mat.opacity = HALO_ALPHA * level * (0.6 + 0.4 * f);
      core.mesh.scale.set(size * (0.92 + 0.08 * f), size * (0.8 + 0.3 * f), 1);
      if (on === lit) return;
      lit = on;
      for (const m of glow) m.emissiveIntensity = on ? LANTERN_GLOW : LANTERN_GLOW_OFF;
    },
    // The geometry and materials belong to the ModelLoader cache, which HouseScene disposes on its own
    // line. Detaching from the camera is all this owns — and it matters, because the camera is never
    // removed from the scene, so anything left on it leaks straight into a rebuilt house. The flame is the
    // exception: it was built here, so it is freed here. The bus subscription has to go with it or the
    // next house's footsteps would still be kicking this one's springs.
    dispose: () => {
      offStep();
      camera.remove(hold);
      core.mat.dispose();
      halo.mat.dispose();
      flameLight.dispose();
      fillLight.dispose();
      flameGeo.dispose();
      flameTex.dispose();
      swing.clear();
      arms.clear();
      hold.clear();
    },
  };
}
