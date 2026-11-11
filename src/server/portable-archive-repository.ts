import { createHash, randomBytes, randomUUID } from "node:crypto";
import { statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { auditLog, documentCrypto, documents, documentStagingObjects, dueEvents, households, items, portableArchiveImports, portableArchives, reminderRules, sections, } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { householdOwnerLockKey } from "@/lib/auth/authority-locks";
import { CALENDAR_DATE_MESSAGE, calendarDate } from "@/lib/calendar-date";
import { COST_MINOR_MAX, NOTES_MAX, PROVIDER_MAX, RECURRENCE_MAX, REFERENCE_MAX, sectionAccents, sectionColours, sectionIcons, SUBTYPE_MAX, TITLE_MAX } from "@/lib/domain";
import { log, operationalDetail } from "@/lib/logger";
import { MIN_PASSWORD_LENGTH, passwordLength } from "@/lib/password-length";
import { currencyCode } from "@/lib/platform-lists";
import { optionalText } from "@/lib/workspace";
import { DOCUMENT_MAX_BYTES_CEILING, getDocumentConfig } from "@/server/documents/config";
import { openDocumentStorage } from "@/server/documents/storage";
import { PDF_STORED_MAX_PAGES } from "@/server/documents/validation";
import { openContentHash } from "@/server/documents/content-hash";
import { openDocumentDownload, uploadItemDocument } from "@/server/document-repository";
import { isEncryptedPortableArchive, PortableArchiveOpener } from "@/server/portable-archive";
import { ARCHIVE_MAGIC, deriveArchiveKey, encodeHeader, HEADER_BYTES, segmentCount, SegmentReader, SegmentWriter } from "@/server/portable-archive-container";
import { Base64Decoder, Base64Text, PayloadScratch, PayloadSyntaxError, readEnvelope, readManifest, readPayload, streamSource, sweepPayloadScratch, type Base64Sink, type ByteSource } from "@/server/portable-archive-payload";
import { readEffectiveArchiveRetention } from "@/server/archive-retention";
import { PortableArchiveStorage, type SpooledUpload } from "@/server/portable-archive-storage";
import { normalizeComparableMetadata } from "@/server/metadata/crypto";
import { MetadataCipher, openMetadataReader, requireMetadataWriter, type MetadataExecutor } from "@/server/metadata/fields";
import { loadMetadataKey, metadataCryptoAvailable, MetadataKeyLockedError, receiptKeyScope } from "@/server/metadata/keys";
import { maxArchiveFileBytes, MAX_MANIFEST_BYTES, PORTABLE_IMPORT_LEASE_MS, SEGMENT_BYTES, V1_MAX_ARCHIVE_BYTES, V1_MAX_ARCHIVE_CIPHERTEXT_CHARACTERS, V1_MAX_ARCHIVE_FILE_BYTES } from "@/server/portable-archive-limits";
import { acquireActiveHouseholdLock, requireHouseholdAccess } from "@/server/workspace-access";

/* How long an export is kept, how many a household keeps and the space for
   them all are the administrator's three settings (#1792,
   src/server/archive-retention.ts), read once per export. */

// Name, icon and accent mirror `workspaceSectionSchema` (src/lib/workspace.ts)
// for the same reason as the item caps below: the reader re-validates every
// stored section, so a looser value here would make the household unreadable.
const importedSectionSchema = z.object({ id: z.string().uuid(), slug: z.string().trim().min(1).max(100), name: z.string().trim().min(1).max(30), icon: z.enum(sectionIcons), accent: z.enum(sectionAccents), colour: z.enum(sectionColours).nullable().optional(), position: z.number().int().min(0).max(10_000), visible: z.boolean(), archivedAt: z.string().nullable().optional() });
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
  importance: z.enum(["low", "normal", "high"]).nullable().optional(),
  status: z.enum(["active", "expired", "cancelled", "archived"]),
});
// Only the fields the import path cross-references (which item a document
// belongs to, its lifecycle, and what to call it on re-upload); every other
// exported document field is carried for round-tripping and left untyped.
const importedDocumentSchema = z.object({ id: z.string().uuid(), itemId: z.string().uuid().nullable(), displayName: z.string().trim().min(1), lifecycle: z.string() }).passthrough();
// The base64 stays in the payload file (#1521); `Base64Text` says where.
const importedDocumentBytesSchema = z.object({ id: z.string().uuid(), contentBase64: z.instanceof(Base64Text) });
// `.max(12)` and `.max(500)` mirror `householdWorkspaceSchema.sections` and
// `.items` so an archive that parses cleanly here cannot still brick the
// household by count alone.
const MAX_SECTIONS_PER_HOUSEHOLD = 12;
const importedArchiveSchema = z.object({ format: z.literal("orbit-portable-archive"), version: z.literal(1), household: z.object({ name: z.string().trim().min(1).max(100) }), sections: z.array(importedSectionSchema).max(MAX_SECTIONS_PER_HOUSEHOLD), items: z.array(importedItemSchema).max(500), dueEvents: z.array(z.unknown()).optional(), reminderRules: z.array(z.unknown()).optional(), documents: z.array(importedDocumentSchema), documentBytes: z.array(importedDocumentBytesSchema).optional() });

// Format v2 (#1390): the v1 payload's fields, version 2, the documents' bytes
// not inside it but after it, in `body` order, each with its length and hash.
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const importedBodySchema = z.object({ id: z.string().uuid(), sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), contentSha256: z.string().regex(SHA256_HEX) });
const importedManifestSchema = z.object({ format: z.literal("orbit-portable-archive"), version: z.literal(2), household: z.object({ name: z.string().trim().min(1).max(100) }), sections: z.array(importedSectionSchema).max(MAX_SECTIONS_PER_HOUSEHOLD), items: z.array(importedItemSchema).max(500), dueEvents: z.array(z.unknown()).optional(), reminderRules: z.array(z.unknown()).optional(), documents: z.array(importedDocumentSchema), body: z.array(importedBodySchema) });

function storage(): PortableArchiveStorage {
  return new PortableArchiveStorage(`${getDocumentConfig().storageRoot}/portable-archives`);
}

/**
 * Whether this person may write the household out or bring an archive in,
 * answered before anyone is asked to prove it is them (#1132): a person who
 * may not do the act at all is told that, rather than being challenged and
 * then refused. Both acts are the owner's (#1049; import since 2026-10-14,
 * #1316): `act` only names which one the route is taking.
 * `createPortableArchive`, `previewPortableImport` and `importPortableArchive`
 * check again, so nothing relies on a route having called this.
 */
