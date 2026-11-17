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

/** @returns {boolean} true while any held isDirty() is true */
export function anyUnsaved() {
  for (const entry of held) if (entry.isDirty()) return true;
  return false;
}

/** @returns {(() => Promise<boolean>) | undefined} the first dirty holder's own ask; undefined when none is dirty or it has none */
export function unsavedAsker() {
  for (const entry of held) if (entry.isDirty()) return entry.ask;
  return undefined;
}
