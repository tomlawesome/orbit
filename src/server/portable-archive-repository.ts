import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog, documentCrypto, documents, dueEvents, households, items, portableArchiveImports, portableArchives, reminderRules, sections, } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { CALENDAR_DATE_MESSAGE, calendarDate } from "@/lib/calendar-date";
import { COST_MINOR_MAX, NOTES_MAX, PROVIDER_MAX, RECURRENCE_MAX, REFERENCE_MAX, SUBTYPE_MAX, TITLE_MAX } from "@/lib/domain";
import { log, operationalDetail } from "@/lib/logger";
import { MIN_PASSWORD_LENGTH, passwordLength } from "@/lib/password-length";
import { currencyCode } from "@/lib/platform-lists";
import { optionalText } from "@/lib/workspace";
import { getDocumentConfig } from "@/server/documents/config";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { readDocumentDownload, uploadItemDocument } from "@/server/document-repository";
import { decryptPortableArchive, encryptPortableArchive, isEncryptedPortableArchive, type EncryptedPortableArchive } from "@/server/portable-archive";
import { PortableArchiveStorage } from "@/server/portable-archive-storage";
import { normalizeComparableMetadata } from "@/server/metadata/crypto";
import { MetadataCipher, openMetadataReader, requireMetadataWriter, type MetadataExecutor } from "@/server/metadata/fields";
import { loadMetadataKey, metadataCryptoAvailable, MetadataKeyLockedError, receiptKeyScope } from "@/server/metadata/keys";
import { MAX_ARCHIVE_BYTES, MAX_ARCHIVE_CIPHERTEXT_CHARACTERS } from "@/server/portable-archive-limits";
import { acquireActiveHouseholdLock, requireHouseholdAccess } from "@/server/workspace-access";

const ARCHIVE_TTL_MS = 24 * 60 * 60 * 1_000;

const importedSectionSchema = z.object({ id: z.string().uuid(), slug: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(100), icon: z.string().trim().min(1).max(50), accent: z.string().trim().min(1).max(50), position: z.number().int().min(0).max(10_000), visible: z.boolean(), archivedAt: z.string().nullable().optional() });
// Field caps deliberately mirror `workspaceItemSchema` (src/lib/workspace.ts):
// the read path re-validates every persisted item against that schema, so an
// imported field this schema accepts but the reader rejects would insert a
// row that 422s `readWorkspace` forever afterwards, with no in-product
// recovery (#383 finding 2).
const importedItemSchema = z.object({
  id: z.string().uuid(),
  sectionId: z.string().uuid(),
  title: z.string().trim().min(1).max(TITLE_MAX),
  subtype: optionalText(SUBTYPE_MAX).nullable(),
  provider: optionalText(PROVIDER_MAX).nullable(),
  reference: optionalText(REFERENCE_MAX).nullable(),
  costMinor: z.number().int().min(0).max(COST_MINOR_MAX).nullable().optional(),
  currency: currencyCode,
  // A date an archive carries is a real day (#1333); one Orbit wrote always is.
  startDate: calendarDate.nullable().optional(),
  expiryDate: calendarDate.nullable().optional(),
  renewalDate: calendarDate.nullable().optional(),
  serviceDate: calendarDate.nullable().optional(),
  recurrenceMonths: z.number().int().min(1).max(RECURRENCE_MAX).nullable().optional(),
  snoozedUntil: calendarDate.nullable().optional(),
  notes: optionalText(NOTES_MAX).nullable(),
  externalDocumentUrl: z.string().nullable().optional(),
  status: z.enum(["active", "expired", "cancelled", "archived"]),
});
// Only the fields the import path cross-references (which item a document
// belongs to, its lifecycle, and what to call it on re-upload); every other
// exported document field is carried for round-tripping and left untyped.
const importedDocumentSchema = z.object({ id: z.string().uuid(), itemId: z.string().uuid().nullable(), displayName: z.string().trim().min(1), lifecycle: z.string() }).passthrough();
const importedDocumentBytesSchema = z.object({ id: z.string().uuid(), contentBase64: z.string() });
// `.max(500)` mirrors `householdWorkspaceSchema.items` so an archive that
// parses cleanly here cannot still brick the household by count alone.
const importedArchiveSchema = z.object({ format: z.literal("orbit-portable-archive"), version: z.literal(1), household: z.object({ name: z.string().trim().min(1).max(100) }), sections: z.array(importedSectionSchema).max(200), items: z.array(importedItemSchema).max(500), dueEvents: z.array(z.unknown()).optional(), reminderRules: z.array(z.unknown()).optional(), documents: z.array(importedDocumentSchema), documentBytes: z.array(importedDocumentBytesSchema).optional() });

