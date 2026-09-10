/**
 * The one place encrypted metadata columns are read and written (ADR-0024
 * decisions 3 and 5), for Tier 1 (#931) and Tier 2 (#963) alike. Repositories
 * call these accessors instead of touching `notes`, `reference`, `title`,
 * `provider`, `cost_minor`, `proposal`, `field_evidence` or the invitation
 * address directly, so the dual-read window, the blind index and the
 * damaged-value behaviour each have exactly one definition.
 *
 * Dual read, for the length of the expand release: a row whose `*_enc` column
 * is non-null is decrypted, and a row the backfill has not reached yet is read
 * from its plaintext column. Every write encrypts and clears the plaintext in
 * the same statement, so a row never sits in both states.
 */
import { getDb } from "@/db";
import { AppError } from "@/lib/app-error";
import { log, operationalDetail } from "@/lib/logger";
import {
  computeBlindIndex,
  decryptMetadataValue,
  encryptMetadataValue,
  MetadataIntegrityError,
  type MetadataColumn,
} from "@/server/metadata/crypto";
import { noteMetadataDamage, noteMetadataReadable } from "@/server/metadata/damage-sightings";
import {
  loadMetadataKey,
  metadataCryptoAvailable,
  MetadataKeyLockedError,
  receiptKeyScope,
  resolveMetadataKey,
  type MetadataExecutor,
  type MetadataKeyMaterial,
} from "@/server/metadata/keys";

export type { MetadataExecutor } from "@/server/metadata/keys";

/**
 * Why a value is not being shown. `metadata_integrity_failed` is a specific
 * damaged value; `metadata_locked` is the whole instance missing its KEK,
 * which is reversible and must not be mistaken for damage.
 */
export type MetadataFieldState = "metadata_integrity_failed" | "metadata_locked";

export interface MetadataTextResult {
  value: string | null;
  state?: MetadataFieldState;
}

export interface MetadataJsonResult {
  value: Record<string, unknown>;
  state?: MetadataFieldState;
}

export interface StoredText {
  encrypted: string | null;
  plaintext: string | null;
}

export interface StoredJson {
  encrypted: string | null;
  plaintext: unknown;
}

export interface StoredNumber {
  encrypted: string | null;
  plaintext: number | null;
}

export interface MetadataNumberResult {
  value: number | null;
  state?: MetadataFieldState;
}

function recordDamage(column: MetadataColumn, rowId: string): void {
  // Two records, deliberately: the log line is the per-occurrence diagnostic
  // ADR-0024 decision 5 requires, and the sighting is what lets an
  // administrator be told how many there are (#941). Neither carries the
  // value, the ciphertext or any key material.
  noteMetadataDamage(column, rowId);
  log.warn({
    event: "metadata.integrity",
    state: "degraded",
    reason: "metadata_integrity_failed",
    impact: "metadata_field_unreadable",
    action: "inspect_admin_diagnostics",
    detail: operationalDetail`${column} row ${rowId} failed authentication`,
  });
}

/**
 * One scope's key, held for the length of a request. A cipher with no key
 * material is locked: it reads every field as `metadata_locked` and refuses
 * every write, rather than returning an empty value or fabricating one.
 */
export class MetadataCipher {
  constructor(private readonly material: MetadataKeyMaterial | undefined) {}

  get locked(): boolean {
    return this.material === undefined;
  }

  private requireKey(): MetadataKeyMaterial {
    if (!this.material) throw new MetadataKeyLockedError();
    return this.material;
  }

  /** Decrypts an encrypted text column, falling back to plaintext for a row the backfill has not reached. */
  text(column: MetadataColumn, rowId: string, stored: StoredText): MetadataTextResult {
    if (stored.encrypted === null) {
      // No ciphertext at all: this row is still pre-encryption, and its
      // plaintext is readable whether or not the instance holds a KEK.
      return { value: stored.plaintext };
    }
    if (!this.material) return { value: null, state: "metadata_locked" };
    try {
      const value = decryptMetadataValue(stored.encrypted, this.material.dataKey, { column, rowId });
      noteMetadataReadable(column, rowId);
      return { value };
    } catch (error) {
      if (!(error instanceof MetadataIntegrityError)) throw error;
      recordDamage(column, rowId);
      return { value: null, state: "metadata_integrity_failed" };
    }
  }

