/**
 * The archive card's small rules (#1002, #1122), kept pure for the unit tests.
 */

import { sizeLabel } from "$lib/format.js";

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
  /* archiveFileBytes follows the current storage limit (maxArchiveFileBytes),
     so an archive over it is over that limit, which can be raised (#1823
     A-F11, owner answer 46a on #1799). */
  if (limits && file.size > limits.archiveFileBytes) {
    return `this file is larger than ${sizeLabel(limits.archiveFileBytes)}, the most the storage limit allows; ask your administrator to raise the storage limit`;
  }
  return null;
}

/** The v2 archive header (#1390, ADR-0045): "ORBITARC", then format version 2. */
const V2_MAGIC = [0x4f, 0x52, 0x42, 0x49, 0x54, 0x41, 0x52, 0x43];
const V2_HEADER_BYTES = 64;
const V2_TAG_BYTES = 16;

/**
 * The part of an archive file a preview needs (#1390). A v2 archive is a
 * 64-byte header, then the manifest's segments, then the documents'; the
 * preview reads only the manifest, so only the header and the segments that
 * carry it are sent: 64 + ceil(M / S) × (S + 16) bytes, read from the
 * header, never more than the file. A v1 archive (it starts with `{`), or a
 * head that is not a v2 header, is sent whole and the server judges it.
 * The import always sends the whole file.
 *
 * @param {Blob} file
 * @returns {Promise<Blob>}
 */
export async function previewSlice(file) {
  if (file.size < V2_HEADER_BYTES) return file;
  const head = new DataView(await file.slice(0, V2_HEADER_BYTES).arrayBuffer());
  for (let index = 0; index < V2_MAGIC.length; index += 1) {
    if (head.getUint8(index) !== V2_MAGIC[index]) return file;
  }
  if (head.getUint8(8) !== 2) return file;
  const segmentBytes = head.getUint32(36);
  const manifestBytes = Number(head.getBigUint64(40));
  if (segmentBytes === 0 || !Number.isSafeInteger(manifestBytes)) return file;
  const wanted = V2_HEADER_BYTES + Math.ceil(manifestBytes / segmentBytes) * (segmentBytes + V2_TAG_BYTES);
  if (!Number.isSafeInteger(wanted) || wanted >= file.size) return file;
  return file.slice(0, wanted);
}

/**
 * The name the export's download carries (#1390): the server's
 * `orbit-export-<id>.orbit`, so the card names the file the person gets.
 * @param {{ id: string }} archive
 */
export function exportFileName(archive) {
  return `orbit-export-${archive.id}.orbit`;
}
