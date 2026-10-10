import { MIN_PASSWORD_LENGTH } from "@/lib/password-length";

/**
 * The portable archive's size caps, in a module of their own so the request
 * pipeline can size the import routes' body limit from them (#1290) without
 * loading the archive repository and the database with it.
 */

/** The largest archive Orbit writes, and the largest plaintext it will decrypt. */
export const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;

// Base64url has no padding, so this is the exact maximum encoded length for
// a ciphertext that could decode to at most MAX_ARCHIVE_BYTES (AES-256-GCM
// ciphertext is the same length as its plaintext; the auth tag is carried
// separately). Checking this before any crypto work means an oversized
// archive is rejected before scryptSync or the cipher ever runs, instead of
// only after `decryptPortableArchive` has already materialised the full
// plaintext into memory (#383 finding 3).
export const MAX_ARCHIVE_CIPHERTEXT_CHARACTERS = Math.ceil(MAX_ARCHIVE_BYTES / 3) * 4;

/**
 * The most an archive file can weigh: the longest ciphertext the import
 * accepts, plus the small JSON envelope Orbit writes around it (version,
 * algorithm, kdf, salt, iv, authTag: well under a KiB). The browser's
 * pre-read ceiling comes from here (#1336), so a file Orbit wrote is never
 * refused by the card that is about to send it. Kept under the import
 * route's whole body limit (ARCHIVE_BODY_LIMIT in web/src/lib/server/body-limit.js).
 */
export const MAX_ARCHIVE_FILE_BYTES = MAX_ARCHIVE_CIPHERTEXT_CHARACTERS + 64 * 1024;

/**
 * The archive routes' bounds on a passphrase (#1336). The floor is the one
 * floor every secret Orbit asks for shares (password-length.ts, counted in
 * code points and enforced by the repository); the ceiling is the routes' own.
 */
export const ARCHIVE_PASSPHRASE_MIN = MIN_PASSWORD_LENGTH;
export const ARCHIVE_PASSPHRASE_MAX = 256;
