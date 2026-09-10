/**
 * Metadata crypto (ADR-0024 decisions 1-3): pure functions only, no
 * database access, so the primitives can be tested without a connection.
 *
 * Like `src/server/mail-in/core/secret-crypto.ts`, this module adds AAD
 * builders and calls the generic AES-256-GCM primitives exported by
 * `src/server/documents/crypto.ts`. ADR-0017's one-construction rule forbids
 * introducing a second cipher here, so nothing below reaches for `node:crypto`
 * except for the random DEK, and the HKDF/HMAC used by the blind index.
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import {
  decryptWithAad,
  encryptWithAad,
  ENVELOPE_KEY_BYTES,
  ENVELOPE_VERSION,
  unwrapKeyWithAad,
  wrapKeyWithAad,
  type WrappedKey,
} from "@/server/documents/crypto";

/** The compact envelope prefix stored in every `*_enc` column. */
export const METADATA_ENVELOPE_PREFIX = "mdv1";

/** Which key protects a value: one DEK per household, plus one instance DEK for unattributed mail-in receipts. */
export type MetadataKeyScope = "household" | "instance";

/**
 * The tables and columns encrypted metadata covers — Tier 1 (#931) and Tier 2
 * (#963) together, because they share one key hierarchy, one envelope and one
 * rewrap path. Bound into the content AAD, so a value cannot be replayed into
 * another row or another column.
 */
export type MetadataColumn =
  | "items.notes"
  | "items.reference"
  | "items.title"
  | "items.provider"
  | "items.cost_minor"
  | "imap_ingestion_messages.proposal"
  | "imap_ingestion_messages.field_evidence"
  | "household_invitations.email";

/** Identifies exactly one value: which column, and which row of it. */
export interface MetadataValueContext {
  column: MetadataColumn;
  rowId: string;
}

export interface MetadataKeyContext {
  scope: MetadataKeyScope;
  householdId: string | null;
  keyId: string;
}

/**
 * Thrown when a stored value will not authenticate. Callers translate this to
 * the `metadata_integrity_failed` marker (ADR-0024 decision 5); it never
 * carries plaintext, key material or the ciphertext itself.
 */
export class MetadataIntegrityError extends Error {
  readonly column: MetadataColumn;
  readonly rowId: string;

  constructor(context: MetadataValueContext) {
    super("Encrypted metadata failed its integrity check");
    this.name = "MetadataIntegrityError";
    this.column = context.column;
    this.rowId = context.rowId;
  }
}

function keyAdditionalData(context: MetadataKeyContext): Buffer {
  return Buffer.from(JSON.stringify({
    purpose: "orbit-metadata-dek",
    envelopeVersion: ENVELOPE_VERSION,
    scope: context.scope,
    householdId: context.householdId,
    keyId: context.keyId,
  }), "utf8");
}

/**
 * Binds ciphertext to its row and column, so moving a note onto another item —
 * or into `reference` — fails authentication. Household id is deliberately
 * absent (ADR-0024 decision 3): it is nullable and mutable on receipts, and
 * household binding already comes from which DEK encrypted the value.
 */
function contentAdditionalData(context: MetadataValueContext): Buffer {
  const [table, column] = splitColumn(context.column);
  return Buffer.from(JSON.stringify({
    purpose: "orbit-metadata-value",
    envelopeVersion: ENVELOPE_VERSION,
    table,
    column,
    rowId: context.rowId,
  }), "utf8");
}

function splitColumn(column: MetadataColumn): [string, string] {
  const separator = column.indexOf(".");
  return [column.slice(0, separator), column.slice(separator + 1)];
}

/** Mints a fresh 32-byte metadata DEK and wraps it under the instance KEK. */
export function createWrappedMetadataKey(
  keyEncryptionKey: Buffer,
  context: MetadataKeyContext,
): { wrapped: WrappedKey; dataKey: Buffer } {
  const dataKey = randomBytes(ENVELOPE_KEY_BYTES);
  return { wrapped: wrapKeyWithAad(dataKey, keyEncryptionKey, keyAdditionalData(context)), dataKey };
}

/** Reverses `createWrappedMetadataKey`; throws unless scope, household and key id all match what wrapped it. */
export function unwrapMetadataKey(
  wrapped: WrappedKey,
  keyEncryptionKey: Buffer,
  context: MetadataKeyContext,
): Buffer {
  return unwrapKeyWithAad(wrapped, keyEncryptionKey, keyAdditionalData(context));
}

/**
 * Rewraps a metadata DEK under a new KEK without touching any value or index
 * (ADR-0024 decision 4). The rewrap worker is #932; this is the primitive it
 * will call, kept here so the key-wrap AAD has exactly one definition.
 */
