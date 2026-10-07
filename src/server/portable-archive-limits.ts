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
