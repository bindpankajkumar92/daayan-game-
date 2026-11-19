/**
 * Clues — every readable object in the house, and the two puzzle answers they encode.
 *
 * All the writing lives in one file so the story can be read straight through and checked for
 * consistency: the ledger in the living room, the diary in the bedroom and the rite in the cellar
 * are one document split across three rooms, and the only way to keep them agreeing is to keep
 * them adjacent in the source.
 *
 * The three answers are declared here too, next to the clues that give them away. If a puzzle's
 * solution is ever changed and its clue is not, the mistake is visible in one screen of code —
 * which is the whole defence against the brief's hardest rule (§9): the player must be able to
 * *derive* every answer, never guess it.
 */

import type { Tension } from './GameState';
import type { NoteDoc } from '@/ui/NoteOverlay';

// --- Answers ---------------------------------------------------------------------------------

/**
 * Where the hidden door can be cracked, in the HUD's coordinates: metres from the spot the player
 * wakes on (0 0 0), y counted from the floor under the feet. The almirah note gives exactly these
 * numbers. x may be off by one either way (the nook is narrow on z but long on x); y and z must match.
 */
export const HIDDEN_DOOR_COORDS = { x: 27, y: 2, z: -9 } as const;

/** The basement screen's digital lock. Written on the last page of the father's diary. */
export const SCREEN_CODE = '2709';

export interface ClueSpec {
  /** Prompt shown when the player is in range and looking at it. */
  prompt: string;
  doc: NoteDoc;
  /** Tension the house is raised to the first time this is read. */
  raises?: Tension;
  /** One-line note shown once, after the first read. */
  firstToast?: string;
}

// --- The writing -----------------------------------------------------------------------------