export async function requirePortableArchiveAccess(
  userId: string,
  householdId: string,
  _act: "export" | "import",
): Promise<void> {
  await requireHouseholdAccess(userId, householdId, true);
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
 * read of such a household is fine -- it has never written an encrypted
 * value, so it has none to read. The same is true of its export. The refusal belongs to the key that exists but
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

/**
 * Writes the household out as a format v2 archive (#1390, ADR-0045): the
 * manifest (every row, normalised and decrypted) then, when asked for, every
 * bound document's own bytes, sealed segment by segment straight to a
 * private temporary file that is renamed into place once complete. Bounded
 * by disk, not memory: one segment and one document piece are held at a
 * time, whatever the household holds.
 */
export async function createPortableArchive(input: {
  userId: string;
  householdId: string;
  passphrase: string;
  includeDocuments: boolean;
}): Promise<{ id: string; expiresAt: string; includesDocuments: boolean; keepPerHousehold: number }> {
  await requireHouseholdAccess(input.userId, input.householdId, true);
  // The floor is held when an archive is made (#1333), counted as a person
  // counts, so a passphrase the route's own length check let through is still
  // refused in words rather than failing as a fault inside the cipher.
  if (passwordLength(input.passphrase) < MIN_PASSWORD_LENGTH) {
    throw new AppError("archive_passphrase_too_short", `Use an export passphrase of at least ${MIN_PASSWORD_LENGTH} characters`, 422);
  }
  const db = getDb();
  // One snapshot for every read (#1390 review, ruling 8): REPEATABLE READ and
  // read-only, so the rows agree with one another -- a document never ships
  // without its item, whatever commits while the export reads. The documents'
  // bytes are read by id afterwards; one deleted meanwhile fails the export.
  const [[household], householdSections, householdItems, events, reminders, documentRows] = await db.transaction(async (snapshot) => Promise.all([
    snapshot.select().from(households).where(eq(households.id, input.householdId)).limit(1),
    snapshot.select().from(sections).where(eq(sections.householdId, input.householdId)).orderBy(asc(sections.position), asc(sections.id)),
    snapshot.select().from(items).where(eq(items.householdId, input.householdId)).orderBy(asc(items.createdAt), asc(items.id)),
    snapshot.select().from(dueEvents).where(eq(dueEvents.householdId, input.householdId)).orderBy(asc(dueEvents.createdAt), asc(dueEvents.id)),
    snapshot.select({
      id: reminderRules.id,
      itemId: reminderRules.itemId,
      daysBefore: reminderRules.daysBefore,
      emailEnabled: reminderRules.emailEnabled,
      pushEnabled: reminderRules.pushEnabled,
    }).from(reminderRules).innerJoin(items, eq(reminderRules.itemId, items.id)).where(eq(items.householdId, input.householdId)).orderBy(asc(items.createdAt), asc(items.id), asc(reminderRules.id)),
    // Bound documents only (#1605 PR-5/PR-52): a staged upload no item has
    // claimed yet is a draft, not the household's, and never ships.
    snapshot.select().from(documents).where(and(eq(documents.householdId, input.householdId), eq(documents.lifecycle, "available"), isNotNull(documents.itemId))).orderBy(asc(documents.createdAt), asc(documents.id)),
  ]), { isolationLevel: "repeatable read", accessMode: "read only" });
  if (!household) throw new AppError("household_not_found", "That household is not available", 404);
  const metadata = await openExportMetadataReader(input.householdId);
  // No key minted is only harmless while nothing was ever encrypted under
  // it. A row carrying ciphertext with no key row to read it (a lost or
  // deleted metadata_keys row, a partial restore) would export blank the
  // same way a locked instance would, so it is refused the same way.
  if (metadata.locked && (householdItems.some((item) => item.titleEnc || item.providerEnc || item.referenceEnc || item.notesEnc || item.costMinorEnc)
    || documentRows.some((document) => document.contentSha256Sealed))) {
    throw archiveMetadataLockedError();
  }
  const exportedItems = householdItems.map((item) => {
    const reference = metadata.text("items.reference", item.id, { encrypted: item.referenceEnc });
    const notes = metadata.text("items.notes", item.id, { encrypted: item.notesEnc });
    // Tier 2 (#963) exports decrypted for the same reason Tier 1 does: the
    // archive is the deliberate plaintext escape hatch, and an archive holding
    // ciphertext nobody outside this instance can open would not be one.
    const title = metadata.text("items.title", item.id, { encrypted: item.titleEnc });
    const provider = metadata.text("items.provider", item.id, { encrypted: item.providerEnc });
    const costMinor = metadata.number("items.cost_minor", item.id, { encrypted: item.costMinorEnc });
    // A field that fails its integrity check would come out blank, and a blank
    // title makes the whole archive unimportable, so the export is refused
    // before anything is written rather than reporting success.
    if ([reference, notes, title, provider, costMinor].some((field) => field.state === "metadata_integrity_failed")) {
      throw new AppError("archive_metadata_damaged", "Orbit can't export: an item's stored details are damaged and would come out blank. Open that item, re-enter the damaged field and save it, then export again.", 409);
    }
    return { ...item, reference: reference.value, notes: notes.value, title: title.value ?? "", provider: provider.value, costMinor: costMinor.value };
  });
  // The archive keeps each document's SHA-256 in plain, inside its own
  // encryption (#1771): sealed in the database, or plain on a row the
  // backfill has not reached. One that will not open is refused, as a
  // damaged item field is, rather than exported as a hash nobody checked.
  const exportedDocumentHashes = new Map<string, string>();
  for (const document of documentRows) {
    const hash = openContentHash(metadata, document.id, { plain: document.contentSha256, sealed: document.contentSha256Sealed });
    if (hash.ok) {
      exportedDocumentHashes.set(document.id, hash.sha256);
      continue;
    }
    if (hash.reason === "metadata_locked") throw archiveMetadataLockedError();
    throw new AppError("archive_metadata_damaged", "Orbit can't export: a document's stored fingerprint is damaged, so its copy could not be vouched for. Remove that document and attach it again, then export again.", 409);
  }

  const manifest: Record<string, unknown> = {
    format: "orbit-portable-archive",
    version: 2,
    exportedAt: new Date().toISOString(),
    household: { id: household.id, name: household.name, timezone: household.timezone, defaultCurrency: household.defaultCurrency },
    sections: householdSections.map((section) => ({ id: section.id, slug: section.slug, name: section.name, icon: section.icon, accent: section.accent, colour: section.colour ?? null, position: section.position, visible: section.visible, archivedAt: section.archivedAt })),
    items: exportedItems.map((item) => ({ id: item.id, sectionId: item.sectionId, title: item.title, subtype: item.subtype, provider: item.provider, reference: item.reference, costMinor: item.costMinor, currency: item.currency, startDate: item.startDate, expiryDate: item.expiryDate, renewalDate: item.renewalDate, serviceDate: item.serviceDate, recurrenceMonths: item.recurrenceMonths, snoozedUntil: item.snoozedUntil, notes: item.notes, externalDocumentUrl: item.externalDocumentUrl, importance: item.importance ?? null, status: item.status, version: item.version })),
    dueEvents: events.map((event) => ({ id: event.id, itemId: event.itemId, kind: event.kind, dueDate: event.dueDate, completedAt: event.completedAt, completionKey: event.completionKey, nextEventId: event.nextEventId })),
    reminderRules: reminders,
    documents: documentRows.map((document) => ({ id: document.id, itemId: document.itemId, displayName: document.displayName, mediaType: document.mediaType, sizeBytes: document.sizeBytes, contentSha256: exportedDocumentHashes.get(document.id), lifecycle: document.lifecycle, scanStatus: document.scanStatus, failureCode: document.failureCode, deleteAfter: document.deleteAfter, deletedAt: document.deletedAt, availableAt: document.availableAt, version: document.version })),
  };
  const included = input.includeDocuments ? documentRows : [];
  manifest.body = included.map((document) => ({ id: document.id, sizeBytes: document.sizeBytes, contentSha256: exportedDocumentHashes.get(document.id) as string }));
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  // The importer reads at most this much manifest; a household whose rows
  // alone pass it could not be brought back, so it is not written.
  // Every refusal before the write zeroes the household's plaintext details
  // first (ruling 7; second review, the manifest cap's early return).
  const refused = (error: unknown) => {
    manifestBytes.fill(0);
    return error;
  };
  if (manifestBytes.length > MAX_MANIFEST_BYTES) {
    throw refused(new AppError("archive_manifest_too_large", "This household's details are too large for an Orbit archive", 413));
  }
  const plaintextBytes = manifestBytes.length + included.reduce((sum, document) => sum + document.sizeBytes, 0);
  const fileBytes = HEADER_BYTES + plaintextBytes + 16 * segmentCount(plaintextBytes);
  // Orbit's own import holds a v2 file to the household quota plus the
  // manifest cap (#1390 review, ruling 6), so a file over it is refused here,
  // before anything is read or written, rather than made and then refused.
  const importCeiling = maxArchiveFileBytes({ householdQuotaBytes: getDocumentConfig().householdQuotaBytes });
  if (fileBytes > importCeiling) throw refused(archiveTooLargeToImportError(fileBytes, importCeiling));
  // Preflight capacity check, then fail closed on ENOSPC: refused before
  // anything is read when the disk cannot hold the file with a margin, so an
  // export never fills the volume every household's uploads share.
  const documentRoot = getDocumentConfig().storageRoot;
  const free = await freeSpaceAt(documentRoot).catch((error: unknown) => { throw refused(error); });
  if (Number(free.bavail) * Number(free.bsize) < fileBytes * 1.01 + 256 * 1_048_576) throw refused(archiveStorageFullError(fileBytes));
  // The space for every household's exports (#1792): one larger than all of
  // it on its own could never be kept, so nothing is written or replaced.
  const retention = await readEffectiveArchiveRetention().catch((error: unknown) => { throw refused(error); });
  if (fileBytes > retention.maxTotalBytes) throw refused(archiveStoreFullError(retention.maxTotalBytes, fileBytes));

  const id = randomUUID();
  const storageKey = storage().createStorageKey();
  const expiresAt = new Date(Date.now() + retention.retentionMs);
  const header = encodeHeader({
    log2N: ARCHIVE_SCRYPT.log2N, r: ARCHIVE_SCRYPT.r, p: ARCHIVE_SCRYPT.p,
    salt: randomBytes(16), noncePrefix: randomBytes(7),
    segmentBytes: SEGMENT_BYTES, manifestBytes: manifestBytes.length, plaintextBytes,
  });
  const key = await deriveArchiveKey(input.passphrase, header.subarray(13, 29), { N: 2 ** ARCHIVE_SCRYPT.log2N, r: ARCHIVE_SCRYPT.r, p: ARCHIVE_SCRYPT.p })
    .catch((error: unknown) => { throw refused(error); });
  let written: { sha256: string; sizeBytes: number };
  try {
    written = await storage().writeStream(storageKey, async (write) => {
      await write(header);
      const writer = new SegmentWriter(header, key, write);
      try {
        await writer.push(manifestBytes);
        // The household's details are sealed: not held a moment longer (ruling 7).
        manifestBytes.fill(0);
        for (const document of included) {
          // Verified, then decrypted in pieces (#1571): never held whole.
          const download = await openDocumentDownload(input.userId, document.id);
          const reader = download.body.getReader();
          let count = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              try {
                count += value.length;
                // Never padded or truncated: a document that is not the size its
                // row records fails the export rather than shifting every body after it.
                if (count > document.sizeBytes) throw archiveIntegrityError();
                await writer.push(value);
              } finally {
                // Decrypted document bytes, used or refused: zeroed (ruling 7).
                value.fill(0);
              }
            }
            if (count !== document.sizeBytes) throw archiveIntegrityError();
          } catch (error) {
            await reader.cancel().catch(() => undefined);
            throw error;
          }
        }
        await writer.finish();
      } finally {
        // On every path; after finish it is already zero.
        writer.dispose();
      }
    });
  } catch (error) {
    throw storageFullError(error, fileBytes);
  } finally {
    key.fill(0);
    manifestBytes.fill(0);
  }
  // Only once the file is safely written are older exports given up, in
  // the transaction that records the new one (#1792), so a failed write
  // never costs anyone an archive.
  let givenUp: string[];
  try {
    givenUp = await db.transaction(async (transaction) => {
      await acquireActiveHouseholdLock(transaction, input.householdId);
      await transaction.insert(portableArchives).values({
        id, householdId: input.householdId, requestedByUserId: input.userId, storageKey,
        contentSha256: written.sha256, sizeBytes: written.sizeBytes,
        includesDocuments: input.includeDocuments, expiresAt,
      });
      await transaction.insert(auditLog).values({
        householdId: input.householdId, actorUserId: input.userId, entityType: "portable_archive", entityId: id,
        action: "portable_archive_requested", changes: { includesDocuments: input.includeDocuments, expiresAt: expiresAt.toISOString() },
      });
      return boundKeptArchives(transaction, { id, householdId: input.householdId, userId: input.userId }, retention);
    });
  } catch (error) {
    await storage().delete(storageKey).catch(() => undefined);
    throw error;
  }
  // Best effort: reconcilePortableArchiveStorage removes any file left behind.
  // A download already streaming keeps reading through its open handle.
  for (const key of givenUp) await storage().delete(key).catch(() => undefined);
  return { id, expiresAt: expiresAt.toISOString(), includesDocuments: input.includeDocuments, keepPerHousehold: retention.keepPerHousehold };
}

type Transaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/**
 * Holds the exports kept to the per-household count and the space for all of
 * them, with the new one (`created`) already inserted (#1792). Per
 * household first: the household's own oldest live exports are replaced
 * until it keeps `keepPerHousehold`. Then the total: while every
 * household's live exports together pass `maxTotalBytes`, the oldest
 * downloaded export goes first (it has served its purpose), then the oldest
 * not yet downloaded; the new one never. The caller has refused an export
 * larger than the total on its own, so this always ends. Returns the storage
 * keys whose files to delete once the transaction commits.
 */
async function boundKeptArchives(
  transaction: Transaction,
  created: { id: string; householdId: string; userId: string },
  limits: { keepPerHousehold: number; maxTotalBytes: number },
): Promise<string[]> {
  const now = new Date();
  const live = and(isNull(portableArchives.purgedAt), gt(portableArchives.expiresAt, now));
  const givenUp: string[] = [];
  const purge = async (archive: { id: string; storageKey: string }) => {
    await transaction.update(portableArchives).set({ purgedAt: now }).where(eq(portableArchives.id, archive.id));
    givenUp.push(archive.storageKey);
  };

  const household = await transaction.select({ id: portableArchives.id, storageKey: portableArchives.storageKey })
    .from(portableArchives)
    .where(and(eq(portableArchives.householdId, created.householdId), live))
    .orderBy(asc(portableArchives.createdAt), asc(portableArchives.id))
    .for("update");
  const older = household.filter((archive) => archive.id !== created.id);
  for (const archive of older.slice(0, Math.max(0, household.length - limits.keepPerHousehold))) {
    await purge(archive);
    await transaction.insert(auditLog).values({
      householdId: created.householdId, actorUserId: created.userId, entityType: "portable_archive", entityId: archive.id,
      action: "portable_archive_replaced", changes: { byArchiveId: created.id },
    });
  }

  const everyone = await transaction.select({
    id: portableArchives.id, householdId: portableArchives.householdId, storageKey: portableArchives.storageKey,
    sizeBytes: portableArchives.sizeBytes, downloadedAt: portableArchives.downloadedAt,
  })
    .from(portableArchives)
    .where(live)
    .orderBy(asc(portableArchives.createdAt), asc(portableArchives.id))
    .for("update");
  let total = everyone.reduce((sum, archive) => sum + archive.sizeBytes, 0);
  const candidates = [
    ...everyone.filter((archive) => archive.id !== created.id && archive.downloadedAt !== null),
    ...everyone.filter((archive) => archive.id !== created.id && archive.downloadedAt === null),
  ];
  for (const archive of candidates) {
    if (total <= limits.maxTotalBytes) break;
    await purge(archive);
    total -= archive.sizeBytes;
    // No actor: the space limit, not a member of that household, removed it.
    await transaction.insert(auditLog).values({
      householdId: archive.householdId, actorUserId: null, entityType: "portable_archive", entityId: archive.id,
      action: "portable_archive_evicted", changes: { byArchiveId: created.id, reason: "total" },
    });
  }
  return givenUp;
}

/**
 * The file system's free space where `path` is, or would be: a store that has
 * written nothing yet has no directory, so the nearest one that exists answers.
 */
async function freeSpaceAt(path: string): Promise<{ bavail: number | bigint; bsize: number | bigint }> {
  for (let at = path; ; at = dirname(at)) {
    try {
      return await statfs(at);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(at) === at) throw error;
    }
  }
}

/**
 * The scrypt parameters Orbit seals with (ADR-0045 decision 1, as changed by
 * the #1390 review, ruling 5): N=2^14, r=8, p=5, OWASP's listed equivalent of
 * N=2^17, r=8, p=1 at 16 MiB of memory. Earlier v2 files (p=1) still open.
 */
const ARCHIVE_SCRYPT = { log2N: 14, r: 8, p: 5 } as const;

function archiveTooLargeToImportError(fileBytes: number, ceiling: number): AppError {
  const size = (bytes: number) => bytes < 1_073_741_824
    ? `${Math.ceil(bytes / 1_048_576)} MiB`
    : `${(Math.round((bytes / 1_073_741_824) * 10) / 10).toFixed(1)} GiB`;
  return new AppError(
    "archive_export_too_large",
    `This household's archive would be about ${size(fileBytes)}, larger than the ${size(ceiling)} Orbit can import (the household's storage limit plus 64 MiB). Remove some documents, then export again.`,
    413,
  );
}

function archiveStorageFullError(fileBytes: number): AppError {
  return new AppError("archive_storage_full", `Orbit's disk has no room for an archive of this household's size (about ${gibibytes(fileBytes)} GiB)`, 507);
}

/** An export larger than the whole space for exports (#1792): it could never be kept, so it is not written. */
function archiveStoreFullError(maxTotalBytes: number, fileBytes: number): AppError {
  return new AppError(
    "archive_store_full",
    `Orbit keeps at most ${Math.floor(maxTotalBytes / 1_073_741_824)} GB of exports and this one would be about ${gibibytes(fileBytes)} GB on its own; ask your administrator to raise the space for exports`,
    507,
  );
}

/**
 * Takes an uploaded archive file in whole, to a spool file under the archive
 * store, before the preview or import route claims the archive slot (#1792):
 * the slot then covers the processing only, which takes server time bounded
 * by the file's size, never the client's link speed. `declaredBytes` is the
 * request's Content-Length, or the archive body limit when it has none.
 *
 * Refused before a byte is written when the document storage root cannot
 * hold that much with the export's margin (507 `archive_storage_full`); a
 * disk that fills while the file is written is the same 507. The spool file
 * is removed on either, and on any other failure. No database access and no
 * access check: the route has done that before it calls this.
 */
export async function spoolPortableArchiveUpload(file: ReadableStream<Uint8Array>, declaredBytes: number): Promise<SpooledUpload> {
  const free = await freeSpaceAt(getDocumentConfig().storageRoot);
  if (Number(free.bavail) * Number(free.bsize) < declaredBytes * 1.01 + 256 * 1_048_576) throw uploadStorageFullError(declaredBytes);
  try {
    return await storage().spool(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    throw code === "ENOSPC" || code === "EDQUOT" ? uploadStorageFullError(declaredBytes) : error;
  }
}

/** One decimal of GiB, floor 0.1, as the export's refusal words it. */
function gibibytes(bytes: number): string {
  return Math.max(0.1, Math.round((bytes / 1_073_741_824) * 10) / 10).toFixed(1);
}

function uploadStorageFullError(declaredBytes: number): AppError {
  return new AppError("archive_storage_full", `Orbit's disk has no room to take in an archive of this size (about ${gibibytes(declaredBytes)} GiB)`, 507);
}

/** A full disk while the archive is written is the same refusal as the preflight's. */
function storageFullError(error: unknown, fileBytes: number): unknown {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOSPC" || code === "EDQUOT" ? archiveStorageFullError(fileBytes) : error;
}

type StoredArchive = typeof portableArchives.$inferSelect;

/**
 * The live archive this person may download, or `archive_not_found`: one
 * lookup and one access rule for both ways of reading it, so they cannot
 * drift apart.
 */
async function findDownloadableArchive(userId: string, archiveId: string): Promise<StoredArchive> {
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
  return archive;
}

function archiveIntegrityError(): AppError {
  return new AppError("archive_integrity_failed", "That export failed its integrity check", 503);
}

async function recordArchiveDownload(userId: string, archive: StoredArchive): Promise<void> {
  await getDb().transaction(async (transaction) => {
    await transaction.update(portableArchives).set({ downloadedAt: new Date() }).where(eq(portableArchives.id, archive.id));
    await transaction.insert(auditLog).values({ householdId: archive.householdId, actorUserId: userId, entityType: "portable_archive", entityId: archive.id, action: "portable_archive_downloaded", changes: { includesDocuments: archive.includesDocuments } });
  });
}

export async function readPortableArchive(userId: string, archiveId: string): Promise<{ bytes: Buffer }> {
  const archive = await findDownloadableArchive(userId, archiveId);
  const bytes = await storage().read(archive.storageKey, archive.sizeBytes);
  if (createHash("sha256").update(bytes).digest("hex") !== archive.contentSha256) {
    bytes.fill(0);
    throw archiveIntegrityError();
  }
  await recordArchiveDownload(userId, archive);
  return { bytes };
}

/**
 * The download route's way in (#1428): verify, then stream, through one open
 * file handle, so the server never holds the whole file. The first pass hashes
 * the file in chunks and refuses a mismatch before any byte is sent; the
 * second streams it from the start. The returned stream closes the handle when
 * it ends, fails or is cancelled; every refusal before that closes it here.
 */
export async function openPortableArchiveDownload(userId: string, archiveId: string): Promise<{ stream: ReadableStream<Uint8Array>; sizeBytes: number }> {
  const archive = await findDownloadableArchive(userId, archiveId);
  const { handle, sizeBytes } = await storage().open(archive.storageKey, archive.sizeBytes);
  // Both passes stop at the size measured on open, so Content-Length holds.
  const end = Math.max(sizeBytes - 1, 0);
  try {
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ start: 0, end, autoClose: false })) hash.update(chunk as Buffer);
    if (hash.digest("hex") !== archive.contentSha256) throw archiveIntegrityError();
    await recordArchiveDownload(userId, archive);
    const stream = Readable.toWeb(handle.createReadStream({ start: 0, end })) as ReadableStream<Uint8Array>;
    return { stream, sizeBytes };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
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
  await storage().sweepTemporaryFiles(60 * 60 * 1_000);
  // A preview or import killed mid-way leaves its decrypted payload file;
  // one older than the import lease belongs to no live request. This tidy
  // runs every cycle of the document worker, not only at boot; an import
  // still running past the lease keeps reading through its open handle.
  await sweepPayloadScratch(PORTABLE_IMPORT_LEASE_MS);
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

