/**
 * HouseScene — the playable house: shell, fixtures, lighting, the three puzzles and the gate.
 *
 * This is the only file that knows how the pieces fit. Everything it uses is deliberately dumb —
 * Fixtures returns geometry with handles, Clues returns writing and answers, GameState owns
 * progress — and the wiring between them lives here, once, where it can be read top to bottom.
 *
 * The rules from the brief that shaped this file rather than the ones it calls into:
 *
 * - **No signposting (§8).** Nothing glows, nothing floats, and no prompt appears until the player
 *   is close to something and looking at it. The one concession is the HUD's three empty key
 *   slots, which say how many keys the gate wants — the gate says that itself anyway, in iron.
 * - **Keys in any order (§7).** Each lock is bound to one key, but every key is reachable
 *   independently, so the three puzzles can be done in any sequence and each lock turns the
 *   moment its key exists.
 * - **No arbitrary punishment (§3).** A wrong symbol sequence blows the candles out. A wrong
 *   breaker pull drops the rockers. Neither costs the player anything but the tap.
 * - **Darker below ground (§2).** Ambient and hemisphere light fall off with depth in `update`,
 *   which is one lerp per frame and does what a second fog volume cannot.
 */

import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  FogExp2,
  Group,
  HemisphereLight,
  Object3D,
  PointLight,
  Raycaster,
  Vector3,
  type AnimationClip,
  type Scene,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Engine } from '@/core/Engine';
import { globalBus } from '@/core/EventBus';
import type { AABB, FPController, FloorRect } from '@/player/FPController';
import { installHeldLantern } from '@/player/HeldLantern';
import type { TouchControls } from '@/player/TouchControls';
import { Batch } from '@/world/Batch';
import { buildHouse } from '@/world/HouseBuilder';
import { PLACE, buildProps } from '@/world/HouseProps';
import { BASE_Y, WALL_T } from '@/world/HouseLayout';
import {
  ARCH,
  BACK_DOOR_E,
  BACK_DOOR_W,
  BASEMENT_DOOR,
  BEDROOM_DOOR,
  CELLAR_DOOR,
  GATE,
  KITCHEN_DOOR,
  LIVING_DOOR,
  POOJA_DOOR,
  RITUAL_DOOR,
  RITUAL,
  SPAWN,
  STORE_DOOR,
  UPPER_INNER,
  UP_BACK_DOOR,
  UP_CHILD_DOOR,
  UP_HIDDEN_DOOR,
  UP_SHRINE_DOOR,
  UP_Y,
} from '@/world/HouseRooms';
import {
  aabbOf,
  disposeGroup,
  makeAltar,
  makeCasing,
  makeFixtureMats,
  makeGate,
  hangGatePadlocks,
} from '@/world/Fixtures';
import { GATE_KEYS, GameState, KEY_NAME, type KeyId } from '@/game/GameState';
import { InteractionSystem } from '@/game/Interaction';
import { ANISOTROPY_CAP, fitToHeight, ModelLoader } from '@/world/ModelLoader';
import { MODEL_PLACEMENTS, installModels } from '@/world/ModelProps';
import { armDaayan, stampKillClipGrip } from '@/world/DaayanSword';
import { armUpperDoor } from '@/world/UpperDoor';
import { armInnerDoor } from '@/world/InnerDoor';
import { armHiddenDoor } from '@/world/HiddenDoor';
import { armRitualDoors, type RitualDoorsHandle } from '@/world/RitualDoors';
import { DaayanAI, type HidingSpotRef } from '@/ai/DaayanAI';
import { DaayanKill } from '@/ai/DaayanKill';
import { DaayanGrab } from '@/ai/DaayanGrab';
import { installHeldPhone, PHONE_FILL } from '@/player/HeldPhone';
import { CoffinBurn } from '@/story/CoffinBurn';
import { CoffinFire } from '@/effects/CoffinFire';
import { armRitualCoffin, type CoffinHandles } from '@/world/Coffin';
import { armAnimatedFurniture, type AnimatedFurnitureHandle } from '@/world/AnimatedFurniture';
import { hingeMainGate } from '@/world/MainGate';
import { armNoiseProps, type NoisePropHandles } from '@/world/NoiseProps';
import { armHiding } from '@/world/Hiding';
import { installAudio } from '@/audio/AudioManager';
import { installFootsteps } from '@/audio/Footsteps';
import { installCat } from '@/world/CatRoamer';
import { CLUES, HIDDEN_DOOR_COORDS, SCREEN_CODE } from '@/game/Clues';
import { Hud } from '@/ui/Hud';
import { KillFx } from '@/ui/KillFx';
import { NoiseSystem } from '@/game/NoiseSystem';
import { OverlayLayer, overlayButton, overlayTitle } from '@/ui/OverlayLayer';
import { showNote } from '@/ui/NoteOverlay';
import { showKeypad } from '@/ui/KeypadOverlay';
import { localize } from '@/ui/Strings';

export interface HouseSceneHandles {
  update: (dt: number) => void;
  /** Gate and spawn bed are ready (or their individual failures were reported). */
  startupReady: Promise<void>;
  /** All imported models have settled, so gameplay will not decode art in the background. */
  allReady: Promise<void>;
  /**
   * Link every model's shaders and upload its textures while the title is still up, so the first frame
   * that draws a room is not also the frame that builds it. See ModelPropsHandles.warm.
   */
  warm: () => Promise<void>;
  /** True while a note, keypad or panel is open, so the loop can hold the player still. */
  overlayOpen: () => boolean;
  /** Close the active note/puzzle layer. Returns true only when it consumed an open overlay. */
  closeOverlay: () => boolean;
  /** Hiding locks translation but deliberately leaves look and INTERACT live. */
  isHidden: () => boolean;
  /** The catch cutscene owns movement, look and the camera for its 1.4 s. */
  isCinematic: () => boolean;
  dispose: () => void;
}

/** Gate lock order, top of the HUD to bottom of the gate. */
const LOCK_KEYS: readonly KeyId[] = GATE_KEYS;

/**
 * The second gate key is not designed yet (docs/mission-flow.md). Until it is, its lock turns
 * without a key so the chain can be played end to end. Set to false once the key has a home.
 */
const SECOND_KEY_PENDING = true;

/**
 * Clues that sit *inside* furniture: their prompt only appears while that furniture is open.
 * Values are AnimatedFurniture ids from the placement hook.
 */
const CLUE_CONTAINER: Record<string, string> = {
  'bedroom.father-note': 'dresser-bedroom',
  'bedroom.mother-photo': 'dresser-bedroom',
  'living.coords-note': 'wardrobe-chateau',
  'hidden.book': 'hidden-wardrobe.glb',
};

/**
 * Anchors for the mission clues that HouseProps does not publish. The dresser (x -2.8, z 9.5,
 * facing -z) gets one per drawer section; the chateau almirah (x -0.3, z 5.5, facing +x) one
 * just inside its doors.
 */
const MISSION_ANCHORS: Record<string, Vector3> = {
  'bedroom.father-note': new Vector3(-3.05, 0.85, 9.05),
  'bedroom.mother-photo': new Vector3(-2.55, 0.85, 9.05),
  'living.coords-note': new Vector3(0.2, 1.15, 5.5),
};

/**
 * HUD coordinates: whole metres from the spawn point, y from the floor under the feet. The spawn
 * itself reads 0 0 0. Shared with the hidden door's check so the two can never disagree.
 */
function hudCoords(p: Vector3, groundY: number): { x: number; y: number; z: number } {
  return {
    x: Math.round(p.x - SPAWN.x),
    y: Math.round(groundY),
    z: Math.round(p.z - SPAWN.z),
  };
}

interface Tween {
  t: number;
  dur: number;
  apply: (k: number) => void;
}

const easeOut = (u: number): number => 1 - (1 - u) ** 3;

