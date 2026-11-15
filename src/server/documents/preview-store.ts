import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { documentPreviews, documents } from "@/db/schema";
import { log } from "@/lib/logger";
import { enqueuePreviewJob } from "@/server/document-maintenance/preview-queue";
import { type DocumentConfig, wrappingKey } from "@/server/documents/config";
import {
  createDocumentSealer,
  createDocumentUnsealer,
  type DocumentEncryptionContext,
  envelopeOf,
} from "@/server/documents/crypto";
import type { PreviewDraw, PreviewRefusal } from "@/server/documents/preview";
import type { LocalDocumentStorage } from "@/server/documents/storage";

/**
 * The kept page previews (#1433 D14-D16): one envelope-encrypted object per
 * page under `previews/`, one `document_previews` row per (document, page).
 *
 * A page is sealed exactly as a document is, under its own DEK and the active
 * wrapping key, with purpose "preview" and the page number in the AAD, so a
 * kept page never opens as the document nor as another page. A refused
 * drawing is remembered with its reason and no object (D18).
 */

/** Bumped when the drawing changes (renderer, scale, format); rows of another value are redrawn by a migration. */
export const PREVIEW_RENDERER = "poppler-1";

export type PreviewRow = typeof documentPreviews.$inferSelect;

/** What a page's context is built from: the document's identity as its own AAD holds it. */
export type PreviewOwner = { documentId: string; householdId: string; itemId: string };

/** The AAD context of one kept page (D15). */
export function previewContextFor(owner: PreviewOwner, page: number, plaintextSize: number): DocumentEncryptionContext {
  return {
    documentId: owner.documentId,
    householdId: owner.householdId,
    itemId: owner.itemId,
    mediaType: "image/jpeg",
    plaintextSize,
    purpose: "preview",
    page,
  };
}

export async function findPreview(documentId: string, page: number): Promise<PreviewRow | undefined> {
  const [row] = await getDb().select().from(documentPreviews)
    .where(and(eq(documentPreviews.documentId, documentId), eq(documentPreviews.page, page)))
    .limit(1);
  return row;
}

export async function listPreviews(documentId: string): Promise<PreviewRow[]> {
  return getDb().select().from(documentPreviews).where(eq(documentPreviews.documentId, documentId));
}

/**
 * Seals a drawn page and records it, unless the document stopped being
 * `available` or another drawer stored the page first. The object is written
 * before the row, so a row never names missing bytes; whenever this call's
 * row does not land, its object is deleted again, so it leaves no orphan.
 * The check runs under the document's lock, the one deletion takes, so no
 * page is added to a document on its way to purge. Answers the page's row:
 * this call's, the earlier drawer's, or undefined when the document is gone.
 * The drawn bytes are the caller's.
 */
export async function storeDrawnPreview(
  storage: LocalDocumentStorage,
  config: DocumentConfig,
  owner: PreviewOwner,
  page: number,
  draw: Extract<PreviewDraw, { outcome: "drawn" }>,
): Promise<PreviewRow | undefined> {
  const wrap = wrappingKey(config);
  const storageKey = storage.createStorageKey();
  const sealer = createDocumentSealer(previewContextFor(owner, page, draw.bytes.length), wrap.keyEncryptionKey, wrap.keyId);
  const copy = Buffer.from(draw.bytes);
  const sealed = await storage.sealBuffer(copy, sealer, { kind: "preview", storageKey });
  let stored: PreviewRow | undefined;
  try {
    stored = await getDb().transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:document:${owner.documentId}`}, 0))`);
      const live = await transaction.execute(sql`select 1 from documents where id = ${owner.documentId} and lifecycle = 'available'`);
      if (live.length === 0) return undefined;
      const now = new Date();
      const [row] = await transaction.insert(documentPreviews).values({
        documentId: owner.documentId,
        page,
        status: "drawn",
        refusal: null,
        attempts: 1,
        renderer: PREVIEW_RENDERER,
        mediaType: draw.mediaType,
        width: draw.width,
        height: draw.height,
        plaintextSize: draw.bytes.length,
        ciphertextSize: sealed.ciphertextSize,
        storageKey,
        envelopeVersion: sealed.envelope.envelopeVersion,
        contentIv: sealed.envelope.contentIv,
        contentAuthTag: sealed.envelope.contentAuthTag,
        wrappedDek: sealed.envelope.wrappedDek,
        wrapIv: sealed.envelope.wrapIv,
        wrapAuthTag: sealed.envelope.wrapAuthTag,
        keyId: sealed.envelope.keyId,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [documentPreviews.documentId, documentPreviews.page],
        // A drawing replaces a remembered refusal (a retried timeout that now
        // draws), never another drawing.
        set: {
          status: "drawn",
          refusal: null,
          renderer: PREVIEW_RENDERER,
          mediaType: draw.mediaType,
          width: draw.width,
          height: draw.height,
          plaintextSize: draw.bytes.length,
          ciphertextSize: sealed.ciphertextSize,
          storageKey,
          envelopeVersion: sealed.envelope.envelopeVersion,
          contentIv: sealed.envelope.contentIv,
          contentAuthTag: sealed.envelope.contentAuthTag,
          wrappedDek: sealed.envelope.wrappedDek,
          wrapIv: sealed.envelope.wrapIv,
          wrapAuthTag: sealed.envelope.wrapAuthTag,
          keyId: sealed.envelope.keyId,
          updatedAt: now,
        },
        setWhere: sql`${documentPreviews.status} = 'refused'`,
      }).returning();
      if (row) return row;
      const [earlier] = await transaction.select().from(documentPreviews)
        .where(and(eq(documentPreviews.documentId, owner.documentId), eq(documentPreviews.page, page)))
        .limit(1);
      return earlier;
    });
  } catch (error) {
    await storage.deletePreviewCiphertext(storageKey).catch(() => undefined);
    throw error;
  }
  if (stored?.storageKey !== storageKey) await storage.deletePreviewCiphertext(storageKey).catch(() => undefined);
  return stored;
}