// The payload scratch is a fixed-size tmpfs (docker-compose.yml), sized for
// one maximum archive; a full one is a passing condition, like the document
// quarantine, so the person is told to retry rather than shown a bare 500.
function scratchFullError(error: unknown): unknown {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code !== "ENOSPC" && code !== "EDQUOT") return error;
  return new AppError("archive_scratch_full", "That export could not be stored for reading: Orbit's space for archives is full. Try again shortly.", 503);
}

function passphraseInvalidError(): AppError {
  return new AppError("archive_passphrase_invalid", "The passphrase or archive is invalid", 422);
}

type ImportedArchive = z.infer<typeof importedArchiveSchema>;
type DocumentBody = (text: Base64Text) => ReadableStream<Uint8Array>;

function archiveInvalidError(): AppError {
  return new AppError("archive_invalid", "That export has an invalid format", 422);
}

function archiveTooLargeError(): AppError {
  return new AppError("archive_too_large", "That export is too large", 413);
}


/** Everything in an archive file but its ciphertext: the envelope Orbit writes is well under a KiB. */
const MAX_ENVELOPE_OTHER_BYTES = V1_MAX_ARCHIVE_FILE_BYTES - V1_MAX_ARCHIVE_CIPHERTEXT_CHARACTERS;

/**
 * Opens a format v1 archive for preview or import without holding it or its
 * plaintext (#1521, #1566). v1 only since #1390: its single tag means the
 * whole plaintext is parked on the scratch tmpfs before any of it is used. Standard pattern: a streaming file upload,
 * decrypted to a private temporary file in pieces, the GCM tag verified
 * before anything decrypted is used, then the verified JSON read from the
 * file in pieces, each document's base64 left there to be streamed into
 * document storage.
 *
 * The archive file is read from `file` as it arrives: its envelope fields
 * are kept, and its ciphertext's base64 is counted (refused the moment it
 * passes V1_MAX_ARCHIVE_CIPHERTEXT_CHARACTERS), decoded, decrypted and written
 * to the file a piece at a time. `salt` and `iv` must come before the
 * ciphertext; `authTag` may come before or after it. `use` gets the validated
 * payload and a way to stream a document's bytes; the file is removed once
 * `use` settles, on every path.
 */
async function withImportArchiveV1<T>(file: ReadableStream<Uint8Array>, passphrase: string, use: (archive: ImportedArchive, documentBody: DocumentBody) => Promise<T>): Promise<T> {
  const reader = file.getReader();
  let readToEnd = false;
  let scratch: PayloadScratch | null = null;
  let opener: PortableArchiveOpener | null = null;
  let keyMaterial: { salt: string; iv: string } | null = null;
  let characters = 0;
  const decoder = new Base64Decoder();
  /** What stands in the envelope for the ciphertext once it has been read. */
  const ciphertextRead = Object.freeze({});

  const append = async (encrypted: Buffer) => {
    if (encrypted.length === 0) return;
    const piece = opener!.push(encrypted);
    try { await scratch!.append(piece); } catch (error) { throw scratchFullError(error); } finally { piece.fill(0); }
  };
  const ciphertextSink = async (envelope: Record<string, unknown>): Promise<Base64Sink> => {
    const { salt, iv } = envelope;
    // A second ciphertext, or one before the key material it needs.
    if (opener || typeof salt !== "string" || salt.length === 0 || typeof iv !== "string" || iv.length === 0) throw archiveInvalidError();
    try { opener = await PortableArchiveOpener.open(salt, iv, passphrase); } catch { throw passphraseInvalidError(); }
    keyMaterial = { salt, iv };
    scratch = await PayloadScratch.create().catch((error: unknown) => { throw scratchFullError(error); });
    return {
      write: async (piece) => {
        characters += piece.length;
        if (characters > V1_MAX_ARCHIVE_CIPHERTEXT_CHARACTERS) throw archiveTooLargeError();
        await append(decoder.push(piece));
      },
      end: async () => {
        await append(decoder.end());
        return ciphertextRead;
      },
    };
  };

  try {
    let envelope: Record<string, unknown>;
    try {
      envelope = await readEnvelope(streamSource(reader), ciphertextSink, MAX_ENVELOPE_OTHER_BYTES);
    } catch (error) {
      if (error instanceof PayloadSyntaxError) throw archiveInvalidError();
      throw error;
    }
    readToEnd = true;
    // Checked as isEncryptedPortableArchive checks a held archive, the ciphertext standing in by its length.
    const opened = opener as PortableArchiveOpener | null;
    const material = keyMaterial as { salt: string; iv: string } | null;
    if (!opened || !scratch || envelope.ciphertext !== ciphertextRead || !material
      || envelope.salt !== material.salt || envelope.iv !== material.iv
      || !isEncryptedPortableArchive({ ...envelope, ciphertext: characters > 0 ? "read" : "" })) throw archiveInvalidError();
    try { opened.finish(envelope.authTag as string); } catch { throw passphraseInvalidError(); }
    const verified: PayloadScratch = scratch;
    if (verified.sizeBytes > V1_MAX_ARCHIVE_BYTES) throw archiveTooLargeError();
    const archive = await parseArchive(importedArchiveSchema, () => readPayload(verified));
    return await use(archive, (text) => verified.documentBody(text));
  } finally {
    // Stopped part-way: the caller reads the rest of the upload away (MultipartReader.dispose).
    if (readToEnd) reader.releaseLock();
    else await reader.cancel().catch(() => undefined);
    await (scratch as PayloadScratch | null)?.dispose();
  }
}


/** Reads and validates a verified payload or manifest, mapping a refusal to the words a person can act on. */
async function parseArchive<T extends z.ZodTypeAny>(schema: T, read: () => Promise<unknown>): Promise<z.infer<T>> {
  try {
    return schema.parse(await read());
  } catch (error) {
    if (!(error instanceof PayloadSyntaxError) && !(error instanceof z.ZodError)) throw error;
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
  }
}

type ImportedManifest = z.infer<typeof importedManifestSchema>;

/** At most `limit` bytes of `source`: the manifest reader cannot run on into the documents. */
function boundedSource(source: ByteSource, limit: number): ByteSource {
  let left = limit;
  return {
    async read(buffer) {
      if (left === 0) return 0;
      const count = await source.read(left < buffer.length ? buffer.subarray(0, left) : buffer);
      left -= count;
      return count;
    },
  };
}

/** The plaintext ceiling a v2 header's T is held to: what a household may store plus the manifest cap (§2.4). */
function v2PlaintextCeiling(): number {
  return getDocumentConfig().householdQuotaBytes + MAX_MANIFEST_BYTES;
}

/**
 * Opens a format v2 archive as it is uploaded (#1390, ADR-0045) and reads its
 * manifest: the header checked before any key derivation, then the manifest
 * segments, each verified before a byte of it is used, then the manifest
 * checked against the header and against itself. Nothing past the manifest
 * is read here: `use` gets the manifest and the open reader, whose bodies
 * follow in `body` order. The reader is let go once `use` settles.
 */
async function withImportArchiveV2<T>(file: ReadableStream<Uint8Array>, passphrase: string, use: (manifest: ImportedManifest, reader: SegmentReader) => Promise<T>): Promise<T> {
  const reader = await SegmentReader.open(file, passphrase, v2PlaintextCeiling());
  try {
    const { manifestBytes, plaintextBytes } = reader.header;
    const manifest = await parseArchive(importedManifestSchema, () => readManifest(boundedSource(reader.source(), manifestBytes), manifestBytes));
    if (reader.position !== manifestBytes) throw archiveInvalidError();
    // The manifest states every length, so it must account for every byte the header says follows it.
    const bodyTotal = manifest.body.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    if (manifestBytes + bodyTotal !== plaintextBytes) throw archiveInvalidError();
    const documentsById = new Map(manifest.documents.map((document) => [document.id, document]));
    const seen = new Set<string>();
    for (const entry of manifest.body) {
      const document = documentsById.get(entry.id);
      if (seen.has(entry.id) || !document || document.sizeBytes !== entry.sizeBytes || document.contentSha256 !== entry.contentSha256) throw archiveInvalidError();
      seen.add(entry.id);
    }
    return await use(manifest, reader);
  } finally {
    // Stopped part-way: the caller reads the rest of the upload away (MultipartReader.dispose).
    await reader.close();
  }
}

