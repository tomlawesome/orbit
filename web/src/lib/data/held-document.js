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