function storage(): PortableArchiveStorage {
  return new PortableArchiveStorage(`${getDocumentConfig().storageRoot}/portable-archives`);
}

/**
 * Whether this person may write the household out or bring an archive in,
 * answered before anyone is asked to prove it is them (#1132): a person who
 * may not do the act at all is told that, rather than being challenged and
 * then refused. Export is the owner's act (#1049); import is open to any
 * member. `createPortableArchive` and `importPortableArchive` check again, so
 * nothing relies on a route having called this.
 */
export async function requirePortableArchiveAccess(
  userId: string,
  householdId: string,
  act: "export" | "import",
): Promise<void> {
  await requireHouseholdAccess(userId, householdId, act === "export");
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}


function rejectOversizedCiphertext(archive: EncryptedPortableArchive): void {
  if (archive.ciphertext.length > MAX_ARCHIVE_CIPHERTEXT_CHARACTERS) {
    throw new AppError("archive_too_large", "That export is too large", 413);
  }
}

/**
 * The household's cipher for an export. The portable archive is the
 * deliberate plaintext escape hatch (ADR-0024 decision 6): it exports
 * decrypted values, and therefore needs the KEK. A locked instance cannot
 * decrypt anything, so an export taken now would write every title as "" --
 * a file that imports but is useless. Refuse the export instead of producing
 * it (#1151 A2-F2).
 *
 * Not `openMetadataReader`: that one answers "locked" for a household whose
 * key has not been minted yet as well, and never throws, because a plain
 * read of such a household is fine -- nothing of its has ever been
 * encrypted, so its rows still hold plaintext and read normally. The same
 * is true of its export. The refusal belongs to the key that exists but
 * cannot be used: no KEK, or one that will not unwrap it.
 */
async function openExportMetadataReader(householdId: string): Promise<MetadataCipher> {
  const scope = receiptKeyScope(householdId);
  try {
    if (!metadataCryptoAvailable()) throw new MetadataKeyLockedError();
    return new MetadataCipher(await loadMetadataKey(scope.scope, scope.householdId));
  } catch (error) {
    if (error instanceof MetadataKeyLockedError) throw archiveMetadataLockedError();
    throw error;
  }
}

function archiveMetadataLockedError(): AppError {
  return new AppError(
    "archive_metadata_locked",
    "Orbit can't export while the encryption key is locked; its titles would come out blank. Unlock the key first.",
    503,
  );
}