/**
 * One document's bytes from a v2 archive, hashed as they are handed on and
 * compared with the manifest's `contentSha256` before the last piece leaves
 * (the AEAD already decides; this is belt and braces). A fault, of the hash
 * or of the archive under it, is kept, so the import can answer with it
 * rather than with what the document path made of it.
 */
class VerifiedBody {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly hash = createHash("sha256");
  private received = 0;
  private ended = false;
  failure: unknown = null;

  constructor(source: ReadableStream<Uint8Array>, private readonly sizeBytes: number, private readonly contentSha256: string) {
    this.reader = source.getReader();
  }

  /** The next piece, or null once every byte has been handed on and checked. */
  async next(): Promise<Uint8Array | null> {
    if (this.failure !== null) throw this.failure;
    if (this.ended) return null;
    try {
      const { done, value } = await this.reader.read();
      if (done) {
        this.check();
        return null;
      }
      this.received += value.length;
      this.hash.update(value);
      if (this.received > this.sizeBytes) throw archiveInvalidError();
      if (this.received === this.sizeBytes) this.check();
      return value;
    } catch (error) {
      this.failure = error;
      throw error;
    }
  }

  private check(): void {
    if (this.ended) return;
    if (this.received !== this.sizeBytes || this.hash.digest("hex") !== this.contentSha256) throw archiveInvalidError();
    this.ended = true;
  }

  get complete(): boolean {
    return this.ended;
  }

  stream(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const piece = await this.next();
          if (piece === null) { controller.close(); return; }
          controller.enqueue(piece);
          if (this.ended) controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    }, { highWaterMark: 0 });
  }

  /** Reads whatever the consumer left, so the next body starts where it should. */
  async drain(): Promise<void> {
    while (await this.next() !== null) { /* discarded */ }
  }
}

/**
 * Which reader the file needs, from its first byte (#1390 §2.3): `{` is a v1
 * JSON envelope, `O` (of ORBITARC) a v2 header, anything else, an empty file
 * included, is refused before any key derivation. The byte is put back.
 */
async function dispatchArchive(file: ReadableStream<Uint8Array>): Promise<{ version: 1 | 2; stream: ReadableStream<Uint8Array> }> {
  const reader = file.getReader();
  let head: Uint8Array | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) { reader.releaseLock(); throw archiveInvalidError(); }
    if (value.length > 0) { head = value; break; }
  }
  const version = head[0] === 0x7b ? 1 : head[0] === ARCHIVE_MAGIC[0] ? 2 : null;
  if (version === null) {
    await reader.cancel().catch(() => undefined);
    throw archiveInvalidError();
  }
  let pending: Uint8Array | null = head;
  const stream = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      if (pending) { controller.enqueue(pending); pending = null; return; }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  }, { highWaterMark: 0 });
  return { version, stream };
}

/**
 * Which of `references` the household already holds, as normalised strings
 * (ADR-0024 decision 2).
 *
 * A row is found only through `reference_index` — an HMAC-SHA-256 keyed by a
 * derivation of the household DEK. Take the index away and duplicate detection
 * stops finding anything the application wrote.
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
 * The household's item titles, decrypted (#963). A locked instance yields
 * nothing, which is the correct conservative answer: an unreadable title cannot be
 * shown to be a duplicate, so the import proceeds rather than being blocked by
 * a comparison nobody can make.
 */
async function existingItemTitles(
  executor: MetadataExecutor,
  householdId: string,
): Promise<Array<{ title: string }>> {
  const rows = await executor.select({ id: items.id, titleEnc: items.titleEnc })
    .from(items).where(eq(items.householdId, householdId));
  const metadata = await openMetadataReader(householdId, executor);
  return rows.flatMap((row) => {
    const title = metadata.text("items.title", row.id, { encrypted: row.titleEnc }).value;
    return title ? [{ title }] : [];
  });
}


/**
 * What an archive would bring in. `file` is the archive file as uploaded,
 * read once, in pieces (#1566). A v2 preview reads the header and the
 * manifest only (#1390): the browser sends only that much, and when a whole
 * file arrives the rest is read away unread.
 */
export async function previewPortableImport(userId: string, householdId: string, file: ReadableStream<Uint8Array>, passphrase: string) {
  await requireHouseholdAccess(userId, householdId, true);
  const { version, stream } = await dispatchArchive(file);
  const { archive, bodyIds } = version === 1
    ? await withImportArchiveV1(stream, passphrase, async (opened) => ({ archive: opened as ImportedArchive | ImportedManifest, bodyIds: new Set((opened.documentBytes ?? []).map((entry) => entry.id)) }))
    : await withImportArchiveV2(stream, passphrase, async (manifest) => ({ archive: manifest as ImportedArchive | ImportedManifest, bodyIds: new Set(manifest.body.map((entry) => entry.id)) }));
  const existing = await existingItemTitles(getDb(), householdId);
  const duplicateReferences = await existingReferenceMatches(getDb(), householdId, archive.items.map((item) => item.reference));
  const conflicts = archive.items.filter((item) => duplicatesExistingItem(item, existing, duplicateReferences)).map((item) => ({ id: item.id, title: item.title }));
  // True whenever at least one live document has no bytes in this archive —
  // a metadata-only export, or a mixed one where some bytes were dropped.
  // Which specific duplicates the person will skip is not known yet, so this
  // is a "some documents may not come back" signal, not a count.
  const documentsExcluded = archive.documents.some((document) => document.lifecycle === "available" && !bodyIds.has(document.id));
  return { householdName: archive.household.name, sections: archive.sections.length, items: archive.items.length, documents: archive.documents.length, conflicts, documentsExcluded };
}

/** Why a document restore failed, in words the admin can act on without a stack trace. */
function documentFailureReason(error: unknown): string {
  if (error instanceof AppError && error.code === "document_malware_detected") return "malware was detected in that file";
  if (error instanceof AppError) return error.message;
  return "the document could not be restored";
}


type ImportRecord = Pick<typeof portableArchiveImports.$inferSelect, "id" | "householdId" | "actorUserId" | "finishedAt" | "createdItemIds" | "createdSectionIds">;

/**
 * Undoes exactly what one import row recorded, under the household's owner
 * lock (#1605 RANGE-R2/1), so it cannot interleave with the import's own
 * switch or with a member's write. The lock only, not the "household is
 * active" check: a household marked for deletion must still be tidied.
 *
 * Since #1390 an import stages its documents unbound until one switch
 * transaction creates the items, so a rollback means: delete the staged
 * documents sealed to the import's pre-generated item ids, and (defensive
 * only; the switch is all-or-nothing) any items and empty sections the row
 * names. Idempotent: a missing or finished row is a no-op. With
 * `onlyIfStale` (the stale sweeps, which chose the row before the lock) a row
 * whose lease was renewed meanwhile is a no-op too: the lease is checked
 * again inside the lock (#1390 second review, F3). `known` is the
 * importer's own copy of its start record, used when the row cannot be read
 * back. Database rows go inside the transaction that closes the row; the
 * ciphertext blobs are deleted afterwards, tolerantly -- a failed delete
 * leaves only an orphan blob, never a row pointing at missing bytes.
 */
