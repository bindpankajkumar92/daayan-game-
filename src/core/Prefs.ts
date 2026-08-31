/**
 * Prefs — the handful of player choices that have to outlive the session.
 *
 * Two values, one key. They are written as a single JSON blob rather than a key each because the
 * failure mode that matters is a *partial* read: a phone that cleared storage between the look
 * sensitivity and the language would come back configured half one way and half another, and one blob
 * either parses or it does not.
 *
 * Every access is wrapped. localStorage is not guaranteed to exist or to succeed — a WebView in a
 * private context throws on `getItem`, and a full quota throws on `setItem` — and a preference is by
 * definition the least important thing in the process. Losing one must never be able to stop the game
 * from starting, so a throw here degrades to "no preference stored" and the caller's default wins.
 *
 * `lang` is typed as a bare string on purpose. The language type belongs to Strings, and Strings has
 * to read this file to restore the choice; typing it properly here would make that import a cycle. So
 * this file stays a leaf, and validating the string back into a language is Strings' job — which it has
 * to do anyway, since the value came off a disk the player could have edited.
 */

const KEY = 'daayan.prefs.v1';

export interface Prefs {
  /** Look sensitivity in radians per CSS pixel. Range is TouchControls.LOOK_MIN..LOOK_MAX. */
  sens: number;
  /** UI language tag. Validated by Strings; see the note above on why this is not `Lang`. */
  lang: string;
}

/**
 * Read once, then serve from memory.
 *
 * Not just to save the parse: `getPref` is called while building the settings panel, which happens
 * on a frame the player is already waiting on, and synchronous localStorage reads on Android can block
 * for milliseconds when the backing store is cold.
 */
let cache: Partial<Prefs> | null = null;

function read(): Partial<Prefs> {
  if (cache !== null) return cache;
  cache = {};
  try {
    const raw = localStorage.getItem(KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      // Anything but an object — including the `null` that `JSON.parse('null')` returns — is treated
      // as nothing stored. Per-field validation is still the caller's, since a hand-edited file can
      // hold a string where a number belongs.
      if (typeof parsed === 'object' && parsed !== null) cache = parsed as Partial<Prefs>;
    }
  } catch {
    // No storage, or unparseable. Defaults it is.
  }
  return cache;
}

export function getPref<K extends keyof Prefs>(key: K): Prefs[K] | undefined {
  const v = read()[key];
  return v;
}

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  const next = { ...read(), [key]: value };
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Written to the cache above regardless, so the choice still holds for this session.
  }
}