  /** As `text`, for the JSONB columns: the object is serialised whole and encrypted as one envelope. */
  json(column: MetadataColumn, rowId: string, stored: StoredJson): MetadataJsonResult {
    if (stored.encrypted === null) return { value: asRecord(stored.plaintext) };
    if (!this.material) return { value: {}, state: "metadata_locked" };
    let decrypted: string;
    try {
      decrypted = decryptMetadataValue(stored.encrypted, this.material.dataKey, { column, rowId });
    } catch (error) {
      if (!(error instanceof MetadataIntegrityError)) throw error;
      recordDamage(column, rowId);
      return { value: {}, state: "metadata_integrity_failed" };
    }
    try {
      const value = asRecord(JSON.parse(decrypted));
      noteMetadataReadable(column, rowId);
      return { value };
    } catch {
      // Authenticated bytes that are not JSON cannot come from this writer.
      recordDamage(column, rowId);
      return { value: {}, state: "metadata_integrity_failed" };
    }
  }

  /** Produces the `*_enc` value for a text column. A null or empty value stays null. */
  encryptText(column: MetadataColumn, rowId: string, value: string | null | undefined): string | null {
    const key = this.requireKey();
    if (value === null || value === undefined || value === "") return null;
    return encryptMetadataValue(value, key.dataKey, { column, rowId });
  }

  /**
   * Produces the `*_enc` value for a JSONB column. The value is serialised
   * exactly as it was found rather than normalised through `asRecord` first:
   * the writer that uses this — the backfill — clears the plaintext column in
   * the same statement, so normalising here would silently discard anything
   * that was not already an object. Reads normalise instead, where it costs
   * nothing.
   */
  encryptJson(column: MetadataColumn, rowId: string, value: unknown): string {
    const key = this.requireKey();
    return encryptMetadataValue(JSON.stringify(value ?? {}), key.dataKey, { column, rowId });
  }

  /**
   * As `text`, for the one numeric Tier 2 column. The value is rendered as its
   * decimal integer and encrypted like any other string; the database no
   * longer holds a number it could sum, which is the point — totals are
   * summed application-side over decrypted values (#365, owner 2026-08-13).
   *
   * A decrypted value that is not a safe non-negative integer is damage, not a
   * cost: it is reported as such rather than coerced to NaN or to zero, either
   * of which would be a fabricated figure in a money field.
   */
  number(column: MetadataColumn, rowId: string, stored: StoredNumber): MetadataNumberResult {
    if (stored.encrypted === null) return { value: stored.plaintext };
    if (!this.material) return { value: null, state: "metadata_locked" };
    let decrypted: string;
    try {
      decrypted = decryptMetadataValue(stored.encrypted, this.material.dataKey, { column, rowId });
    } catch (error) {
      if (!(error instanceof MetadataIntegrityError)) throw error;
      recordDamage(column, rowId);
      return { value: null, state: "metadata_integrity_failed" };
    }
    const parsed = Number(decrypted);
    if (!/^\d+$/.test(decrypted) || !Number.isSafeInteger(parsed)) {
      recordDamage(column, rowId);
      return { value: null, state: "metadata_integrity_failed" };
    }
    noteMetadataReadable(column, rowId);
    return { value: parsed };
  }

