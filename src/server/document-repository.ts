import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, notInArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLog,
  documentCrypto,
  documentJobs,
  documentStagingObjects,
  documents,
  items,
} from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { asOperationalReason, log } from "@/lib/logger";
import { createDocumentSealer, createDocumentUnsealer, DocumentIntegrityError, envelopeOf } from "@/server/documents/crypto";
import { getDocumentConfig, keyEncryptionKeyFor, wrappingKey } from "@/server/documents/config";
import { readEffectiveUploadLimit } from "@/server/upload-limit";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { type LocalDocumentStorage, openDocumentStorage, type ReceivedDocument, releaseBuffer } from "@/server/documents/storage";
import {
  detectDocumentMediaType,
  normalizedDocumentFilename,
  classifyDocumentStructure,
  type DocumentStructureVerdict,
  type SupportedDocumentMediaType,
} from "@/server/documents/validation";
import { canAccessHouseholdDocuments, canManageDocumentDeletion } from "@/server/documents/authorization";
import { scannerRecoveryDelayMs } from "@/server/documents/staging";
import { classifyScan, documentScanCodes, type ScanClassification } from "@/server/documents/scan-outcome";
import { validUuid } from "@/lib/uuid";
import { findHouseholdAccess } from "@/server/workspace-access";
import { metadataLockedError, openMetadataReader, openMetadataWriter, type MetadataCipher } from "@/server/metadata/fields";
import { openContentHash, sealContentHash, type StoredContentHash } from "@/server/documents/content-hash";
import { MetadataKeyLockedError } from "@/server/metadata/keys";
import { enqueuePreviewJob, enqueuePreviewJobIfIncomplete, notifyPreviewWorker } from "@/server/document-maintenance/preview-queue";

/**
 * Lifecycles a user may see listed against an item.
 *
 * `deleted` is deliberately absent: a purged document must stay invisible, so
 * this list must never become a way to observe removed content.
 */
export const listableDocumentLifecycles = [
  "receiving",
  "validating",
  "quarantined",
  "scanning",
  "encrypting",
  "available",
  "pending_deletion",
  "rejected",
] as const;

export type ListableDocumentLifecycle = typeof listableDocumentLifecycles[number];

export type DocumentContentOperation = "summary" | "download" | "restore";

/**
 * The single content-readiness boundary for document operations.
 *
 * A genuinely `clean` scan is always ready. `skipped` is ready only when the
 * runtime scan mode is explicitly `disabled`; any other or unknown scan mode
 * value must not authorize a `skipped` scan status. The operation also
 * supplies its own lifecycle boundary: content reads require `available`,
 * while restore is only valid during retention.
 */
export function isDocumentContentReady(
  record: { lifecycle: string; scanStatus: string },
  scanMode: string,
  operation: DocumentContentOperation,
): boolean {
  const scanReady = record.scanStatus === "clean"
    || (record.scanStatus === "skipped" && scanMode === "disabled");
  if (!scanReady) return false;

  switch (operation) {
    case "summary":
      return record.lifecycle === "available" || record.lifecycle === "pending_deletion";
    case "download":
      return record.lifecycle === "available";
    case "restore":
      return record.lifecycle === "pending_deletion";
    default:
      return false;
  }
}

export interface DocumentSummary {
  id: string;
  itemId: string | null;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  lifecycle: ListableDocumentLifecycle;
  scanStatus: string;
  availableAt: string | null;
  deleteAfter: string | null;
  /** Whether the document's content can be downloaded yet. */
  ready: boolean;
  /** Bounded failure reason for a rejected document; never provider text. */
  failureCode: string | null;
  /** Whether an outage-staged scan can be retried without re-upload. */
  recoverable: boolean;
  recoveryExpiresAt: string | null;
  recoveryStatus: "retrying" | "manual" | null;
  /**
   * #1437: the household already holds a byte-identical file. Present only on
   * an upload's first successful store (null when nothing matches); absent on
   * a replay and on every other read of a document.
   */
  alreadyHeld?: AlreadyHeld | null;
  /** Pages, from the structure check (#1436): 1 for an image; null until known for a document from before it. */
  pageCount: number | null;
}

/**
 * The earliest available, item-bound document in the household whose bytes
 * equal the one just received (#1437). `entry` is null only when its item went
 * between the lookup and the title read.
 */
export interface AlreadyHeld {
  documentId: string;
  displayName: string;
  addedAt: string;
  entry: { itemId: string; title: string } | null;
}

const unavailableDocumentConditions = ["deleted", "rejected"] as const;

async function requireHouseholdAndItemAccess(
  userId: string,
  householdId: string,
  itemId: string,
): Promise<void> {
  // A malformed id fails the way an unknown one does, not as a driver error.
  if (!validUuid(householdId) || !validUuid(itemId)) {
    throw new AppError("item_not_found", "That item is not available", 404);
  }
  const access = await findHouseholdAccess(userId, householdId);
  const [item] = access
    ? await getDb().select({ id: items.id }).from(items)
      .where(and(eq(items.id, itemId), eq(items.householdId, householdId))).limit(1)
    : [];
  if (!access || !item || !canAccessHouseholdDocuments(access.administrator, access.role ? userId : null)) {
    throw new AppError("item_not_found", "That item is not available", 404);
  }
}

/**
 * The stage route's check (#1316): a household member who may hold documents,
 * with no item yet. Refused the same way as an unknown household.
 */
async function requireHouseholdDocumentAccess(userId: string, householdId: string): Promise<void> {
  const access = validUuid(householdId) ? await findHouseholdAccess(userId, householdId) : undefined;
  if (!access || !canAccessHouseholdDocuments(access.administrator, access.role ? userId : null)) {
    throw new AppError("household_not_found", "That household is not available", 404);
  }
}

/**
 * The item id a document's ciphertext opens under. A staged upload is sealed
 * under its draft item id before that item exists, so the row keeps it beside
 * the envelope; rows from before that column read under `item_id` as always.
 */
export function sealedItemIdOf(row: { sealedItemId: string | null; itemId: string | null }): string | null {
  return row.sealedItemId ?? row.itemId;
}

/**
 * How long a staged upload waits to be bound before the storage sweep retires
 * it: at least a day, and never less than scanner recovery keeps the row
 * recoverable, so a document recovery publishes is still there to bind.
 */
