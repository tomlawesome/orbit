import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, documents, dueEvents, households, items, memberships, portableArchives, reminderRules, sections, users } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { getDocumentConfig } from "@/server/documents/config";
import { readDocumentDownload } from "@/server/document-repository";
import { encryptPortableArchive, type EncryptedPortableArchive } from "@/server/portable-archive";
import { PortableArchiveStorage } from "@/server/portable-archive-storage";

const ARCHIVE_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;

function storage(): PortableArchiveStorage {
  return new PortableArchiveStorage(`${getDocumentConfig().storageRoot}/portable-archives`);
}

async function requireHouseholdAccess(userId: string, householdId: string) {
  const [access] = await getDb().select({ id: households.id, administrator: users.isInstanceAdmin, membershipUserId: memberships.userId })
    .from(households).innerJoin(users, eq(users.id, userId))
    .leftJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.householdId, households.id)))
    .where(eq(households.id, householdId)).limit(1);
  if (!access || (!access.administrator && !access.membershipUserId)) {
    throw new AppError("household_not_found", "That household is not available", 404);
  }
  return access;
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
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

  const payload: Record<string, unknown> = {
    format: "orbit-portable-archive",
    version: 1,
    exportedAt: new Date().toISOString(),
    household: { id: household.id, name: household.name, timezone: household.timezone, defaultCurrency: household.defaultCurrency },
    sections: householdSections.map((section) => ({ id: section.id, slug: section.slug, name: section.name, icon: section.icon, accent: section.accent, position: section.position, visible: section.visible, archivedAt: section.archivedAt })),
    items: householdItems.map((item) => ({ id: item.id, sectionId: item.sectionId, title: item.title, subtype: item.subtype, provider: item.provider, reference: item.reference, costMinor: item.costMinor, currency: item.currency, startDate: item.startDate, expiryDate: item.expiryDate, renewalDate: item.renewalDate, serviceDate: item.serviceDate, recurrenceMonths: item.recurrenceMonths, snoozedUntil: item.snoozedUntil, notes: item.notes, externalDocumentUrl: item.externalDocumentUrl, status: item.status, version: item.version })),
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
    await storage().write(storageKey, contents);
    await db.transaction(async (transaction) => {
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
  await requireHouseholdAccess(userId, archive.householdId);
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