/** Builds a normalized, household-scoped payload. Document bytes are opt-in and bounded. */
export async function createPortableArchive(input: {
  userId: string;
  householdId: string;
  passphrase: string;
  includeDocuments: boolean;
}): Promise<{ id: string; expiresAt: string; includesDocuments: boolean }> {
  await requireHouseholdAccess(input.userId, input.householdId, true);
  // The floor is held when an archive is made (#1333), counted as a person
  // counts, so a passphrase the route's own length check let through is still
  // refused in words rather than failing as a fault inside the cipher.
  if (passwordLength(input.passphrase) < MIN_PASSWORD_LENGTH) {
    throw new AppError("archive_passphrase_too_short", `Use an export passphrase of at least ${MIN_PASSWORD_LENGTH} characters`, 422);
  }
  const db = getDb();
  const [[household], householdSections, householdItems, events, reminders, documentRows] = await Promise.all([
    db.select().from(households).where(eq(households.id, input.householdId)).limit(1),
    db.select().from(sections).where(eq(sections.householdId, input.householdId)).orderBy(asc(sections.position)),
    db.select().from(items).where(eq(items.householdId, input.householdId)).orderBy(asc(items.createdAt)),
    db.select().from(dueEvents).where(eq(dueEvents.householdId, input.householdId)).orderBy(asc(dueEvents.createdAt)),
    db.select({
      id: reminderRules.id,
      itemId: reminderRules.itemId,
      daysBefore: reminderRules.daysBefore,
      emailEnabled: reminderRules.emailEnabled,
      pushEnabled: reminderRules.pushEnabled,
    }).from(reminderRules).innerJoin(items, eq(reminderRules.itemId, items.id)).where(eq(items.householdId, input.householdId)),
    db.select().from(documents).where(and(eq(documents.householdId, input.householdId), eq(documents.lifecycle, "available"))),
  ]);
  if (!household) throw new AppError("household_not_found", "That household is not available", 404);
  const metadata = await openExportMetadataReader(input.householdId);
  // No key minted is only harmless while nothing was ever encrypted under
  // it. A row carrying ciphertext with no key row to read it (a lost or
  // deleted metadata_keys row, a partial restore) would export blank the
  // same way a locked instance would, so it is refused the same way.
  if (metadata.locked && householdItems.some((item) => item.titleEnc || item.providerEnc || item.referenceEnc || item.notesEnc || item.costMinorEnc)) {
    throw archiveMetadataLockedError();
  }
  const exportedItems = householdItems.map((item) => ({
    ...item,
    reference: metadata.text("items.reference", item.id, { encrypted: item.referenceEnc, plaintext: item.reference }).value,
    notes: metadata.text("items.notes", item.id, { encrypted: item.notesEnc, plaintext: item.notes }).value,
    // Tier 2 (#963) exports decrypted for the same reason Tier 1 does: the
    // archive is the deliberate plaintext escape hatch, and an archive holding
    // ciphertext nobody outside this instance can open would not be one.
    title: metadata.text("items.title", item.id, { encrypted: item.titleEnc, plaintext: item.title }).value ?? "",
    provider: metadata.text("items.provider", item.id, { encrypted: item.providerEnc, plaintext: item.provider }).value,
    costMinor: metadata.number("items.cost_minor", item.id, { encrypted: item.costMinorEnc, plaintext: item.costMinor }).value,
  }));

  const payload: Record<string, unknown> = {
    format: "orbit-portable-archive",
    version: 1,
    exportedAt: new Date().toISOString(),
    household: { id: household.id, name: household.name, timezone: household.timezone, defaultCurrency: household.defaultCurrency },
    sections: householdSections.map((section) => ({ id: section.id, slug: section.slug, name: section.name, icon: section.icon, accent: section.accent, position: section.position, visible: section.visible, archivedAt: section.archivedAt })),
    items: exportedItems.map((item) => ({ id: item.id, sectionId: item.sectionId, title: item.title, subtype: item.subtype, provider: item.provider, reference: item.reference, costMinor: item.costMinor, currency: item.currency, startDate: item.startDate, expiryDate: item.expiryDate, renewalDate: item.renewalDate, serviceDate: item.serviceDate, recurrenceMonths: item.recurrenceMonths, snoozedUntil: item.snoozedUntil, notes: item.notes, externalDocumentUrl: item.externalDocumentUrl, status: item.status, version: item.version })),
    dueEvents: events.map((event) => ({ id: event.id, itemId: event.itemId, kind: event.kind, dueDate: event.dueDate, completedAt: event.completedAt, completionKey: event.completionKey, nextEventId: event.nextEventId })),
    reminderRules: reminders,
    documents: documentRows.map((document) => ({ id: document.id, itemId: document.itemId, displayName: document.displayName, mediaType: document.mediaType, sizeBytes: document.sizeBytes, contentSha256: document.contentSha256, lifecycle: document.lifecycle, scanStatus: document.scanStatus, failureCode: document.failureCode, deleteAfter: document.deleteAfter, deletedAt: document.deletedAt, availableAt: document.availableAt, version: document.version })),
  };
  if (input.includeDocuments) {
    const bytes: Array<{ id: string; contentBase64: string }> = [];
    let total = 0;
    for (const document of documentRows) {
      if (document.lifecycle !== "available") continue;
      if (!document.itemId) continue;
      if (total + document.sizeBytes > MAX_ARCHIVE_BYTES) {
        throw new AppError("archive_too_large", "Document-inclusive exports are limited to 128 MiB; export metadata only or remove documents first", 413);
      }
      const downloaded = await readDocumentDownload(input.userId, document.id);
      total += downloaded.bytes.length;
      bytes.push({ id: document.id, contentBase64: downloaded.bytes.toString("base64") });
      downloaded.bytes.fill(0);
    }
    payload.documentBytes = bytes;
  }

  const plaintext = jsonBuffer(payload);
  let encrypted: EncryptedPortableArchive;
  try {
    encrypted = encryptPortableArchive(plaintext, input.passphrase);
  } finally {
    plaintext.fill(0);
  }
  const contents = jsonBuffer(encrypted);
  if (contents.length > MAX_ARCHIVE_BYTES) {
    contents.fill(0);
    throw new AppError("archive_too_large", "That export exceeds Orbit's portable archive limit", 413);
  }
  const id = randomUUID();
  const storageKey = storage().createStorageKey();
  const expiresAt = new Date(Date.now() + ARCHIVE_TTL_MS);
  try {
    await db.transaction(async (transaction) => {
      await acquireActiveHouseholdLock(transaction, input.householdId);
      await storage().write(storageKey, contents);
      await transaction.insert(portableArchives).values({
        id, householdId: input.householdId, requestedByUserId: input.userId, storageKey,
        contentSha256: createHash("sha256").update(contents).digest("hex"), sizeBytes: contents.length,
        includesDocuments: input.includeDocuments, expiresAt,
      });
      await transaction.insert(auditLog).values({
        householdId: input.householdId, actorUserId: input.userId, entityType: "portable_archive", entityId: id,
        action: "portable_archive_requested", changes: { includesDocuments: input.includeDocuments, expiresAt: expiresAt.toISOString() },
      });
    });
  } catch (error) {
    await storage().delete(storageKey).catch(() => undefined);
    throw error;
  } finally {
    contents.fill(0);
  }
  return { id, expiresAt: expiresAt.toISOString(), includesDocuments: input.includeDocuments };
}

