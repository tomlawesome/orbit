/**
 * Tier 1 metadata key resolution (ADR-0024 decision 1): one wrapped DEK per
 * household, plus one instance-scope DEK for mail-in receipts that have no
 * household yet, both wrapped under the existing `DOCUMENT_KEK`. Reading picks
 * by the row's own key id against every key the instance holds — during a
 * rotation that is `DOCUMENT_KEK` and `DOCUMENT_KEK_NEXT` (#954, ADR-0024
 * decision 4) — while minting a scope key always wraps under the current key.
 *
 * Unwrapped DEKs are cached in process. ADR-0024 permits this explicitly: the
 * KEK itself already lives in process memory, so the cache adds nothing to
 * what a live host compromise already yields, and it keeps a household read to
 * one unwrap per request rather than one per row.
 */
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { metadataKeys } from "@/db/schema";
import { ENVELOPE_VERSION, type WrappedKey } from "@/server/documents/crypto";
import { getDocumentConfig, keyEncryptionKeyFor, type DocumentConfig } from "@/server/documents/config";
import {
  createWrappedMetadataKey,
  unwrapMetadataKey,
  type MetadataKeyScope,
} from "@/server/metadata/crypto";

type Database = ReturnType<typeof getDb>;
export type MetadataExecutor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * The KEK is absent, or a stored DEK will not unwrap under it. ADR-0024
 * decision 5 keeps this distinct from a damaged value: the application stays
 * usable, Tier 1 fields read as locked rather than damaged, and writes to them
 * are refused, exactly as document operations lock today.
 */
export class MetadataKeyLockedError extends Error {
  constructor() {
    super("Tier 1 metadata is locked");
    this.name = "MetadataKeyLockedError";
  }
}

export interface MetadataKeyMaterial {
  scope: MetadataKeyScope;
  householdId: string | null;
  keyId: string;
  dataKey: Buffer;
}

const unwrappedKeys = new Map<string, Buffer>();

function cacheKey(keyId: string, scope: MetadataKeyScope, householdId: string | null): string {
  return `${keyId} ${scope} ${householdId ?? ""}`;
}

/** Test-only: the cache outlives a `resetDocumentConfigForTests` otherwise. */
export function resetMetadataKeyCacheForTests(): void {
  for (const key of unwrappedKeys.values()) key.fill(0);
  unwrappedKeys.clear();
}

function readDocumentConfig(): DocumentConfig | undefined {
  try {
    return getDocumentConfig();
  } catch {
    return undefined;
  }
}

/** True when the instance holds a usable KEK. Callers use it to choose locked-not-damaged. */
export function metadataCryptoAvailable(): boolean {
  return readDocumentConfig() !== undefined;
}

function scopeCondition(scope: MetadataKeyScope, householdId: string | null) {
  return scope === "instance"
    ? and(eq(metadataKeys.scope, "instance"), isNull(metadataKeys.householdId))
    : and(eq(metadataKeys.scope, "household"), eq(metadataKeys.householdId, householdId ?? ""));
}

function unwrapRow(
  row: WrappedKey & { keyId: string },
  scope: MetadataKeyScope,
  householdId: string | null,
  config: DocumentConfig,
): MetadataKeyMaterial {
  const cached = unwrappedKeys.get(cacheKey(row.keyId, scope, householdId));
  if (cached) return { scope, householdId, keyId: row.keyId, dataKey: cached };
  // The row's own `key_id` picks which held key unwraps it (#954, ADR-0024
  // decision 4): a row the rewrap worker has not reached yet is still
  // wrapped under the current key id, and one it has already moved is
  // wrapped under the next key id — both are held for the duration of a
  // rotation, so either is readable with no restart between them.
  const keyEncryptionKey = keyEncryptionKeyFor(config, row.keyId);
  if (!keyEncryptionKey) throw new MetadataKeyLockedError();
  let dataKey: Buffer;
  try {
    dataKey = unwrapMetadataKey(row, keyEncryptionKey, { scope, householdId, keyId: row.keyId });
  } catch {
    // A DEK that will not unwrap means the wrong KEK, not a damaged value:
    // locking is reversible when the right key comes back, and never
    // overwrites anything.
    throw new MetadataKeyLockedError();
  }
  unwrappedKeys.set(cacheKey(row.keyId, scope, householdId), dataKey);
  return { scope, householdId, keyId: row.keyId, dataKey };
}

/** Reads an existing scope key. Returns undefined when none has been minted yet. */
export async function loadMetadataKey(
  scope: MetadataKeyScope,
  householdId: string | null,
  executor: MetadataExecutor = getDb(),
): Promise<MetadataKeyMaterial | undefined> {
  const config = readDocumentConfig();
  if (!config) throw new MetadataKeyLockedError();
  const [row] = await executor.select({
    wrappedDek: metadataKeys.wrappedDek,
    wrapIv: metadataKeys.wrapIv,
    wrapAuthTag: metadataKeys.wrapAuthTag,
    keyId: metadataKeys.keyId,
  }).from(metadataKeys).where(scopeCondition(scope, householdId)).limit(1);
  return row ? unwrapRow(row, scope, householdId, config) : undefined;
}

/**
 * Reads the scope key, minting and storing it on first use. Two callers racing
 * to create the same scope key is ordinary: the unique indexes decide, the
 * loser discards its candidate and reads the winner's row.
 */
export async function resolveMetadataKey(
  scope: MetadataKeyScope,
  householdId: string | null,
  executor: MetadataExecutor = getDb(),
): Promise<MetadataKeyMaterial> {
  const existing = await loadMetadataKey(scope, householdId, executor);
  if (existing) return existing;

  const config = readDocumentConfig();
  if (!config) throw new MetadataKeyLockedError();
  // A freshly minted key always wraps under the current key — never the
  // rotation-in-progress next one — so exactly one key is ever the wrapping
  // key for new writes.
  const context = { scope, householdId, keyId: config.keyId };
  const minted = createWrappedMetadataKey(config.keyEncryptionKey, context);
  try {
    await executor.insert(metadataKeys).values({
      scope,
      householdId,
      envelopeVersion: ENVELOPE_VERSION,
      keyId: config.keyId,
      ...minted.wrapped,
    }).onConflictDoNothing();
  } finally {
    minted.dataKey.fill(0);
  }
  const stored = await loadMetadataKey(scope, householdId, executor);
  if (!stored) throw new MetadataKeyLockedError();
  return stored;
}

/** The scope a mail-in receipt's Tier 1 values belong to, given its nullable household. */
export function receiptKeyScope(householdId: string | null): { scope: MetadataKeyScope; householdId: string | null } {
  return householdId ? { scope: "household" as const, householdId } : { scope: "instance" as const, householdId: null };
}