export async function rollBackPortableImport(importId: string, known?: ImportRecord, options: { onlyIfStale?: boolean } = {}): Promise<void> {
  const outcome = await getDb().transaction(async (transaction) => {
    const [found] = await transaction.select({ householdId: portableArchiveImports.householdId }).from(portableArchiveImports)
      .where(eq(portableArchiveImports.id, importId)).limit(1);
    const householdId = found?.householdId ?? known?.householdId;
    if (!householdId) return undefined;
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${householdOwnerLockKey(householdId)}, 0))`);
    const [current] = await transaction.select().from(portableArchiveImports)
      .where(and(eq(portableArchiveImports.id, importId), options.onlyIfStale ? leaseExpired() : undefined)).limit(1);
    const importRow: ImportRecord | undefined = options.onlyIfStale ? current : current ?? known;
    if (!importRow || importRow.finishedAt) return undefined;

    const createdItemIds: string[] = importRow.createdItemIds ?? [];
    const createdSectionIds: string[] = importRow.createdSectionIds ?? [];

    // Recovery undoes only what a crash left, never items already in use: an
    // imported item a member has edited (every edit bumps `version` past the
    // 1 it was inserted at) or whose due event they completed keeps the whole
    // import. The row stays open, so this is logged again at every sweep.
    // With stage-then-switch no unfinished row has items, so this is defence
    // in depth.
    if (createdItemIds.length > 0) {
      const [edited] = await transaction.select({ id: items.id }).from(items)
        .where(and(inArray(items.id, createdItemIds), gt(items.version, 1))).limit(1);
      const [completed] = edited ? [] : await transaction.select({ id: dueEvents.id }).from(dueEvents)
        .where(and(inArray(dueEvents.itemId, createdItemIds), isNotNull(dueEvents.completedAt))).limit(1);
      if (edited || completed) {
        log.error({
          event: "portable_archive.import",
          state: "degraded",
          reason: "unexpected_failure",
          action: "inspect_admin_diagnostics",
          impact: "application_degraded",
          detail: operationalDetail`${importId}.household.${importRow.householdId}.unfinished_import_in_use_not_rolled_back`,
        });
        return undefined;
      }
    }

    // The staged documents sealed to the import's item ids, and any bound to
    // its items (none, unless the switch committed and its row did not).
    const ownDocuments = createdItemIds.length > 0
      ? and(eq(documents.householdId, importRow.householdId), or(
        and(inArray(documents.sealedItemId, createdItemIds), isNull(documents.itemId)),
        inArray(documents.itemId, createdItemIds),
      ))
      : undefined;
    const documentRows = ownDocuments
      ? await transaction.select({ documentId: documents.id, storageKey: documentCrypto.storageKey, stagingKey: documentStagingObjects.storageKey })
          .from(documents)
          .leftJoin(documentCrypto, eq(documentCrypto.documentId, documents.id))
          .leftJoin(documentStagingObjects, eq(documentStagingObjects.documentId, documents.id))
          .where(ownDocuments)
      : [];
    // Deleted by the rule, not only the rows read above, so nothing staged
    // escapes; their staging object rows go with them (cascade), and their
    // staging blobs are deleted after, with the stored ones.
    if (ownDocuments) await transaction.delete(documents).where(ownDocuments);
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
      .where(and(eq(portableArchiveImports.id, importId), isNull(portableArchiveImports.finishedAt)));

    return {
      documentStorageKeys: documentRows.flatMap((row) => row.storageKey ? [row.storageKey] : []),
      stagingStorageKeys: documentRows.flatMap((row) => row.stagingKey ? [row.stagingKey] : []),
    };
  });
  if (!outcome) return;

  const storage = openDocumentStorage();
  const results = await Promise.allSettled([
    ...outcome.documentStorageKeys.map((storageKey) => storage.deleteCiphertext(storageKey)),
    ...outcome.stagingStorageKeys.map((storageKey) => storage.deleteStagingCiphertext(storageKey)),
  ]);
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

function logRollbackFailure(importId: string, error: unknown): void {
  log.error({
    event: "portable_archive.import",
    state: "degraded",
    reason: "unexpected_failure",
    action: "inspect_admin_diagnostics",
    impact: "application_degraded",
    detail: operationalDetail`${importId}.${error instanceof Error ? error.name : "unknown"}`,
  });
}

/** Rolls back every import row a crash left open, oldest first (boot). One row's failure does not stop the rest. */
export async function rollBackUnfinishedPortableImports(): Promise<void> {
  const unfinished = await getDb().select({ id: portableArchiveImports.id }).from(portableArchiveImports)
    .where(isNull(portableArchiveImports.finishedAt)).orderBy(asc(portableArchiveImports.startedAt));
  for (const row of unfinished) {
    try {
      await rollBackPortableImport(row.id);
    } catch (error) {
      logRollbackFailure(row.id, error);
    }
  }
}

/** An open row whose lease ran out: no heartbeat (or, before 0010, no start) within the lease. */
function leaseExpired() {
  const cutoff = new Date(Date.now() - PORTABLE_IMPORT_LEASE_MS);
  return and(
    isNull(portableArchiveImports.finishedAt),
    // A bound timestamp beside a raw expression has no column to encode it: pass it as text, cast.
    sql`coalesce(${portableArchiveImports.leaseRenewedAt}, ${portableArchiveImports.startedAt}) < ${cutoff.toISOString()}::timestamptz`,
  );
}

/**
 * Rolls back this household's own stranded import before starting a new one
 * (#1151 RANGE-R2). The lease is the one the household-access gate closes
 * the household for (#1316), measured from the last heartbeat (#1390), so a
 * long import that is still restoring is never mistaken for a crash.
 */
async function rollBackStaleUnfinishedPortableImport(householdId: string): Promise<void> {
  const stale = await getDb().select({ id: portableArchiveImports.id }).from(portableArchiveImports)
    .where(and(eq(portableArchiveImports.householdId, householdId), leaseExpired()));
  for (const row of stale) await rollBackPortableImport(row.id, undefined, { onlyIfStale: true });
}

/**
 * Every household's stranded imports, for the document worker's fifteen-
 * minute step (#1390, #1605 AR2-1): an import whose own undo failed is
 * finished here once its lease runs out, so the household reopens without a
 * restart. One row's failure does not stop the rest.
 */
export async function rollBackStaleUnfinishedPortableImports(): Promise<void> {
  const stale = await getDb().select({ id: portableArchiveImports.id }).from(portableArchiveImports)
    .where(leaseExpired()).orderBy(asc(portableArchiveImports.startedAt));
  for (const row of stale) {
    try {
      await rollBackPortableImport(row.id, undefined, { onlyIfStale: true });
    } catch (error) {
      logRollbackFailure(row.id, error);
    }
  }
}

/** Brings an archive in. `input.archive` is the archive file as uploaded, read once, in pieces (#1566). */
export async function importPortableArchive(input: { userId: string; householdId: string; archive: ReadableStream<Uint8Array>; passphrase: string; conflictItemIds: string[] }) {
  await requireHouseholdAccess(input.userId, input.householdId, true);
  // Outside any transaction: the rollback takes the household lock itself.
  await rollBackStaleUnfinishedPortableImport(input.householdId);
  const { version, stream } = await dispatchArchive(input.archive);
  if (version === 1) {
    // The temporary payload file lives until the switch, and is removed
    // whether the import completes, is refused or is rolled back.
    return withImportArchiveV1(stream, input.passphrase, (archive, documentBody) => stageAndSwitch(input, archive, v1Bodies(archive, documentBody)));
  }
  return withImportArchiveV2(stream, input.passphrase, (manifest, reader) => stageAndSwitch(input, manifest, v2Bodies(manifest, reader)));
}

/**
 * The documents' bytes an archive carries, in the order they must be read.
 * `open` gives each in turn, only once the one before it has ended.
 */
interface ArchiveBodies {
  entries: Array<{ id: string; sizeBytes: number }>;
  open(index: number): { stream(): ReadableStream<Uint8Array>; drain(): Promise<void>; failure: unknown };
  /** Every byte after the last body accounted for; throws if the archive does not end there. */
  finish(): Promise<void>;
  /** Whether a body that is not restored must still be read (v2: they follow one another). */
  readonly sequential: boolean;
}

function v1Bodies(archive: ImportedArchive, documentBody: DocumentBody): ArchiveBodies {
  // An empty base64 string carries no document, as before.
  const byId = new Map((archive.documentBytes ?? []).filter((entry) => entry.contentBase64.length > 0).map((entry) => [entry.id, entry.contentBase64]));
  const entries = [...byId].map(([id, text]) => ({ id, sizeBytes: text.decodedBytes, text }));
  return {
    entries,
    sequential: false,
    open: (index) => ({ stream: () => documentBody(entries[index].text), drain: async () => undefined, failure: null }),
    finish: async () => undefined,
  };
}

function v2Bodies(manifest: ImportedManifest, reader: SegmentReader): ArchiveBodies {
  return {
    entries: manifest.body,
    sequential: true,
    open: (index) => new VerifiedBody(reader.take(manifest.body[index].sizeBytes), manifest.body[index].sizeBytes, manifest.body[index].contentSha256),
    finish: () => reader.finish(),
  };
}

const TIDY_SENTENCE = "Orbit couldn't finish tidying up yet. The household stays closed to other members for up to an hour while Orbit finishes; then try the import again.";

function scannerUnavailableError(): AppError {
  return new AppError("archive_scanner_unavailable", "Nothing was imported: Orbit's malware scanner isn't available right now. Try the import again later.", 503);
}

/** The import lost its lease (#1390 review, ruling 1): the sweep, or a later import, has taken the household back. */
function leaseLostError(): AppError {
  return new AppError("archive_import_failed", "Nothing was imported: the import took too long and Orbit stopped it. Try the import again.", 422);
}

function importInProgressError(): AppError {
  return new AppError("archive_import_in_progress", "An archive is already being imported into this household. Wait for it to finish, then try again.", 409);
}

/** Whether an UPDATE changed no row: postgres-js reports the count of rows it changed. */
function changedNothing(result: unknown): boolean {
  return (result as { count?: unknown } | null)?.count === 0;
}

/**
 * Whether another import of the household is running (ruling 9): an open row
 * whose lease is live, the predicate `openImportFor` (the household gate)
 * uses. Asked inside phase 0's transaction, under the household lock, so two
 * imports cannot both find none.
 */
async function anotherImportRunning(transaction: MetadataExecutor, householdId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - PORTABLE_IMPORT_LEASE_MS).toISOString();
  const rows = await transaction.execute(sql`select 1 from ${portableArchiveImports}
    where ${portableArchiveImports.householdId} = ${householdId} and ${portableArchiveImports.finishedAt} is null
      and coalesce(${portableArchiveImports.leaseRenewedAt}, ${portableArchiveImports.startedAt}) > ${cutoff}::timestamptz
    limit 1`);
  return rows.length > 0;
}

/** How often the lease is renewed while one document is staging: well inside the lease. */
const LEASE_HEARTBEAT_MS = 5 * 60 * 1_000;

/**
 * The import's hold on its start record, an optimistic lock (#1390 review,
 * ruling 1). Every change the import makes to its row -- the heartbeat, and
 * the switch's close -- applies only while the row is still open
 * (`finished_at is null`) and still carries the lease this import last wrote
 * (`lease_renewed_at`, the fencing token). A change that touches 0 rows means
 * the lease is lost: the sweep rolled the row back, or it read as expired,
 * and the import must stop without switching. Renewals run one at a time, so
 * the token each one checks is the one the last one wrote.
 */
class ImportLease {
  private token: Date;
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  lost = false;

  constructor(private readonly importId: string, startedAt: Date) {
    this.token = startedAt;
  }

  /** The row's condition: still open, still ours. */
  held() {
    return and(
      eq(portableArchiveImports.id, this.importId),
      isNull(portableArchiveImports.finishedAt),
      eq(portableArchiveImports.leaseRenewedAt, this.token),
    );
  }

  /** Renews the lease; throws `archive_import_failed` once it is lost. */
  renew(): Promise<void> {
    const next = this.chain.then(async () => {
      if (this.lost) return;
      // Past the lease by this process's own clock, the sweep may already
      // have given the household back: never revive it.
      if (Date.now() - this.token.getTime() > PORTABLE_IMPORT_LEASE_MS) {
        this.lost = true;
        return;
      }
      const renewed = new Date();
      const result = await getDb().update(portableArchiveImports).set({ leaseRenewedAt: renewed }).where(this.held());
      if (changedNothing(result)) this.lost = true;
      else this.token = renewed;
    });
    this.chain = next.catch(() => undefined);
    return next.then(() => this.assertHeld());
  }

  assertHeld(): void {
    if (this.lost) throw leaseLostError();
  }

  /** Renews on a timer while `work` runs (one document's staging can outlast the lease). */
  async during<T>(work: () => Promise<T>): Promise<T> {
    this.timer = setInterval(() => { void this.renew().catch(() => undefined); }, LEASE_HEARTBEAT_MS);
    this.timer.unref?.();
    try {
      return await work();
    } finally {
      clearInterval(this.timer);
      this.timer = undefined;
      // Whatever the timer started finishes before the import goes on.
      await this.chain;
    }
  }
}

/**
 * The documents an import staged after it lost its lease: sealed to its own
 * pre-generated item ids, bound to none. The sweep that closed the row could
 * not see them, so they are deleted here, under the household lock, and
 * their blobs after (tolerantly, as the rollback does). Its item ids were
 * never inserted (the switch did not run), so nothing else can be sealed to
 * them.
 */
async function discardStagingAfterLostLease(record: ImportRecord): Promise<void> {
  if (record.createdItemIds.length === 0) return;
  const staged = await getDb().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${householdOwnerLockKey(record.householdId)}, 0))`);
    const own = and(
      eq(documents.householdId, record.householdId),
      inArray(documents.sealedItemId, record.createdItemIds),
      isNull(documents.itemId),
    );
    const rows = await transaction.select({ storageKey: documentCrypto.storageKey, stagingKey: documentStagingObjects.storageKey }).from(documents)
      .leftJoin(documentCrypto, eq(documentCrypto.documentId, documents.id))
      .leftJoin(documentStagingObjects, eq(documentStagingObjects.documentId, documents.id)).where(own);
    await transaction.delete(documents).where(own);
    return rows;
  });
  const storage = openDocumentStorage();
  await Promise.allSettled([
    ...staged.flatMap((row) => row.storageKey ? [storage.deleteCiphertext(row.storageKey)] : []),
    ...staged.flatMap((row) => row.stagingKey ? [storage.deleteStagingCiphertext(row.stagingKey)] : []),
  ]);
}

