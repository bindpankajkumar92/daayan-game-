# Mission flow (gameplay after the intro cutscene)

| # | Step | Where | Code |
|---|------|-------|------|
| 1 | Open the dresser drawer: father's note (left) + mother's photo (right) | Bedroom (spawn room), `dresser-bedroom` | `bedroom.father-note`, `bedroom.mother-photo` in `Clues.ts` |
| 2 | Open the big almirah, read the coordinates scrap | Living room, `wardrobe-chateau` | `living.coords-note` |
| 3 | Stand at X 27 Y 2 Z -9 (HUD readout, spawn = 0 0 0) and crack the hidden door | Upper floor nook | `HIDDEN_DOOR_COORDS`, `HiddenDoor.ts` `canCrack` |
| 4 | Open the hidden-room wardrobe: diary + Father's Key (mother's skeleton already there) | Hidden room | `hidden.book`, `handOff` |
| 5 | Read the diary (who you are, why she wants you, mother, what to do) | | `hidden.book` |
| 6 | Enter code 2709 on the digital lock beside the basement paper screen, slide it | Basement | `SCREEN_CODE`, `basement.screen-lock`, `RitualDoors.canOpen` |
| 7 | Open the coffin, take the Coffin Key | Ritual room | `coffin.lid`, `coffin.key` |
| 8 | Throw the lantern, coffin burns | | `coffin.burn`, `CoffinBurn.ts` |
| 9 | Phone flashlight (cold steady light), go to the main door, turn the 3 locks | Main hall | `finishBurn`, `gate.lock0..2` |
| 10 | Gate opens, step onto the porch = end (escape cutscene to be made later) | | `endGame` |

## Open items
- **Second key**: not designed yet. `SECOND_KEY_PENDING` in `HouseScene.ts` lets the middle lock be forced until then.
- **Phone flashlight animation**: currently only the light changes colour/flicker; no hand/phone model.
- **Ending cutscene** (bike escape, lady on the road): `endGame()` is the hook.
- Hinglish translations for the new notes/diary are not in `Strings.ts` yet (English shows).
- Removed: altar symbols, bedroom clock/strongbox, breaker panel, red key under the pillow.
