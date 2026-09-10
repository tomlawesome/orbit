import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog, documents, dueEvents, households, items, memberships, portableArchives, reminderRules, sections, users } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { optionalText } from "@/lib/workspace";
import { getDocumentConfig } from "@/server/documents/config";
import { readDocumentDownload } from "@/server/document-repository";
import { decryptPortableArchive, encryptPortableArchive, isEncryptedPortableArchive, type EncryptedPortableArchive } from "@/server/portable-archive";
import { PortableArchiveStorage } from "@/server/portable-archive-storage";
import { normalizeComparableMetadata } from "@/server/metadata/crypto";
import { openMetadataReader, requireMetadataWriter, type MetadataExecutor } from "@/server/metadata/fields";
import { acquireActiveHouseholdLock } from "@/server/workspace-access";

const ARCHIVE_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;

const importedSectionSchema = z.object({ id: z.string().uuid(), slug: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(100), icon: z.string().trim().min(1).max(50), accent: z.string().trim().min(1).max(50), position: z.number().int().min(0).max(10_000), visible: z.boolean() });
// Field caps deliberately mirror `workspaceItemSchema` (src/lib/workspace.ts):
// the read path re-validates every persisted item against that schema, so an
// imported field this schema accepts but the reader rejects would insert a
// row that 422s `readWorkspace` forever afterwards, with no in-product
// recovery (#383 finding 2).
const importedItemSchema = z.object({ id: z.string().uuid(), sectionId: z.string().uuid(), title: z.string().trim().min(1).max(100), subtype: optionalText(80).nullable(), provider: optionalText(100).nullable(), reference: optionalText(80).nullable(), costMinor: z.number().int().min(0).max(100_000_000).nullable().optional(), currency: z.string().length(3), startDate: z.string().nullable().optional(), expiryDate: z.string().nullable().optional(), renewalDate: z.string().nullable().optional(), serviceDate: z.string().nullable().optional(), recurrenceMonths: z.number().int().min(1).max(120).nullable().optional(), snoozedUntil: z.string().nullable().optional(), notes: optionalText(2_000).nullable(), externalDocumentUrl: z.string().nullable().optional(), status: z.enum(["active", "expired", "cancelled", "archived"]) });
// `.max(500)` mirrors `householdWorkspaceSchema.items` so an archive that
// parses cleanly here cannot still brick the household by count alone.
const importedArchiveSchema = z.object({ format: z.literal("orbit-portable-archive"), version: z.literal(1), household: z.object({ name: z.string().trim().min(1).max(100) }), sections: z.array(importedSectionSchema).max(200), items: z.array(importedItemSchema).max(500), dueEvents: z.array(z.unknown()).optional(), reminderRules: z.array(z.unknown()).optional(), documents: z.array(z.unknown()) });

function storage(): PortableArchiveStorage {
  return new PortableArchiveStorage(`${getDocumentConfig().storageRoot}/portable-archives`);
}

async function requireHouseholdAccess(userId: string, householdId: string) {
  const [access] = await getDb().select({ id: households.id, administrator: users.isInstanceAdmin, membershipUserId: memberships.userId })
    .from(households).innerJoin(users, eq(users.id, userId))
    .leftJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.householdId, households.id)))
    .where(and(eq(households.id, householdId), isNull(households.deletionRequestedAt))).limit(1);
  if (!access || (!access.administrator && !access.membershipUserId)) {
    throw new AppError("household_not_found", "That household is not available", 404);
  }
  return access;
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

// Base64url has no padding, so this is the exact maximum encoded length for
// a ciphertext that could decode to at most MAX_ARCHIVE_BYTES (AES-256-GCM
// ciphertext is the same length as its plaintext; the auth tag is carried
// separately). Checking this before any crypto work means an oversized
// archive is rejected before scryptSync or the cipher ever runs, instead of
// only after `decryptPortableArchive` has already materialised the full
// plaintext into memory (#383 finding 3).
const MAX_ARCHIVE_CIPHERTEXT_CHARACTERS = Math.ceil(MAX_ARCHIVE_BYTES / 3) * 4;

function rejectOversizedCiphertext(archive: EncryptedPortableArchive): void {
  if (archive.ciphertext.length > MAX_ARCHIVE_CIPHERTEXT_CHARACTERS) {
    throw new AppError("archive_too_large", "That export is too large", 413);
  }
}

