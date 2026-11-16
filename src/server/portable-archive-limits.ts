import { MIN_PASSWORD_LENGTH } from "@/lib/password-length";

/**
 * The portable archive's size caps, in a module of their own so the request
 * pipeline can size the import routes' body limit from them (#1290) without
 * loading the archive repository and the database with it.
 *
 * Format v2 (#1390, ADR-0045) is bounded by the household's document quota,
 * not by memory: `maxArchiveFileBytes`. The `V1_` figures bound the format v1
 * archives Orbit still imports (it no longer writes them), which decrypt into
 * the scratch tmpfs before their single tag can be checked.
 */

/** Plaintext bytes per v2 segment (S in the header). One fixed value this release. */
export const SEGMENT_BYTES = 1_048_576;

/**
 * The largest v2 manifest (M in the header): the metadata of a household,
 * read with the payload reader's budgets (#1607). The reference archive needs
 * about 16 MiB; this is the reader's non-document byte budget.
 */
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

/** The v2 header's length and the GCM tag every segment carries (ADR-0045). */
const V2_HEADER_BYTES = 64;
const V2_TAG_BYTES = 16;

/**
 * The largest v2 archive file: everything a household may store
 * (`householdQuotaBytes`, DOCUMENT_HOUSEHOLD_QUOTA_BYTES) plus the manifest
 * cap, the header and one tag per segment. A function of configuration, read
 * per request, so the card's limit, the import's 413 and what the export can
 * write all agree (#1390).
 */
export function maxArchiveFileBytes(config: { householdQuotaBytes: number }): number {
  const plaintext = config.householdQuotaBytes + MAX_MANIFEST_BYTES;
  return plaintext + V2_HEADER_BYTES + Math.ceil(plaintext / SEGMENT_BYTES) * V2_TAG_BYTES;
}

/**
 * Format v1: the largest archive plaintext Orbit will decrypt. A v1 archive
 * carries one authentication tag over the whole, so it is decrypted into the
 * scratch space (the 320m tmpfs in docker-compose.yml, which is memory)
 * before the tag is verified; the bound is that scratch, sized for one v1
 * archive of this size.
 */
export const V1_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

/**
 * Format v1 carried documents as base64 (4 characters per 3 bytes), so a v1
 * archive held about three quarters of its plaintext in documents, in whole MiB.
 */
export const V1_MAX_ARCHIVE_DOCUMENT_MIB = Math.floor((V1_MAX_ARCHIVE_BYTES * 3) / 4 / (1024 * 1024));

// Base64url has no padding, so this is the exact maximum encoded length for
// a ciphertext that could decode to at most V1_MAX_ARCHIVE_BYTES (AES-256-GCM
// ciphertext is the same length as its plaintext; the auth tag is carried
// separately). Checking this as the ciphertext streams in means an oversized
// v1 archive is refused before it fills the scratch space (#383 finding 3).
export const V1_MAX_ARCHIVE_CIPHERTEXT_CHARACTERS = Math.ceil(V1_MAX_ARCHIVE_BYTES / 3) * 4;

/**
 * The most a v1 archive file can weigh: the longest ciphertext the import
 * accepts, plus the small JSON envelope Orbit wrote around it (version,
 * algorithm, kdf, salt, iv, authTag: well under a KiB). A v1 file over this
 * is refused with 413.
 */
export const V1_MAX_ARCHIVE_FILE_BYTES = V1_MAX_ARCHIVE_CIPHERTEXT_CHARACTERS + 64 * 1024;

/**
 * The archive routes' bounds on a passphrase (#1336). The floor is the one
 * floor every secret Orbit asks for shares (password-length.ts, counted in
 * code points and enforced by the repository); the ceiling is the routes' own.
 */
export const ARCHIVE_PASSPHRASE_MIN = MIN_PASSWORD_LENGTH;
export const ARCHIVE_PASSPHRASE_MAX = 256;

/**
 * How long an unfinished import's start record (`portable_archive_imports`,
 * `finished_at` still null) counts as an import in progress, measured from
 * its last heartbeat (`coalesce(lease_renewed_at, started_at)`, #1390): the
 * import renews it after every document it restores. Within it the household
 * is closed to everyone but the importer (#1316, owner 2026-10-14); past it
 * the row is a crash, not an import, and the next import into that
 * household, or the document worker's sweep, rolls it back. One figure for
 * every judgement, so the gate and the sweeps never disagree.
 */
export const PORTABLE_IMPORT_LEASE_MS = 60 * 60 * 1_000;