export function rewrapMetadataKey(
  wrapped: WrappedKey,
  currentKeyEncryptionKey: Buffer,
  nextKeyEncryptionKey: Buffer,
  context: MetadataKeyContext,
  nextKeyId: string,
): WrappedKey {
  const dataKey = unwrapMetadataKey(wrapped, currentKeyEncryptionKey, context);
  try {
    return wrapKeyWithAad(dataKey, nextKeyEncryptionKey, keyAdditionalData({ ...context, keyId: nextKeyId }));
  } finally {
    dataKey.fill(0);
  }
}

/** Produces `mdv1.<iv>.<authTag>.<ciphertext>` with base64url segments. */
export function encryptMetadataValue(plaintext: string, dataKey: Buffer, context: MetadataValueContext): string {
  const encrypted = encryptWithAad(Buffer.from(plaintext, "utf8"), dataKey, contentAdditionalData(context));
  return [
    METADATA_ENVELOPE_PREFIX,
    encrypted.contentIv,
    encrypted.contentAuthTag,
    encrypted.ciphertext.toString("base64url"),
  ].join(".");
}

/** True when a column value is a Tier 1 envelope rather than something else. */
export function isMetadataEnvelope(value: string): boolean {
  return value.startsWith(`${METADATA_ENVELOPE_PREFIX}.`);
}

/**
 * Authenticates and decrypts one stored envelope. Every failure — malformed
 * envelope, wrong version, wrong key, tampered ciphertext, or a value moved to
 * another row or column — raises `MetadataIntegrityError` rather than
 * returning anything.
 */
export function decryptMetadataValue(stored: string, dataKey: Buffer, context: MetadataValueContext): string {
  const segments = stored.split(".");
  if (segments.length !== 4 || segments[0] !== METADATA_ENVELOPE_PREFIX) throw new MetadataIntegrityError(context);
  try {
    const plaintext = decryptWithAad(
      Buffer.from(segments[3], "base64url"),
      { contentIv: segments[1], contentAuthTag: segments[2] },
      dataKey,
      contentAdditionalData(context),
    );
    return plaintext.toString("utf8");
  } catch {
    throw new MetadataIntegrityError(context);
  }
}

/**
 * The one canonical comparison form for encrypted metadata text (ADR-0024
 * decision 2),
 * promoted from `comparableText` in `mail-in/core/review-state.ts`: NFKC,
 * control characters to spaces, whitespace collapsed, trimmed, lowercased.
 * Punctuation is kept deliberately — stripping it would merge references that
 * differ today, which is a product change this has no mandate for.
 *
 * Control characters are scanned explicitly rather than matched by a
 * hand-written regular-expression range: losing an escape in such a range
 * silently widens it to ordinary characters (AGENTS.md, "Traps when running
 * things locally").
 */
export function normalizeComparableMetadata(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let scanned = "";
  for (const character of value.normalize("NFKC")) {
    scanned += isControlCharacter(character) ? " " : character;
  }
  const normalized = scanned.replace(/\s+/g, " ").trim().toLocaleLowerCase("en-GB");
  return normalized || undefined;
}

function isControlCharacter(character: string): boolean {
  const code = character.codePointAt(0);
  if (code === undefined) return false;
  if (code < 0x20) return true;
  if (code === 0x7f) return true;
  if (code >= 0x80 && code <= 0x9f) return true;
  return code === 0x2028 || code === 0x2029;
}

/**
 * Derives the per-scope blind-index key from the scope DEK. The key is never
 * stored: holding the DEK yields it, losing the DEK loses it, and a KEK rewrap
 * leaves every index valid because it leaves the DEK unchanged.
 */
export function deriveBlindIndexKey(dataKey: Buffer, column: MetadataColumn): Buffer {
  return Buffer.from(hkdfSync(
    "sha256",
    dataKey,
    Buffer.alloc(0),
    Buffer.from(`orbit-blind-index-v1:${column}`, "utf8"),
    ENVELOPE_KEY_BYTES,
  ));
}

/**
 * base64url of HMAC-SHA-256 over the normalised value. Returns undefined when
 * the value normalises to nothing, so an empty reference is stored as a NULL
 * index and never collides with another empty one.
 */
export function computeBlindIndex(value: unknown, dataKey: Buffer, column: MetadataColumn): string | undefined {
  const normalized = normalizeComparableMetadata(value);
  if (normalized === undefined) return undefined;
  const indexKey = deriveBlindIndexKey(dataKey, column);
  try {
    return createHmac("sha256", indexKey).update(normalized, "utf8").digest("base64url");
  } finally {
    indexKey.fill(0);
  }
}

/** Constant-time comparison of two blind-index digests. */
export function blindIndexEquals(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  const leftBytes = Buffer.from(left, "base64url");
  const rightBytes = Buffer.from(right, "base64url");
  if (leftBytes.length !== rightBytes.length || leftBytes.length === 0) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}