function stagedUploadHoldMs(config: { scanRecoveryRetentionHours: number }): number {
  return Math.max(24, config.scanRecoveryRetentionHours) * 60 * 60 * 1_000;
}

async function requireDocumentAccess(userId: string, documentId: string) {
  // A malformed id must fail the same way an unknown-but-well-formed one
  // does: postgres.js runs with prepare: false, so an invalid uuid literal
  // reaches PostgreSQL as text and raises a driver error the route handler
  // cannot classify, surfacing as a 500 instead of the intended 404 (#383).
  if (!validUuid(documentId)) {
    throw new AppError("document_not_found", "That document is not available", 404);
  }
  const [record] = await getDb()
    .select({
      id: documents.id,
      householdId: documents.householdId,
      itemId: documents.itemId,
      sealedItemId: documents.sealedItemId,
      displayName: documents.displayName,
      mediaType: documents.mediaType,
      sizeBytes: documents.sizeBytes,
      lifecycle: documents.lifecycle,
      scanStatus: documents.scanStatus,
      deleteAfter: documents.deleteAfter,
      availableAt: documents.availableAt,
      uploadedByUserId: documents.uploadedByUserId,
      pageCount: documents.pageCount,
    })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  const access = record ? await findHouseholdAccess(userId, record.householdId) : undefined;
  if (
    !record
    || !access
    || !canAccessHouseholdDocuments(access.administrator, access.role ? userId : null)
    || unavailableDocumentConditions.includes(record.lifecycle as typeof unavailableDocumentConditions[number])
  ) {
    throw new AppError("document_not_found", "That document is not available", 404);
  }
  return { ...record, administrator: access.administrator, membershipRole: access.role };
}

/**
 * Queueing a deletion or undoing one is narrower than the household-wide read
 * access `requireDocumentAccess` grants: only the household owner or the
 * member who uploaded the document may do it (#1151 A3-S1). Any other
 * member can see the document but must not be able to purge or restore
 * someone else's upload.
 */
export async function requireDocumentDeletionAccess(userId: string, documentId: string) {
  const record = await requireDocumentAccess(userId, documentId);
  const isUploader = record.uploadedByUserId !== null && record.uploadedByUserId === userId;
  if (!canManageDocumentDeletion(record.administrator, record.membershipRole, isUploader)) {
    throw new AppError(
      "document_deletion_forbidden",
      "Only the household owner or the member who uploaded this document can do that",
      403,
    );
  }
  return record;
}

/** Exported for tests: the visibility boundary is the security-relevant part. */
export function toSummary(record: {
  id: string;
  itemId: string | null;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  lifecycle: string;
  scanStatus: string;
  availableAt: Date | null;
  deleteAfter: Date | null;
  failureCode?: string | null;
  recoverable?: boolean;
  recoveryExpiresAt?: Date | null;
  recoveryStatus?: "retrying" | "manual" | null;
  alreadyHeld?: AlreadyHeld | null;
  pageCount?: number | null;
}, scanMode: string): DocumentSummary {
  // A purged document must never reach a user-visible list, so an unexpected
  // lifecycle fails loudly rather than being rendered.
  if (!(listableDocumentLifecycles as readonly string[]).includes(record.lifecycle)) {
    throw new Error("Document is not in a user-visible state");
  }
  return {
    id: record.id,
    itemId: record.itemId,
    displayName: record.displayName,
    mediaType: record.mediaType,
    sizeBytes: record.sizeBytes,
    lifecycle: record.lifecycle as ListableDocumentLifecycle,
    scanStatus: record.scanStatus,
    availableAt: record.availableAt?.toISOString() ?? null,
    deleteAfter: record.deleteAfter?.toISOString() ?? null,
    ready: isDocumentContentReady(record, scanMode, "summary"),
    failureCode: record.failureCode ?? null,
    recoverable: record.recoverable ?? false,
    recoveryExpiresAt: record.recoveryExpiresAt?.toISOString() ?? null,
    recoveryStatus: record.recoveryStatus ?? null,
    ...(record.alreadyHeld !== undefined ? { alreadyHeld: record.alreadyHeld } : {}),
    pageCount: record.pageCount ?? null,
  };
}

/**
 * A new row's content hash, sealed under the household key (#1771), and its
 * blind index (#1437), from one writer, with the plain column left NULL.
 * With the household key locked the upload still goes ahead, as it did
 * before #1771: the row keeps the plain hash with no seal and no index, the
 * maintenance backfill seals it once the key opens, and until then duplicate
 * detection simply finds no match for it.
 */
async function sealedDocumentContentHash(
  householdId: string,
  documentId: string,
  contentSha256: string,
): Promise<{ contentSha256: string | null; contentSha256Sealed: string | null; contentIndex: string | null }> {
  try {
    const cipher = await openMetadataWriter(householdId);
    return {
      contentSha256: null,
      contentSha256Sealed: sealContentHash(cipher, documentId, contentSha256),
      contentIndex: cipher.contentIndex(contentSha256),
    };
  } catch (error) {
    if (error instanceof MetadataKeyLockedError) return { contentSha256, contentSha256Sealed: null, contentIndex: null };
    throw error;
  }
}

/**
 * Whether a stored row's content hash is `contentSha256`: the sealed value
 * when there is one, the plain one on a row the backfill has not reached
 * (#1771). A sealed value that will not open is never a match: a damaged or
 * moved one is a conflict, and a locked key a refusal to be retried.
 * `householdId` is the row's own household, already checked by the caller.
 */
async function storedContentHashIs(
  householdId: string,
  documentId: string,
  stored: StoredContentHash,
  contentSha256: string,
): Promise<boolean> {
  const opened = openContentHash(stored.sealed === null ? undefined : await openMetadataReader(householdId), documentId, stored);
  if (opened.ok) return opened.sha256 === contentSha256;
  if (opened.reason === "metadata_locked") throw metadataLockedError();
  return false;
}

/**
 * "You already hold this document" (#1437, detection note decision 2): the
 * earliest available, item-bound document of THIS household whose bytes equal
 * `contentSha256`, other than `excludeDocumentId`. One file's question of
 * `findHeldDuplicates`.
 */
export async function findHeldDuplicate(
  householdId: string,
  contentSha256: string,
  excludeDocumentId: string | null = null,
  metadata?: MetadataCipher,
): Promise<AlreadyHeld | null> {
  return (await findHeldDuplicates(householdId, [contentSha256], excludeDocumentId, metadata)).get(contentSha256) ?? null;
}