export async function readPortableArchive(userId: string, archiveId: string): Promise<{ bytes: Buffer }> {
  const [archive] = await getDb().select().from(portableArchives)
    .where(and(eq(portableArchives.id, archiveId), gt(portableArchives.expiresAt, new Date()), isNull(portableArchives.purgedAt))).limit(1);
  if (!archive) throw new AppError("archive_not_found", "That export is not available", 404);
  try {
    await requireHouseholdAccess(userId, archive.householdId);
  } catch (error) {
    if (error instanceof AppError && error.code === "household_not_found") {
      throw new AppError("archive_not_found", "That export is not available", 404);
    }
    throw error;
  }
  const bytes = await storage().read(archive.storageKey, archive.sizeBytes);
  if (createHash("sha256").update(bytes).digest("hex") !== archive.contentSha256) {
    bytes.fill(0);
    throw new AppError("archive_integrity_failed", "That export failed its integrity check", 503);
  }
  await getDb().transaction(async (transaction) => {
    await transaction.update(portableArchives).set({ downloadedAt: new Date() }).where(eq(portableArchives.id, archive.id));
    await transaction.insert(auditLog).values({ householdId: archive.householdId, actorUserId: userId, entityType: "portable_archive", entityId: archive.id, action: "portable_archive_downloaded", changes: { includesDocuments: archive.includesDocuments } });
  });
  return { bytes };
}

/** Removes expired ciphertext and retains only an auditable tombstone. */
export async function purgeExpiredPortableArchives(): Promise<void> {
  const expired = await getDb().select().from(portableArchives)
    .where(and(lt(portableArchives.expiresAt, new Date()), isNull(portableArchives.purgedAt))).limit(100);
  for (const archive of expired) {
    await storage().delete(archive.storageKey).catch(() => undefined);
    await getDb().transaction(async (transaction) => {
      const [changed] = await transaction.update(portableArchives).set({ purgedAt: new Date() })
        .where(and(eq(portableArchives.id, archive.id), isNull(portableArchives.purgedAt))).returning({ id: portableArchives.id });
      if (changed) await transaction.insert(auditLog).values({ householdId: archive.householdId, actorUserId: null, entityType: "portable_archive", entityId: archive.id, action: "portable_archive_expired", changes: {} });
    });
  }
}

/** Removes abandoned encrypted export files after a failed write or household purge. */
export async function reconcilePortableArchiveStorage(): Promise<void> {
  const records = await getDb().select({ storageKey: portableArchives.storageKey }).from(portableArchives)
    .where(isNull(portableArchives.purgedAt));
  const referenced = new Set(records.map((record) => record.storageKey));
  const orphanBoundary = Date.now() - 24 * 60 * 60 * 1_000;
  for (const object of await storage().list()) {
    if (!referenced.has(object.storageKey) && object.modifiedAt.getTime() < orphanBoundary) {
      await storage().delete(object.storageKey);
    }
  }
}

/** Decrypts and validates an archive in memory only; it never writes household data. */
export function previewPortableArchive(serialized: unknown, passphrase: string) {
  if (!isEncryptedPortableArchive(serialized)) throw new AppError("archive_invalid", "That export has an invalid format", 422);
  rejectOversizedCiphertext(serialized);
  let plaintext: Buffer;
  try { plaintext = decryptPortableArchive(serialized, passphrase); } catch { throw new AppError("archive_passphrase_invalid", "The passphrase or archive is invalid", 422); }
  try {
    if (plaintext.length > MAX_ARCHIVE_BYTES) throw new AppError("archive_too_large", "That export is too large", 413);
    const payload = JSON.parse(plaintext.toString("utf8")) as { format?: string; version?: number; household?: { name?: unknown }; sections?: unknown[]; items?: unknown[]; documents?: unknown[] };
    if (payload.format !== "orbit-portable-archive" || payload.version !== 1 || !payload.household || typeof payload.household.name !== "string" || !Array.isArray(payload.sections) || !Array.isArray(payload.items) || !Array.isArray(payload.documents)) throw new AppError("archive_invalid", "That export is not a supported Orbit archive", 422);
    return { householdName: payload.household.name, sections: payload.sections.length, items: payload.items.length, documents: payload.documents.length };
  } finally { plaintext.fill(0); }
}