/**
 * Remembers a refused drawing (D18): a first refusal is attempts 1; a retry's
 * refusal counts up and takes the latest reason. A page already drawn stays drawn.
 */
export async function storeRefusedPreview(documentId: string, page: number, refusal: PreviewRefusal): Promise<void> {
  const now = new Date();
  await getDb().insert(documentPreviews).values({
    documentId,
    page,
    status: "refused",
    refusal,
    attempts: 1,
    renderer: PREVIEW_RENDERER,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [documentPreviews.documentId, documentPreviews.page],
    set: { refusal, attempts: sql`${documentPreviews.attempts} + 1`, renderer: PREVIEW_RENDERER, updatedAt: now },
    setWhere: sql`${documentPreviews.status} = 'refused'`,
  });
}

/** Decrypts a drawn page into one buffer; the tag is verified before it is returned. */
export async function readPreview(
  storage: LocalDocumentStorage,
  owner: PreviewOwner,
  row: PreviewRow,
  keyEncryptionKey: Buffer,
): Promise<Buffer> {
  if (row.status !== "drawn" || !row.storageKey || row.plaintextSize === null || row.ciphertextSize === null) {
    throw new Error("Preview row is not a drawn page");
  }
  const envelope = envelopeOf({
    envelopeVersion: row.envelopeVersion!,
    keyId: row.keyId!,
    contentIv: row.contentIv!,
    contentAuthTag: row.contentAuthTag!,
    wrappedDek: row.wrappedDek!,
    wrapIv: row.wrapIv!,
    wrapAuthTag: row.wrapAuthTag!,
  });
  return storage.unsealIntoBuffer(
    { kind: "preview", storageKey: row.storageKey },
    { ciphertextSize: row.ciphertextSize, plaintextSize: row.plaintextSize },
    createDocumentUnsealer(previewContextFor(owner, row.page, row.plaintextSize), envelope, keyEncryptionKey),
  );
}


/**
 * Read repair and sweep repair share one eviction (#1803): a kept page whose
 * object is missing or fails its check is dropped, row first, so a row never
 * names bytes known bad. Under the document's lock; skipped when the document
 * is not owed pages (a due purge owns its objects). Compare-and-delete on the
 * storage key, so a page another viewer redrew meanwhile is kept. A deleted
 * row queues the document's preview job; the object is then removed best effort.
 */
export async function discardKeptPreview(
  storage: LocalDocumentStorage,
  row: { documentId: string; page: number; storageKey: string },
  reason: "storage_object_missing" | "storage_object_damaged",
): Promise<void> {
  const deleted = await getDb().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:document:${row.documentId}`}, 0))`);
    const [document] = await transaction.select({ lifecycle: documents.lifecycle, deleteAfter: documents.deleteAfter })
      .from(documents).where(eq(documents.id, row.documentId)).limit(1);
    if (!document || !["available", "pending_deletion"].includes(document.lifecycle)) return false;
    if (document.lifecycle === "pending_deletion" && document.deleteAfter && document.deleteAfter.getTime() <= Date.now()) return false;
    const removed = await transaction.delete(documentPreviews).where(and(
      eq(documentPreviews.documentId, row.documentId),
      eq(documentPreviews.page, row.page),
      eq(documentPreviews.storageKey, row.storageKey),
    )).returning({ page: documentPreviews.page });
    if (removed.length === 0) return false;
    await enqueuePreviewJob(transaction, row.documentId);
    return true;
  });
  if (!deleted) return;
  await storage.deletePreviewCiphertext(row.storageKey).catch(() => undefined);
  log.warn({ event: "document.preview", state: "degraded", reason, action: "retry_job", impact: "none" });
}
