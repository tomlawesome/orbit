import { MIN_PASSWORD_LENGTH } from "@/lib/password-length";

/**
 * The portable archive's size caps, in a module of their own so the request
 * pipeline can size the import routes' body limit from them (#1290) without
 * loading the archive repository and the database with it.
 */

/**
 * The largest archive plaintext: the most Orbit encrypts on export, and the
 * most it will decrypt on import. The whole archive is held as one JavaScript
 * string, and V8's longest string is about 512M characters, which caps the
 * plaintext near 380 MiB; 256 MiB leaves room below that.
 */
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

/**
 * Documents travel in the plaintext as base64 (4 characters per 3 bytes), so
 * a document-inclusive export holds about three quarters of the limit in
 * documents. The figure the export's refusal names, in whole MiB.
 */
export const MAX_ARCHIVE_DOCUMENT_MIB = Math.floor((MAX_ARCHIVE_BYTES * 3) / 4 / (1024 * 1024));

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

/**
 * How long an unfinished import's start record (`portable_archive_imports`,
 * `finished_at` still null) counts as an import in progress. Within it the
 * household is closed to everyone but the importer (#1316, owner
 * 2026-10-14); past it the row is a crash mid-restore, not an import, and the
 * next import into that household rolls it back first. One figure for both
 * judgements, so the gate and the stale sweep never disagree.
 */
export const PORTABLE_IMPORT_LEASE_MS = 60 * 60 * 1_000;
