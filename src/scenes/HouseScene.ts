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
  PointLight,
  Vector3,
  type Scene,
} from 'three';
import type { Engine } from '@/core/Engine';
import type { AABB, FPController, FloorRect } from '@/player/FPController';
import { installHeldLantern } from '@/player/HeldLantern';
import type { TouchControls } from '@/player/TouchControls';
import { Batch } from '@/world/Batch';
import { buildHouse } from '@/world/HouseBuilder';
import { PLACE, buildProps } from '@/world/HouseProps';
import { BASE_Y, WALL_T } from '@/world/HouseLayout';
import {
  ARCH,
  BASEMENT_DOOR,
  BEDROOM_DOOR,
  CELLAR_DOOR,
  GATE,
  LIVING_DOOR,
  RITUAL_DOOR,
  SPAWN,
  UPPER_INNER,
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
import { installModels } from '@/world/ModelProps';
import { armDaayan } from '@/world/DaayanKnife';
import { armUpperDoor } from '@/world/UpperDoor';
import { armInnerDoor } from '@/world/InnerDoor';
import { armRitualDoors } from '@/world/RitualDoors';
import { armRitualCoffin, type CoffinHandles } from '@/world/Coffin';
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
  lantern.position.set(0.25, -0.15, 0.1);
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
    // they are what covers the two paper-thin skin edges the cut leaves. y0 drops a sill's height below
    // the clear opening on purpose: makeCasing draws a sill for any opening that does not start at the
    // floor, and this one starts 2 cm above it, so pulling y0 down by 0.1 lands that sill exactly on the
    // 5 cm of wall the carve left standing and turns it into a threshold instead of a lip.
    { x: UPPER_INNER.x, z: UPPER_INNER.z, axis: 'z' as const, half: UPPER_INNER.half, y0: UPPER_INNER.bottom - 0.1, y1: UPPER_INNER.top, thickness: 0.16 },
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
  // and so could not go through the model-placement hook. HouseProps no longer builds it, and the
  // bedroom's wardrobe pocket is closet-old.glb at (-2.0, 9.75), which Hiding picks up through
  // WARDROBE_NAMES like every other imported hiding spot. Beds join the same way.
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
  /** The screen's per-frame mixer tick, null until it is placed and if its clip did not arrive. */
  let slideScreen: ((dt: number) => void) | null = null;

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
  // The knife goes in on the placement hook rather than here, because it is measured in her bone
  // units and those only mean anything once her fit has written the root scale.
  const models = installModels(modelLoader, scene, engine.camera, aabbs, fx.shadow, reportError, (name, root, clips) => {
    if (name === 'daayan.glb') armDaayan(modelLoader, root, reportError);
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
    // The four bottles and plates. Unconditional: the arm ignores every other placement.
    noiseProps?.onPlaced(name, root);
    // Same reason as the knife: the hinge is placed from the leaf's world box, which only exists once
    // the fit has written the root's scale and position.
    if (name === 'door.glb') {
      armUpperDoor(root, {
        aabbs,
        interact,
        tween,
        toast: (msg) => hud.showToast(msg, 4.0),
        onError: reportError,
      });
    }
    if (name === 'door-inner.glb') {
      armInnerDoor(root, {
        aabbs,
        interact,
        tween,
        toast: (msg) => hud.showToast(msg, 4.0),
        onError: reportError,
      });
    }
    if (name === 'doors-ritual') {
      // The one placement that wants the file's clips: the slide is a baked ease this scene must not
      // re-ease, so RitualDoors builds its own mixer and hands back the tick the frame loop calls.
      slideScreen = armRitualDoors(root, clips, {
        aabbs,
        interact,
        toast: (msg) => hud.showToast(msg, 3.4),
        onError: reportError,
        onOpen: () => {
          ritualOpen = true;
          state.raiseTension('DISTURBING');
        },
      });
    }
    if (name === 'coffin-ritual') {
      // The second placement that wants the file's clips: the lid's swing is a baked ease the scene
      // must not re-ease, so Coffin builds its own mixer, holds it shut, and hands back the tick the
      // frame loop calls and the release the puzzle's solve fires.
      coffinLid = armRitualCoffin(root, clips, reportError);
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

  // --- Frame ---
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
    slideScreen?.(dt);
    // The coffin's lid, for the same reason and with the same cost: parked shut until the sequence is
    // solved, then one 1.2 s swing, then clamped open.
    coffinLid?.tick(dt);

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
    if (overlay.isOpen()) {
      // No prompt behind an open overlay, and no picking either: the tap that closes the note
      // must not also be able to fire whatever the camera happens to be aimed at.
      hud.setPrompt(null);
      touch.setInteractionVerb('interact');
      return;
    }
    hud.setPrompt(interact.update());
    touch.setInteractionVerb(interact.getCurrentVerb());
    // After the overlay return and after the prompt, because this is the other half of the same thing:
    // what the player can touch on purpose, and what they knock over by accident. It reads the
    // controller's position, which main.ts has already advanced for this frame.
    noiseProps?.update(dt);
    if (gateOpen && !ended && engine.camera.position.z < ESCAPE_Z) endGame();
  };

  const dispose = (): void => {
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