/**
 * As `findHeldDuplicate`, for several files at once -- a mail-in receipt's
 * attachments -- in one query, keyed by each file's SHA-256 (absent when
 * nothing is held). The household id comes from the already-authorised
 * request and the digest is keyed by that household's own key, so the same
 * bytes in another household can never match. This is the only reader of
 * `documents.content_index`. A household with no key (nothing encrypted
 * yet, or a locked cipher) holds nothing to match.
 */
export async function findHeldDuplicates(
  householdId: string,
  contentSha256s: readonly string[],
  excludeDocumentId: string | null = null,
  metadata?: MetadataCipher,
): Promise<Map<string, AlreadyHeld>> {
  const held = new Map<string, AlreadyHeld>();
  if (contentSha256s.length === 0) return held;
  const cipher = metadata ?? await openMetadataReader(householdId);
  /** blind index -> the SHA-256s asked about under it */
  const asked = new Map<string, string[]>();
  try {
    for (const sha of new Set(contentSha256s)) {
      const index = cipher.contentIndex(sha);
      if (index) asked.set(index, [...asked.get(index) ?? [], sha]);
    }
  } catch (error) {
    if (error instanceof MetadataKeyLockedError) return held;
    throw error;
  }
  if (asked.size === 0) return held;
  /* One row per index asked, the earliest copy (DISTINCT ON), and an explicit
     LIMIT of that many, so a household holding many copies of one file never
     reads more than it uses. */
  const matches = await getDb().selectDistinctOn([documents.contentIndex], {
    id: documents.id,
    displayName: documents.displayName,
    createdAt: documents.createdAt,
    contentIndex: documents.contentIndex,
    itemId: items.id,
    titleEnc: items.titleEnc,
  }).from(documents)
    .leftJoin(items, and(eq(items.id, documents.itemId), eq(items.householdId, householdId)))
    .where(and(
      eq(documents.householdId, householdId),
      inArray(documents.contentIndex, [...asked.keys()]),
      eq(documents.lifecycle, "available"),
      isNotNull(documents.itemId),
      excludeDocumentId ? ne(documents.id, excludeDocumentId) : undefined,
    )).orderBy(asc(documents.contentIndex), asc(documents.createdAt), asc(documents.id))
    .limit(asked.size);
  for (const match of matches) {
    for (const sha of asked.get(match.contentIndex ?? "") ?? []) {
      if (held.has(sha)) continue; /* the earliest copy names it */
      held.set(sha, {
        documentId: match.id,
        displayName: match.displayName,
        addedAt: match.createdAt.toISOString(),
        entry: match.itemId ? { itemId: match.itemId, title: cipher.text("items.title", match.itemId, { encrypted: match.titleEnc }).value ?? "" } : null,
      });
    }
  }
  return held;
}

export async function recordDocumentAudit(
  householdId: string,
  documentId: string,
  actorUserId: string,
  action: string,
  changes: Record<string, unknown>,
): Promise<void> {
  await getDb().insert(auditLog).values({
    householdId,
    actorUserId,
    entityType: "document",
    entityId: documentId,
    action,
    changes,
  });
}

export async function listItemDocuments(
  userId: string,
  householdId: string,
  itemId: string,
): Promise<DocumentSummary[]> {
  await requireHouseholdAndItemAccess(userId, householdId, itemId);
  const config = getDocumentConfig();
  const rows = await getDb()
    .select({
      id: documents.id,
      itemId: documents.itemId,
      displayName: documents.displayName,
      mediaType: documents.mediaType,
      sizeBytes: documents.sizeBytes,
      lifecycle: documents.lifecycle,
      scanStatus: documents.scanStatus,
      availableAt: documents.availableAt,
      deleteAfter: documents.deleteAfter,
      failureCode: documents.failureCode,
      pageCount: documents.pageCount,
      stageStatus: documentStagingObjects.status,
      recoveryExpiresAt: documentStagingObjects.recoveryExpiresAt,
      recoveryJobStatus: documentJobs.status,
    })
    .from(documents)
    .leftJoin(documentStagingObjects, eq(documentStagingObjects.documentId, documents.id))
    .leftJoin(documentJobs, and(eq(documentJobs.documentId, documents.id), eq(documentJobs.kind, "scan")))
    .where(and(
      eq(documents.householdId, householdId),
      eq(documents.itemId, itemId),
      // Widened beyond the openable states so an upload in progress, or one
      // that was rejected, is visible rather than indistinguishable from an
      // upload that never happened. Authorisation above is unchanged.
      inArray(documents.lifecycle, [...listableDocumentLifecycles]),
    ))
    .orderBy(desc(documents.createdAt));
  return rows.map((row) => {
    const recoverable = row.stageStatus === "pending" && row.recoveryExpiresAt !== null && row.recoveryExpiresAt > new Date() && row.lifecycle === "scanning";
    return toSummary({
      ...row,
      recoverable,
      recoveryStatus: recoverable && row.recoveryJobStatus === "failed" ? "manual" : recoverable ? "retrying" : null,
    }, config.scanMode);
  });
}

/**
 * Whether a document's content has durably reached `available`: the boundary
 * before which no other holder of its bytes may treat its own copy as
 * redundant and destroy it (#383 finding 4). A document that is still
 * `scanning` (including scanner-outage recovery) or has been `rejected` is
 * not yet — or will never be — safe to treat as the sole retained copy.
 */
export async function isDocumentAvailable(documentId: string): Promise<boolean> {
  const config = getDocumentConfig();
  const [row] = await getDb()
    .select({ lifecycle: documents.lifecycle, scanStatus: documents.scanStatus })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  if (!row) return false;
  return isDocumentContentReady(row, config.scanMode, "download");
}

