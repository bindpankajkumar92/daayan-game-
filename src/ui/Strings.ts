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
  ['LOADING...', 'LOAD HO RAHA HAI...'],
  ['SETTINGS', 'SETTINGS'],
  ['BACK', 'PEECHE'],
  ['PAUSED', 'RUKA HUA'],
  ['The house is awake. Get out.', 'Ghar jaag gaya hai. Bahar niklo.'],
  ['The house is waking up...', 'Ghar jaag raha hai...'],
  ['LOOK SENSITIVITY', 'DEKHNE KI SPEED'],
  ['LANGUAGE', 'BHASHA'],
  ['SLOW', 'DHEEMA'],
  ['FAST', 'TEZ'],
  ['Drag anywhere to look. Left stick walks.', 'Dekhne ke liye kahin bhi drag karo. Left stick se chalo.'],
  ['Tap PAUSE any time to come back here.', 'Kabhi bhi PAUSE dabao, yahin wapas aa jaoge.'],

  // --- Touch controls and HUD verbs ---
  ['INTERACT', 'CHHUO'],
  ['HIDE', 'CHHUPO'],
  ['EXIT', 'BAHAR'],
  ['RUN', 'DAUDO'],
  ['CROUCH', 'JHUKO'],
  ['PAUSE', 'ROKO'],
  ['Hide under the bed', 'Bed ke neeche chhupo'],
  ['Hide inside the wardrobe', 'Almirah ke andar chhupo'],
  ['Leave hiding place', 'Chhupne ki jagah se bahar niklo'],

  // --- Toasts ---
  ['You wake on the floor of the hall.', 'Tum hall ke farsh par jaagte ho.'],
  ['You wake on a bed in the dark bedroom.', 'Tum andhere bedroom ke bed par jaagte ho.'],
  ['Three turns. The gate gives.', 'Teen baar ghumao. Gate khul jayega.'],
  ['The last bolt draws back.', 'Aakhri chatakni khul gayi.'],
  ['The candles go out.', 'Mombattiyan bujh gayin.'],
  ['The lid of the coffin swings open.', 'Kafan ka dhakkan khul gaya.'],
  ['The lid comes up.', 'Dhakkan uth gaya.'],
  ['A bolt shifts, further along the wall.', 'Deewar ke aage kahin ek chatakni sarki.'],
  ['Cold air. There is a doorway behind it.', 'Thandi hawa. Peeche ek darwaza hai.'],

  // --- Doors, which can be shut again as well as opened ---
  // Both the flat's front door and the leaf into its corridor are two-way, so each needs both verbs.
  ['Open the door', 'Darwaza kholo'],
  ['Close the door', 'Darwaza band karo'],
  ['Push the door open', 'Darwaza dhakka dekar kholo'],
  ['The door gives, and the flat exhales.', 'Darwaza maan gaya, aur flat ne saans chhodi.'],
  ['You pull the door shut behind you.', 'Tum darwaza apne peeche band kar lete ho.'],
  ['The door swings back, and the rest of the flat opens up.', 'Darwaza peeche khulta hai, aur baaki flat khul jata hai.'],
  ['You swing it shut, and the corridor clears.', 'Tum use band karte ho, aur galli saaf ho jati hai.'],

  // --- The red lock, the hidden room, and what is in it ---
  ['Locked', 'Band hai'],
  ['Turn the red key', 'Laal chaabi ghumao'],
  ['Lift the pillow', 'Takiya uthao'],
  ['Take the red key', 'Laal chaabi lo'],
  ['Under the pillow, flat on the sheet: a red key.', 'Takiye ke neeche, chadar par seedhi padi: ek laal chaabi.'],
  ['You take the red key.', 'Tum laal chaabi utha lete ho.'],
  ['The key turns, and the wall opens where there was no door.', 'Chaabi ghoomti hai, aur jahan darwaza hi nahi tha wahan deewar khul jati hai.'],
  ["Read your father's book", 'Apne baap ki kitaab padho'],
  ['A brass key, under the book.', 'Kitaab ke neeche, ek peetal ki chaabi.'],

  // --- Puzzle overlays ---
  ['Four digits.', 'Chaar ank daalo.'],
  ['The dial does not turn.', 'Dial nahi ghoomta.'],
  ['CLR', 'SAAF'],
  ['ON', 'CHALU'],
  ['OFF', 'BAND'],
  ['PULL MAIN LEVER', 'MAIN LEVER KHINCHO'],
  ['A hard snap, and the breakers fall back.', 'Zor se jhatka lagta hai, aur saare breaker wapas gir jaate hain.'],
  ['Tap outside to put it back', 'Wapas rakhne ke liye bahar tap karo'],
  ['A strongbox', 'Ek mazboot sandook'],
  ['Four figures on a brass dial', 'Peetal ke dial par chaar ank'],
  ['Sub-panel', 'Chhota panel'],
  ['Four breakers, and a main lever', 'Chaar breaker aur ek main lever'],

  // --- Ending ---
  ['Outside', 'Bahar'],
  ['The gate stands open behind you', 'Gate tumhare peeche khula khada hai'],
  ['The cold is real, and the fog is real, and the road is somewhere ahead of you in it.', 'Thand asli hai, dhund asli hai, aur raasta isi mein kahin aage hai.'],
  ['Behind you the house has gone quiet. The twelfth nail is still empty.', 'Tumhare peeche ghar chup ho gaya hai. Baarahvi keel ab bhi khaali hai.'],
  ['Walk', 'CHALO'],

  // --- Being caught ---
  ['She has you', 'Usne tumhe pakad liya'],
  ['Her hand closes on your wrist and the house goes quiet.', 'Uska haath tumhari kalai par bandh ho jata hai aur ghar chup ho jata hai.'],
  ['Try again', 'Phir se koshish karo'],
  ['You wake on the bed, and the house has shifted.', 'Tum bistar par jaagte ho, aur ghar badal chuka hai.'],
  ['The house keeps you', 'Ghar tumhe rakh leta hai'],
  ['There is nothing left to wake into.', 'Ab jaagne ke liye kuch bacha hi nahi.'],
  ['Begin again', 'Naye sire se shuru karo'],

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
