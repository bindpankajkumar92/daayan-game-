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
  UP_SHRINE_DOOR,
  UP_Y,
} from '@/world/HouseRooms';
import {
  aabbOf,
  disposeGroup,
  makeAltar,
  makeBreakerPanel,
  makeCasing,
  makeClock,
  makeCodeBox,
  makeFixtureMats,
  makeGate,
  type SymbolKind,
} from '@/world/Fixtures';
import { GameState, KEY_NAME, KEY_OF, type KeyId } from '@/game/GameState';
import { InteractionSystem } from '@/game/Interaction';
import { ANISOTROPY_CAP, ModelLoader } from '@/world/ModelLoader';
import { MODEL_PLACEMENTS, installModels } from '@/world/ModelProps';
import { armDaayan } from '@/world/DaayanKnife';
import { armUpperDoor } from '@/world/UpperDoor';
import { armInnerDoor } from '@/world/InnerDoor';
import { armHiddenDoor } from '@/world/HiddenDoor';
import { armRitualDoors, type RitualDoorsHandle } from '@/world/RitualDoors';
import { DaayanAI, type HidingSpotRef } from '@/ai/DaayanAI';
import { armRitualCoffin, type CoffinHandles } from '@/world/Coffin';
import { armAnimatedFurniture, type AnimatedFurnitureHandle } from '@/world/AnimatedFurniture';
import { hingeMainGate } from '@/world/MainGate';
import { armNoiseProps, type NoisePropHandles } from '@/world/NoiseProps';
import { armHiding } from '@/world/Hiding';
import { installAudio } from '@/audio/AudioManager';
import { installFootsteps } from '@/audio/Footsteps';
import { installCat } from '@/world/CatRoamer';
import {
  ALTAR_DISPLAY,
  BOX_CODE,
  BREAKER_ANSWER,
  BREAKER_LABELS,
  CLOCK_HOURS,
  CLOCK_MINUTES,
  CLUES,
  RITUAL_ORDER,
} from '@/game/Clues';
import { Hud } from '@/ui/Hud';
import { NoiseSystem } from '@/game/NoiseSystem';
import { OverlayLayer, overlayButton, overlayTitle } from '@/ui/OverlayLayer';
import { showNote } from '@/ui/NoteOverlay';
import { showKeypad } from '@/ui/KeypadOverlay';
import { showSwitchPanel } from '@/ui/SwitchPanelOverlay';
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
  dispose: () => void;
}

/** Gate lock order, top of the HUD to bottom of the gate. */
const LOCK_KEYS: KeyId[] = [KEY_OF.ritual, KEY_OF.clock, KEY_OF.breaker];