// A schema failure whose only issues are required text fields coming back
// empty is not an unrecognized file — it is this exact format, produced
// while the household's encryption key was locked (A2-F2). Telling the two
// apart means a person who hits this is pointed at unlocking the key and
// re-exporting, rather than being told their archive is unsupported.
function isEmptyRequiredFieldsFailure(error: unknown): boolean {
  return error instanceof z.ZodError
    && error.issues.length > 0
    && error.issues.every((issue) => issue.code === "too_small" && issue.origin === "string" && issue.minimum === 1);
}

// A date that is not a real day is told apart from a file that is not this
// format (#1333): the person is pointed at the file having been edited, rather
// than at the archive being unsupported.
function isBadDateFailure(error: unknown): boolean {
  return error instanceof z.ZodError && error.issues.some((issue) => issue.code === "custom" && issue.message === CALENDAR_DATE_MESSAGE);
}

function decodeImportArchive(serialized: unknown, passphrase: string) {
  if (!isEncryptedPortableArchive(serialized)) throw new AppError("archive_invalid", "That export has an invalid format", 422);
  rejectOversizedCiphertext(serialized);
  let plaintext: Buffer;
  try { plaintext = decryptPortableArchive(serialized, passphrase); } catch { throw new AppError("archive_passphrase_invalid", "The passphrase or archive is invalid", 422); }
  try {
    if (plaintext.length > MAX_ARCHIVE_BYTES) throw new AppError("archive_too_large", "That export is too large", 413);
    return importedArchiveSchema.parse(JSON.parse(plaintext.toString("utf8")));
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (isEmptyRequiredFieldsFailure(error)) {
      throw new AppError(
        "archive_fields_empty",
        "That export has empty required fields, most likely because the encryption key was locked when it was made. Unlock the key and export again.",
        422,
      );
    }
    if (isBadDateFailure(error)) {
      throw new AppError(
        "archive_date_invalid",
        "That export has a date that is not a real calendar day, so Orbit will not import it. An export Orbit made never has one; check the file has not been edited.",
        422,
      );
    }
    throw new AppError("archive_invalid", "That export is not a supported Orbit archive", 422);
  } finally { plaintext.fill(0); }
}

/**
 * Which of `references` the household already holds, as normalised strings
 * (ADR-0024 decision 2).
 *
 * The plaintext `items.reference` column is cleared the moment a row is
 * encrypted, so an encrypted row is found only through `reference_index` —
 * an HMAC-SHA-256 keyed by a derivation of the household DEK. Take the index
 * away and duplicate detection stops finding anything the application wrote.
 * The second query is the dual-read leg for rows the backfill has not reached
 * yet, and it goes away with the plaintext column in the contract release.
 */
async function existingReferenceMatches(
  executor: MetadataExecutor,
  householdId: string,
  references: Array<string | null | undefined>,
): Promise<Set<string>> {
  const found = new Set<string>();
  const wanted = new Set<string>();
  for (const reference of references) {
    const normalized = normalizeComparableMetadata(reference);
    if (normalized) wanted.add(normalized);
  }
  if (wanted.size === 0) return found;

  const metadata = await openMetadataReader(householdId, executor);
  if (!metadata.locked) {
    const byDigest = new Map<string, string>();
    for (const normalized of wanted) {
      const digest = metadata.referenceIndex(normalized);
      if (digest) byDigest.set(digest, normalized);
    }
    if (byDigest.size > 0) {
      const rows = await executor.select({ referenceIndex: items.referenceIndex }).from(items)
        .where(and(eq(items.householdId, householdId), inArray(items.referenceIndex, [...byDigest.keys()])));
      for (const row of rows) {
        const normalized = row.referenceIndex ? byDigest.get(row.referenceIndex) : undefined;
        if (normalized) found.add(normalized);
      }
    }
  }

  const remaining = await executor.select({ reference: items.reference }).from(items)
    .where(and(eq(items.householdId, householdId), isNotNull(items.reference)));
  for (const row of remaining) {
    const normalized = normalizeComparableMetadata(row.reference);
    if (normalized && wanted.has(normalized)) found.add(normalized);
  }
  return found;
}

/**
 * Title matching now compares decrypted titles (#963): `items.title` is Tier 2,
 * not Tier 3 as this comment used to say, so the caller decrypts the
 * household's titles before handing them here. It already reads every item in
 * the household, so nothing is lost by comparing in the application.
 */
function duplicatesExistingItem(
  source: { title: string; reference?: string | null },
  existingTitles: Array<{ title: string }>,
  duplicateReferences: Set<string>,
): boolean {
  const normalized = normalizeComparableMetadata(source.reference);
  if (normalized && duplicateReferences.has(normalized)) return true;
  return existingTitles.some((candidate) => candidate.title.toLowerCase() === source.title.toLowerCase());
}

