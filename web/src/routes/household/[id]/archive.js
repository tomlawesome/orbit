/**
 * The archive card's small rules (#1002, #1122), kept pure for the unit tests.
 */

/**
 * The archive card's numbers are the engine's, carried on the session
 * (#1336): the file ceiling, which exists only to avoid reading a huge file
 * the server would refuse anyway, and the passphrase bounds.
 * @typedef {import("$lib/data/engine-limits.js").EngineLimits} EngineLimits
 */

/**
 * How long a passphrase is to the engine's floor: NFC-normalised, one code
 * point each, the way the person counts it and the engine counts it
 * (src/lib/password-length.ts). The ceiling is the route's own and counts
 * UTF-16 units, so it keeps `.length`.
 * @param {string} passphrase
 */
export function passphraseLength(passphrase) {
  return [...passphrase.normalize("NFC")].length;
}

/**
 * The passphrase length the card waits for before a button wakes. Without the
 * engine's number nothing can be sent, so the gate stays shut.
 * @param {EngineLimits | null | undefined} limits
 */
export function passphraseFloor(limits) {
  return limits?.passphraseMin ?? Number.POSITIVE_INFINITY;
}

/**
 * Why the export's passphrase pair cannot be used yet, or null when it can.
 * @param {string} passphrase
 * @param {string} again
 * @param {EngineLimits | null | undefined} limits
 * @returns {string | null}
 */
export function passphraseProblem(passphrase, again, limits) {
  if (!limits) return "orbit has not said how long a passphrase may be yet — reload the page";
  if (passphraseLength(passphrase) < limits.passphraseMin) return `at least ${limits.passphraseMin} characters`;
  if (passphrase.length > limits.passphraseMax) return `at most ${limits.passphraseMax} characters`;
  if (passphrase !== again) return "the two passphrases are not the same yet";
  return null;
}

/**
 * Why a chosen file cannot be an archive, judged before it is read. The size
 * check is the engine's ceiling when the session gave one; the server still
 * refuses an oversized body whatever this says.
 * @param {{ size: number }} file
 * @param {EngineLimits | null | undefined} limits
 * @returns {string | null}
 */
export function archiveFileProblem(file, limits) {
  if (file.size === 0) return "this file is empty";
  if (limits && file.size > limits.archiveFileBytes) {
    return `this file is larger than ${sizeLabel(limits.archiveFileBytes)}, the most an archive can be`;
  }
  return null;
}

/**
 * "84 KB" / "3.2 MB" / "171 MB".
 * @param {number} bytes
 */
export function sizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1).replace(/\.0$/, "") : Math.round(mb)} MB`;
}
