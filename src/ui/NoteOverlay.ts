/**
 * NoteOverlay — diary pages, handwritten notes, books, photographs and damaged diagrams.
 *
 * One overlay covers all of them because they are the same interaction: the player picks a thing
 * up and reads it. What changes is the *typography*, and that carries more than it looks like it
 * should — a diary in a slanted serif and a wiring diagram in a monospace grid read as two
 * different objects found in two different rooms, which is exactly what the brief's
 * environmental-storytelling rule (§8) is asking for.
 *
 * `draw` exists for the one clue that genuinely is not text: the basement's damaged schematic.
 * Painting it on a canvas — with the damage as real missing ink — beats describing it in prose.
 */

import { OverlayLayer, overlayTitle } from './OverlayLayer';
import { localize } from '@/ui/Strings';

export type NoteStyle = 'diary' | 'note' | 'book' | 'photo' | 'diagram';

export interface NoteDoc {
  title: string;
  /** Small line under the title: where it was found, whose hand it is in. */
  sub?: string;
  lines: string[];
  style?: NoteStyle;
  /** Optional figure painted above the text, sized to the card. */
  draw?: (g: CanvasRenderingContext2D, w: number, h: number) => void;
}

const BODY_CSS: Record<NoteStyle, string> = {
  diary: `font: italic 400 15px/1.75 Georgia, "Times New Roman", serif; color: #ddd2bd;`,
  note: `font: italic 400 15px/1.7 Georgia, serif; color: #d8cdb8;`,
  book: `font: 400 14px/1.7 Georgia, serif; color: #cfc9bc;`,
  photo: `font: 400 12px/1.6 ui-monospace, monospace; color: rgba(215,210,200,0.72);`,
  diagram: `font: 400 12px/1.65 ui-monospace, monospace; color: #c9c6bd;`,
};

export function showNote(layer: OverlayLayer, doc: NoteDoc, onClosed?: () => void): void {
  const style: NoteStyle = doc.style ?? 'note';
  layer.show((content) => {
    content.appendChild(
      doc.sub === undefined
        ? overlayTitle(localize(doc.title))
        : overlayTitle(localize(doc.title), localize(doc.sub)),
    );

    if (doc.draw) {
      const w = 460;
      const h = 260;
      const canvas = document.createElement('canvas');
      // Fixed backing size, CSS-scaled: the figure is line art, so a 1x buffer is plenty and it
      // avoids allocating a 2x canvas on a phone for one static drawing.
      canvas.width = w;
      canvas.height = h;
      canvas.style.cssText = 'display: block; width: 100%; height: auto; margin-bottom: 14px; border-radius: 3px;';
      const g = canvas.getContext('2d');
      if (g) doc.draw(g, w, h);
      content.appendChild(canvas);
    }

    const body = document.createElement('div');
    body.style.cssText = BODY_CSS[style];
    for (const line of doc.lines) {
      const p = document.createElement('p');
      p.style.cssText = 'margin: 0 0 0.7em;';
      // An empty string is a deliberate paragraph break in the source text.
      p.textContent = localize(line);
      if (line === '') p.style.height = '0.4em';
      body.appendChild(p);
    }
    content.appendChild(body);

    const hint = document.createElement('div');
    hint.style.cssText = 'margin-top: 10px; font: 400 10px/1.4 ui-monospace, monospace; color: rgba(230,223,210,0.32);';
    hint.textContent = localize('Tap outside to put it back');
    content.appendChild(hint);
  }, onClosed);
}