  /** Produces the `*_enc` value for a numeric column. A null or undefined value stays null. */
  encryptNumber(column: MetadataColumn, rowId: string, value: number | null | undefined): string | null {
    const key = this.requireKey();
    if (value === null || value === undefined) return null;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${column} must be a non-negative safe integer`);
    return encryptMetadataValue(String(value), key.dataKey, { column, rowId });
  }

  /**
   * The blind index for a column that needs exact-match lookup (ADR-0024
   * decision 2), or null when there is nothing to index. Only two columns do:
   * `items.reference`, and `household_invitations.email`, whose database rule
   * "one open invitation per address" would otherwise be lost with the
   * plaintext. Nothing else is indexed, deliberately — an index that serves no
   * query leaks equality for nothing.
   */
  blindIndex(column: MetadataColumn, value: string | null | undefined): string | null {
    const key = this.requireKey();
    return computeBlindIndex(value, key.dataKey, column) ?? null;
  }

  /** `blindIndex` for `items.reference`, kept for the Tier 1 callers that read best that way. */
  referenceIndex(value: string | null | undefined): string | null {
    return this.blindIndex("items.reference", value);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * A cipher for writing: mints the scope key on first use, and throws
 * `MetadataKeyLockedError` when the instance has no usable KEK. Callers turn
 * that into a refused write.
 */
export async function openMetadataWriter(
  householdId: string,
  executor: MetadataExecutor = getDb(),
): Promise<MetadataCipher> {
  return new MetadataCipher(await resolveMetadataKey("household", householdId, executor));
}

/** As `openMetadataWriter`, for a mail-in receipt whose household may not be known yet. */
export async function openReceiptMetadataWriter(
  householdId: string | null,
  executor: MetadataExecutor = getDb(),
): Promise<MetadataCipher> {
  const scope = receiptKeyScope(householdId);
  return new MetadataCipher(await resolveMetadataKey(scope.scope, scope.householdId, executor));
}

/**
 * The refusal every encrypted-metadata writer gives when the instance has no usable KEK
 * (ADR-0024 decision 5). It matches what document operations already do: the
 * application stays usable and only the encrypted surface locks.
 *
 * "the encryption key", not "the document key": the owner ruled on 2026-09-10
 * that one key gets one name wherever a person reads it, because two names for
 * the same thing read as two different faults.
 */
export function metadataLockedError(): AppError {
  return new AppError("metadata_locked", "Encrypted details cannot be saved until the encryption key is available", 503);
}

/** `openMetadataWriter`, with a locked instance surfaced as a refused write. */
export async function requireMetadataWriter(
  householdId: string,
  executor: MetadataExecutor = getDb(),
): Promise<MetadataCipher> {
  try {
    return await openMetadataWriter(householdId, executor);
  } catch (error) {
    if (error instanceof MetadataKeyLockedError) throw metadataLockedError();
    throw error;
  }
}

/** `openReceiptMetadataWriter`, with a locked instance surfaced as a refused write. */
export async function requireReceiptMetadataWriter(
  householdId: string | null,
  executor: MetadataExecutor = getDb(),
): Promise<MetadataCipher> {
  try {
    return await openReceiptMetadataWriter(householdId, executor);
  } catch (error) {
    if (error instanceof MetadataKeyLockedError) throw metadataLockedError();
    throw error;
  }
}

/**
 * A cipher for reading. Never throws for want of a key: an instance with no
 * KEK, or a household whose key has not been minted yet, yields a locked
 * cipher, and rows still holding plaintext read normally through it.
 */
export async function openMetadataReader(
  householdId: string | null,
  executor: MetadataExecutor = getDb(),
): Promise<MetadataCipher> {
  if (!metadataCryptoAvailable()) return new MetadataCipher(undefined);
  const scope = receiptKeyScope(householdId);
  try {
    return new MetadataCipher(await loadMetadataKey(scope.scope, scope.householdId, executor));
  } catch (error) {
    if (error instanceof MetadataKeyLockedError) return new MetadataCipher(undefined);
    throw error;
  }
}

/**
 * Readers keyed by scope for a page of mail-in receipts, whose `household_id`
 * is nullable: an unattributed receipt reads under the instance key. One
 * unwrap per distinct scope, not one per receipt.
 */
export async function openReceiptMetadataReaders(
  householdIds: Array<string | null>,
  executor: MetadataExecutor = getDb(),
): Promise<Map<string | null, MetadataCipher>> {
  const readers = new Map<string | null, MetadataCipher>();
  for (const householdId of new Set(householdIds)) {
    readers.set(householdId, await openMetadataReader(householdId, executor));
  }
  return readers;
}

/**
 * Readers for several households in one query, for `readWorkspace`, which
 * shows every household the member belongs to. One unwrap per household, not
 * one per row.
 */
export async function openMetadataReaders(
  householdIds: string[],
  executor: MetadataExecutor = getDb(),
): Promise<Map<string, MetadataCipher>> {
  const readers = new Map<string, MetadataCipher>();
  for (const householdId of new Set(householdIds)) {
    readers.set(householdId, await openMetadataReader(householdId, executor));
  }
  return readers;
}
