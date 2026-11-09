/**
 * A document's stored content hash (#1771). The lowercase hex SHA-256 of the
 * plaintext is sealed under the household metadata key in
 * `documents.content_sha256_sealed`, column key `documents.content_sha256`,
 * bound to the row id (ADR-0024). A row stored before #1771 still has the
 * plaintext in `documents.content_sha256` until the maintenance backfill
 * reaches it, so readers take the sealed value first and fall back to the
 * plain one.
 *
 * A sealed value that will not open -- damaged, moved from another row or
 * household, or under a locked key -- answers no hash at all, never a guess:
 * every caller treats that as "cannot verify", so it is never a match.
 */
import type { MetadataCipher, MetadataFieldState } from "@/server/metadata/fields";

export const CONTENT_HASH_COLUMN = "documents.content_sha256" as const;

export interface StoredContentHash {
  /** `documents.content_sha256`: set only on a row the backfill has not reached. */
  plain: string | null;
  /** `documents.content_sha256_sealed`. */
  sealed: string | null;
}

export type OpenedContentHash =
  | { ok: true; sha256: string }
  | { ok: false; reason: MetadataFieldState | "content_hash_missing" };

/** The `content_sha256_sealed` value for a row. Throws `MetadataKeyLockedError` on a locked cipher. */
export function sealContentHash(cipher: MetadataCipher, documentId: string, sha256Hex: string): string {
  const sealed = cipher.encryptText(CONTENT_HASH_COLUMN, documentId, sha256Hex);
  if (!sealed) throw new Error("an empty content hash cannot be sealed");
  return sealed;
}

/**
 * The row's content hash: the sealed value when there is one, else the plain
 * one. The cipher is the row's own household's; `cipher` is only consulted
 * for a sealed value, so it may be omitted for a legacy row.
 */
export function openContentHash(
  cipher: MetadataCipher | undefined,
  documentId: string,
  stored: StoredContentHash,
): OpenedContentHash {
  if (stored.sealed !== null) {
    if (!cipher) return { ok: false, reason: "metadata_locked" };
    const opened = cipher.text(CONTENT_HASH_COLUMN, documentId, { encrypted: stored.sealed });
    if (opened.value === null) return { ok: false, reason: opened.state ?? "metadata_integrity_failed" };
    return { ok: true, sha256: opened.value };
  }
  if (stored.plain !== null) return { ok: true, sha256: stored.plain };
  return { ok: false, reason: "content_hash_missing" };
}
