/**
 * A file the home drawer's drop box was given, waiting for /create to take
 * it (#1243). The quick add is only a doorway: the full form reads, previews
 * and attaches the document, so the box hands the file across instead of
 * growing a second reader.
 *
 * Memory only. It survives the client-side navigation from /home to /create
 * and nothing else, and taking it empties it, so a later visit to /create
 * never finds an old file waiting.
 */

/** @type {File | null} */
let held = null;

/** @param {File} file */
export function holdDocument(file) {
  held = file;
}

/** The held file, once; null when nothing is waiting. */
export function takeHeldDocument() {
  const file = held;
  held = null;
  return file;
}

/**
 * A kind (service, renewal, inspection) the drawer's type button was pressed
 * for, waiting for /create to choose it (#1467). Same hand-over as the file:
 * memory only, taken once, so a later plain visit to /create starts with no
 * kind chosen. "Something else" holds nothing.
 *
 * @type {string | null}
 */
let heldType = null;

/** @param {string | null} type the chip's `data-type`; null clears what was held */
export function holdType(type) {
  heldType = type;
}

/** The held kind, once; null when nothing is waiting. */
export function takeHeldType() {
  const type = heldType;
  heldType = null;
  return type;
}