function tidyFailedError(): AppError {
  return new AppError("archive_import_failed", `Nothing was imported, and ${TIDY_SENTENCE}`, 422);
}

type ImportSource = Pick<ImportedArchive, "household" | "sections" | "items" | "documents">;
type ImportedSection = ImportSource["sections"][number];
type ImportedItem = ImportSource["items"][number];

interface ImportPlan {
  /** Each archive section, and the household section it lands in: existing (matched by slug) or created with `id`. */
  sections: Array<{ source: ImportedSection; id: string; create: boolean }>;
  /** Each archive item that is imported, and its pre-generated id. */
  items: Array<{ source: ImportedItem; id: string }>;
}

/**
 * The import's checks, as a dry run in phase 0 and again in the switch
 * (§2.3): the section limit and unresolved duplicates refuse it; sections are
 * matched by slug; each imported item gets its id. `previous` keeps the ids
 * phase 0 chose, so the switch inserts exactly what the start record names.
 */
async function planImport(
  transaction: MetadataExecutor,
  input: { householdId: string; conflictItemIds: string[] },
  archive: ImportSource,
  previous?: ImportPlan,
): Promise<ImportPlan> {
  const skipped = new Set(input.conflictItemIds);
  const existingSections = await transaction.select({ id: sections.id, slug: sections.slug, archivedAt: sections.archivedAt }).from(sections).where(eq(sections.householdId, input.householdId));
  // Sections are matched by slug only, so most archive sections arrive as
  // new rows. The reader refuses a household with more than 12 live
  // sections, so refuse here, before anything is written, rather than
  // leave a household no one can open. Archived sections are not read.
  const liveExisting = existingSections.filter((section) => !section.archivedAt).length;
  const liveAdded = archive.sections.filter((source) => !source.archivedAt && !existingSections.some((section) => section.slug === source.slug)).length;
  if (liveExisting + liveAdded > MAX_SECTIONS_PER_HOUSEHOLD) {
    throw new AppError("archive_sections_over_limit", `This archive would give the household more than ${MAX_SECTIONS_PER_HOUSEHOLD} sections; remove or merge some first`, 422);
  }
  const plannedSections = archive.sections.map((source, index) => {
    const current = existingSections.find((section) => section.slug === source.slug);
    if (current) return { source, id: current.id, create: false };
    const earlier = previous?.sections[index];
    return { source, id: earlier?.create ? earlier.id : randomUUID(), create: true };
  });
  const sectionIdFor = new Map(plannedSections.map((planned) => [planned.source.id, planned.id]));
  const existing = await existingItemTitles(transaction, input.householdId);
  const duplicateReferences = await existingReferenceMatches(transaction, input.householdId, archive.items.map((item) => item.reference));
  const plannedItems: ImportPlan["items"] = [];
  if (previous) {
    // The switch keeps phase 0's items and ids exactly: their documents are
    // already staged under those ids. One that has since become a duplicate
    // (the importer edited the household meanwhile) refuses the import.
    for (const planned of previous.items) {
      if (duplicatesExistingItem(planned.source, existing, duplicateReferences)) throw new AppError("archive_conflict_unresolved", "Review every duplicate before importing", 409);
      plannedItems.push(planned);
    }
    return { sections: plannedSections, items: plannedItems };
  }
  for (const source of archive.items) {
    const duplicate = duplicatesExistingItem(source, existing, duplicateReferences);
    if (duplicate && !skipped.has(source.id)) throw new AppError("archive_conflict_unresolved", "Review every duplicate before importing", 409);
    if (duplicate || !sectionIdFor.has(source.sectionId)) continue;
    plannedItems.push({ source, id: randomUUID() });
  }
  return { sections: plannedSections, items: plannedItems };
}

/** The household's and the instance's document usage, as the upload path counts it. */
async function documentUsage(executor: MetadataExecutor, householdId: string): Promise<{ household: number; instance: number }> {
  const excluded: Array<"deleted" | "rejected"> = ["deleted", "rejected"];
  const [instanceRows, householdRows] = await Promise.all([
    executor.select({ total: sql<number>`coalesce(sum(${documents.sizeBytes}), 0)` }).from(documents)
      .where(notInArray(documents.lifecycle, excluded)),
    executor.select({ total: sql<number>`coalesce(sum(${documents.sizeBytes}), 0)` }).from(documents)
      .where(and(eq(documents.householdId, householdId), notInArray(documents.lifecycle, excluded))),
  ]);
  return { household: Number(householdRows[0]?.total ?? 0), instance: Number(instanceRows[0]?.total ?? 0) };
}

/**
 * Brings the archive in by the two-phase "stage, then switch" pattern
 * (#1390 §2.3, ADR-0045 decision 4), for both formats:
 *
 * 0. Under the household lock, the checks run as a dry run (sections,
 *    duplicates, quota), the new ids are chosen, and the start record is
 *    written. Nothing else. The household is closed to everyone else.
 * 1. Each restorable document is uploaded as a staged document sealed to its
 *    pre-generated item id, through the same path a direct upload takes;
 *    the lease is renewed after each. A document that does not come back
 *    available and scanned fails the import (#1605 RANGE-R2/2).
 * 2. One transaction under the household lock re-runs the checks, inserts
 *    the sections and items, binds the staged documents, writes the audit
 *    row and closes the start record. Until it commits a member sees nothing.
 *
 * Any failure rolls back what the start record names, leaving nothing to
 * retry against (#1151 RANGE-R2). An error from the switch whose commit
 * landed anyway is settled by reading the record back (#1605 AR2-1).
 */