/** Builds a normalized, household-scoped payload. Document bytes are opt-in and bounded. */
export async function createPortableArchive(input: {
  userId: string;
  householdId: string;
  passphrase: string;
  includeDocuments: boolean;
}): Promise<{ id: string; expiresAt: string; includesDocuments: boolean }> {
  await requireHouseholdAccess(input.userId, input.householdId);
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
    db.select().from(documents).where(and(eq(documents.householdId, input.householdId), inArray(documents.lifecycle, ["available", "pending_deletion"]))),
  ]);
  if (!household) throw new AppError("household_not_found", "That household is not available", 404);
  // The portable archive is the deliberate plaintext escape hatch (ADR-0024
  // decision 6): it exports decrypted values, and therefore needs the KEK.
  const metadata = await openMetadataReader(input.householdId);
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
  return { householdName: archive.household.name, sections: archive.sections.length, items: archive.items.length, documents: archive.documents.length, conflicts, documentsExcluded: archive.documents.length > 0 };
}

/** Imports normalized metadata atomically. Attachments are deliberately excluded until they pass normal scan/encryption. */
export async function importPortableArchive(input: { userId: string; householdId: string; archive: unknown; passphrase: string; conflictItemIds: string[] }) {
  await requireHouseholdAccess(input.userId, input.householdId);
  const archive = decodeImportArchive(input.archive, input.passphrase);
  const skipped = new Set(input.conflictItemIds);
  const imported = await getDb().transaction(async (transaction) => {
    await acquireActiveHouseholdLock(transaction, input.householdId);
    const existingSections = await transaction.select({ id: sections.id, slug: sections.slug }).from(sections).where(eq(sections.householdId, input.householdId));
    const sectionMap = new Map<string, string>();
    for (const source of archive.sections) {
      const current = existingSections.find((section) => section.slug === source.slug);
      const id = current?.id ?? randomUUID();
      if (!current) await transaction.insert(sections).values({ id, householdId: input.householdId, slug: source.slug, name: source.name, icon: source.icon, accent: source.accent, position: source.position, visible: source.visible });
      sectionMap.set(source.id, id);
    }
    const existing = await existingItemTitles(transaction, input.householdId);
    const duplicateReferences = await existingReferenceMatches(transaction, input.householdId, archive.items.map((item) => item.reference));
    const metadata = await requireMetadataWriter(input.householdId, transaction);
    let count = 0;
    for (const source of archive.items) {
      const duplicate = duplicatesExistingItem(source, existing, duplicateReferences);
      if (duplicate && !skipped.has(source.id)) throw new AppError("archive_conflict_unresolved", "Review every duplicate before importing", 409);
      if (duplicate || !sectionMap.has(source.sectionId)) continue;
      const itemId = randomUUID();
      await transaction.insert(items).values({ id: itemId, householdId: input.householdId, sectionId: sectionMap.get(source.sectionId)!, title: null, titleEnc: metadata.encryptText("items.title", itemId, source.title), subtype: source.subtype ?? null, provider: null, providerEnc: metadata.encryptText("items.provider", itemId, source.provider), reference: null, referenceEnc: metadata.encryptText("items.reference", itemId, source.reference), referenceIndex: metadata.referenceIndex(source.reference), costMinor: null, costMinorEnc: metadata.encryptNumber("items.cost_minor", itemId, source.costMinor), currency: source.currency, startDate: source.startDate ?? null, expiryDate: source.expiryDate ?? null, renewalDate: source.renewalDate ?? null, serviceDate: source.serviceDate ?? null, recurrenceMonths: source.recurrenceMonths ?? null, snoozedUntil: source.snoozedUntil ?? null, notes: null, notesEnc: metadata.encryptText("items.notes", itemId, source.notes), externalDocumentUrl: source.externalDocumentUrl ?? null, status: source.status });
      count++;
    }
    await transaction.insert(auditLog).values({ householdId: input.householdId, actorUserId: input.userId, entityType: "portable_archive", entityId: randomUUID(), action: "portable_archive_imported", changes: { importedItems: count, skippedConflicts: skipped.size, documentsExcluded: archive.documents.length } });
    return count;
  });
  return { importedItems: imported, documentsExcluded: archive.documents.length };
}
