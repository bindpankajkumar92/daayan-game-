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
import type { SymbolKind } from '@/world/Fixtures';

// --- Answers ---------------------------------------------------------------------------------

/** Puzzle 1. Display order on the altar is deliberately different — see ALTAR_DISPLAY. */
export const RITUAL_ORDER: SymbolKind[] = ['eye', 'skull', 'moon', 'cross'];
/** Left-to-right as the player sees them, so the arrangement itself gives nothing away. */
export const ALTAR_DISPLAY: SymbolKind[] = ['moon', 'cross', 'eye', 'skull'];

/** Puzzle 2. The clock in the bedroom shows this, and the diary says the code is that hour. */
export const CLOCK_HOURS = 11;
export const CLOCK_MINUTES = 40;
export const BOX_CODE = `${CLOCK_HOURS}${CLOCK_MINUTES}`;

/** Puzzle 3. A and D are the rows burned off the diagram; the margin note says those stay down. */
export const BREAKER_ANSWER: boolean[] = [false, true, true, false];
export const BREAKER_LABELS = ['A', 'B', 'C', 'D'];

export interface ClueSpec {
  /** Prompt shown when the player is in range and looking at it. */
  prompt: string;
  doc: NoteDoc;
  /** Tension the house is raised to the first time this is read. */
  raises?: Tension;
  /** One-line note shown once, after the first read. */
  firstToast?: string;
}

// --- Figures ---------------------------------------------------------------------------------

/**
 * The damaged sub-panel diagram. Two of the four rows are burned away rather than simply absent:
 * the missing information has to look like it was destroyed, because the margin note's whole
 * meaning depends on the player believing someone burned it on purpose.
 */