async function stageAndSwitch(
  input: { userId: string; householdId: string; conflictItemIds: string[] },
  archive: ImportSource,
  bodies: ArchiveBodies,
): Promise<{ importedItems: number; documentsExcluded: number }> {
  const db = getDb();
  const config = getDocumentConfig();
  const importId = randomUUID();
  const startedAt = new Date();
  const bodyIndex = new Map(bodies.entries.map((entry, index) => [entry.id, index]));

  // Phase 0: the dry run and the start record.
  const { plan, record, restorable } = await db.transaction(async (transaction) => {
    await acquireActiveHouseholdLock(transaction, input.householdId);
    // One import per household at a time (#1390 review, ruling 9), whether
    // or not this process's slot is held: a live open row is another import
    // (another tab, another instance). A stale one was rolled back above.
    if (await anotherImportRunning(transaction, input.householdId)) throw importInProgressError();
    const plan = await planImport(transaction, input, archive);
    const itemIdFor = new Map(plan.items.map((planned) => [planned.source.id, planned.id]));
    // documentId -> the pre-generated item id it is sealed to.
    const restorable = new Map<string, { itemId: string; displayName: string }>();
    for (const document of archive.documents) {
      if (document.lifecycle !== "available" || !document.itemId || !bodyIndex.has(document.id)) continue;
      const itemId = itemIdFor.get(document.itemId);
      if (itemId) restorable.set(document.id, { itemId, displayName: document.displayName });
    }
    const needed = bodies.entries.filter((entry) => restorable.has(entry.id)).reduce((sum, entry) => sum + entry.sizeBytes, 0);
    if (needed > 0) {
      const usage = await documentUsage(transaction, input.householdId);
      if (usage.household + needed > config.householdQuotaBytes) {
        throw new AppError("archive_over_quota", "This archive's documents would take the household past its storage limit", 413);
      }
      if (usage.instance + needed > config.instanceQuotaBytes) {
        throw new AppError("archive_over_quota", "This archive's documents would take Orbit past its storage limit", 413);
      }
    }
    const record: ImportRecord = {
      id: importId,
      householdId: input.householdId,
      actorUserId: input.userId,
      finishedAt: null,
      createdSectionIds: plan.sections.filter((planned) => planned.create).map((planned) => planned.id),
      createdItemIds: plan.items.map((planned) => planned.id),
    };
    await transaction.insert(portableArchiveImports).values({ ...record, startedAt, leaseRenewedAt: startedAt });
    return { plan, record, restorable };
  });

  // Phase 1: stage every restorable document; read every other body away.
  const lease = new ImportLease(importId, startedAt);
  let documentsRestored = 0;
  let current: { failure: unknown } | null = null;
  let restoring: string | null = null;
  try {
    for (const [index, entry] of bodies.entries.entries()) {
      const target = restorable.get(entry.id);
      if (!target && !bodies.sequential) continue;
      // Nothing more is staged once the lease is lost.
      lease.assertHeld();
      const body = bodies.open(index);
      current = body;
      if (!target) {
        await body.drain();
      } else {
        restoring = target.displayName;
        const summary = await lease.during(() => uploadItemDocument({
          userId: input.userId,
          householdId: input.householdId,
          itemId: target.itemId,
          staged: true,
          filename: target.displayName,
          body: body.stream(),
          declaredBytes: entry.sizeBytes,
          /* #1784: the archive carries bytes the household already held under whatever
             limit applied when they were stored (a mail-filed attachment, or an upload
             before the limit was lowered); the current upload limit never re-judges
             them (upload-limit.ts). The hard ceiling still bounds the receive, the
             structure read and the scan, and declaredBytes pins the exact length. */
          maxBytes: Math.min(entry.sizeBytes, DOCUMENT_MAX_BYTES_CEILING),
          /* #1801 A-F14: the archive carries documents accepted under the page cap of
             their day (1,000 before #1436); the current cap for new input never
             re-judges them. The stored bound still holds. */
          maxPages: PDF_STORED_MAX_PAGES,
          /* #1437: a restore is expected to re-create what the household holds. */
          detectDuplicates: false,
        }));
        await body.drain();
        // A document still waiting on the scanner when the import says
        // complete could later be refused with no way back (RANGE-R2/2).
        const scanned = summary.scanStatus === "clean" || (summary.scanStatus === "skipped" && config.scanMode === "disabled");
        if (summary.lifecycle !== "available" || !scanned) throw scannerUnavailableError();
        documentsRestored++;
        restoring = null;
      }
      current = null;
      // The lease's heartbeat: a long import is never taken for a crash, and
      // one whose row was taken back stops here (ruling 1).
      await lease.renew();
    }
    await bodies.finish();
  } catch (error) {
    if (lease.lost) {
      // The row is no longer this import's: the sweep closed it and undid
      // what it could see. What was staged since is this import's to remove.
      await discardStagingAfterLostLease(record).catch((cleanupError: unknown) => logRollbackFailure(importId, cleanupError));
      throw leaseLostError();
    }
    // The archive's own fault (a failed segment, a hash, a cut upload) answers as itself.
    const archiveFault = current?.failure ?? null;
    let tidied = true;
    try {
      await rollBackPortableImport(importId, record);
    } catch (rollbackError) {
      logRollbackFailure(importId, rollbackError);
      tidied = false;
    }
    if (archiveFault !== null) throw tidied ? archiveFault : tidyFailedError();
    if (error instanceof AppError && error.code === "archive_scanner_unavailable") throw tidied ? error : tidyFailedError();
    if (restoring === null) throw tidied ? error : tidyFailedError();
    throw new AppError(
      "archive_import_failed",
      `Nothing was imported: restoring "${restoring}" failed because ${documentFailureReason(error)}${tidied ? ". Fix the problem and try the import again." : `, and ${TIDY_SENTENCE}`}`,
      422,
    );
  }

  const result = { importedItems: plan.items.length, documentsExcluded: archive.documents.length - documentsRestored };

  // Phase 2: the switch, one transaction.
  try {
    await db.transaction(async (transaction) => {
      await acquireActiveHouseholdLock(transaction, input.householdId);
      const final = await planImport(transaction, input, archive, plan);
      for (const planned of final.sections) {
        if (!planned.create) continue;
        const source = planned.source;
        await transaction.insert(sections).values({ id: planned.id, householdId: input.householdId, slug: source.slug, name: source.name, icon: source.icon, accent: source.accent, colour: source.colour ?? null, position: source.position, visible: source.visible, archivedAt: source.archivedAt ? new Date(source.archivedAt) : null });
      }
      const sectionIdFor = new Map(final.sections.map((planned) => [planned.source.id, planned.id]));
      const metadata = await requireMetadataWriter(input.householdId, transaction);
      for (const { source, id: itemId } of final.items) {
        await transaction.insert(items).values({ id: itemId, householdId: input.householdId, sectionId: sectionIdFor.get(source.sectionId)!, titleEnc: metadata.encryptText("items.title", itemId, source.title), subtype: source.subtype ?? null, providerEnc: metadata.encryptText("items.provider", itemId, source.provider), referenceEnc: metadata.encryptText("items.reference", itemId, source.reference), referenceIndex: metadata.referenceIndex(source.reference), costMinorEnc: metadata.encryptNumber("items.cost_minor", itemId, source.costMinor), currency: source.currency, startDate: source.startDate ?? null, expiryDate: source.expiryDate ?? null, renewalDate: source.renewalDate ?? null, serviceDate: source.serviceDate ?? null, recurrenceMonths: source.recurrenceMonths ?? null, snoozedUntil: source.snoozedUntil ?? null, notesEnc: metadata.encryptText("items.notes", itemId, source.notes), externalDocumentUrl: source.externalDocumentUrl ?? null, importance: source.importance ?? null, status: source.status });
      }
      // The item.upsert bind rule (workspace-repository.ts): sealed to the
      // item, bound to none, and not refused or on its way out.
      if (record.createdItemIds.length > 0) {
        await transaction.update(documents).set({ itemId: sql`${documents.sealedItemId}`, deleteAfter: null, updatedAt: new Date() })
          .where(and(
            eq(documents.householdId, input.householdId),
            inArray(documents.sealedItemId, record.createdItemIds),
            isNull(documents.itemId),
            notInArray(documents.lifecycle, ["rejected", "deleted", "pending_deletion"]),
          ));
      }
      await transaction.insert(auditLog).values({ householdId: input.householdId, actorUserId: input.userId, entityType: "portable_archive", entityId: randomUUID(), action: "portable_archive_imported", changes: { importedItems: final.items.length, skippedConflicts: input.conflictItemIds.length, documentsTotal: archive.documents.length, documentsRestorable: restorable.size } });
      // Closed in the same transaction: there is no write after the commit.
      // Only while the row is still open and still this import's (ruling 1);
      // 0 rows means the lease was lost, and the whole switch is undone.
      const closed = await transaction.update(portableArchiveImports).set({
        finishedAt: new Date(),
        outcome: "completed",
        createdSectionIds: final.sections.filter((planned) => planned.create).map((planned) => planned.id),
      }).where(lease.held());
      if (changedNothing(closed)) {
        lease.lost = true;
        throw leaseLostError();
      }
    });
  } catch (error) {
    if (lease.lost) {
      await discardStagingAfterLostLease(record).catch((cleanupError: unknown) => logRollbackFailure(importId, cleanupError));
      throw leaseLostError();
    }
    // Idempotent commit confirmation: an error after the commit landed (a
    // lost reply) is not a failed import.
    const [row] = await db.select({ finishedAt: portableArchiveImports.finishedAt, outcome: portableArchiveImports.outcome })
      .from(portableArchiveImports).where(eq(portableArchiveImports.id, importId)).limit(1)
      .catch(() => [] as Array<{ finishedAt: Date | null; outcome: string | null }>);
    if (row?.finishedAt && row.outcome === "completed") return result;
    try {
      await rollBackPortableImport(importId, record);
    } catch (rollbackError) {
      logRollbackFailure(importId, rollbackError);
      throw tidyFailedError();
    }
    if (error instanceof AppError) throw error;
    throw new AppError("archive_import_failed", "Nothing was imported: Orbit couldn't finish the import. Try the import again.", 422);
  }
  return result;
}
