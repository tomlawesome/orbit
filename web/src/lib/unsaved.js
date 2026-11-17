/**
 * The unsaved-changes registry (#1879 W-S1). A screen holding text the reader
 * has typed registers an isDirty() while it is mounted; the root layout asks
 * `anyUnsaved()` before any navigation leaves it.
 */
const held = /** @type {Set<{ isDirty: () => boolean, ask?: () => Promise<boolean> }>} */ (new Set());

/**
 * @param {() => boolean} isDirty  read live, so it follows the form
 * @param {{ ask?: () => Promise<boolean> }} [options]  the holder's own discard question, when it has one (the phone's callout); resolves true to leave
 * @returns {() => void} release; safe to call more than once
 */
export function holdUnsaved(isDirty, options = {}) {
  const entry = { isDirty: () => isDirty(), ask: options.ask };
  held.add(entry);
  return () => { held.delete(entry); };
}

/** True once the page has agreed to be thrown away by a reload (#1879 review). */
let leaving = false;

/**
 * The page is about to unload on purpose, after the reader said yes: until the
 * returned undo runs, every holder reads clean, so no second prompt follows.
 * @returns {() => void}
 */
export function markLeaving() {
  leaving = true;
  return () => { leaving = false; };
}

/** Puts the page under guard again, as when it is restored from the back-forward cache. */
export function resetLeaving() {
  leaving = false;
}

/** @returns {boolean} true while any held isDirty() is true */
export function anyUnsaved() {
  if (leaving) return false;
  for (const entry of held) if (entry.isDirty()) return true;
  return false;
}

/** @returns {(() => Promise<boolean>) | undefined} the first dirty holder's own ask; undefined when none is dirty or it has none */
export function unsavedAsker() {
  if (leaving) return undefined;
  for (const entry of held) if (entry.isDirty()) return entry.ask;
  return undefined;
}