const SYMBOL_NAME: Record<SymbolKind, string> = {
  eye: 'eye',
  skull: 'skull',
  moon: 'moon',
  cross: 'cross',
};

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
  /**
   * A provisional mattress under the new spawn while bed.glb is in flight.
   *
   * Imported models load asynchronously, but the controller starts synchronously. Without this small
   * surface its first gravity step sees only the bedroom floor at y=0 and drops the player through the
   * not-yet-loaded bed before the title menu has even been dismissed. The placement hook below mutates
   * this same object to the fitted model's exact footprint/top, because FPController holds `floors` by
   * reference. 0.47 is the mattress measured when the row was authored (the headboard is 0.19 m above
   * it); it is a boot-time fallback, not a second permanent source of truth.
   */
  const spawnMattress: FloorRect = {
    // The bed lies length-along-x against the west wall (ModelProps' bed row), and SPAWN sits 0.25 m in
    // from its foot edge on the centre line, so these offsets are that footprint: 2.1 m on x, 1.0 on z.
    x0: SPAWN.x - 1.85,
    x1: SPAWN.x + 0.25,
    z0: SPAWN.z - 0.5,
    z1: SPAWN.z + 0.5,
    y: SPAWN.y - 1.7,
  };
  floors.push(spawnMattress);

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
    hud.showToast('Three turns. The gate gives.', 4.0);
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
        return state.hasKey(k) ? `Turn the ${KEY_NAME[k]}` : 'Locked';
      },
      onUse: () => {
        if (!state.openLock(k)) return;
        // Physical feedback, per §7: the bolt slides clear and stays that way.
        const from = bolt.position.x;
        tween(0.55, (p) => {
          bolt.position.x = from + p * 0.3;
          bolt.rotation.z = p * 0.35;
        });
        hud.setKeyUsed(k);
        const left = state.locksRemaining();
        hud.showToast(left === 0 ? 'The last bolt draws back.' : `${left} more.`, 2.8);
        if (state.gateUnlocked()) openGate();
      },
    });
  });

  // --- Puzzle 1: the order of waking ---
  // Symbols stand in display order; the answer is a different order and lives in Clues. Touching
  // out of turn puts every candle out and starts again — no lockout, nothing lost but the taps.
  /**
   * The coffin's lid, armed by the placement hook below and released by the solve. Null until the
   * model lands — and if its clip did not arrive, null forever, which is survivable: the key still
   * appears, only without the ceremony.
   */
  let coffinLid: CoffinHandles | null = null;
  const animatedFurnitures: AnimatedFurnitureHandle[] = [];
  const altar = makeAltar(fx, PLACE.altar.x, PLACE.altar.z, BASE_Y, ALTAR_DISPLAY);
  fixtures.add(altar.group);
  aabbs.push(...altar.aabbs);
  let seq: SymbolKind[] = [];
  altar.symbolAnchors.forEach((anchor, i) => {
    const kind = ALTAR_DISPLAY[i];
    if (!kind) return;
    interact.add({
      id: `altar.${kind}`,
      pos: anchor,
      reach: 1.9,
      label: () => (state.isSolved('ritual') ? null : `Touch the ${SYMBOL_NAME[kind]}`),
      onUse: () => {
        const flame = altar.flames[i];
        if (flame) flame.visible = true;
        seq.push(kind);
        if (RITUAL_ORDER[seq.length - 1] !== kind) {
          seq = [];
          for (const f of altar.flames) f.visible = false;
          hud.showToast('The candles go out.', 2.4);
          return;
        }
        if (seq.length < RITUAL_ORDER.length) return;
        if (!state.solve('ritual')) return;
        // The coffin's lid swings open on its own eased clip — started by the placement hook's `open`
        // and ticked by the frame loop. The key is revealed inside the opened shell.
        coffinLid?.open();
        placeKey('altar.key', altar.key, altar.keyAnchor, KEY_OF.ritual, 'An iron key, in the coffin.');
        hud.showToast('The lid of the coffin swings open.', 3.4);
      },
    });
  });

  // --- Puzzle 2: the hour on the clock ---
  const box = makeCodeBox(fx, PLACE.codeBox.x, PLACE.codeBox.y, PLACE.codeBox.z);
  fixtures.add(box.group);
  aabbs.push(...box.aabbs);
  fixtures.add(makeClock(fx, PLACE.clock.x, PLACE.clock.y, PLACE.clock.z, 0, CLOCK_HOURS, CLOCK_MINUTES));
  interact.add({
    id: 'box.dial',
    pos: box.anchor,
    reach: 1.7,
    label: () => (state.isSolved('clock') ? null : 'Work the dial'),
    onUse: () => {
      showKeypad(overlay, {
        title: 'A strongbox',
        sub: 'Four figures on a brass dial',
        onSubmit: (code) => {
          if (code !== BOX_CODE) return false;
          if (state.solve('clock')) {
            tween(0.8, (k) => {
              box.lid.rotation.x = -k * 1.55;
            });
            placeKey('box.key', box.key, box.keyAnchor, KEY_OF.clock, 'A brass key, inside the box.');
            hud.showToast('The lid comes up.', 3.0);
          }
          return true;
        },
      });
    },
  });

  // --- Puzzle 3: the two that stay down ---
  const panel = makeBreakerPanel(fx, PLACE.breaker.x, PLACE.breaker.y, PLACE.breaker.z);
  fixtures.add(panel.group);
  const rockers = [false, false, false, false];
  interact.add({
    id: 'panel.rockers',
    pos: panel.anchor,
    reach: 1.7,
    label: () => (state.isSolved('breaker') ? null : 'Open the panel'),
    onUse: () => {
      showSwitchPanel(overlay, {
        title: 'Sub-panel',
        sub: 'Four breakers, and a main lever',
        labels: BREAKER_LABELS,
        initial: rockers,
        onChange: (s) => {
          for (let i = 0; i < rockers.length; i++) rockers[i] = s[i] === true;
        },
        onCommit: (s) => {
          if (BREAKER_ANSWER.some((want, i) => (s[i] === true) !== want)) return false;
          if (state.solve('breaker')) {
            tween(0.9, (k) => {
              panel.lid.rotation.x = k * 1.5;
            });
            placeKey('panel.key', panel.key, panel.keyAnchor, KEY_OF.breaker, 'A rusted key, behind the hatch.');
            hud.showToast('A bolt shifts, further along the wall.', 3.4);
          }
          return true;
        },
      });
    },
  });

  // --- The screen over the ritual doorway ---
  // Only the flag lives here. The screen itself is doors-sliding.glb, so everything about it — the
  // blocker filling the opening, the prompt, and the mixer that plays its own eased slide — is built in
  // the placement hook below, once the model exists and its fit has been applied. See RitualDoors.
  let ritualOpen = false;
  /** The screen's handle — mixer tick plus the opener the noise:alert path uses — null until placed. */
  let ritualScreen: RitualDoorsHandle | null = null;

  // --- Everything readable ---
  // One registration per CLUES entry that HouseProps published an anchor for, so a clue that has
  // writing but no place to lie simply does not appear rather than floating at the origin.
  //
  // Reading stays available forever — a note can be picked up twice, and the player who forgot the
  // code must be able to go back for it. The tension raise and the one-line beat fire on the first
  // read only, and they fire on *close*, because a toast shown behind the open note is a toast
  // nobody sees.
  for (const [id, spec] of Object.entries(CLUES)) {
    const at = props.anchors[id];
    if (!at) continue;
    interact.add({
      id,
      pos: at,
      reach: 2.0,
      label: () => spec.prompt,
      onUse: () => {
        if (!state.markSeen(id)) {
          showNote(overlay, spec.doc);
          return;
        }
        showNote(overlay, spec.doc, () => {
          if (spec.raises) state.raiseTension(spec.raises);
          if (spec.firstToast) hud.showToast(spec.firstToast, 4.0);
        });
      },
    });
  }

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

    const alive = state.caught();
    overlay.close();
    hud.setPrompt(null);

    // Back to the bed, and her back to the ritual room. Both are hard warps rather than a fade,
    // because the catch has already played its own beat and a second one would read as a stutter.
    // `warpTo` clears velocity itself, so there is no separate stop to make.
    controller.warpTo(new Vector3(SPAWN.x, SPAWN.y, SPAWN.z), SPAWN.yaw);
    ai.resetToStart();

    if (!alive) {
      ended = true;
      overlay.show((content) => {
        content.appendChild(
          overlayTitle(localize('The house keeps you'), localize('There is nothing left to wake into.')),
        );
        const body = document.createElement('div');
        body.style.cssText = 'font: italic 400 15px/1.75 Georgia, serif; color: #ddd2bd;';
        const p = document.createElement('p');
        p.style.cssText = 'margin: 0 0 1em;';
        p.textContent = localize('Her hand closes on your wrist and the house goes quiet.');
        body.appendChild(p);
        content.appendChild(body);
        content.appendChild(
          overlayButton(
            localize('Begin again'),
            () => {
              state.reset();
              ended = false;
              controller.warpTo(new Vector3(SPAWN.x, SPAWN.y, SPAWN.z), SPAWN.yaw);
              ai.resetToStart();
              overlay.close();
              hud.showToast('You wake on a bed in the dark bedroom.', 4.0);
            },
            'width: 100%; margin-top: 8px;',
          ),
        );
      });
      return;
    }

    hud.showToast('You wake on the bed, and the house has shifted.', 4.0);
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
  // The knife goes in on the placement hook rather than here, because it is measured in her bone
  // units and those only mean anything once her fit has written the root scale.
  const models = installModels(modelLoader, scene, engine.camera, aabbs, fx.shadow, house.mats.wallWarm.map, reportError, (name, root, clips) => {
    if (name === 'daayan.glb') {
      daayanRoot = root;
      daayanClips = clips;
      armDaayan(modelLoader, root, clips, reportError);
    }
    if (name === 'bed.glb') {
      root.updateWorldMatrix(true, true);
      const bedBox = new Box3().setFromObject(root);
      /**
       * The headboard is 19 cm above the bedding in the fitted model. Box3.maxY is therefore not a
       * walkable top — using it would float the player on the top rail. This offset is already encoded
       * in the cat's `on: bed.glb, y: -0.19` placement; repeating the measured art fact here makes the
       * player's feet and the cat agree on which surface is the mattress.
       */
      const mattressY = bedBox.max.y - 0.19;
      const inset = 0.06;
      spawnMattress.x0 = bedBox.min.x + inset;
      spawnMattress.x1 = bedBox.max.x - inset;
      spawnMattress.z0 = bedBox.min.z + inset;
      spawnMattress.z1 = bedBox.max.z - inset;
      spawnMattress.y = mattressY;

      // The normal `collide:true` placement box was removed from this bed: a full-height AABB would
      // overlap a capsule whose feet are on the mattress and lock the spawn in place. A base ending at
      // the mattress blocks walking through the bed from the floor, while FPController deliberately
      // ignores colliders whose max is at or below the player's feet when they stand on top.
      // Inset the base by the capsule radius. The capsule still meets the visible bed edge from the
      // floor, but after its centre leaves the mattress it no longer overlaps the base while gravity
      // lowers it. A full-footprint box traps the player permanently at that transition: the feet drop
      // to floor level while the capsule's trailing edge is still over the bed.
      const baseInset = controller.getRadius() + 0.02;
      aabbs.push({
        minX: bedBox.min.x + baseInset,
        maxX: bedBox.max.x - baseInset,
        minY: bedBox.min.y,
        maxY: mattressY,
        minZ: bedBox.min.z + baseInset,
        maxZ: bedBox.max.z - baseInset,
      });

      // Usually the title menu is still open and the player has not moved. Keep the distance gate so a
      // very fast player who already stepped off the provisional surface is not teleported back when
      // the model finishes decoding.
      if (Math.hypot(controller.position.x - SPAWN.x, controller.position.z - SPAWN.z) < 0.2) {
        controller.warpTo(new Vector3(SPAWN.x, mattressY + 1.7, SPAWN.z), SPAWN.yaw);
      }
    }
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
      // The leaf for the carved opening in the nook's west wall, and the red lock that holds it. Same
      // hinge surgery as the other two doors; what is different is that this one is gated on the red
      // key and carries the plate the player identifies it by. `onOpened` is the reveal's cue.
      armHiddenDoor(root, {
        aabbs,
        player: controller,
        interact,
        state,
        mats: fx,
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
      // The second placement that wants the file's clips: the lid's swing is a baked ease the scene
      // must not re-ease, so Coffin builds its own mixer, holds it shut, and hands back the tick the
      // frame loop calls and the release the puzzle's solve fires.
      coffinLid = armRitualCoffin(root, clips, reportError);
    }
    if (name === 'wardrobe-chateau') {
      const h = armAnimatedFurniture({
        id: 'wardrobe-chateau',
        root,
        clips,
        interact,
        openLabel: 'Open Wardrobe',
        closeLabel: 'Close Wardrobe',
        openToast: 'You open the chateau wardrobe.',
        closeToast: 'You close the wardrobe.',
        toast: (msg) => hud.showToast(msg, 3.0),
        onError: reportError,
      });
      if (h) animatedFurnitures.push(h);
    }
    if (name === 'dresser-bedroom') {
      const h = armAnimatedFurniture({
        id: 'dresser-bedroom',
        root,
        clips,
        interact,
        openLabel: 'Open Drawer',
        closeLabel: 'Close Drawer',
        openToast: 'You slide the dresser drawer open.',
        closeToast: 'You close the drawer.',
        toast: (msg) => hud.showToast(msg, 3.0),
        onError: reportError,
      });
      if (h) animatedFurnitures.push(h);
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
      if (h) animatedFurnitures.push(h);
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
     * Take the red key without walking to it, so the hidden door can be tested end to end.
     *
     * The key lives under a pillow in the black magic room at the far end of the basement, and a door
     * that cannot be opened on demand cannot be checked — the prompt has to be watched changing from
     * "Locked" to "Turn the red key", and that is the whole of what this door does.
     */
    handles.redKey = () => state.collectRedKey();
    handles.open = () => ritualScreen?.open('A screen slides open.');
    /**
     * What the crosshair is actually on, as one pasteable line.
     *
     * A screenshot cannot say what it is a picture of, and "the red square on the door" is not a thing
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
    (window as unknown as { __daayan: unknown }).__daayan = handles;
  }

  let clock = 0;
  const AMB_TOP = ambient.intensity;
  const HEMI_TOP = hemi.intensity;
  /** Engine's baseline grade, so the storey lerp below is relative to it rather than a second source. */
  const EXP_TOP = engine.renderer.toneMappingExposure;

  const update = (dt: number): void => {
    clock += dt;

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
    lantern.intensity = flame;
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
    if (!overlay.isOpen()) ai.update(dt);

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
    ai.dispose();
    interact.clear();
    hiding.dispose();
    hud.dispose();
    overlay.dispose();
    tweens.length = 0;
    models.dispose();
    held.dispose();
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
    dispose,
  };
}