/**
 * The household's item titles, decrypted (#963). A locked instance yields the
 * plaintext of any row the backfill has not reached and nothing for the rest,
 * which is the correct conservative answer: an unreadable title cannot be
 * shown to be a duplicate, so the import proceeds rather than being blocked by
 * a comparison nobody can make.
 */
async function existingItemTitles(
  executor: MetadataExecutor,
  householdId: string,
): Promise<Array<{ title: string }>> {
  const rows = await executor.select({ id: items.id, title: items.title, titleEnc: items.titleEnc })
    .from(items).where(eq(items.householdId, householdId));
  const metadata = await openMetadataReader(householdId, executor);
  return rows.flatMap((row) => {
    const title = metadata.text("items.title", row.id, { encrypted: row.titleEnc, plaintext: row.title }).value;
    return title ? [{ title }] : [];
  });
}

export async function previewPortableImport(userId: string, householdId: string, serialized: unknown, passphrase: string) {
  await requireHouseholdAccess(userId, householdId);
  const archive = decodeImportArchive(serialized, passphrase);
  const existing = await existingItemTitles(getDb(), householdId);
  const duplicateReferences = await existingReferenceMatches(getDb(), householdId, archive.items.map((item) => item.reference));
  const conflicts = archive.items.filter((item) => duplicatesExistingItem(item, existing, duplicateReferences)).map((item) => ({ id: item.id, title: item.title }));
  const documentBytesById = new Set((archive.documentBytes ?? []).map((entry) => entry.id));
  // True whenever at least one live document has no matching bytes in this
  // archive — a metadata-only export, or a mixed one where some bytes were
  // dropped. Which specific duplicates the person will skip is not known
  // yet, so this is a "some documents may not come back" signal, not a count.
  const documentsExcluded = archive.documents.some((document) => document.lifecycle === "available" && !documentBytesById.has(document.id));
  return { householdName: archive.household.name, sections: archive.sections.length, items: archive.items.length, documents: archive.documents.length, conflicts, documentsExcluded };
}

/**
 * Past this age an unfinished import row (`finished_at` still null) is not a
 * concurrent request in flight -- it is a crash or timeout mid-restore
 * (#1151 RANGE-R2). Deliberately generous: the document-restore loop can
 * legitimately take a while for a large archive, and rolling back a request
 * that is merely slow would be worse than leaving it a little longer.
 */
const STALE_UNFINISHED_IMPORT_MS = 60 * 60 * 1_000;

function documentStorage(): LocalDocumentStorage {
  const config = getDocumentConfig();
  return new LocalDocumentStorage(config.storageRoot, config.quarantineRoot);
}

/** Why a document restore failed, in words the admin can act on without a stack trace. */
function documentFailureReason(error: unknown): string {
  if (error instanceof AppError && error.code === "document_malware_detected") return "malware was detected in that file";
  if (error instanceof AppError) return error.message;
  return "the document could not be restored";
}

/**
 * Undoes exactly what one import row recorded: the documents it restored for
 * its created items, those items, and any section it created that holds no
 * other item. Idempotent -- a row that is missing or already finished is a
 * no-op, so calling this twice (a retry racing the boot-time sweep) is safe.
 *
 * Mirrors `hardDeleteHousehold` (household-lifecycle.ts): database rows go
 * first, inside the transaction that also closes the import row, and the
 * encrypted ciphertext is deleted from local storage afterwards, tolerantly
 * -- a failed local delete leaves only an orphaned blob, never a dangling
 * database reference.
 */