export function buildHouseScene(
  scene: Scene,
  controller: FPController,
  touch: TouchControls,
  engine: Engine,
  reportError: (err: unknown, where: string) => void = (err, where) => {
    // eslint-disable-next-line no-console
    console.error('[daayan]', where, err);
  },
): HouseSceneHandles {
  scene.background = new Color(0x06060a);
  // FogExp2's factor is 1 - exp(-(density * depth)^2), so density is only worth arguing about at the
  // far end of a room: at 0.055 a wall 12 m off was 35% fog before a single light hit it, which is
  // most of the upper storey's main room. 0.038 halves that and still buries the corridor's far end.
  scene.fog = new FogExp2(0x0a0a12, 0.038);

  const disposables: Array<{ dispose: () => void }> = [];
  const track = <T extends { dispose: () => void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  // --- Shell, materials, dressing ---
  // One anisotropy for the whole house, procedural and imported alike. The device reports 16 and the
  // cap takes it to 8; the two halves have to agree, because a floor that changes sharpness where a
  // built room meets an imported one reads as a bug rather than as either setting.
  const aniso = Math.min(engine.renderer.capabilities.getMaxAnisotropy(), ANISOTROPY_CAP);
  const house = buildHouse(aniso);
  scene.add(house.group);
  const fx = makeFixtureMats(house.mats.trim, house.mats.door, track);
  const props = buildProps(fx);
  scene.add(props.group);
  for (const g of props.geos) track(g);

  const aabbs: AABB[] = [...house.aabbs, ...props.aabbs];
  const floors: FloorRect[] = [...house.floors];
  // The provisional spawn mattress that stood in for bed.glb while it loaded is gone with the bed: the
  // player now wakes standing on the bedroom floor, which is already in `house.floors`.

  // Everything interactive goes in one group so disposal is one traversal.
  const fixtures = new Group();
  fixtures.name = 'fixtures';
  scene.add(fixtures);

  // --- Light ---
  // One lantern does the work. The ambient and hemisphere terms exist only so unlit geometry is
  // not pure black, and both fall away underground — see the depth lerp in update().
  //
  // These two carry more than they look like they should, and it is because of what they multiply:
  // every imported model's albedo map measures around #7c7c7c, i.e. under a quarter of the linear
  // brightness of the procedural plaster, so the fill is the only term that reaches a surface the
  // lantern's falloff has already given up on. Measured on the phone, not guessed.
  const ambient = new AmbientLight(0x8a8296, 0.57);
  const hemi = new HemisphereLight(0x3d4a68, 0x2b2119, 0.66);
  scene.add(ambient, hemi);
  // The two ends of the storey lerp in the frame loop below. GROUND_LOW is the authored warm brown the
  // ground floor is signed off with; GROUND_UP is a neutral grey of about the same luminance, for the
  // upper storey, where hemi is strong enough for that brown to tint the whole apartment.
  const GROUND_LOW = new Color(0x2b2119);
  const GROUND_UP = new Color(0x232323);
  // Decay, not intensity, is the knob that reaches across a room. Three attenuates a point light by
  // 1 / dist^decay, so at 0.8 rather than the physical 2 a surface 6 m away receives 5.5x the light
  // while the lantern's own body 0.35 m away receives about a third *less* — under a metre is the side
  // of the curve where a smaller exponent means less amplification, which is why HeldLantern's albedo
  // constants did not have to move. Intensity then makes up the near field. The cutoff is 26 rather
  // than 16 so that the upper room, 10 x 11 m, is not windowed to black at its far wall.
  const lantern = new PointLight(0xffc27a, 3.0, 26, 0.8);
  lantern.position.set(-0.205, -0.16, -0.30);
  engine.camera.add(lantern);
  scene.add(engine.camera);
  // The burn takes the lantern out of the player's hand. The per-frame flame write below must not
  // switch it back on for the rest of the run.
  let lanternOut = false;
  // Moon through the two windows. A directional light is free and it is the only thing that tells
  // the player which way is outside.
  const moon = new DirectionalLight(0x8fb0ff, 0.5);
  moon.position.set(-14, 12, 18);
  scene.add(moon);
  // The lantern has no off switch any more. It was a button in the thumb column whose only effect was
  // to make the game harder to see, and nothing in the design ever asked the player to go dark —
  // hiding (see armHiding) is what the stealth layer is built on, not darkness. `held.update` still
  // takes the flag, so this reads as a constant rather than as a deleted parameter.
  const LANTERN_LIT = true;

  // --- Openings: casing on every one, a leaf on the ones that are doors ---
  const casings = [
    { x: GATE.x, z: GATE.z, axis: 'x' as const, half: GATE.half, y0: 0, y1: GATE.top, thickness: WALL_T },
    { x: ARCH.x, z: 0, axis: 'x' as const, half: ARCH.half, y0: 0, y1: ARCH.top, thickness: WALL_T },
    { x: BEDROOM_DOOR.x, z: BEDROOM_DOOR.z, axis: 'x' as const, half: BEDROOM_DOOR.half, y0: 0, y1: BEDROOM_DOOR.top, thickness: WALL_T },
    { x: LIVING_DOOR.x, z: LIVING_DOOR.z, axis: 'x' as const, half: LIVING_DOOR.half, y0: 0, y1: LIVING_DOOR.top, thickness: WALL_T },
    { x: CELLAR_DOOR.x, z: CELLAR_DOOR.z, axis: 'z' as const, half: CELLAR_DOOR.half, y0: 0, y1: CELLAR_DOOR.top, thickness: WALL_T },
    { x: BASEMENT_DOOR.x, z: BASEMENT_DOOR.z, axis: 'z' as const, half: BASEMENT_DOOR.half, y0: BASEMENT_DOOR.bottom, y1: BASEMENT_DOOR.top, thickness: WALL_T },
    { x: RITUAL_DOOR.x, z: RITUAL_DOOR.z, axis: 'z' as const, half: RITUAL_DOOR.half, y0: RITUAL_DOOR.bottom, y1: RITUAL_DOOR.top, thickness: WALL_T },
    // The doorway carved through the upper flat's east partition. Not WALL_T: this hole is cut in an
    // imported wall and that panel measures 0.16, so the jambs are sized to what they are lining — and
    // they are what covers the two paper-thin skin edges the cut leaves. `sill: false` and jambs that
    // start on the floor rather than 10 cm under it: see the upper wing's three below, which had the
    // same construction and were measurably the reported artefact.
    { x: UPPER_INNER.x, z: UPPER_INNER.z, axis: 'z' as const, half: UPPER_INNER.half, y0: UP_Y, y1: UPPER_INNER.top, thickness: 0.16, sill: false },
    // The hidden door's reveal — the third and last of the three things the carve through the flat's
    // west panel left bare.
    //
    // This opening is a CarveBox through imported triangles (`UP_HIDDEN_CUT`) and not a framed run, so
    // nothing had ever drawn a jamb on its edges: from the nook it was a rectangle sawn out of the wall,
    // and from the top of the stair the same three cut faces read as the sides of a slot with the stair
    // descending into it. The wall above the door and the wall below are the model's own, so the cut
    // faces are the only thing this hole has, and a lining is what makes them read as a door.
    //
    // `y1` is the carve's own top rather than the door's header. The leaf is a 2.15 m door standing in a
    // 2.03 m opening, so its top 12 cm is already buried in the wall above the hole — invisible, and the
    // lintel should line the hole, not the leaf. `sill: false` because the opening's floor is the stair's
    // own top tread and a threshold box there would be a step in the landing; it is also the case `sill`
    // documents, where a sill box's top face lands exactly on the boards.
    //
    // `thickness: WALL_T` rather than UPPER_INNER's 0.16: that one lines a 0.16 m imported panel, and
    // this is a hole in the floor plan at a wall the shell also draws north and south of it. The mouth
    // matters too: the leaf is 1.01 m in a 1.24 m carve, so the jambs are also what closes the 11.5 cm of
    // open slot either side of it down to 7.5 cm. A `fit` on the leaf to widen it instead is not an
    // option — `armHiddenDoor` takes the leaf's collider from the placed model's own box, and widening
    // that turned it into two 6.8 m bars across the flat. See the hidden-door row in ModelProps.
    { x: UP_HIDDEN_DOOR.x, z: UP_HIDDEN_DOOR.z, axis: 'z' as const, half: UP_HIDDEN_DOOR.half, y0: UP_Y, y1: UP_HIDDEN_DOOR.top, thickness: WALL_T, sill: false },
    // The rear wing's five, all cut in east-west walls and all standing on the ground floor, so these
    // get jambs and a lintel and skip makeCasing's sill branch the way BEDROOM_DOOR does. Two off the
    // front half of the house into the back corridor, three off that corridor into the rooms behind it.
    { x: BACK_DOOR_W.x, z: BACK_DOOR_W.z, axis: 'x' as const, half: BACK_DOOR_W.half, y0: 0, y1: BACK_DOOR_W.top, thickness: WALL_T },
    { x: BACK_DOOR_E.x, z: BACK_DOOR_E.z, axis: 'x' as const, half: BACK_DOOR_E.half, y0: 0, y1: BACK_DOOR_E.top, thickness: WALL_T },
    { x: KITCHEN_DOOR.x, z: KITCHEN_DOOR.z, axis: 'x' as const, half: KITCHEN_DOOR.half, y0: 0, y1: KITCHEN_DOOR.top, thickness: WALL_T },
    { x: POOJA_DOOR.x, z: POOJA_DOOR.z, axis: 'x' as const, half: POOJA_DOOR.half, y0: 0, y1: POOJA_DOOR.top, thickness: WALL_T },
    { x: STORE_DOOR.x, z: STORE_DOOR.z, axis: 'x' as const, half: STORE_DOOR.half, y0: 0, y1: STORE_DOOR.top, thickness: WALL_T },
    // The upper wing's three. Their openings start exactly on UP_Y, the storey's own floor, so
    // makeCasing's sill branch fires unless it is told not to — and this is where the reported brown
    // band across the threshold came from.
    //
    // These used to pass `y0: UP_Y - 0.1`, on the reasoning that pulling y0 down by a sill's height
    // sinks the sill into the floor slab and leaves only jambs and lintel showing. It does not: the
    // sill is 0.1 tall and is centred at y0 + 0.05, so its top face lands at y0 + 0.1 = UP_Y — not
    // under the floor, *on* it. Probed live at the two doorways where two room floors also meet, the
    // stack read `up-store-floor@2.40000`, `up-child-floor@2.40000`, `fixture:batch:0@2.40000`, gaps
    // 0 um and 0 um. Three coincident upward planes, one of them 1.4 x 0.34 m of `mats.wood`, and no
    // depth buffer can order coincident planes — so which one showed was decided by round-off and
    // changed as the camera turned. That is "angle change hone pe structure bhi change ho jata hai",
    // and it was brown because the winner half the time was the wooden sill.
    //
    // A doorway you walk through does not want a threshold box anyway, so it is not drawn rather than
    // hidden a millimetre lower, where its 0.34 m depth could still poke out past the wall.
    { x: UP_BACK_DOOR.x, z: UP_BACK_DOOR.z, axis: 'x' as const, half: UP_BACK_DOOR.half, y0: UP_Y, y1: UP_BACK_DOOR.top, thickness: WALL_T, sill: false },
    { x: UP_CHILD_DOOR.x, z: UP_CHILD_DOOR.z, axis: 'z' as const, half: UP_CHILD_DOOR.half, y0: UP_Y, y1: UP_CHILD_DOOR.top, thickness: WALL_T, sill: false },
    { x: UP_SHRINE_DOOR.x, z: UP_SHRINE_DOOR.z, axis: 'x' as const, half: UP_SHRINE_DOOR.half, y0: UP_Y, y1: UP_SHRINE_DOOR.top, thickness: WALL_T, sill: false },
    // Windows. No leaf; the casing is the sill and lintel that make a hole read as a window.
    { x: -9, z: 6.0, axis: 'z' as const, half: 0.8, y0: 1.0, y1: 2.2, thickness: WALL_T },
    { x: 4.0, z: 10.2, axis: 'x' as const, half: 1.1, y0: 0.9, y1: 2.3, thickness: WALL_T },
  ];
  for (const c of casings) fixtures.add(makeCasing(fx, c));

  // Leaves stand ajar rather than shut. A shut door needs an open/close interaction on every
  // threshold, which is four extra taps per lap of the house and buys nothing — and a house left
  // with every door half open is its own piece of storytelling.
  //
  // No procedural leaf is generated any more: every doorway that has one now hangs an imported leaf from
  // ModelProps, ajar to the same side and by the same policy — 'door-bedroom' and 'door-living' in
  // casings 2 and 3, 'door-cellar' and 'door-basement' in casings 4 and 5. The casings themselves are
  // still built here, because each of those imports is a leaf and not a frame. makeDoorLeaf is only
  // reachable through this file, so it went with the array; makeCasing did not.

  // --- The porch beyond the gate ---
  // Somewhere to actually arrive. Without it the gateway opens onto no floor at all, and the
  // ending would be the player falling through the world.
  // The deck and the two parapets stop just short of the hall's south wall rather than running into
  // it. Both used to end at GATE.z + 0.1, which is exactly where that wall's outer face and the hall
  // floor's edge are: 0.36 m2 of deck coplanar with the floor slab and 0.20 m2 of each parapet
  // coplanar with the wall, near-black against warm plaster, in different meshes — so the winner
  // flipped as the player crossed the threshold. They now finish inside the wall's 0.2 thickness,
  // which covers the join from both sides.
  const porch = new Batch();
  porch.box(fx.dark, 3.6, 0.24, 1.9, GATE.x, -0.12, GATE.z - 0.95);
  porch.box(fx.dark, 4.0, 0.14, 0.44, GATE.x, -0.31, GATE.z - 2.05);
  for (const dx of [-1.7, 1.7]) porch.box(fx.dark, 0.2, 1.0, 1.85, GATE.x + dx, 0.5, GATE.z - 0.975);
  for (const dx of [-1.7, 1.7]) porch.cyl(fx.wood, 0.09, 0.1, 1.9, 6, GATE.x + dx, 0.95, GATE.z - 2.0);
  for (const g of porch.flush(fixtures, 'porch')) track(g);
  floors.push({ x0: GATE.x - 1.6, x1: GATE.x + 1.6, z0: GATE.z - 1.9, z1: GATE.z, y: 0 });
  aabbs.push(aabbOf(GATE.x - 1.75, 0, GATE.z - 0.9, 0.12, 1.0, 1.0));
  aabbs.push(aabbOf(GATE.x + 1.75, 0, GATE.z - 0.9, 0.12, 1.0, 1.0));
  // Far edge: the player may stand on the porch but not wander off into the fog.
  aabbs.push(aabbOf(GATE.x, 0, GATE.z - 2.1, 2.0, 0.12, 1.4));

  // --- Progress, UI, interaction ---
  const state = new GameState();
  const hud = new Hud();
  hud.setKeySlots(LOCK_KEYS);
  const overlay = new OverlayLayer();
  const interact = new InteractionSystem(engine);
  const hiding = armHiding({ player: controller, interact });
  // No authored hiding box is registered here any more. The one that was — 'bedroom-wardrobe', the box of
  // the procedural almirah at (-1.45, 6.6) — existed only because that wardrobe was built synchronously
  // and so could not go through the model-placement hook. HouseProps no longer builds it, and the almirah
  // that replaced it is not in the bedroom either: closet-old.glb stands in the store room at
  // (4.4, 16.65), which Hiding picks up through WARDROBE_NAMES like every other imported hiding spot.
  // Beds join the same way, which is why the two that left the bedroom for the upper wing are still
  // hiding places without a line here changing.
  const tweens: Tween[] = [];
  const tween = (dur: number, apply: (k: number) => void): void => {
    tweens.push({ t: 0, dur, apply });
  };

  /** Reveal a key where its puzzle hides it, and register the pick-up. */
  const placeKey = (id: string, key: Group, anchor: Vector3, k: KeyId, taken: string): void => {
    key.visible = true;
    interact.add({
      id,
      pos: anchor,
      reach: 2.4,
      label: () => (state.hasKey(k) ? null : `Take the ${KEY_NAME[k]}`),
      onUse: () => {
        if (!state.collectKey(k)) return;
        key.visible = false;
        hud.setKeyHeld(k, true);
        hud.showToast(taken, 3.0);
      },
    });
  };

  // --- The gate ---
  // Only the locks and the casing are built here now; the leaf is gate-main.glb, placed by
  // ModelProps and hinged below.
  const gate = makeGate(fx, GATE.x, GATE.z);
  fixtures.add(gate.group);
  // A leaf has no collider, so the gateway is held shut by one box across it. Mutating this box
  // in place is enough to open the way — the controller holds the array by reference.
  const gateBlock = aabbOf(GATE.x, 0, GATE.z, GATE.half + 0.12, 0.14, GATE.top);
  aabbs.push(gateBlock);
  let gateOpen = false;
  // Filled by the placement hook. Null until the model lands, and the model lands well after the
  // locks are wired, so the swing is optional at every call site rather than awaited.
  let swingGate: ((k: number) => void) | null = null;

  const openGate = (): void => {
    if (gateOpen) return;
    gateOpen = true;
    // Drop the blocker below the world. FPController skips colliders that end under the player's
    // feet, so this is cheaper and less error-prone than splicing the array.
    gateBlock.minY = -60;
    gateBlock.maxY = -59.8;
    tween(2.6, (k) => {
      swingGate?.(k);
    });
    hud.showToast('The gate gives.', 4.0);
  };

  gate.lockAnchors.forEach((anchor, i) => {
    const k = LOCK_KEYS[i];
    const bolt = gate.bolts[i];
    if (!k || !bolt) return;
    interact.add({
      id: `gate.lock${i}`,
      pos: anchor,
      reach: 1.9,
      label: () => {
        if (state.isLockOpen(k)) return null;
        if (state.hasKey(k)) return `Turn the ${KEY_NAME[k]}`;
        // Placeholder until the second key is designed: this lock can be forced so the chain is playable.
        if (k === 'key-second' && SECOND_KEY_PENDING) return 'Force the middle lock';
        return 'Locked';
      },
      onUse: () => {
        if (k === 'key-second' && SECOND_KEY_PENDING && !state.hasKey(k)) state.collectKey(k);
        if (!state.openLock(k)) return;
        // Physical feedback, per §7: the padlock comes off its staple and hangs open, and stays that way.
        const fromY = bolt.position.y;
        tween(0.55, (p) => {
          bolt.position.y = fromY - p * 0.04;
          bolt.rotation.z = p * 0.5;
        });
        hud.setKeyUsed(k);
        const left = state.locksRemaining();
        if (left === 0) {
          // All three locks are off: the door swings, and stepping out onto the porch ends the run.
          openGate();
          hud.showToast('The last lock falls. RUN.', 4.0);
        } else {
          hud.showToast(`${left} more.`, 2.8);
        }
      },
    });
  });

  // --- The coffin: open it, take the third key, burn it (mission steps 7-8) ---
  /**
   * The coffin's lid, armed by the placement hook below. Null until the model lands — and if its clip
   * did not arrive, null forever, which is survivable: the key still appears, only without the swing.
   */
  let coffinLid: CoffinHandles | null = null;
  let coffinOpenRequested = false;
  let sonSkeleton: Object3D | null = null;
  let sonBurned = false;
  let burnSequence: CoffinBurn | null = null;
  /** After the burn the lantern is gone and the camera light becomes the phone's flashlight. */
  let phoneLight = false;
  let hiddenWardrobe: AnimatedFurnitureHandle | null = null;
  const animatedFurnitures: AnimatedFurnitureHandle[] = [];
  /** Furniture by AnimatedFurniture id, so clues inside them can ask whether they are open. */
  const furnitureById = new Map<string, AnimatedFurnitureHandle>();
  // makeAltar now only builds the small key that lies with the son's bones.
  const altar = makeAltar(fx, PLACE.altar.x, PLACE.altar.z, BASE_Y, []);
  fixtures.add(altar.group);
  aabbs.push(...altar.aabbs);
  interact.add({
    id: 'coffin.lid',
    pos: new Vector3(PLACE.altar.x, BASE_Y + 0.35, PLACE.altar.z),
    reach: 2.4,
    label: () => (coffinOpenRequested ? null : 'Open the coffin'),
    onUse: () => {
      if (coffinOpenRequested) return;
      coffinOpenRequested = true;
      coffinLid?.open();
      state.raiseTension('TERRIFYING');
      placeKey('coffin.key', altar.key, altar.keyAnchor, 'key-coffin', 'A key, lying beside the bones.');
      hud.showToast('The lid swings open. A small skeleton, and a key beside it.', 4.0);
    },
  });
  /** Only once the key is taken, so the throw cannot spend the lantern before the key is in hand. */
  interact.add({
    id: 'coffin.burn',
    pos: new Vector3(PLACE.altar.x, BASE_Y + 0.35, PLACE.altar.z),
    reach: 2.4,
    label: () =>
      !sonBurned && coffinOpenRequested && state.hasKey('key-coffin') && !burnSequence?.isActive()
        ? 'Throw the lantern'
        : null,
    onUse: () => {
      if (sonBurned || !coffinOpenRequested || !state.hasKey('key-coffin')) return;
      if (burnSequence?.start()) hud.setPrompt(null);
    },
  });

  // --- The screen over the ritual doorway, and its digital lock (mission step 6) ---
  // The screen itself is doors-sliding.glb and is armed in the placement hook; it refuses to slide
  // until `screenUnlocked`. The keypad is a small panel on the wall beside it.
  let ritualOpen = false;
  /** The screen's handle — mixer tick plus the opener the noise:alert path uses — null until placed. */
  let ritualScreen: RitualDoorsHandle | null = null;
  let screenUnlocked = false;
  const LOCK_PANEL = new Vector3(RITUAL_DOOR.x + 0.13, RITUAL_DOOR.bottom + 1.3, RITUAL_DOOR.z + RITUAL_DOOR.half + 0.32);
  {
    const panel = new Batch();
    panel.box(fx.iron, 0.05, 0.22, 0.15, LOCK_PANEL.x, LOCK_PANEL.y, LOCK_PANEL.z);
    panel.box(fx.glow, 0.012, 0.035, 0.1, LOCK_PANEL.x + 0.03, LOCK_PANEL.y + 0.065, LOCK_PANEL.z);
    for (const g of panel.flush(fixtures, 'screen-lock')) track(g);
  }
  interact.add({
    id: 'basement.screen-lock',
    pos: new Vector3(LOCK_PANEL.x + 0.3, LOCK_PANEL.y, LOCK_PANEL.z),
    reach: 2.0,
    label: () => (screenUnlocked || ritualOpen ? null : 'Enter the code'),
    onUse: () => {
      if (screenUnlocked || ritualOpen) return;
      showKeypad(overlay, {
        title: 'A digital lock',
        sub: 'Beside the paper screen',
        onSubmit: (code) => {
          if (code !== SCREEN_CODE) return false;
          screenUnlocked = true;
          state.solve('screen-code');
          hud.showToast('The lock clicks. The screen can slide now.', 3.4);
          return true;
        },
      });
    },
  });

  // --- The diary hands over the first key (mission steps 4-5) ---
  // On *close* of the first read, appended to the clue's own toast (the HUD has one toast slot).
  const handOff = (id: string): string | null => {
    if (id !== 'hidden.book') return null;
    if (!state.collectKey('key-father')) return null;
    props.hiddenKey.visible = false;
    hud.setKeyHeld('key-father', true);
    return `You take the ${KEY_NAME['key-father']}.`;
  };

  // --- Everything readable ---
  // One registration per CLUES entry with an anchor (HouseProps' own, or MISSION_ANCHORS). Reading
  // stays available forever; the tension raise and the one-line beat fire on the first read, on close.
  // A clue listed in CLUE_CONTAINER only offers its prompt while that furniture is open.
  const containerOpen = (id: string): boolean => {
    const box = CLUE_CONTAINER[id];
    if (box === undefined) return true;
    const h = box === 'hidden-wardrobe.glb' ? hiddenWardrobe : furnitureById.get(box);
    return h?.isOpen() ?? false;
  };
  for (const [id, spec] of Object.entries(CLUES)) {
    const at = props.anchors[id] ?? MISSION_ANCHORS[id];
    if (!at) continue;
    interact.add({
      id,
      pos: at,
      reach: 2.0,
      label: () => (containerOpen(id) ? spec.prompt : null),
      onUse: () => {
        if (!containerOpen(id)) return;
        if (!state.markSeen(id)) {
          showNote(overlay, spec.doc);
          return;
        }
        showNote(overlay, spec.doc, () => {
          if (spec.raises) state.raiseTension(spec.raises);
          const extra = handOff(id);
          const line = [spec.firstToast, extra].filter((s): s is string => !!s).join(' ');
          if (line) hud.showToast(line, 4.5);
        });
      },
    });
  }

  /** True while the player stands where the almirah note points (see HIDDEN_DOOR_COORDS). */
  const atHiddenDoorCoords = (): boolean => {
    const c = hudCoords(controller.getPosition(), controller.getGroundY());
    return (
      Math.abs(c.x - HIDDEN_DOOR_COORDS.x) <= 1 &&
      c.y === HIDDEN_DOOR_COORDS.y &&
      Math.abs(c.z - HIDDEN_DOOR_COORDS.z) <= 1
    );
  };

  // --- Walking out ---
  // The escape is not a button and not a prompt. Once the three bolts are back and the leaves have
  // swung, the porch is simply reachable, and standing on it ends the game — per §7 the gate
  // opening *is* the ending. A future cutscene hangs off endGame() and nothing else changes.
  let ended = false;
  const ESCAPE_Z = GATE.z - 1.1;

  const endGame = (): void => {
    if (ended) return;
    ended = true;
    state.escape();
    hud.setPrompt(null);
    overlay.show((content) => {
      content.appendChild(overlayTitle(localize('Outside'), localize('The gate stands open behind you')));
      const body = document.createElement('div');
      body.style.cssText = 'font: italic 400 15px/1.75 Georgia, serif; color: #ddd2bd;';
      for (const line of [
        'The cold is real, and the fog is real, and the road is somewhere ahead of you in it.',
        'Behind you the house has gone quiet. The twelfth nail is still empty.',
      ]) {
        const p = document.createElement('p');
        p.style.cssText = 'margin: 0 0 0.7em;';
        p.textContent = localize(line);
        body.appendChild(p);
      }
      content.appendChild(body);
      content.appendChild(
        overlayButton(localize('Walk'), () => overlay.close(), 'width: 100%; margin-top: 8px;'),
      );
    });
  };

  /**
   * She caught the player — the consequence `game:caught` never had.
   *
   * The AI emits `game:caught` exactly once per catch and then holds a recovery window open
   * (`cfg.catchRecovery`, 6 s on normal) for whoever subscribes. Nothing ever did, so being caught
   * cost the player nothing at all: she grabbed, stunned herself, woke, and the run simply continued.
   * That is the gap this closes.
   *
   * The flow is deliberately the shortest one that reads as a failure rather than a hiccup:
   *
   *   1. `state.caught()` spends a life and tells us whether any are left.
   *   2. Either way the player is warped back to the bed and the Daayan is reset to her ritual room —
   *      being sent back to the *same room* she is standing in would be a second catch, not a mercy.
   *   3. With lives left: a toast and the run continues. On the last life: the run ends.
   *
   * The respawn is the reason this handler exists rather than the AI doing it. Only the scene knows
   * where the bed is, that the overlay has to be closed first, and that she has to be walked home
   * before the player sees anything — and none of that belongs in the AI, whose recovery window is
   * what makes this window safe to use.
   */
  globalBus.on('game:caught', () => {
    // A catch during the ending is not a failure, and a catch after the last life has already been
    // spent must not spend another. `state.caught()` guards both, but bailing here too keeps the
    // overlay from being replaced under the player as they read the ending.
    if (ended || state.isDead()) return;
    onCaught();
  });

  // --- Hand the world to the player ---
  // The controller holds both arrays by reference, which is what lets the gate blocker and the
  // ritual screen's blocker be animated, or dropped, by mutating the objects already inside them.
  controller.setAabbs(aabbs);
  controller.setFloors(floors);
  controller.warpTo(new Vector3(SPAWN.x, SPAWN.y, SPAWN.z), SPAWN.yaw);
  touch.setOnInteract(() => {
    // INTERACT is also the fastest keyboard way out of a puzzle. Consume the topmost layer first so
    // the same E press cannot hit the world behind it; a press that opens a layer ends here as well.
    if (overlay.isOpen()) overlay.close();
    else interact.use();
  });
  hud.showToast('You wake on a bed in the dark bedroom.', 4.0);

  // --- Imported art ---
  // Started after setAabbs on purpose: these load over several frames and push their colliders into
  // the array the controller is already holding, so the house is walkable before any of them land.
  const modelLoader = new ModelLoader(aniso);
  // The three gate padlocks. makeGate() left a pivot per lock; the model lands a few frames later.
  void modelLoader
    .load('lock-and-key.glb')
    .then(({ root }) => hangGatePadlocks(root, gate.bolts, 2.0))
    .catch((e: unknown) => reportError(e instanceof Error ? e : new Error(String(e)), 'gate-padlocks'));
  /**
   * The noise props' arm, which needs the audio listener that is not built until below. Declared here
   * and assigned there rather than leaned on by hoisting: the arms in this hook already read `audio`
   * and `interact` from further down the function by accident of the models loading asynchronously,
   * and one synchronous placement would turn that accident into a TDZ crash. A null this hook checks
   * says the same thing without the trap — the models take several frames to arrive, so by the time
   * any of them do, this is set.
   */
  let noiseProps: NoisePropHandles | null = null;
  let daayanRoot: Object3D | null = null;
  /**
   * Her animation clips, kept separately from the root.
   *
   * `installModels` hands both to the placement hook, but the AI is constructed after this and needs
   * to build its own mixer — deliberately separate from ModelProps' own, so driving `timeScale` from
   * her real speed cannot interfere with the distance cull that stops ModelProps evaluating a clip
   * nobody can see.
   */
  let daayanClips: readonly AnimationClip[] = [];
  // The sword goes in on the placement hook rather than here, because it is measured in her bone
  // units and those only mean anything once her fit has written the root scale.
  const models = installModels(modelLoader, scene, engine.camera, aabbs, fx.shadow, house.mats.wallWarm.map, reportError, (name, root, clips) => {
    // The son in the coffin. The other skeleton in the house is a different placement and must stay
    // untouched; this name is the one laid in the coffin.
    if (name === 'skeleton.glb') sonSkeleton = root;
    if (name === 'daayan.glb') {
      daayanRoot = root;
      daayanClips = clips;
      armDaayan(modelLoader, root, clips, reportError);
    }
    // (The bed.glb hook — mattress surface, base collider and spawn re-warp — was removed with the bed.)
    // Imported beds and closet are measured only after fitToHeight has written their scale. The hiding
    // arm ignores every other name, just like NoiseProps below.
    hiding.onPlaced(name, root);
    // The AI's copy of the hiding-spot list is a snapshot, so it has to be rebuilt when a spot lands.
    // Cheap — every placement in the house runs through this, and it is a handful of objects.
    refreshHidingSpots();
    // The four bottles and plates. Unconditional: the arm ignores every other placement.
    noiseProps?.onPlaced(name, root);
    // Same reason as the knife: the hinge is placed from the leaf's world box, which only exists once
    // the fit has written the root's scale and position.
    if (name === 'door.glb') {
      armUpperDoor(root, {
        aabbs,
        player: controller,
        interact,
        tween,
        toast: (msg) => hud.showToast(msg, 4.0),
        onError: reportError,
      });
    }
    if (name === 'door-inner.glb') {
      armInnerDoor(root, {
        aabbs,
        player: controller,
        interact,
        tween,
        toast: (msg) => hud.showToast(msg, 4.0),
        onError: reportError,
      });
    }
    if (name === 'hidden-door') {
      // The leaf for the carved opening in the nook's west wall. Same hinge surgery as the other two
      // doors; what is different is that it only cracks at the almirah note's coordinates. `onOpened` is the reveal's
      // cue.
      armHiddenDoor(root, {
        aabbs,
        player: controller,
        interact,
        state,
        canCrack: atHiddenDoorCoords,
        tween,
        toast: (msg) => hud.showToast(msg, 4.0),
        onOpened: () => state.raiseTension('DISTURBING'),
        onError: reportError,
      });
    }
    if (name === 'doors-ritual') {
      // The one placement that wants the file's clips: the slide is a baked ease this scene must not
      // re-ease, so RitualDoors builds its own mixer and hands back the tick the frame loop calls.
      ritualScreen = armRitualDoors(root, clips, {
        aabbs,
        interact,
        toast: (msg) => hud.showToast(msg, 3.4),
        onError: reportError,
        canOpen: () => screenUnlocked,
        onOpen: () => {
          ritualOpen = true;
          state.raiseTension('DISTURBING');
          // The hunt starts here. This is the beat where the player has deliberately opened the room
          // she is standing in, which is the one moment in the game where a silent, waiting Daayan
          // would be wrong: from now on she is awake and the house is hers. Slight delay so the slide
          // finishes before her footsteps start, or the two read as one sound.
          wakeDaayanAt = performance.now() / 1000 + 1.2;
        },
      });
    }
    if (name === 'coffin-ritual') {
      // The lid's swing is the model's baked ease, so Coffin owns the mixer and the frame loop ticks it.
      coffinLid = armRitualCoffin(root, clips, reportError);
      if (coffinOpenRequested) coffinLid?.open();
    }
    if (name === 'wardrobe-chateau') {
      const h = armAnimatedFurniture({
        id: 'wardrobe-chateau',
        root,
        clips,
        interact,
        openLabel: 'Open the almirah',
        closeLabel: 'Close the almirah',
        openToast: 'You open the almirah.',
        closeToast: 'You close the wardrobe.',
        toast: (msg) => hud.showToast(msg, 3.0),
        onError: reportError,
      });
      if (h) {
        animatedFurnitures.push(h);
        furnitureById.set(name, h);
      }
    }
    if (name === 'hidden-wardrobe.glb') {
      const h = armAnimatedFurniture({
        id: 'hidden-wardrobe.glb',
        root,
        clips,
        interact,
        openLabel: 'Open Wardrobe',
        closeLabel: 'Close Wardrobe',
        openToast: 'You open the wardrobe.',
        closeToast: 'You close the wardrobe.',
        toast: (msg) => hud.showToast(msg, 3.0),
        onError: reportError,
      });
      if (h) {
        animatedFurnitures.push(h);
        furnitureById.set(name, h);
        hiddenWardrobe = h;
      }
    }
    if (name === 'dresser-bedroom') {
      const h = armAnimatedFurniture({
        id: 'dresser-bedroom',
        root,
        clips,
        interact,
        openLabel: 'Open Drawer',
        closeLabel: 'Close Drawer',
        openToast: 'The drawer slides open. Two sections, something in each.',
        closeToast: 'You close the drawer.',
        toast: (msg) => hud.showToast(msg, 3.0),
        onError: reportError,
      });
      if (h) {
        animatedFurnitures.push(h);
        furnitureById.set(name, h);
      }
    }
    if (name === 'cabinet-animated') {
      const h = armAnimatedFurniture({
        id: 'cabinet-animated',
        root,
        clips,
        interact,
        openLabel: 'Open Cabinet',
        closeLabel: 'Close Cabinet',
        openToast: 'You open the bedside cabinet.',
        closeToast: 'You close the cabinet.',
        toast: (msg) => hud.showToast(msg, 3.0),
        onError: reportError,
      });
      if (h) {
        animatedFurnitures.push(h);
        furnitureById.set(name, h);
      }
    }
    if (name === 'gate-main.glb') {
      swingGate = hingeMainGate(root);
      // Worth reporting rather than swallowing: the blocker still drops, so the player could still
      // walk out, but through a gate that never visibly opened — which is the game's last shot.
      if (swingGate === null) reportError(new Error('gate leaf arrived with no children'), 'main-gate:hinge');
      // The models load asynchronously, so a saved game that has already drawn all three bolts can
      // finish the load with the gate logically open and the leaf still shut. Snap it.
      else if (gateOpen) swingGate(1);
    }
  });
  // The lantern the light is coming from, and the arm holding it. Camera children, not props — the
  // rows for lantern.glb and arms.glb were removed from MODEL_PLACEMENTS so this owns both files.
  const held = installHeldLantern(modelLoader, engine.camera, reportError);
  // The phone that replaces it after the burn. Loaded now so the hand is there the moment it is needed;
  // its flashlight is only created on activation (see HeldPhone).
  const phone = installHeldPhone(modelLoader, engine.camera, held.hand, reportError);
  // Sound, such as it is: one listener on the camera and one cat. The listener has to be created
  // before anything asks for a sound, and it wants the camera it is going to hear from.
  const audio = installAudio(engine.camera, reportError);
  // Now that there is a listener, the four noise props can be armed. Any of them already placed are
  // impossible — the loader is asynchronous and this line is synchronous with the call above it. They
  // take the controller and not `interact`: there is no prompt on them any more, and the trigger is the
  // player's own capsule brushing past. See NoiseProps for why that was the wrong affordance.
  noiseProps = armNoiseProps({ audio, player: controller, tween });
  // The player's own boots. Nothing to update — it plays whatever FPController puts on the bus, which is
  // also what jolts the lantern, so the sample and the swing start on the same frame.
  const footsteps = installFootsteps(audio, engine.camera);
  // The roaming cat owns cat-walk.glb outright — its row came out of MODEL_PLACEMENTS — and reads
  // ritualOpen so it can follow the player into the ritual room once that doorway exists.
  const cat = installCat(
    modelLoader,
    audio,
    scene,
    engine.camera,
    aabbs,
    () => ritualOpen,
    reportError,
  );

  // Dynamic noise tracking: sprinting, object collision impulses, cat meows, scaled by Daayan distance
  const noiseSystem = new NoiseSystem({
    player: controller,
    getDaayanPos: () => {
      if (daayanRoot) {
        const p = new Vector3();
        daayanRoot.getWorldPosition(p);
        return p;
      }
      return new Vector3(-28.4, BASE_Y, 4.3);
    },
  });

  /**
   * Daayan's brain — see `src/ai/`. This replaces the previous static statue: she still starts
   * wherever `daayan.glb` was authored, in the ritual room, but she now perceives, remembers, plans
   * and walks.
   *
   * Built here, after the collider lists are complete but before the frame loop, and given the
   * *live* `aabbs` and `floors` arrays by reference — the same arrays the controller walks on — so her
   * navigation cannot disagree with the world the player experiences. Her nav grid is baked once from
   * them, so anything pushed into `aabbs` later (the bed's base box, if it had not already landed)
   * would be missed; by this point every synchronous collider is in, and the bed's box is only a
   * boot-order guard for the controller rather than a wall she should respect.
   *
   * `getRoot` is a thunk because the model arrives asynchronously: by the time her first tick needs a
   * root, `daayanRoot` is set, and until then she simulates perfectly well without a mesh.
   */
  const hidingSpots: HidingSpotRef[] = [];
  /**
   * Her start pose, read from the same row that places the mesh.
   *
   * Not a literal: the model row is the source of truth for where she stands, and duplicating its
   * numbers here is how a spawn quietly stops matching the statue the player can actually see. If the
   * row is ever renamed, the fallback keeps her in the ritual room rather than at the origin.
   */
  const daayanRow = MODEL_PLACEMENTS.find((p) => p.name === 'daayan.glb');
  const daayanStart = {
    position: new Vector3(
      daayanRow?.x ?? RITUAL.x0 + 1.6,
      daayanRow?.y ?? BASE_Y,
      daayanRow?.z ?? 4.3,
    ),
    yaw: daayanRow?.yaw ?? 2.41,
  };

  const ai = new DaayanAI({
    getRoot: () => daayanRoot,
    getClips: () => daayanClips,
    player: controller,
    obstacles: aabbs,
    floors,
    hidingSpots,
    start: daayanStart,
    difficulty: 'normal',
    overrides: {
      // Woken by the first real noise, which in practice is the player breaking into the cellar wing.
      wakeOnTrigger: true,
      // The overlay is worth having while the AI is new. Flip to false — or build for production, where
      // `daayanConfigFor` forces it off — once it stops being useful.
      debug: import.meta.env.DEV,
    },
    // She may only start behaving once the screen over the ritual doorway has actually opened.
    //
    // What seals her in is this predicate plus being asleep — not her graph. The basement's west
    // wall is built with the doorway already cut, and the screen's own blocker lands with the model,
    // after the nav bake, so the grid leaves the doorway walkable throughout. What keeps her home is
    // that nothing may wake her while the screen is shut: the wake paths in DaayanAI gate on this,
    // because an ambient noise waking her was the reported bug — she set off on a patrol and was
    // suddenly standing in the house before the door had slid.
    //
    // The one exception is a maxed noise bar, which breaks the seal itself: see the `noise:alert`
    // subscription below.
    canRoam: () => ritualOpen,
    scene,
    camera: engine.camera,
  });

  /**
   * Hiding spots are registered asynchronously as their models land, so the list is rebuilt rather than
   * captured: the AI's search consults it every time it plans an itinerary (§14 requires a search to
   * check the places a player could be).
   */
  const refreshHidingSpots = (): void => {
    hidingSpots.length = 0;
    for (const s of hiding.getSpots()) {
      hidingSpots.push({ id: s.id, position: new Vector3(s.use.x, s.use.y, s.use.z) });
    }
  };
  refreshHidingSpots();

  /**
   * When to wake her, as a wall-clock deadline, or 0 for "not yet".
   *
   * A deadline rather than a flag because the ritual door's slide is 1.3 s and her first footstep
   * landing on top of it reads as a single confused noise.
   */
  let wakeDaayanAt = 0;

  /**
   * A maxed noise bar breaks the ritual seal, wherever in the house it maxed.
   *
   * The bar filling up is the loudest thing the player can do; the reported bug was that it could
   * sit full a room away from a sealed-in Daayan who never reacted. So the racket disturbs the
   * ritual itself: the screen slides open on its own, and she wakes on the usual 1.2 s beat already
   * knowing where it happened — the AI's own `noise:alert` handler stashes the position while the
   * seal is shut and delivers it on `wake`.
   *
   * Subscription order is load-bearing: this is registered *after* the AI's constructor, so the
   * AI's handler runs first and stashes while `canRoam` is still false; this handler then opens the
   * seal, and the frame loop's `wakeDaayanAt` fires the delivery. Ordinary noises stay gated —
   * being sealed in is still a working defense against everything short of a full bar.
   */
  globalBus.on('noise:alert', () => {
    if (ritualOpen) return;
    if (ritualScreen) {
      ritualScreen.open('Somewhere below, a screen slides open.');
    } else {
      // The screen's model has not landed yet, so its blocker does not exist either and the doorway
      // is already passable: flip the flags its opening would have flipped and carry on.
      ritualOpen = true;
      state.raiseTension('DISTURBING');
      wakeDaayanAt = performance.now() / 1000 + 1.2;
    }
  });

  // --- The catch cutscene ---
  /**
   * One grab, one sword hit, black. The clip is optional: if it is missing or has not loaded when a
   * catch lands, the old instant respawn runs instead. That is deliberate — a missing optional asset
   * must never leave the player standing in front of a frozen Daayan, and it must never let a catch
   * cost a life with no consequence.
   *
   * `tryPrepareKill` is retried from the frame loop because the clip and her rig load independently.
   * The fist pose is stamped after both exist; see `stampKillClipGrip` for why the clip cannot ship
   * with its own right-hand finger tracks.
   */
  const killFx = new KillFx();
  const daayanGrab = new DaayanGrab(() => daayanRoot, engine.camera);
  let killClip: AnimationClip | null = null;
  let killClipReady = false;
  let killDisposed = false;
  let catchSequence: DaayanKill | null = null;

  const showDeathCard = (): void => {
    ended = true;
    overlay.show((content) => {
      content.appendChild(
        overlayTitle(localize('The house keeps you'), localize('There is nothing left to wake into.')),
      );
      const body = document.createElement('div');
      body.style.cssText = 'font: italic 400 15px/1.75 Georgia, serif; color: #ddd2bd;';
      const p = document.createElement('p');
      p.style.cssText = 'margin: 0 0 1em;';
      p.textContent = localize('Her hand closes on your throat and the house goes quiet.');
      body.appendChild(p);
      content.appendChild(body);
      content.appendChild(
        overlayButton(
          localize('Begin again'),
          () => {
            state.reset();
            ended = false;
            controller.warpTo(new Vector3(SPAWN.x, SPAWN.y, SPAWN.z), SPAWN.yaw);
            ai.endKill();
            ai.resetToStart();
            held.setVisible(true);
            touch.setPaused(false);
            catchSequence?.reset();
            overlay.close();
            hud.showToast('You wake on a bed in the dark bedroom.', 4.0);
          },
          'width: 100%; margin-top: 8px;',
        ),
      );
    });
  };

  const respawnAfterCatch = (): void => {
    controller.warpTo(new Vector3(SPAWN.x, SPAWN.y, SPAWN.z), SPAWN.yaw);
    ai.endKill();
    ai.resetToStart();
    held.setVisible(true);
    touch.setPaused(false);
    hud.showToast('You wake on the bed, and the house has shifted.', 4.0);
  };

  catchSequence = new DaayanKill({
    player: controller,
    ai,
    hud,
    camera: engine.camera,
    fx: killFx,
    onRespawn: respawnAfterCatch,
    onDeath: showDeathCard,
  });

  function onCaught(): void {
    if (ended || state.isDead()) return;
    const alive = state.caught();
    hud.setPrompt(null);
    // A catch inside a hiding pocket would put the kill camera inside the furniture, so those keep
    // the old instant consequence. So does a missing clip — the sequence refuses to start and the
    // fallback spends the life exactly as the game has always done.
    const started = !hiding.isHidden() && catchSequence !== null && catchSequence.start(alive);
    if (started) {
      held.setVisible(false);
      touch.setPaused(true);
      return;
    }

    held.setVisible(true);
    touch.setPaused(false);
    controller.warpTo(new Vector3(SPAWN.x, SPAWN.y, SPAWN.z), SPAWN.yaw);
    ai.endKill();
    ai.resetToStart();
    if (!alive) showDeathCard();
    else hud.showToast('You wake on the bed, and the house has shifted.', 4.0);
  }

  function tryPrepareKill(): void {
    if (killDisposed || killClipReady || !killClip || !daayanRoot) return;
    if (!stampKillClipGrip(killClip, daayanRoot)) return;
    ai.setKillClip(killClip);
    killClipReady = true;
  }

  new GLTFLoader()
    .loadAsync('/assets/models/daayan-kill.glb')
    .then((gltf) => {
      const clip = gltf.animations[0];
      if (!clip) return;
      killClip = clip;
      tryPrepareKill();
    })
    .catch((err) => {
      // Optional asset: the instant catch path is the fallback, so this is a warning, not a red box.
      console.warn('kill clip unavailable; catches will use the instant path', err);
    });

  // --- The coffin burn ---
  /**
   * The last task before the gate. The three locks are already back, the gate is held, and the player
   * has returned to the open coffin with the lantern. The sequence is in-engine because the room,
   * coffin, skeleton and lantern are all here; only the fire is new.
   *
   * The lantern prop is loaded from the same `lantern.glb` the viewmodel uses. It is optional: if it
   * has not landed, the fire still ignites on schedule, because the beat must never depend on a
   * cosmetic prop.
   */
  const burnFx = new KillFx('burn-fx');
  const burnFire = new CoffinFire(scene, () => sonSkeleton);
  let burnPropRoot: Object3D | null = null;
  let burnDisposed = false;
  const burnProp = {
    show: () => {
      if (burnPropRoot) burnPropRoot.visible = true;
    },
    hide: () => {
      if (burnPropRoot) burnPropRoot.visible = false;
    },
    place: (x: number, y: number, z: number, spin: number) => {
      if (!burnPropRoot) return;
      burnPropRoot.position.set(x, y, z);
      // Tumble about the base as well as yaw; a lantern crossing the coffin upright reads as a prop
      // being slid into place rather than thrown.
      burnPropRoot.rotation.set(spin * 0.55, spin, spin * 0.35);
    },
  };
  void modelLoader
    .load('lantern.glb')
    .then(({ root }) => {
      if (burnDisposed) return;
      const prop = root.clone(true);
      fitToHeight(prop, 0.34, 0, 0, 0);
      prop.visible = false;
      scene.add(prop);
      burnPropRoot = prop;
    })
    .catch((err) => {
      // The fire and the beat still work without the flying prop; do not red-box the finale.
      console.warn('coffin burn lantern prop unavailable', err);
    });

  /**
   * Mission step 9. The burn no longer ends the run: the screen comes back from black, the lantern is
   * gone, and the camera light becomes the phone's flashlight (a cold, steady white). The player then
   * has to reach the main door and turn the three locks. The phone-raise animation is still to come.
   */
  const finishBurn = (): void => {
    if (ended || sonBurned) return;
    sonBurned = true;
    state.solve('coffin-burn');
    burnSequence?.reset();
    // Same fist, no lantern: the phone goes into the hand the player has carried all game.
    held.setLanternShown(false);
    held.setVisible(true);
    phoneLight = true;
    // The camera light becomes a faint cool fill; the phone's own spot carries the beam.
    lantern.color.setHex(0xc8d4ff);
    phone.setActive(true);
    hud.showToast('The lantern is gone. You switch on your phone’s flashlight. Get to the main door.', 5.0);
  };

  burnSequence = new CoffinBurn({
    player: controller,
    hud,
    touch,
    held,
    camera: engine.camera,
    fx: burnFx,
    fire: burnFire,
    prop: burnProp,
    getTarget: () => {
      const target = new Vector3(PLACE.altar.x, BASE_Y + 0.05, PLACE.altar.z);
      if (sonSkeleton) {
        // The middle of the body, not its root. skeleton.glb's origin sits at its feet — measured,
        // root z 3.16 against a box of z 1.42..3.17 — so aiming at the root threw the lantern onto the
        // foot end and lit only the lower part of the coffin. The box centre is the middle of the
        // coffin bed; y is the bed the bones lie on, so the fire stands on it rather than inside it.
        const box = new Box3().setFromObject(sonSkeleton);
        box.getCenter(target);
        target.y = box.min.y + 0.03;
      }
      return target;
    },
    onIgnite: () => {
      lanternOut = true;
    },
    onFinish: finishBurn,
  });

  // --- Frame ---
  /**
   * Developer probe — extra handles on the existing `window.__daayan` object, in DEV builds only.
   *
   * The noise bar is the one mechanic that cannot be checked from outside the render loop: whether a
   * sprint actually fills the bar, whether the fill fires `noise:alert` at the right moment, and
   * whether the AI then routes to where the player stood, all depend on the live controller and the
   * live scene. A headless suite proves the AI half (see `tools/playtest-check.ts` BUG 3) but cannot
   * prove the wiring half, and the wiring half is what the player reported.
   *
   * `import.meta.env.DEV` is statically folded, so these additions are absent from a release bundle
   * rather than merely unreferenced. `main.ts` already publishes the base object unconditionally,
   * because the on-device perf gate reads it; this adds the scene-local handles it cannot reach.
   *
   *   __daayan.noise()   fill the bar and fire the alert, wherever the player is standing
   *   __daayan.level()   the bar's current value, 0–1
   *   __daayan.state()   her state, why, and how far away she is
   *   __daayan.open()    open the ritual screen without waiting for a full bar
   */
  let devProbe: NoiseSystem | null = null;
  if (import.meta.env.DEV) {
    const handles = (window as unknown as { __daayan?: Record<string, unknown> }).__daayan ?? {};
    handles.noise = () => devProbe?.fill();
    handles.level = () => devProbe?.getLevel() ?? 0;
    /**
     * The gait as the noise system sees it, which is the half that was wrong three times over.
     *
     * `bar()` prints one line: what the run control is doing, what the controller concluded from it,
     * and what the bar has done as a result. The distinction between `intent` and `running` is the
     * whole of the small-room bug — holding run while pressed against a wall is `intent: true,
     * running: false`, and that combination must hold the bar rather than drain it.
     */
    handles.bar = () => ({
      intent: controller.isRunIntent(),
      running: controller.isRunning(),
      level: Number((devProbe?.getLevel() ?? 0).toFixed(3)),
      alerted: devProbe?.hasFiredAlert() ?? false,
    });
    handles.state = () => ({
      state: ai.getState(),
      reason: ai.getReason(),
      awake: ai.isAwake(),
      away: ai.getPosition().distanceTo(engine.camera.position),
    });
    /**
     * Run the catch cutscene without waiting to be hunted. It spends a life exactly like a real
     * catch, so it exercises the respawn and death paths too; `killReady` says whether the clip
     * stamped onto her rig, and `killActive` is true for the 1.4 s the camera is locked.
     */
    handles.kill = () => onCaught();
    handles.killReady = () => killClipReady;
    handles.killActive = () => catchSequence?.isActive() ?? false;
    /**
     * Stage the final burn without solving the whole house. This bypasses the trigger, not the beat:
     * it opens the coffin if needed, then starts the same sequence the interaction starts.
     */
    handles.burn = () => {
      if (!coffinOpenRequested) {
        coffinOpenRequested = true;
        coffinLid?.open();
      }
      return burnSequence?.start() ?? false;
    };
    handles.burnReady = () => ({
      gateUnlocked: state.gateUnlocked(),
      coffinOpen: coffinOpenRequested,
      sonBurned,
      active: burnSequence?.isActive() ?? false,
    });
    // Staging handle: lets a probe put her on a known spot for the cutscene without waiting for a
    // real hunt. DEV-only, like every other handle in this block.
    handles.ai = ai;
    /**
     * Take the red key without walking to it, so the hidden door can be tested end to end.
     *
     * The key lives under a pillow in the black magic room at the far end of the basement, and a door
     * that cannot be opened on demand cannot be checked — the prompt has to be watched changing from
     * "Locked" to "Turn the red key", and that is the whole of what this door does.
     */
    handles.open = () => ritualScreen?.open('A screen slides open.');
    /**
     * What the crosshair is actually on, as one pasteable line.
     *
     * A screenshot cannot say what it is a picture of, and "the lock on the door" is not a thing
     * the code has a name for. This raycasts from the camera and walks up to the nearest named
     * ancestor, which for an imported prop is the placement row's `id` — so it answers both "which
     * object is this" and "where in the world is it", which together are enough to place or remove
     * anything without a debugger.
     */
    handles.look = () => {
      const dir = new Vector3();
      engine.camera.getWorldDirection(dir);
      // Start half a metre out, not at the eye. The camera carries the held lantern, the arm and the
      // fist as children — thirteen of them — so a ray from the eye hits the viewmodel at 0.2 m every
      // single time and the probe answers "grade" for the whole house. Nothing placeable is closer than
      // half a metre anyway, and the reach of every interaction in the game is longer than that.
      const from = engine.camera.position.clone().addScaledVector(dir, 0.5);
      const caster = new Raycaster(from, dir, 0.05, 30);
      const hits = caster.intersectObjects(engine.scene.children, true);
      const hit = hits.find((h) => h.object.visible);
      if (hit === undefined) return 'nothing';
      // The whole chain, innermost first. A placement row names the root it was loaded into, so the
      // useful answer is usually the second or third entry — but which one is only knowable by looking,
      // and reporting one name guessed wrong is worse than reporting five that are right.
      const chain: string[] = [];
      let o: Object3D | null = hit.object;
      while (o !== null && chain.length < 6) {
        if (o.name !== '') chain.push(o.name);
        o = o.parent;
      }
      const p = hit.point;
      return (
        `chain=${chain.join(' < ') || '(unnamed)'} ` +
        `at(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}) d=${hit.distance.toFixed(2)}`
      );
    };
    /**
     * Where the player is standing and which way they are looking, as one pasteable line.
     *
     * Prop placement needs both numbers and needs them from the player's own eyes: the position is
     * where the thing goes, and the heading is which way its front faces. It reads the camera's
     * forward vector rather than the controller's yaw so that "stand at the door and look at it"
     * means exactly what it sounds like — the answer describes the sightline, not an internal angle.
     */
    /**
     * What the interaction system currently holds, and which one it is offering.
     *
     * Added while wiring the hidden room's book, because "I published an anchor and no prompt
     * appeared" has two very different causes that look identical from a screenshot: the anchor
     * never reached `interact`, or it reached it and is out of reach / facing away. `ids` answers
     * the first and `nearest` the second, with the distance and the facing dot product for the
     * candidate closest to the crosshair.
     *
     *   __daayan.interactables()  -> { count, ids, current, nearest }
     */
    /** Fire one interaction by id, for staging screenshots and cutscene tests. */
    handles.use = (id: string) => {
      const item = interact.get(id);
      if (!item) return 'missing';
      item.onUse();
      return 'used';
    };
    handles.interactables = () => {
      const cam = engine.camera;
      const dir = new Vector3();
      cam.getWorldDirection(dir);
      const ids = interact.listIds();
      let nearest: Record<string, unknown> | null = null;
      let best = Infinity;
      for (const it of interact.list()) {
        const to = it.pos.clone().sub(cam.position);
        const dist = to.length();
        if (dist > best) continue;
        best = dist;
        nearest = {
          id: it.id,
          dist: Number(dist.toFixed(3)),
          reach: it.reach ?? 2.2,
          facing: Number(dist < 1e-4 ? 1 : to.divideScalar(dist).dot(dir).toFixed(3)),
          label: it.label(),
        };
      }
      return { count: ids.length, ids, current: interact.getCurrent()?.id ?? null, nearest };
    };
    handles.where = () => {
      const p = controller.getPosition();
      const dir = new Vector3();
      engine.camera.getWorldDirection(dir);
      return (
        `pos(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})  ` +
        `dir(${dir.x.toFixed(2)}, ${dir.y.toFixed(2)}, ${dir.z.toFixed(2)})  ` +
        `yaw(${Math.atan2(dir.x, dir.z).toFixed(2)})`
      );
    };
    /**
     * The simulation clock, in seconds. Added because every timing-sensitive probe was wrong without
     * it, and the failure mode was silent and convincing.
     *
     * `engine.clock` advances by the fixed timestep once per logic step, and `GameLoop` clamps a
     * frame's contribution to `maxFrameDt` (0.1 s) while running at most 8 steps per frame. In a
     * Chrome tab that is not being composited, `requestAnimationFrame` drops to about 1 Hz, so the
     * *game* advances ~0.1 s per real second — roughly 16x slower than wall time. A probe that waits
     * on `setTimeout(3000)` therefore waits 0.3 s of game time, and then reports a slow tween as a
     * stuck door. Waiting on this value instead makes a settle wait mean the same thing at any
     * framerate.
     *
     *   __daayan.clock()  -> game seconds since the scene loaded
     */
    handles.clock = () => clock;
    handles.warp = (x: number, y: number, z: number, yaw?: number) => {
      controller.warpTo(new Vector3(x, y, z), yaw);
    };
    handles.openWardrobe = () => {
      if (hiddenWardrobe && !hiddenWardrobe.isOpen()) {
        hiddenWardrobe.toggle();
      }
    };
    /**
     * A live player-position readout, DEV builds only.
     *
     * Added because placing geometry from a screenshot needs the screenshot to carry a world
     * coordinate, and a hand-drawn region cannot be converted into one. "Put a wall here" arrives as
     * a 2D outline with no depth, no yaw and no scale; the same outline from two different rooms
     * describes two different walls. With this on screen a screenshot is self-locating, and the
     * numbers can be read straight off it.
     *
     * It sits above the AI readout rather than in it because that line is written by Debug.ts, which
     * has no handle on the controller — and because this one is about the *player*, which is the thing
     * a geometry report is always implicitly about.
     *
     * Prints the EYE position (what `getPosition()` returns) and the feet height beside it, since
     * every floor and wall in this house is specified by the surface under the feet and the two differ
     * by the eye height.
     */
    const posReadout = document.createElement('div');
    posReadout.id = 'daayan-pos-readout';
    posReadout.style.cssText =
      'position:fixed;left:6px;bottom:66px;z-index:60;font:12px/1.35 ui-monospace,monospace;' +
      'color:#e8e8e8;background:rgba(0,0,0,.62);padding:2px 7px;border-radius:3px;' +
      'pointer-events:none;white-space:pre';
    document.body.appendChild(posReadout);
    const posTimer = window.setInterval(() => {
      const at = controller.getPosition();
      const dir = new Vector3();
      engine.camera.getWorldDirection(dir);
      const yaw = Math.atan2(dir.x, dir.z);
      // The eye height is not reachable from here (`currentEyeHeight` and `opts` are both private), so
      // the readout gives the eye and the feet as eye-minus-eye-height using the controller's standing
      // default of 1.7. Crouched readings will be 0.6 out on the feet figure — visible and obvious
      // rather than silently wrong, and the eye figure is exact either way.
      const feet = at.y - 1.7;
      posReadout.textContent =
        `pos(${at.x.toFixed(2)}, ${at.y.toFixed(2)}, ${at.z.toFixed(2)})` +
        `  feet(~${feet.toFixed(2)})  yaw(${yaw.toFixed(2)})`;
    }, 200);
    void posTimer;
    (window as unknown as { __daayan: unknown }).__daayan = handles;
  }

  let clock = 0;
  const AMB_TOP = ambient.intensity;
  const HEMI_TOP = hemi.intensity;
  /** Engine's baseline grade, so the storey lerp below is relative to it rather than a second source. */
  const EXP_TOP = engine.renderer.toneMappingExposure;

  const update = (dt: number): void => {
    clock += dt;
    // The clip and the rig land in either order. One cheap guard per frame until both exist.
    if (!killClipReady) tryPrepareKill();

    // Skinned models advance even behind an open overlay: the daayan's clip is a 17 s loop and
    // freezing it while the player reads a note would make her twitch on close.
    models.update(dt);
    // Also before the overlay return, and for the same reason: the cat is mid-stride between two
    // waypoints, and freezing it while the player reads a note would leave it standing in a doorway.
    cat.update(dt);
    // The ritual screen, once. It is paused until the player uses it and re-paused by the clip's own
    // clampWhenFinished, so outside those 1.3 seconds this call costs a null check and a timeScale of 0.
    ritualScreen?.tick?.(dt);
    // The coffin's lid, for the same reason and with the same cost: parked shut until the sequence is
    // solved, then one 1.2 s swing, then clamped open.
    coffinLid?.tick(dt);
    for (const f of animatedFurnitures) f.tick(dt);

    // Tweens run backwards so a finished one can be spliced out mid-loop.
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i];
      if (!tw) continue;
      tw.t += dt;
      const u = Math.min(tw.t / tw.dur, 1);
      tw.apply(easeOut(u));
      if (u >= 1) tweens.splice(i, 1);
    }

    // Two out-of-phase sines: one fast enough to read as flame, one slow enough to read as
    // draught. There is no longer an "off" branch here — see LANTERN_LIT.
    const flame = 3.0 + Math.sin(clock * 11.3) * 0.22 + Math.sin(clock * 4.1) * 0.14;
    // After the burn the camera light is the phone flashlight: steady, no flicker.
    lantern.intensity = phoneLight ? PHONE_FILL : lanternOut ? 0 : flame;
    // The arm carrying it. Cosmetic sway only, and it rides the same clock as the flame.
    held.update(dt, LANTERN_LIT);

    // Depth, not rooms (§2). One lerp on the fill terms, so the basement is darker without a
    // second fog volume and without knowing which room the player is standing in.
    const eyeY = engine.camera.position.y;
    const depth = Math.min(Math.max(-eyeY / 3, 0), 1);
    // Height does the opposite, for a reason that is about the art rather than the mood: the upper
    // storey is an imported apartment, its albedo a fraction of the procedural plaster's and its
    // main room 10 x 11 m rather than a 2.6 m corridor, so the same lantern lands far less light per
    // surface and the room read as unlit even with the stronger flame. Keyed off the eye height that
    // culls that room in (ModelProps.minEyeY) so the two agree on where a storey begins, and
    // exclusive with `depth` by construction — nobody is above 1.9 and below 0 at the same time.
    //
    // Quadrupling the fill for one storey was the first version of this and it was the wrong lever:
    // the boost lands on *every* surface above eye 1.9, including the stair shaft's procedural plaster,
    // whose albedo is several times the imported room's — so it saturated to a flat cream slab in the
    // same frame as the still-dark apartment, which is what read as "ajeeb". 1.8 is where the plaster
    // stays a gradient; the room's own darkness is carried by ModelProps.curve instead, at the material
    // level, where it reaches what the lantern lands on it too. Measured on the phone at (16, 4.1, 3.7)
    // and at the far corner (22.5, 4.1, 6.0), the worst sightline in the game.
    //
    // Ambient and hemi move together now. They were split 3.16/3.03 when this term was carrying the
    // whole storey; at 1.8 the difference is below what the phone shows, and one number is one thing
    // to retune.
    const up = Math.min(Math.max((eyeY - 1.9) / 0.6, 0), 1);
    ambient.intensity = AMB_TOP * (1 - 0.72 * depth) * (1 + 1.8 * up);
    hemi.intensity = HEMI_TOP * (1 - 0.74 * depth) * (1 + 1.8 * up);
    // Hemi's ground colour is the other half of "dark redish". It is a warm brown, and hemi hands a
    // *ceiling* its ground colour, so upstairs — where the fill is the strongest light in the room and
    // the ceiling is 10 x 11 m of it — that brown was being painted over the whole apartment. Neutral
    // grey of about the same luminance up there, the authored brown left untouched downstairs, where
    // the user already signed off on how it looks.
    hemi.groundColor.lerpColors(GROUND_LOW, GROUND_UP, up);
    // Exposure rides the same term. Tone mapping is the one control that lifts the *shadows* rather
    // than adding light: ACES has a toe that halves anything under about 0.02, which is exactly where
    // the far half of that room sits, and no amount of fill fixes a curve. It is a uniform, so
    // rewriting it per frame costs nothing — no shader recompile, unlike changing the operator.
    // 0.05 rather than the old 0.2: past about 1.45 the plaster by the stair door goes again.
    engine.renderer.toneMappingExposure = EXP_TOP * (1 + 0.05 * up);

    hud.update(dt);
    noiseSystem.update(dt, controller.isRunning());
    hud.setNoiseLevel(noiseSystem.getLevel());
    // Written every frame rather than on the `player:lives` event, because the "begin again" path
    // restores all three at once from a button handler and an event-only update would need a second
    // emitter for that case. `setLives` is a handful of style writes and only touches changed state.
    hud.setLives(state.getLives());
    {
      const c = hudCoords(controller.getPosition(), controller.getGroundY());
      hud.setCoords(c.x, c.y, c.z);
    }

    /**
     * Her tick.
     *
     * Deliberately after the player has advanced for this frame — `main.ts` has already moved the
     * controller — so she perceives and reacts to where the player *is*, not where they were one frame
     * ago. Running her before `models.update` above would also work, but then her own mixer would be a
     * frame behind the pose she just wrote.
     *
     * Paused behind an open overlay, with everything else that is not scenery: reading a note should
     * not be a chance to be crept up on, and §27's whole scheduling design assumes she is not the
     * thing costing frames while the player is stationary.
     */
    // The burn freezes her too. The player is standing over the coffin; a catch landing during the
    // ignition would only replace the finale with a respawn.
    if (!overlay.isOpen() && !burnSequence?.isActive()) ai.update(dt);

    // The cutscenes' clocks, cameras and black. They run after her mixer tick so the frame the camera
    // lands on belongs to the pose just produced, and before the prompt/escape code so a locked
    // player cannot interact with the room while a beat owns the camera.
    catchSequence?.update(dt);
    // After the sequence has written this frame's look and shake, so the fist lands on the camera
    // the renderer is about to draw from. Her mixer has already posed the arm; this only re-aims it.
    if (catchSequence?.isActive()) daayanGrab.apply(catchSequence.getElapsed());
    burnSequence?.update(dt);
    if (catchSequence?.isActive() || burnSequence?.isActive()) {
      hud.setPrompt(null);
      touch.setInteractionVerb('interact');
      return;
    }

    // The hunt's start, once the ritual door has finished sliding.
    if (wakeDaayanAt !== 0 && performance.now() / 1000 >= wakeDaayanAt) {
      wakeDaayanAt = 0;
      ai.wake();
    }

    if (overlay.isOpen()) {
      // No prompt behind an open overlay, and no picking either: the tap that closes the note
      // must not also be able to fire whatever the camera happens to be aimed at.
      hud.setPrompt(null);
      touch.setInteractionVerb('interact');
      return;
    }
    // Developer probe: run `noise()` from the devtools console to fill the bar and fire the alert by
    // hand, which is the only way to reproduce the "bar maxed, she never came" report in a real
    // browser without sprinting the whole house. See `__daayan` for the rest of the readout.
    devProbe = noiseSystem;
    hud.setPrompt(interact.update());
    touch.setInteractionVerb(interact.getCurrentVerb());
    // After the overlay return and after the prompt, because this is the other half of the same thing:
    // what the player can touch on purpose, and what they knock over by accident. It reads the
    // controller's position, which main.ts has already advanced for this frame.
    noiseProps?.update(dt);
    if (gateOpen && !ended && engine.camera.position.z < ESCAPE_Z) endGame();
  };

  const dispose = (): void => {
    killDisposed = true;
    burnDisposed = true;
    catchSequence?.dispose();
    burnSequence?.dispose();
    killFx.dispose();
    burnFx.dispose();
    burnFire.dispose();
    if (burnPropRoot) {
      scene.remove(burnPropRoot);
      burnPropRoot = null;
    }
    ai.dispose();
    interact.clear();
    hiding.dispose();
    hud.dispose();
    overlay.dispose();
    tweens.length = 0;
    models.dispose();
    held.dispose();
    phone.dispose();
    cat.dispose();
    footsteps.dispose();
    audio.dispose();
    noiseSystem.dispose();
    modelLoader.dispose();

    engine.camera.remove(lantern);
    lantern.dispose();
    scene.remove(ambient, hemi, moon, house.group, props.group, fixtures);
    ambient.dispose();
    hemi.dispose();
    moon.dispose();

    disposeGroup(props.group);
    disposeGroup(fixtures);
    house.dispose();
    for (const d of disposables) d.dispose();
    scene.fog = null;
  };

  return {
    update,
    startupReady: models.startupReady,
    allReady: models.allReady,
    warm: () => models.warm(engine.renderer),
    overlayOpen: () => overlay.isOpen(),
    closeOverlay: () => {
      if (!overlay.isOpen()) return false;
      overlay.close();
      return true;
    },
    isHidden: () => hiding.isHidden(),
    isCinematic: () => (catchSequence?.isActive() ?? false) || (burnSequence?.isActive() ?? false),
    dispose,
  };
}