export const CLUES: Record<string, ClueSpec> = {
  'hall.notice': {
    prompt: 'Read the pinned note',
    raises: 'SUSPICIOUS',
    firstToast: 'Three turns. Nothing less.',
    doc: {
      title: 'A note pinned beside the gate',
      sub: 'Pressed flat with a thumbtack',
      style: 'note',
      lines: [
        'Do not open this for him.',
        'He will stand there very politely and say that he only wants to go home. They all say it in the same voice, and I have stopped being able to tell them apart.',
        'Three turns. Nothing less.',
      ],
    },
  },

  'hall.photo': {
    prompt: 'Look at the photograph',
    raises: 'SUSPICIOUS',
    doc: {
      title: 'A framed photograph',
      sub: 'Hall, hung alone on the wall',
      style: 'photo',
      lines: [
        'Six people on the front steps of this house, squinting into a low sun. The frame is polished. The glass has been wiped recently, and often.',
        'The woman on the left is holding the door open. She is not squinting.',
        'The face at the far right has been worked away with something sharp, down through the paper to the card behind. Only the shoulders and a good coat are left.',
      ],
    },
  },

  'living.ledger': {
    prompt: 'Read the ledger',
    raises: 'SUSPICIOUS',
    doc: {
      title: 'A household ledger',
      sub: 'Living room, open on the side table',
      style: 'book',
      lines: [
        'Columns ruled by hand: NAME. ROOM. ARRIVED. SETTLED.',
        'Eleven entries. Every one has a name, a room, and a date of arrival in careful copperplate.',
        'The SETTLED column is filled in for all eleven. It does not contain dates. It contains the word yes.',
      ],
    },
  },

  'living.mantel': {
    prompt: 'Look at the photographs',
    raises: 'DISTURBING',
    firstToast: 'The frames are decades apart.',
    doc: {
      title: 'Photographs on the wall',
      sub: 'Living room, four frames in a row',
      style: 'photo',
      lines: [
        'Four photographs in four frames, and the frames are the only way to date them: pressed tin, then painted wood, then cheap steel, then plastic.',
        'The same woman stands in all four. In the tin frame she is standing beside a horse.',
        'She has not changed. Not aged badly, not aged well. The photographs have aged. She has not.',
      ],
    },
  },

  'living.list': {
    prompt: 'Read the list',
    raises: 'SUSPICIOUS',
    doc: {
      title: 'A shopping list',
      sub: 'Living room, pinned beside the window',
      style: 'note',
      lines: [
        'Flour. Lamp oil, two tins. Nails, the long ones.',
        'Lye. As much as they will sell.',
        'Something for the cellar smell. It is worse in the warm weather and I am tired of opening the window.',
      ],
    },
  },

  'bedroom.photo': {
    prompt: 'Turn the photograph over',
    raises: 'DISTURBING',
    doc: {
      title: 'A photograph, face down on the sill',
      sub: 'Bedroom window',
      style: 'photo',
      lines: [
        'A man in a good coat standing in the hall of this house with his case still in his hand. He is looking at the camera the way people do when they have just been asked to stand still.',
        'It is the coat from the photograph in the hall. Here the face is not damaged.',
      ],
    },
  },

  'basement.tally': {
    prompt: 'Look at the marks',
    raises: 'DISTURBING',
    doc: {
      title: 'Marks scratched into the plaster',
      sub: 'Basement, beside the foot of the stair',
      style: 'note',
      lines: [
        'Groups of five, cut deep, at the height of someone sitting on the floor with their back against the wall.',
        'Ten groups. Then one mark on its own, fresher than the rest, the plaster dust still lying in the groove.',
      ],
    },
  },

  'ritual.records': {
    prompt: 'Look at the wall',
    raises: 'TERRIFYING',
    firstToast: 'The twelfth column is you.',
    doc: {
      title: 'Her records',
      sub: 'The whole of the far wall',
      style: 'photo',
      lines: [
        'Photographs pinned up in eleven columns. Under each column a name in copperplate, and under the name a room in this house.',
        'The eleventh column is a man in a good coat. Under him: Bedroom.',
        'A twelfth column has been started at the end of the wall. One nail, no photograph on it yet, and underneath, already written: Hall.',
      ],
    },
  },

  // --- The mission chain (docs/mission-flow.md) ---------------------------------------------------
  // Short, plain sentences on purpose: the player should be able to read each of these in a few
  // seconds on a phone. The two drawer items and the almirah note only offer a prompt while their
  // furniture is open; see CLUE_CONTAINER in HouseScene.

  /** Step 1a. The dresser drawer in the room the player wakes in, left section. */
  'bedroom.father-note': {
    prompt: "Read your father's note",
    raises: 'SUSPICIOUS',
    firstToast: 'Start with the big almirah on this floor.',
    doc: {
      title: "A note in your father's hand",
      sub: 'Folded small, at the back of the drawer',
      style: 'note',
      lines: [
        'If you are reading this, the prediction of that saint was right, and you have really reached here.',
        'Try to find my diary.',
        'Be safe from that woman.',
        'I left you the way to it in the big almirah on this floor.',
      ],
    },
  },

  /** Step 1b. Same drawer, right section. Sets up the mother before the diary explains her. */
  'bedroom.mother-photo': {
    prompt: 'Look at the photograph',
    doc: {
      title: 'An old photograph',
      sub: 'In the other half of the drawer',
      style: 'photo',
      lines: [
        'A young woman laughing, holding a small boy up to the camera. The boy has your eyes.',
        'On the back, in faded ink: "My son, my whole world. — Maa"',
      ],
    },
  },

  /** Step 2. Inside the chateau almirah in the living room. Gives the hidden door's coordinates. */
  'living.coords-note': {
    prompt: 'Read the scrap of paper',
    raises: 'SUSPICIOUS',
    firstToast: `Go to X ${HIDDEN_DOOR_COORDS.x}, Y ${HIDDEN_DOOR_COORDS.y}, Z ${HIDDEN_DOOR_COORDS.z}.`,
    doc: {
      title: 'A scrap of paper',
      sub: 'Tucked into the almirah door',
      style: 'note',
      lines: [
        `X ${HIDDEN_DOOR_COORDS.x}    Y ${HIDDEN_DOOR_COORDS.y}    Z ${HIDDEN_DOOR_COORDS.z}`,
        'Count from where you woke up. Stand on this spot and the wall will open for you.',
        'Upstairs, past the door she never uses.',
      ],
    },
  },

  /**
   * Steps 4-6. The father's diary, in the hidden-room wardrobe, beside the first gate key and the
   * mother's remains. Answers the four questions in order (who you are, why she wants you, what
   * happened to your mother, what to do), and the last page carries the screen's code.
   */
  'hidden.book': {
    prompt: "Read your father's diary",
    raises: 'TERRIFYING',
    firstToast: 'Her son is in the coffin behind the basement screen.',
    doc: {
      title: "Father's Diary",
      sub: 'The hidden room, inside the wardrobe',
      style: 'diary',
      lines: [
        'WHO YOU ARE. You are my son. The woman in this house is your stepmother. I married her after your mother was gone, and I did not know what she was.',
        'WHY SHE WANTS YOU. Her own son died years ago. She is trying to bring him back. Her ritual needs a bali: the death of a male of this family. That is you.',
        'YOUR MOTHER. She did not die of fever, as I told you. She saw the ritual and tried to run away with you. That woman caught her on the stairs. Your mother held on to you until the end. I could not bury her. She is here, beside this diary.',
        'WHAT YOU MUST DO. The boy’s coffin is behind the paper screen in the basement. Open it. The last key of the main door lies with his bones. Then burn the coffin with your lantern, so his soul can rest and her ritual dies with him.',
        'Then take all three keys to the main door and run. Do not stop.',
        'The first key is here with this diary.',
        `LAST PAGE. The lock on the screen: ${SCREEN_CODE}. The day your mother died.`,
      ],
    },
  },
};