export async function rollBackPortableImport(importId: string): Promise<void> {
  const outcome = await getDb().transaction(async (transaction) => {
    const [importRow] = await transaction.select().from(portableArchiveImports)
      .where(eq(portableArchiveImports.id, importId)).limit(1);
    if (!importRow || importRow.finishedAt) return undefined;

    const createdItemIds: string[] = importRow.createdItemIds ?? [];
    const createdSectionIds: string[] = importRow.createdSectionIds ?? [];

    const documentRows = createdItemIds.length > 0
      ? await transaction.select({ documentId: documents.id, storageKey: documentCrypto.storageKey })
          .from(documents)
          .leftJoin(documentCrypto, eq(documentCrypto.documentId, documents.id))
          .where(inArray(documents.itemId, createdItemIds))
      : [];
    if (documentRows.length > 0) {
      await transaction.delete(documents).where(inArray(documents.id, documentRows.map((row) => row.documentId)));
    }
    if (createdItemIds.length > 0) {
      await transaction.delete(items).where(inArray(items.id, createdItemIds));
    }

    let sectionsRemoved = 0;
    for (const sectionId of createdSectionIds) {
      const [remainingItem] = await transaction.select({ id: items.id }).from(items).where(eq(items.sectionId, sectionId)).limit(1);
      if (!remainingItem) {
        await transaction.delete(sections).where(eq(sections.id, sectionId));
        sectionsRemoved++;
      }
    }

    await transaction.insert(auditLog).values({
      householdId: importRow.householdId,
      actorUserId: importRow.actorUserId,
      entityType: "portable_archive",
      entityId: importId,
      action: "portable_archive_import_rolled_back",
      changes: { itemsRemoved: createdItemIds.length, sectionsRemoved, documentsRemoved: documentRows.length },
    });
    await transaction.update(portableArchiveImports).set({ finishedAt: new Date(), outcome: "rolled_back" })
      .where(eq(portableArchiveImports.id, importId));

    return { documentStorageKeys: documentRows.flatMap((row) => row.storageKey ? [row.storageKey] : []) };
  });
  if (!outcome) return;

  // Database access to these documents is already gone; a failed local
  // delete here leaves an orphan blob, never a row pointing at missing bytes.
  const storage = documentStorage();
  const results = await Promise.allSettled(outcome.documentStorageKeys.map((storageKey) => storage.deleteCiphertext(storageKey)));
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length > 0) {
    log.error({
      event: "portable_archive.import",
      state: "degraded",
      reason: "unexpected_failure",
      action: "inspect_admin_diagnostics",
      impact: "application_degraded",
      detail: operationalDetail`${importId}.ciphertext_cleanup`,
    });
  }
}

/** Rolls back every import row a crash left open, oldest first. One row's failure does not stop the rest. */
export async function rollBackUnfinishedPortableImports(): Promise<void> {
  const unfinished = await getDb().select({ id: portableArchiveImports.id }).from(portableArchiveImports)
    .where(isNull(portableArchiveImports.finishedAt)).orderBy(asc(portableArchiveImports.startedAt));
  for (const row of unfinished) {
    try {
      await rollBackPortableImport(row.id);
    } catch (error) {
      log.error({
        event: "portable_archive.import",
        state: "degraded",
        reason: "unexpected_failure",
        action: "inspect_admin_diagnostics",
        impact: "application_degraded",
        detail: operationalDetail`${row.id}.${error instanceof Error ? error.name : "unknown"}`,
      });
    }
  }
}

/** Rolls back this household's own stranded import before starting a new one, if it is old enough to be a crash rather than a concurrent request. */
async function rollBackStaleUnfinishedPortableImport(householdId: string): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_UNFINISHED_IMPORT_MS);
  const stale = await getDb().select({ id: portableArchiveImports.id }).from(portableArchiveImports)
    .where(and(eq(portableArchiveImports.householdId, householdId), isNull(portableArchiveImports.finishedAt), lt(portableArchiveImports.startedAt, cutoff)));
  for (const row of stale) await rollBackPortableImport(row.id);
}

/**
 * Imports normalized metadata atomically, then restores any documents whose
 * bytes travelled with the archive (A2-S2) through the same upload path —
 * same validation, malware scan and encryption — a direct upload takes.
 * Document restoration happens after the metadata transaction commits,
 * because `uploadItemDocument` manages its own scan/encrypt transactions and
 * must see the newly imported items already committed.
 *
 * The whole import is all-or-nothing (#1151 RANGE-R2): a `portable_archive_imports`
 * row is opened inside the metadata transaction, recording exactly what it
 * created, and a document that fails to restore -- for any reason, including
 * an infected upload -- rolls everything back and throws, rather than leaving
 * items with some of their documents permanently unrestorable (a prior
 * attempt at this mapped skipped duplicates onto existing items instead; the
 * owner rejected that, because a retry must either finish the whole import or
 * leave nothing behind to retry against).
 */