export function drawBreakerDiagram(g: CanvasRenderingContext2D, w: number, h: number): void {
  g.fillStyle = '#cfc4a6';
  g.fillRect(0, 0, w, h);
  // Aged paper: a few translucent blotches, no noise loop — this is drawn once per open.
  g.fillStyle = 'rgba(120,96,58,0.14)';
  for (const [bx, by, br] of [
    [70, 40, 60],
    [330, 180, 80],
    [190, 220, 50],
  ] as Array<[number, number, number]>) {
    g.beginPath();
    g.arc(bx, by, br, 0, Math.PI * 2);
    g.fill();
  }

  g.strokeStyle = '#3a3226';
  g.fillStyle = '#3a3226';
  g.lineWidth = 1.5;
  g.font = 'bold 15px ui-monospace, monospace';
  g.fillText('SUB-PANEL — CELLAR', 22, 34);
  g.font = '13px ui-monospace, monospace';
  g.fillText('BREAKER      CIRCUIT              POSITION', 22, 60);
  g.beginPath();
  g.moveTo(22, 68);
  g.lineTo(w - 22, 68);
  g.stroke();

  const rows: Array<[string, string, string, boolean]> = [
    ['A', 'STAIR LAMP', 'UP', true],
    ['B', 'STORE ROOM BOLT', 'UP', false],
    ['C', 'STORE ROOM BOLT', 'UP', false],
    ['D', 'YARD PUMP', 'UP', true],
  ];
  rows.forEach(([id, circuit, pos, burned], i) => {
    const y = 96 + i * 34;
    g.fillStyle = '#3a3226';
    g.font = 'bold 14px ui-monospace, monospace';
    g.fillText(id, 30, y);
    g.font = '13px ui-monospace, monospace';
    if (burned) {
      // Scorched: char the row, then paint over it so nothing of it can be recovered.
      g.fillStyle = 'rgba(30,22,14,0.88)';
      g.beginPath();
      for (let k = 0; k <= 14; k++) {
        const px = 78 + (k / 14) * 250;
        const py = y - 14 + Math.sin(k * 1.9 + i) * 5;
        if (k === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      for (let k = 14; k >= 0; k--) {
        const px = 78 + (k / 14) * 250;
        const py = y + 8 + Math.cos(k * 1.6 + i) * 6;
        g.lineTo(px, py);
      }
      g.closePath();
      g.fill();
      g.fillStyle = 'rgba(90,70,44,0.55)';
      g.fillText('· · · · · · · · ·', 96, y);
    } else {
      g.fillText(circuit, 78, y);
      g.fillText(pos, 330, y);
      g.strokeRect(392, y - 12, 14, 14);
      g.beginPath();
      g.moveTo(394, y - 6);
      g.lineTo(398, y - 1);
      g.lineTo(405, y - 11);
      g.stroke();
    }
  });

  // Margin note, in her hand — a different colour so it is plainly a later addition.
  g.strokeStyle = '#5a2b28';
  g.fillStyle = '#5a2b28';
  g.font = 'italic 14px Georgia, serif';
  g.fillText('the two I burned out', 34, h - 42);
  g.fillText('are the two that stay down', 34, h - 22);
  g.beginPath();
  g.moveTo(30, h - 58);
  g.lineTo(28, h - 10);
  g.stroke();
}

/**
 * The stopped clock, drawn at inspection size.
 *
 * The 3D clock on the wall is the honest version — hands frozen at the same time, visible from
 * across the room. This is what leaning in gives you, and it exists because on a 393-pixel-tall
 * phone screen a 34 cm clock face two metres away is roughly forty pixels across. Making the
 * player squint at it is not observation, it is an eye test, so inspecting draws it properly.
 */
export function drawClockFace(g: CanvasRenderingContext2D, w: number, h: number): void {
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) * 0.42;

  g.fillStyle = '#100f14';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#3a2f22';
  g.beginPath();
  g.arc(cx, cy, R * 1.12, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#d7cdb2';
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.fill();

  g.strokeStyle = '#2a241c';
  g.fillStyle = '#2a241c';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const inner = i % 3 === 0 ? R * 0.8 : R * 0.87;
    g.lineWidth = i % 3 === 0 ? 4 : 2;
    g.beginPath();
    g.moveTo(cx + Math.sin(a) * inner, cy - Math.cos(a) * inner);
    g.lineTo(cx + Math.sin(a) * R * 0.94, cy - Math.cos(a) * R * 0.94);
    g.stroke();
  }
  g.font = `bold ${Math.round(R * 0.2)}px Georgia, serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const [n, i] of [[12, 0], [3, 3], [6, 6], [9, 9]] as Array<[number, number]>) {
    const a = (i / 12) * Math.PI * 2;
    g.fillText(String(n), cx + Math.sin(a) * R * 0.66, cy - Math.cos(a) * R * 0.66);
  }

  const drawHand = (angle: number, len: number, wide: number): void => {
    g.lineWidth = wide;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(cx - Math.sin(angle) * R * 0.1, cy + Math.cos(angle) * R * 0.1);
    g.lineTo(cx + Math.sin(angle) * len, cy - Math.cos(angle) * len);
    g.stroke();
  };
  const minuteAngle = (CLOCK_MINUTES / 60) * Math.PI * 2;
  const hourAngle = ((CLOCK_HOURS % 12) + CLOCK_MINUTES / 60) * (Math.PI / 6);
  drawHand(hourAngle, R * 0.52, 7);
  drawHand(minuteAngle, R * 0.8, 5);
  g.fillStyle = '#6b5a2f';
  g.beginPath();
  g.arc(cx, cy, R * 0.045, 0, Math.PI * 2);
  g.fill();

  // Cracked glass. It is why the clock stopped, and it is the reason nobody wound it again.
  g.strokeStyle = 'rgba(255,255,255,0.3)';
  g.lineWidth = 1;
  for (const [sx, sy, ex, ey] of [
    [-0.7, -0.55, 0.15, 0.1],
    [0.15, 0.1, 0.62, -0.3],
    [0.15, 0.1, 0.3, 0.75],
  ] as Array<[number, number, number, number]>) {
    g.beginPath();
    g.moveTo(cx + sx * R, cy + sy * R);
    g.lineTo(cx + ex * R, cy + ey * R);
    g.stroke();
  }
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
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
      sub: 'Hall, beside the coat pegs',
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
      sub: 'Living room, open on the arm of the chair',
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
      title: 'Photographs on the mantelpiece',
      sub: 'Living room',
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
      sub: 'Living room, weighted down with a cup',
      style: 'note',
      lines: [
        'Flour. Lamp oil, two tins. Nails, the long ones.',
        'Lye. As much as they will sell.',
        'Something for the cellar smell. It is worse in the warm weather and I am tired of opening the window.',
      ],
    },
  },

  'bedroom.diary': {
    prompt: 'Read the diary page',
    raises: 'SUSPICIOUS',
    firstToast: 'The box is set to the hour on the clock.',
    doc: {
      title: 'A diary page',
      sub: 'Bedroom, folded on the table beside the bed',
      style: 'diary',
      lines: [
        'I have stopped the clock. I put my thumb against the minute hand and held it there until it gave, and now the room is quiet in the way I wanted it.',
        'It is the hour he came to the door. I will not have it going round past that hour over and over, as though it were an ordinary afternoon.',
        'The box is his. What is left of it. I set the box to the hour on the clock — four figures — and if I ever forget the number, then the clock is still on the wall to tell me.',
      ],
    },
  },

  'bedroom.clock': {
    prompt: 'Lean in and read the clock',
    doc: {
      title: 'The stopped clock',
      sub: 'Bedroom wall — the glass is cracked',
      style: 'photo',
      draw: drawClockFace,
      lines: [
        'The hands have not moved in a long time. Dust has settled along the top edge of both of them.',
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

  'basement.diagram': {
    prompt: 'Read the diagram',
    firstToast: 'Two rows burned off. Two that stay down.',
    doc: {
      title: 'A damaged wiring diagram',
      sub: 'Basement, nailed up beside the panel',
      style: 'diagram',
      draw: drawBreakerDiagram,
      lines: [
        'Two rows have been burned off the sheet with something held flat against the paper. The char is on the front only, and it has been done carefully enough to take the whole line and nothing above or below it.',
        'The note down the margin is in the same hand as everything else in this house.',
      ],
    },
  },

  'basement.draught': {
    prompt: 'Read the note',
    raises: 'DISTURBING',
    firstToast: 'Behind the jars.',
    doc: {
      title: 'A note weighted under a jar',
      sub: 'Basement, on the workbench',
      style: 'note',
      lines: [
        'The cold comes in behind the jars, not under the door.',
        'I have stopped putting the shelf back exactly. There is no one left in this house to notice the marks on the floor.',
      ],
    },
  },

  'ritual.rite': {
    prompt: 'Read the pinned page',
    raises: 'TERRIFYING',
    firstToast: 'Eye. Bone. Moon. Cross.',
    doc: {
      title: 'The fourth rite',
      sub: 'Pinned to the wall at eye height',
      style: 'book',
      lines: [
        'ORDER OF WAKING. It cannot be hurried and it cannot be taken out of turn.',
        'First the eye is opened, for she must be seen before she can be called.',
        'Then the bone is named, for the one who is given must be named aloud.',
        'Then the moon is shown, for it fixes the hour, and the hour cannot afterwards be moved.',
        'Last the cross is laid down, to close the door behind her.',
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
};
