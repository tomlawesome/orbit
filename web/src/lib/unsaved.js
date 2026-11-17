/**
 * The unsaved-changes registry (#1879 W-S1). A screen holding text the reader
 * has typed registers an isDirty() while it is mounted; the root layout asks
 * `anyUnsaved()` before any navigation leaves it.
 */
const held = /** @type {Set<() => boolean>} */ (new Set());

/**
 * @param {() => boolean} isDirty  read live, so it follows the form
 * @returns {() => void} release; safe to call more than once
 */
export function holdUnsaved(isDirty) {
  const entry = () => isDirty();
  held.add(entry);
  return () => { held.delete(entry); };
}

/** @returns {boolean} true while any held isDirty() is true */
export function anyUnsaved() {
  for (const isDirty of held) if (isDirty()) return true;
  return false;
}