export async function importPortableArchive(input: { userId: string; householdId: string; archive: unknown; passphrase: string; conflictItemIds: string[] }) {
  await requireHouseholdAccess(input.userId, input.householdId);
  await rollBackStaleUnfinishedPortableImport(input.householdId);
  const archive = decodeImportArchive(input.archive, input.passphrase);
  const skipped = new Set(input.conflictItemIds);
  const documentBytesById = new Map((archive.documentBytes ?? []).map((entry) => [entry.id, entry.contentBase64]));
  const importId = randomUUID();
  const importStartedAt = new Date();
  const { imported, itemIdMap } = await getDb().transaction(async (transaction) => {
    await acquireActiveHouseholdLock(transaction, input.householdId);
    const existingSections = await transaction.select({ id: sections.id, slug: sections.slug }).from(sections).where(eq(sections.householdId, input.householdId));
    const sectionMap = new Map<string, string>();
    const createdSectionIds: string[] = [];
    for (const source of archive.sections) {
      const current = existingSections.find((section) => section.slug === source.slug);
      const id = current?.id ?? randomUUID();
      if (!current) {
        await transaction.insert(sections).values({ id, householdId: input.householdId, slug: source.slug, name: source.name, icon: source.icon, accent: source.accent, position: source.position, visible: source.visible, archivedAt: source.archivedAt ? new Date(source.archivedAt) : null });
        createdSectionIds.push(id);
      }
      sectionMap.set(source.id, id);
    }
    const existing = await existingItemTitles(transaction, input.householdId);
    const duplicateReferences = await existingReferenceMatches(transaction, input.householdId, archive.items.map((item) => item.reference));
    const metadata = await requireMetadataWriter(input.householdId, transaction);
    const itemIdMap = new Map<string, string>();
    let count = 0;
    for (const source of archive.items) {
      const duplicate = duplicatesExistingItem(source, existing, duplicateReferences);
      if (duplicate && !skipped.has(source.id)) throw new AppError("archive_conflict_unresolved", "Review every duplicate before importing", 409);
      if (duplicate || !sectionMap.has(source.sectionId)) continue;
      const itemId = randomUUID();
      await transaction.insert(items).values({ id: itemId, householdId: input.householdId, sectionId: sectionMap.get(source.sectionId)!, title: null, titleEnc: metadata.encryptText("items.title", itemId, source.title), subtype: source.subtype ?? null, provider: null, providerEnc: metadata.encryptText("items.provider", itemId, source.provider), reference: null, referenceEnc: metadata.encryptText("items.reference", itemId, source.reference), referenceIndex: metadata.referenceIndex(source.reference), costMinor: null, costMinorEnc: metadata.encryptNumber("items.cost_minor", itemId, source.costMinor), currency: source.currency, startDate: source.startDate ?? null, expiryDate: source.expiryDate ?? null, renewalDate: source.renewalDate ?? null, serviceDate: source.serviceDate ?? null, recurrenceMonths: source.recurrenceMonths ?? null, snoozedUntil: source.snoozedUntil ?? null, notes: null, notesEnc: metadata.encryptText("items.notes", itemId, source.notes), externalDocumentUrl: source.externalDocumentUrl ?? null, status: source.status });
      itemIdMap.set(source.id, itemId);
      count++;
    }
    const restorableDocuments = archive.documents.filter((document) => document.lifecycle === "available" && document.itemId && itemIdMap.has(document.itemId) && documentBytesById.has(document.id));
    await transaction.insert(portableArchiveImports).values({
      id: importId,
      householdId: input.householdId,
      actorUserId: input.userId,
      startedAt: importStartedAt,
      finishedAt: null,
      createdSectionIds,
      createdItemIds: Array.from(itemIdMap.values()),
    });
    await transaction.insert(auditLog).values({ householdId: input.householdId, actorUserId: input.userId, entityType: "portable_archive", entityId: randomUUID(), action: "portable_archive_imported", changes: { importedItems: count, skippedConflicts: skipped.size, documentsTotal: archive.documents.length, documentsRestorable: restorableDocuments.length } });
    return { imported: count, itemIdMap };
  });

  // Outside the metadata transaction: `uploadItemDocument` runs its own
  // scan/encrypt transactions and must see the items above as committed. A
  // document that fails to restore now aborts the whole import (#1151
  // RANGE-R2): anything restoring unattended, mid-crash, cannot be retried
  // piecemeal, so it is undone instead of left half-done.
  let documentsRestored = 0;
  for (const document of archive.documents) {
    if (document.lifecycle !== "available" || !document.itemId) continue;
    const targetItemId = itemIdMap.get(document.itemId);
    const contentBase64 = documentBytesById.get(document.id);
    if (!targetItemId || !contentBase64) continue;
    const bytes = Buffer.from(contentBase64, "base64");
    try {
      await uploadItemDocument({
        userId: input.userId,
        householdId: input.householdId,
        itemId: targetItemId,
        filename: document.displayName,
        body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
        declaredBytes: bytes.length,
      });
      documentsRestored++;
    } catch (error) {
      await rollBackPortableImport(importId);
      throw new AppError(
        "archive_import_failed",
        `Nothing was imported: restoring "${document.displayName}" failed because ${documentFailureReason(error)}. Fix the problem and try the import again.`,
        422,
      );
    } finally {
      bytes.fill(0);
    }
  }
  await getDb().update(portableArchiveImports).set({ finishedAt: new Date(), outcome: "completed" }).where(eq(portableArchiveImports.id, importId));
  return { importedItems: imported, documentsExcluded: archive.documents.length - documentsRestored };
}
