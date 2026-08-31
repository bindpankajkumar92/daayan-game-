/**
 * Strings — the game's two languages, and the one function that switches between them.
 *
 * The unusual part is that English *is* the key. `localize('The lid comes up.')` looks that exact
 * sentence up in the Hinglish table and returns the English unchanged if it is not there. Every other
 * scheme was worse for this codebase:
 *
 *  - A key registry (`t('toast.lid')`) means every one of the twenty-odd call sites has to be edited
 *    to add a language, and a key that is missing or misspelled renders as `toast.lid` on the player's
 *    screen. Here a missing entry renders as the English sentence, which is the current behaviour and
 *    is never wrong, only untranslated.
 *  - Translating at the call sites means finding them all. Translating at the *sink* — Hud.setPrompt
 *    and Hud.showToast — means the call sites keep writing plain English prose, which is also what
 *    makes them readable next to the puzzle logic they belong to.
 *
 * So the price of the choice is that changing an English string silently drops its translation. That is
 * the right way round: the English is what ships if anything is out of step.
 *
 * Hinglish here is Hindi written in Roman script, not Devanagari — the way the players who asked for it
 * actually type. It is a real second language for the UI, not a transliteration of the English.
 */

import { getPref, setPref } from '@/core/Prefs';

export type Lang = 'en' | 'hinglish';

/** Menu order, and the label each one shows *in its own language*. Never translated. */
export const LANGS: ReadonlyArray<{ id: Lang; label: string }> = [
  { id: 'en', label: 'ENGLISH' },
  { id: 'hinglish', label: 'HINGLISH' },
];

/**
 * English → Hinglish. Keys must match the source literal exactly, including punctuation.
 *
 * Proper nouns are deliberately absent: the title, "DAAYAN", and the room names read the same in both
 * and an entry for them would be a place for the two to drift apart.
 */
const HINGLISH = new Map<string, string>([
  // --- Menu and settings ---
  ['BEGIN', 'SHURU KARO'],
  ['RESUME', 'WAPAS CHALO'],
  ['SETTINGS', 'SETTINGS'],
  ['BACK', 'PEECHE'],
  ['PAUSED', 'RUKA HUA'],
  ['The house is awake. Get out.', 'Ghar jaag gaya hai. Bahar niklo.'],
  ['LOOK SENSITIVITY', 'DEKHNE KI SPEED'],
  ['LANGUAGE', 'BHASHA'],
  ['SLOW', 'DHEEMA'],
  ['FAST', 'TEZ'],
  ['Drag anywhere to look. Left stick walks.', 'Dekhne ke liye kahin bhi drag karo. Left stick se chalo.'],
  ['Tap PAUSE any time to come back here.', 'Kabhi bhi PAUSE dabao, yahin wapas aa jaoge.'],

  // --- HUD verb ---
  ['INTERACT', 'CHHUO'],

  // --- Toasts ---
  ['You wake on the floor of the hall.', 'Tum hall ke farsh par jaagte ho.'],
  ['Three turns. The gate gives.', 'Teen baar ghumao. Gate khul jayega.'],
  ['The last bolt draws back.', 'Aakhri chatakni khul gayi.'],
  ['The candles go out.', 'Mombattiyan bujh gayin.'],
  ['The front of the plinth drops open.', 'Chabutre ka aage wala hissa khul gaya.'],
  ['The lid comes up.', 'Dhakkan uth gaya.'],
  ['A bolt shifts, further along the wall.', 'Deewar ke aage kahin ek chatakni sarki.'],
  ['Cold air. There is a doorway behind it.', 'Thandi hawa. Peeche ek darwaza hai.'],

  // --- Interaction prompts (Clues.ts) ---
  ['Read the pinned note', 'Chipki hui parchi padho'],
  ['Read the pinned page', 'Chipka hua panna padho'],
  ['Read the note', 'Parchi padho'],
  ['Read the ledger', 'Bahi-khata padho'],
  ['Read the list', 'List padho'],
  ['Read the diary page', 'Diary ka panna padho'],
  ['Read the diagram', 'Naksha padho'],
  ['Look at the photograph', 'Photo dekho'],
  ['Look at the photographs', 'Photos dekho'],
  ['Turn the photograph over', 'Photo ko palto'],
  ['Lean in and read the clock', 'Paas jaakar ghadi padho'],
  ['Look at the marks', 'Nishaan dekho'],
  ['Look at the wall', 'Deewar dekho'],
]);

/**
 * For the strings that are built rather than written — a count spliced into a sentence cannot be a
 * table key. Applied only when the exact-match table misses, so a literal always wins.
 */
const HINGLISH_RULES: ReadonlyArray<readonly [RegExp, string]> = [[/^(\d+) more\.$/, '$1 aur bache.']];

function validate(tag: string | undefined): Lang {
  return LANGS.some((l) => l.id === tag) ? (tag as Lang) : 'en';
}

let current: Lang = validate(getPref('lang'));
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  setPref('lang', lang);
  for (const fn of listeners) fn();
}

/**
 * Re-render whatever is on screen when the language changes. Returns its own unsubscribe, so a UI
 * that is torn down does not leave a closure holding its dead DOM.
 */
export function onLangChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * English in, the active language out. Safe to call every frame — the prompt does.
 */
export function localize(text: string): string {
  if (current === 'en') return text;
  const hit = HINGLISH.get(text);
  if (hit !== undefined) return hit;
  for (const [re, to] of HINGLISH_RULES) {
    if (re.test(text)) return text.replace(re, to);
  }
  return text;
}
