/**
 * The archive card's small rules (#1002, #1122), kept pure for the unit tests.
 */

/** The largest archive the card will read, checked before anything is sent (#1002 round 1). */
export const ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;

/** The route's own bounds on a passphrase (portable-archives/+server.js). */
export const PASSPHRASE_MIN = 12;
export const PASSPHRASE_MAX = 256;

/**
 * Why the export's passphrase pair cannot be used yet, or null when it can.
 * @param {string} passphrase
 * @param {string} again
 * @returns {string | null}
 */
export function passphraseProblem(passphrase, again) {
  if (passphrase.length < PASSPHRASE_MIN) return `at least ${PASSPHRASE_MIN} characters`;
  if (passphrase.length > PASSPHRASE_MAX) return `at most ${PASSPHRASE_MAX} characters`;
  if (passphrase !== again) return "the two passphrases are not the same yet";
  return null;
}

/**
 * Why a chosen file cannot be an archive, judged before it is read.
 * @param {{ size: number }} file
 * @returns {string | null}
 */
export function archiveFileProblem(file) {
  if (file.size === 0) return "this file is empty";
  if (file.size > ARCHIVE_MAX_BYTES) return `this file is larger than ${sizeLabel(ARCHIVE_MAX_BYTES)}, the most an archive can be`;
  return null;
}

/**
 * "84 KB" / "3.2 MB" / "128 MB".
 * @param {number} bytes
 */
export function sizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1).replace(/\.0$/, "") : Math.round(mb)} MB`;
}