async function reserveDocumentMetadata(input: {
  documentId: string;
  userId: string;
  householdId: string;
  /** The item id the ciphertext is sealed under. */
  itemId: string;
  /** A staged upload: stored with no item, due to be retired unless bound in time. */
  staged: boolean;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  /** Plain only when the household key was locked at upload (#1771); else NULL. */
  contentSha256: string | null;
  /** The content hash sealed under the household key (#1771); NULL only when the key was locked. */
  contentSha256Sealed: string | null;
  /** The content hash's blind index (#1437), written in the same INSERT so the two cannot drift. */
  contentIndex: string | null;
  scanStatus: "pending" | "skipped";
}): Promise<void> {
  const config = getDocumentConfig();
  await getDb().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended('orbit:document-instance-quota', 0))`);
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:document-household-quota:${input.householdId}`}, 0))`,
    );
    const excluded: Array<"deleted" | "rejected"> = ["deleted", "rejected"];
    const [[instanceUsage], [householdUsage]] = await Promise.all([
      transaction.select({ total: sql<number>`coalesce(sum(${documents.sizeBytes}), 0)` })
        .from(documents)
        .where(notInArray(documents.lifecycle, excluded)),
      transaction.select({ total: sql<number>`coalesce(sum(${documents.sizeBytes}), 0)` })
        .from(documents)
        .where(and(eq(documents.householdId, input.householdId), notInArray(documents.lifecycle, excluded))),
    ]);
    if (Number(instanceUsage.total) + input.sizeBytes > config.instanceQuotaBytes) {
      throw new AppError("document_instance_quota", "Orbit document storage has reached its configured limit", 413);
    }
    if (Number(householdUsage.total) + input.sizeBytes > config.householdQuotaBytes) {
      throw new AppError("document_household_quota", "This household has reached its document storage limit", 413);
    }
    await transaction.insert(documents).values({
      id: input.documentId,
      householdId: input.householdId,
      itemId: input.staged ? null : input.itemId,
      sealedItemId: input.itemId,
      deleteAfter: input.staged ? new Date(Date.now() + stagedUploadHoldMs(config)) : null,
      uploadedByUserId: input.userId,
      displayName: input.displayName,
      mediaType: input.mediaType,
      sizeBytes: input.sizeBytes,
      contentSha256: input.contentSha256,
      contentSha256Sealed: input.contentSha256Sealed,
      contentIndex: input.contentIndex,
      lifecycle: "quarantined",
      scanStatus: input.scanStatus,
    });
  });
}

/**
 * The open check's one read of the quarantine file (#1567). The buffer lives
 * only in this function's frame: it is zeroed and freed when the check
 * answers, so the encrypt stage that follows never runs with it still held.
 * Kept in the upload's own frame, a suspended async function keeps it
 * reachable across the later awaits.
 */
async function checkQuarantinedStructure(
  storage: LocalDocumentStorage,
  received: ReceivedDocument,
  mediaType: SupportedDocumentMediaType,
  maxBytes: number,
): Promise<DocumentStructureVerdict> {
  const bytes = await storage.readQuarantine(received.quarantinePath, maxBytes);
  try {
    return await classifyDocumentStructure(bytes, mediaType, { path: received.quarantinePath, sizeBytes: received.sizeBytes });
  } finally {
    // Zeroed and freed the moment the check answers, as the recovery and
    // mail-in checks do, so the seal never runs beside it (#1151 F13).
    releaseBuffer(bytes);
  }
}

export async function uploadItemDocument(input: {
  userId: string;
  householdId: string;
  /** The item the document belongs to; for a staged upload, the draft item it will be bound to. */
  itemId: string;
  /**
   * Stage it (#1316): store it with no item, sealed under `itemId`, for
   * `item.upsert { documentIds }` to bind in the same transaction that saves
   * the item. The item need not exist yet.
   */
  staged?: boolean;
  filename: string;
  body: ReadableStream<Uint8Array> | null;
  declaredBytes?: number;
  /**
   * The bound these bytes were already accepted under. A mail-in transfer
   * (#1388) passes the held attachment's size: the mail limit bounded it at
   * ingestion and the upload limit never applies to mail. Absent, the
   * administrator's upload limit applies (#1285).
   */
  maxBytes?: number;
  documentId?: string;
  /**
   * #1437: false where no "already held" alert belongs -- an archive restore,
   * which is expected to re-create what the household holds, and a mail-in
   * transfer, whose review card already said so.
   */
  detectDuplicates?: boolean;
}): Promise<DocumentSummary> {
  const staged = input.staged === true;
  if (staged) await requireHouseholdDocumentAccess(input.userId, input.householdId);
  else await requireHouseholdAndItemAccess(input.userId, input.householdId, input.itemId);
  /** The item the row is bound to: none yet for a staged upload. */
  const rowItemId = staged ? null : input.itemId;
  const config = getDocumentConfig();
  // The administrator's limit, read now so a change needs no restart (#1285).
  // Held for the whole upload, so every read below agrees with the receive.
  // Bytes already accepted under another bound (a held mail attachment,
  // #1784) carry that bound instead: a later limit never re-judges them.
  const maxBytes = input.maxBytes ?? await readEffectiveUploadLimit(config);
  const storage = openDocumentStorage(config);
  const documentId = input.documentId ?? randomUUID();
  const received = await storage.receive(input.body, documentId, maxBytes, input.declaredBytes);
  let storageKey: string | undefined;
  let stagingKey: string | undefined;
  let metadataReserved = false;
  // The structure check's page count (#1436), kept on the row when it publishes.
  let pageCount: number | null = null;
  try {
    // Check idempotency scope and content before parsing the retry body. A
    // reused identity must deterministically return 409 even when the new
    // bytes are not a supported document type.
    if (input.documentId) {
      const [identity] = await getDb().select({
        householdId: documents.householdId,
        itemId: documents.itemId,
        sealedItemId: documents.sealedItemId,
        plain: documents.contentSha256,
        sealed: documents.contentSha256Sealed,
        sizeBytes: documents.sizeBytes,
      }).from(documents).where(eq(documents.id, input.documentId)).limit(1);
      if (identity && (identity.householdId !== input.householdId || sealedItemIdOf(identity) !== input.itemId
        || identity.sizeBytes !== received.sizeBytes
        || !await storedContentHashIs(input.householdId, input.documentId, identity, received.contentSha256))) {
        throw new AppError("document_conflict", "That document identity is already in use", 409);
      }
    }
    const mediaType = detectDocumentMediaType(received.leadingBytes);
    const displayName = normalizedDocumentFilename(input.filename, mediaType);

    if (input.documentId) {
      const [existing] = await getDb().select({
        id: documents.id,
        itemId: documents.itemId,
        sealedItemId: documents.sealedItemId,
        householdId: documents.householdId,
        displayName: documents.displayName,
        mediaType: documents.mediaType,
        sizeBytes: documents.sizeBytes,
        plain: documents.contentSha256,
        sealed: documents.contentSha256Sealed,
        lifecycle: documents.lifecycle,
        scanStatus: documents.scanStatus,
        failureCode: documents.failureCode,
        availableAt: documents.availableAt,
        deleteAfter: documents.deleteAfter,
        pageCount: documents.pageCount,
        stageStatus: documentStagingObjects.status,
        recoveryExpiresAt: documentStagingObjects.recoveryExpiresAt,
        recoveryJobStatus: documentJobs.status,
      }).from(documents).leftJoin(documentStagingObjects, eq(documentStagingObjects.documentId, documents.id))
        .leftJoin(documentJobs, and(eq(documentJobs.documentId, documents.id), eq(documentJobs.kind, "scan")))
        .where(eq(documents.id, input.documentId)).limit(1);
      if (existing) {
        if (existing.householdId !== input.householdId || sealedItemIdOf(existing) !== input.itemId
          || existing.sizeBytes !== received.sizeBytes
          || existing.mediaType !== mediaType
          || !await storedContentHashIs(input.householdId, input.documentId, existing, received.contentSha256)) {
          throw new AppError("document_conflict", "That document identity is already in use", 409);
        }
        if (existing.lifecycle === "available") return toSummary(existing, config.scanMode);
        if (existing.lifecycle === "scanning" && existing.stageStatus === "pending" && existing.recoveryExpiresAt !== null && existing.recoveryExpiresAt > new Date()) {
          return toSummary({
            ...existing,
            recoverable: true,
            recoveryStatus: existing.recoveryJobStatus === "failed" ? "manual" : "retrying",
          }, config.scanMode);
        }
        if (existing.lifecycle === "rejected" && existing.failureCode === "malware_detected") {
          throw new AppError("document_malware_detected", "That document upload has already been rejected", 422);
        }
        // A staged file the sweep retired is gone for good under this id:
        // answer as the bind does, so the form stages it afresh under a new
        // id rather than being told "needs recovery" for ever.
        if (staged && (existing.lifecycle === "pending_deletion" || existing.lifecycle === "deleted")) {
          throw new AppError("document_not_available", "That document is no longer available — pick it again", 409);
        }
        if (existing.lifecycle !== "rejected") {
          throw new AppError("document_upload_recoverable", "That document upload needs recovery", 503);
        }
        // A rejection that was not a verdict on the file (a storage or
        // scanner failure, an interrupted upload) is retried, not remembered:
        // the row goes (its staging and crypto rows cascade; any orphaned
        // object is left to storage reconciliation) and the same id is
        // reserved afresh below.
        await getDb().delete(documents).where(and(
          eq(documents.id, input.documentId),
          eq(documents.lifecycle, "rejected"),
          sql`${documents.failureCode} is distinct from 'malware_detected'`,
        ));
      }
    }

    // ADR-0033: the scan comes before anything opens the file. ClamAV reads
    // the quarantine copy over its own socket; only a clean file (or, with
    // scanning `disabled`, any file) is read into memory and handed to the
    // renderer's structure check. A file it refuses is refused before any
    // durable metadata exists, as it always was. The one read here serves the
    // check and nothing else: its buffer is zeroed the moment the check
    // answers, and the encrypt stage reads the quarantine file again in
    // pieces, verifying its digest (#1567). The read happens after the scan,
    // so no plaintext is held in memory across the scan's wait (A2-Q1).
    let scan: ScanClassification<typeof documentScanCodes[keyof typeof documentScanCodes]> | undefined;
    let scanMs = 0;
    if (config.scanMode === "required") {
      log.info({ event: "document.scan", state: "starting", action: "check_scanner" });
      const scanStartedAt = Date.now();
      scan = classifyScan(await scanFileWithClamAv(received.quarantinePath, config.clamAv), documentScanCodes);
      scanMs = Math.max(0, Date.now() - scanStartedAt);
    }
    if (!scan || scan.status === "clean") {
      const verdict = await checkQuarantinedStructure(storage, received, mediaType, maxBytes);
      pageCount = verdict.pageCount ?? null;
      const structure = verdict.reason;
      if (structure === "password_required") {
        throw new AppError(
          "document_password_required",
          "This document needs a password to open. Choose a copy without a password.",
          422,
        );
      }
      if (structure === "structure_check_unavailable") {
        // The sandbox reached no verdict (#1593): a busy host, not a bad file.
        // The member is told only to try again; the real reason is for the
        // administrator's log. Nothing is stored, as for any refusal.
        log.warn({
          event: "document.inspection",
          state: "degraded",
          reason: "structure_check_unavailable",
          action: "inspect_admin_diagnostics",
          impact: "document_upload_blocked",
        });
        throw new AppError("document_check_unavailable", "The file couldn't be uploaded. Please try again.", 503);
      }
      if (structure !== "supported_structure") {
        throw new AppError(
          "document_structure_invalid",
          "Orbit could not open this document. Choose another PDF, JPEG, or PNG.",
          422,
        );
      }
    }
    await reserveDocumentMetadata({
      documentId,
      userId: input.userId,
      householdId: input.householdId,
      itemId: input.itemId,
      staged,
      displayName,
      mediaType,
      sizeBytes: received.sizeBytes,
      ...await sealedDocumentContentHash(input.householdId, documentId, received.contentSha256),
      scanStatus: config.scanMode === "disabled" ? "skipped" : "pending",
    });
    metadataReserved = true;

    log.info({ event: "document.lifecycle", state: "starting", action: "none" });

    if (scan) {
      await getDb().update(documents).set({ lifecycle: "scanning", updatedAt: new Date() })
        .where(and(eq(documents.id, documentId), eq(documents.lifecycle, "quarantined")));
      log.info({ event: "document.lifecycle", state: "starting", action: "check_scanner" });
      if (scan.status !== "clean") {
        const infected = scan.status === "infected";
        // Distinguish "cannot reach the scanner" from "the scanner answered
        // with a failure" so an operator knows whether to check connectivity or
        // the scanner itself. Neither message discloses host, port or provider
        // text, per the bounded-diagnostics rule.
        const failureCode = scan.code;
        // A fixed enumeration from the scanner adapter, never provider text,
        // so it is safe to record.
        log.warn({
          event: "document.scan",
          state: infected ? "exhausted" : "degraded",
          reason: asOperationalReason(failureCode),
          action: "check_scanner",
          impact: "document_upload_blocked",
          durationMs: scanMs,
        });
        if (scan.retryable) {
          // The next key while a rotation is in progress (#955).
          const stagingWrap = wrappingKey(config);
          const stagingSealer = createDocumentSealer({
            documentId,
            householdId: input.householdId,
            itemId: input.itemId,
            mediaType,
            plaintextSize: received.sizeBytes,
            purpose: "scanner_recovery",
          }, stagingWrap.keyEncryptionKey, stagingWrap.keyId);
          // Encrypted from the quarantine file in pieces, its digest verified.
          const stagingObjectKey = storage.createStorageKey();
          const staged = await storage.sealQuarantine(
            received.quarantinePath,
            { sizeBytes: received.sizeBytes, contentSha256: received.contentSha256 },
            stagingSealer,
            { kind: "staging", storageKey: stagingObjectKey },
          );
          stagingKey = stagingObjectKey;
          const now = new Date();
          const recoveryExpiresAt = new Date(now.getTime() + config.scanRecoveryRetentionHours * 60 * 60 * 1_000);
          const nextAttemptAt = new Date(now.getTime() + scannerRecoveryDelayMs(1));
          try {
            await getDb().transaction(async (transaction) => {
              await transaction.insert(documentStagingObjects).values({
                documentId,
                storageKey: stagingKey!,
                purpose: "scanner_recovery",
                ciphertextSize: staged.ciphertextSize,
                ...staged.envelope,
                status: "pending",
                recoveryExpiresAt,
              });
              await transaction.insert(documentJobs).values({
                documentId,
                kind: "scan",
                generation: 1,
                status: "pending",
                attempts: 0,
                nextAttemptAt,
                lastError: failureCode,
              });
              await transaction.update(documents).set({
                lifecycle: "scanning",
                scanStatus: "error",
                failureCode,
                updatedAt: now,
              }).where(and(eq(documents.id, documentId), eq(documents.lifecycle, "scanning")));
              await transaction.insert(auditLog).values({
                householdId: input.householdId,
                actorUserId: input.userId,
                entityType: "document",
                entityId: documentId,
                action: "document_scan_recoverable",
                changes: { itemId: input.itemId, reason: failureCode },
              });
            });
          } catch (error) {
            await storage.deleteStagingCiphertext(stagingKey).catch(() => undefined);
            stagingKey = undefined;
            throw error;
          }
          log.warn({
            event: "document.scan",
            state: "retrying",
            reason: asOperationalReason(failureCode),
            action: "retry",
            impact: "document_upload_blocked",
            durationMs: scanMs,
          });
          return toSummary({
            id: documentId,
            itemId: rowItemId,
            displayName,
            mediaType,
            sizeBytes: received.sizeBytes,
            lifecycle: "scanning",
            scanStatus: "error",
            availableAt: null,
            deleteAfter: null,
            failureCode,
            recoverable: true,
            recoveryExpiresAt,
            recoveryStatus: "retrying",
          }, config.scanMode);
        }

        await getDb().update(documents).set({
          lifecycle: "rejected",
          scanStatus: infected ? "infected" : "error",
          failureCode,
          updatedAt: new Date(),
        }).where(eq(documents.id, documentId));
        log.warn({
          event: "document.lifecycle",
          state: "exhausted",
          reason: asOperationalReason(failureCode),
          action: "check_scanner",
          impact: "document_upload_blocked",
        });
        await recordDocumentAudit(
          input.householdId,
          documentId,
          input.userId,
          infected ? "document_rejected_malware" : "document_rejected_scanner",
          { itemId: input.itemId },
        );
        if (infected) {
          throw new AppError(
            "document_malware_detected",
            "Orbit rejected that document because malware was detected",
            422,
          );
        }
        throw new AppError(
          "document_scanner_failed",
          "Document upload is not possible because the malware scanner reported a failure. Uploads stay blocked until the scanner is healthy.",
          503,
        );
      }
      log.info({ event: "document.scan", state: "ready", action: "none", durationMs: scanMs });
      await getDb().update(documents).set({ scanStatus: "clean", lifecycle: "encrypting", updatedAt: new Date() })
        .where(eq(documents.id, documentId));
    } else {
      log.info({ event: "document.scan", state: "disabled", reason: "scan_mode_disabled", action: "none" });
      await getDb().update(documents).set({ lifecycle: "encrypting", updatedAt: new Date() })
        .where(eq(documents.id, documentId));
    }
    log.info({ event: "document.lifecycle", state: "starting", action: "none" });

    // The next key while a rotation is in progress (#955).
    const publishWrap = wrappingKey(config);
    const publishSealer = createDocumentSealer({
      documentId,
      householdId: input.householdId,
      itemId: input.itemId,
      mediaType,
      plaintextSize: received.sizeBytes,
    }, publishWrap.keyEncryptionKey, publishWrap.keyId);
    // Encrypted from the quarantine file in pieces, its digest verified.
    const objectKey = storage.createStorageKey();
    const encrypted = await storage.sealQuarantine(
      received.quarantinePath,
      { sizeBytes: received.sizeBytes, contentSha256: received.contentSha256 },
      publishSealer,
      { kind: "object", storageKey: objectKey },
    );
    storageKey = objectKey;

    const now = new Date();
    await getDb().transaction(async (transaction) => {
      await transaction.insert(documentCrypto).values({
        documentId,
        storageKey: storageKey!,
        ciphertextSize: encrypted.ciphertextSize,
        ...encrypted.envelope,
      });
      // Asserted, not assumed: a slow encrypt can run past the maintenance
      // sweep's interrupted-upload boundary (rejectInterruptedDocuments),
      // which moves the row out of `encrypting` while this is in flight. An
      // unconditional update would report success regardless, leaving a
      // document the caller is told is "available" but whose ciphertext the
      // next reconciliation sweep deletes as unreferenced (A2-R1).
      const [published] = await transaction.update(documents).set({
        lifecycle: "available",
        availableAt: now,
        failureCode: null,
        pageCount,
        version: sql`${documents.version} + 1`,
        updatedAt: now,
      }).where(and(eq(documents.id, documentId), eq(documents.lifecycle, "encrypting")))
        .returning({ id: documents.id });
      if (!published) {
        throw new AppError(
          "document_publish_conflict",
          "That document's upload state changed while it was being published",
          409,
        );
      }
      await transaction.insert(auditLog).values({
        householdId: input.householdId,
        actorUserId: input.userId,
        entityType: "document",
        entityId: documentId,
        action: "document_available",
        changes: {
          itemId: input.itemId,
          sizeBytes: received.sizeBytes,
          mediaType,
          scanStatus: config.scanMode === "disabled" ? "skipped" : "clean",
        },
      });
      // Its pages are drawn and kept in the background from now (#1433 D12).
      await enqueuePreviewJob(transaction, documentId);
    });
    notifyPreviewWorker();
    log.info({ event: "document.lifecycle", state: "ready", action: "none" });
    /* #1437: the row is available, so the alert can name an entry the card
       can open; a rejected upload never gets this far. */
    const alreadyHeld = input.detectDuplicates === false
      ? null
      : await findHeldDuplicate(input.householdId, received.contentSha256, documentId).catch((error: unknown) => {
        /* The file is stored and the answer stands: an alert that cannot be
           looked up is not a failed upload. */
        log.warn({
          event: "document.lifecycle",
          state: "degraded",
          reason: asOperationalReason(error instanceof AppError ? error.code : "duplicate_lookup_failed"),
          action: "inspect_admin_diagnostics",
          impact: "none",
        });
        return null;
      });
    return {
      id: documentId,
      itemId: rowItemId,
      displayName,
      mediaType,
      sizeBytes: received.sizeBytes,
      lifecycle: "available",
      scanStatus: config.scanMode === "disabled" ? "skipped" : "clean",
      availableAt: now.toISOString(),
      deleteAfter: null,
      ready: isDocumentContentReady({ lifecycle: "available", scanStatus: config.scanMode === "disabled" ? "skipped" : "clean" }, config.scanMode, "summary"),
      failureCode: null,
      recoverable: false,
      recoveryExpiresAt: null,
      recoveryStatus: null,
      alreadyHeld,
      pageCount,
    };
  } catch (error) {
    if (storageKey) await storage.deleteCiphertext(storageKey).catch(() => undefined);
    if (stagingKey) await storage.deleteStagingCiphertext(stagingKey).catch(() => undefined);
    if (metadataReserved && !(error instanceof AppError && error.code.startsWith("document_malware"))) {
      const failureCode = error instanceof AppError ? error.code : "processing_failed";
      const rejected = await getDb().update(documents).set({
        lifecycle: "rejected",
        failureCode,
        updatedAt: new Date(),
      }).where(and(eq(documents.id, documentId), notInArray(documents.lifecycle, ["available", "rejected"])))
        .returning({ id: documents.id })
        .catch(() => []);
      if (rejected.length > 0) {
        log.warn({
          event: "document.lifecycle",
          state: "exhausted",
          reason: asOperationalReason(failureCode),
          action: "inspect_admin_diagnostics",
          impact: "document_processing_blocked",
        });
      }
    }
    throw error;
  } finally {
    received.leadingBytes.fill(0);
    await storage.discardQuarantine(received.quarantinePath).catch(() => undefined);
  }
}

/** The plaintext reads that share this authorization and readiness path. */
export type DocumentContentAuditAction = "document_downloaded" | "document_previewed";

/**
 * What a plaintext read needs, once authorization and readiness have passed:
 * the document's record, its crypto row, the key-encryption key for that row,
 * its envelope, and the encryption context its unsealer is built over. Shared
 * by the whole-buffer read and the streamed download so both stay one path.
 */
/** Authorization, readiness, the crypto row and its key: everything a reader of a document's content needs first. Exported for the preview path (#1433 D21). */
export async function resolveDocumentContent(userId: string, documentId: string) {
  const record = await requireDocumentAccess(userId, documentId);
  const config = getDocumentConfig();
  if (!record.itemId || !isDocumentContentReady(record, config.scanMode, "download")) {
    throw new AppError("document_not_found", "That document is not available", 404);
  }
  const [crypto] = await getDb().select().from(documentCrypto).where(eq(documentCrypto.documentId, documentId)).limit(1);
  if (!crypto) throw new AppError("document_unavailable", "That document cannot currently be opened", 503);

  // Picks by the row's own key_id (#954, ADR-0024 decision 4): during a
  // rotation the config holds both the current and next key, so a row is
  // readable whether or not the rewrap worker (#932) has reached it yet.
  const documentKek = keyEncryptionKeyFor(config, crypto.keyId);
  if (!documentKek) {
    throw new AppError("document_key_unavailable", "Document encryption keys require administrator attention", 503);
  }
  const envelope = envelopeOf(crypto);
  const context = {
    documentId,
    householdId: record.householdId,
    itemId: sealedItemIdOf(record)!,
    mediaType: record.mediaType,
    plaintextSize: record.sizeBytes,
  };
  return { record, crypto, documentKek, envelope, context };
}

/**
 * A failed tag, a key or envelope that does not open, or an object not the
 * length that was sealed is an integrity failure; a missing or unreadable
 * object is the document being unavailable.
 */
export function documentReadError(error: unknown): AppError {
  if (error instanceof DocumentIntegrityError) {
    return new AppError("document_integrity_failed", "That document failed its integrity check", 503);
  }
  return new AppError("document_unavailable", "That document cannot currently be opened", 503);
}

/**
 * Decrypts a document's plaintext for an authorized reader.
 *
 * Every caller that needs plaintext goes through here so that authorization,
 * readiness and audit stay one path; only the recorded action varies, so a
 * page-one preview (#476) is never logged as a whole-document download.
 * The stored object is decrypted straight into one buffer, and that buffer is
 * returned only once the tag has verified (#1571).
 */
export async function readDocumentDownload(
  userId: string,
  documentId: string,
  auditAction: DocumentContentAuditAction = "document_downloaded",
): Promise<{ bytes: Buffer; displayName: string; mediaType: string; pageCount?: number | null }> {
  const { record, crypto, documentKek, envelope, context } = await resolveDocumentContent(userId, documentId);
  let bytes: Buffer;
  try {
    bytes = await openDocumentStorage().unsealIntoBuffer(
      crypto.storageKey,
      { ciphertextSize: crypto.ciphertextSize, plaintextSize: record.sizeBytes },
      createDocumentUnsealer(context, envelope, documentKek),
    );
  } catch (error) {
    throw documentReadError(error);
  }
  await recordDocumentAudit(record.householdId, documentId, userId, auditAction, { itemId: record.itemId });
  return { bytes, displayName: record.displayName, mediaType: record.mediaType, pageCount: record.pageCount };
}

/**
 * Opens a document's plaintext as a stream for an authorized reader (#1571).
 *
 * The tag is verified in one pass over the stored ciphertext before this
 * returns; the body then decrypts the same object again in pieces, so the
 * plaintext is never held whole. A tampered object fails here with
 * `document_integrity_failed`, before any body exists. The download is audited
 * after that first pass, before the body is returned.
 */
export async function openDocumentDownload(
  userId: string,
  documentId: string,
): Promise<{ body: ReadableStream<Uint8Array>; sizeBytes: number; displayName: string; mediaType: string }> {
  const { record, crypto, documentKek, envelope, context } = await resolveDocumentContent(userId, documentId);
  let body: ReadableStream<Uint8Array>;
  try {
    body = await openDocumentStorage().streamVerifiedPlaintext(
      crypto.storageKey,
      { ciphertextSize: crypto.ciphertextSize },
      () => createDocumentUnsealer(context, envelope, documentKek),
    );
  } catch (error) {
    throw documentReadError(error);
  }
  try {
    await recordDocumentAudit(record.householdId, documentId, userId, "document_downloaded", { itemId: record.itemId });
  } catch (error) {
    await body.cancel().catch(() => undefined);
    throw error;
  }
  return { body, sizeBytes: record.sizeBytes, displayName: record.displayName, mediaType: record.mediaType };
}

export async function requestDocumentDeletion(
  userId: string,
  documentId: string,
  options: { stagedDiscard?: boolean } = {},
): Promise<DocumentSummary> {
  const record = await requireDocumentDeletionAccess(userId, documentId);
  if (record.lifecycle !== "available") throw new AppError("document_not_found", "That document is not available", 404);
  const config = getDocumentConfig();
  /* #1437: only the Add form's discard of its own staged pick (a copy it
     replaced, turned down or left) asks for `stagedDiscard`. That copy was
     never part of the household's papers, so it has nothing to restore and
     goes at the next purge, not after the retention window. Every other
     delete -- an unbound document included, such as one whose item was
     deleted -- keeps the window and its restore. A staged copy is one no item
     binds that still carries its hold; the update takes it only while it
     still is one, so a bind that wins the race keeps the file. */
  const staged = options.stagedDiscard === true;
  if (staged && (record.itemId !== null || record.deleteAfter === null)) {
    throw new AppError("document_conflict", "That document is no longer a staged upload", 409);
  }
  const deleteAfter = staged ? new Date() : new Date(Date.now() + config.retentionDays * 86_400_000);
  const updated = await getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:document:${documentId}`}, 0))`,
    );
    const [changed] = await transaction.update(documents).set({
      lifecycle: "pending_deletion",
      deleteAfter,
      version: sql`${documents.version} + 1`,
      updatedAt: new Date(),
    }).where(and(
      eq(documents.id, documentId),
      eq(documents.lifecycle, "available"),
      staged ? isNull(documents.itemId) : undefined,
      staged ? isNotNull(documents.deleteAfter) : undefined,
    )).returning();
    if (!changed) return undefined;
    await transaction.insert(documentJobs).values({
      documentId,
      kind: "purge",
      generation: changed.version,
    }).onConflictDoNothing();
    return changed;
  });
  if (!updated) throw new AppError("document_conflict", "That document changed; refresh and try again", 409);
  log.info({ event: "document.lifecycle", state: "stopping", action: "none" });
  await recordDocumentAudit(record.householdId, documentId, userId, "document_deletion_requested", {
    itemId: record.itemId,
    deleteAfter: deleteAfter.toISOString(),
  });
  return toSummary(updated, config.scanMode);
}

export async function restoreDocument(userId: string, documentId: string): Promise<DocumentSummary> {
  const record = await requireDocumentDeletionAccess(userId, documentId);
  const config = getDocumentConfig();
  if (!isDocumentContentReady(record, config.scanMode, "restore") || !record.deleteAfter || record.deleteAfter <= new Date()) {
    throw new AppError("document_not_found", "That document is not available", 404);
  }
  const updated = await getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:document:${documentId}`}, 0))`,
    );
    const [crypto] = await transaction.select({ storageKey: documentCrypto.storageKey })
      .from(documentCrypto)
      .where(eq(documentCrypto.documentId, documentId))
      .limit(1);
    const [purgeJob] = await transaction.select({ status: documentJobs.status })
      .from(documentJobs)
      .where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "purge")))
      .orderBy(desc(documentJobs.generation))
      .limit(1);
    if (purgeJob?.status === "processing") {
      throw new AppError("document_conflict", "That document is being removed; try again shortly", 409);
    }
    if (!crypto) throw new AppError("document_unavailable", "That document cannot currently be restored", 503);
    let ciphertextExists = false;
    try {
      ciphertextExists = await openDocumentStorage().ciphertextExists(crypto.storageKey);
    } catch {
      throw new AppError("document_unavailable", "That document cannot currently be restored", 503);
    }
    if (!ciphertextExists) {
      // Ciphertext may already be gone after a worker interruption. Keep the
      // pending purge and its metadata so a valid retry can finalize it.
      throw new AppError("document_unavailable", "That document cannot currently be restored", 503);
    }
    const [changed] = await transaction.update(documents).set({
      lifecycle: "available",
      deleteAfter: null,
      version: sql`${documents.version} + 1`,
      updatedAt: new Date(),
    }).where(and(eq(documents.id, documentId), eq(documents.lifecycle, "pending_deletion"))).returning();
    if (!changed) return undefined;
    await transaction.update(documentJobs).set({
      status: "completed",
      completedAt: new Date(),
      lockedAt: null,
      leaseExpiresAt: null,
      lastError: "restored_before_purge",
      updatedAt: new Date(),
    }).where(and(
      eq(documentJobs.documentId, documentId),
      eq(documentJobs.kind, "purge"),
      inArray(documentJobs.status, ["pending", "retry", "failed"]),
    ));
    // A preview job that ran while the document was pending deletion, or a
    // deletion mid-slice, left pages undrawn: queue them again (#1433, 12a).
    await enqueuePreviewJobIfIncomplete(transaction, documentId);
    return changed;
  });
  if (!updated) throw new AppError("document_conflict", "That document changed; refresh and try again", 409);
  notifyPreviewWorker();
  log.info({ event: "document.lifecycle", state: "recovered", action: "none" });
  await recordDocumentAudit(record.householdId, documentId, userId, "document_restored", { itemId: record.itemId });
  return toSummary(updated, config.scanMode);
}
