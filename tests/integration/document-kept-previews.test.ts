import { mkdtemp, readdir, readFile, rm, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createInContainerAdapter } from "@/lib/in-container-adapter";
import { createPortableArchive, importPortableArchive, readPortableArchive } from "@/server/portable-archive-repository";
import { auditLog, documents } from "@/db/schema";
import { updateDocumentJob } from "@/server/admin-operations";
import { enqueuePreviewJob } from "@/server/document-maintenance/preview-queue";
import { getDocumentHealth } from "@/server/document-health";
import { reconcileDocumentStorage, runDocumentMaintenanceCycle } from "@/server/document-worker";
import { deriveDocumentKeyId, getDocumentConfig, resetDocumentConfigForTests } from "@/server/documents/config";
import { decryptDocument, type CryptoEnvelope, type DocumentEncryptionContext, DocumentIntegrityError, envelopeOf } from "@/server/documents/crypto";
import {
  lastPdfSandboxChildPidForTests,
  pdfStructureSandboxInFlightForTests,
  setPdfStructureSandboxLimitsForTests,
} from "@/server/documents/pdf-structure-sandbox";
import { setDocumentPreviewRenderBudgetForTests } from "@/server/documents/preview";
import { runKekRotationToCompletion, rotationRemaining, type RotationKeys } from "@/server/documents/rewrap-worker";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { archiveStream } from "./support/portable-archive-upload";
import { openV2, v2PayloadOf } from "../support/portable-archive-v2";
import { callRoute, callRouteForSession, loadRoute } from "./support/request-event";
import { syntheticJpeg } from "../support/synthetic-documents";
import { enqueuePreviewJobIfIncomplete } from "@/server/document-maintenance/preview-queue";
import { colourScanPdf, textPagesPdf, tinyStepTilingPdf } from "../support/pdf-measure/fixtures";
import { jpegFrameSize, NEEDS_POPPLER, popplerIt } from "../support/poppler-sandbox";

/**
 * #1433, design note §2.6: every page is drawn once, by a background worker
 * from arrival (and on first view for a page it has not reached), and kept
 * as one envelope-encrypted object per page under `previews/`, with a
 * `document_previews` row; a view decrypts instead of drawing. Each test
 * names its §2.6 line.
 *
 * Every test here draws with the real pdftoppm, so all go through
 * `popplerIt` (skip outside CI without poppler; fail in CI). The new table,
 * column and worker module do not exist yet: rows are read with SQL and the
 * worker is imported by path at run time, so this file type-checks today.
 *
 * Names this file chooses where the note gives none (the builder may rename
 * with the test): `runPreviewWorkerOnce()` in preview-jobs.ts claims one
 * job and draws one slice (resolves falsy when there was nothing to claim);
 * `RotationProgress.previewsRemaining`; `DocumentHealth.previewBytes` and
 * `previewsPending` as the note names them.
 */

const { GET: previewDocument } = await loadRoute("documents/[documentId]/preview");
const { GET: downloadDocument } = await loadRoute("documents/[documentId]/download");
const { DELETE: deleteDocument } = await loadRoute("documents/[documentId]");
const { POST: restoreDocumentRoute } = await loadRoute("documents/[documentId]/restore");
const { GET: listDocuments, POST: uploadDocument } = await loadRoute("households/[householdId]/items/[itemId]/documents");

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(),
}));

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

afterEach(() => {
  setDocumentPreviewRenderBudgetForTests(undefined);
  setPdfStructureSandboxLimitsForTests(undefined);
  vi.restoreAllMocks();
  vi.mocked(scanFileWithClamAv).mockReset();
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
});

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
type PreviewWorker = { runPreviewWorkerOnce(): Promise<unknown> };

const PREVIEW_JOBS_MODULE = "@/server/document-maintenance/preview-jobs";

async function previewWorker(): Promise<PreviewWorker> {
  return await import(/* @vite-ignore */ PREVIEW_JOBS_MODULE) as PreviewWorker;
}

/** Runs worker slices until one finds nothing to claim (at most `limit`). */
async function drainPreviewWorker(limit = 50): Promise<void> {
  const worker = await previewWorker();
  for (let round = 0; round < limit; round += 1) {
    if (!await worker.runPreviewWorkerOnce()) return;
  }
}

type PreviewRow = {
  page: number;
  status: "drawn" | "refused";
  refusal: string | null;
  attempts: number;
  media_type: string | null;
  width: number | null;
  height: number | null;
  plaintext_size: number | null;
  ciphertext_size: number | null;
  storage_key: string | null;
  envelope_version: number | null;
  content_iv: string | null;
  content_auth_tag: string | null;
  wrapped_dek: string | null;
  wrap_iv: string | null;
  wrap_auth_tag: string | null;
  key_id: string | null;
};

async function previewRows(documentId: string): Promise<PreviewRow[]> {
  const rows = await getDb().execute(sql`select * from document_previews where document_id = ${documentId} order by page`);
  return rows as unknown as PreviewRow[];
}

type JobRow = { kind: string; status: string; generation: number };

async function previewJobs(documentId: string): Promise<JobRow[]> {
  const rows = await getDb().execute(sql`select kind::text as kind, status::text as status, generation from document_jobs where document_id = ${documentId} and kind::text = 'preview' order by generation`);
  return rows as unknown as JobRow[];
}

async function pageCountOf(documentId: string): Promise<number | null> {
  const rows = await getDb().execute(sql`select page_count from documents where id = ${documentId}`);
  return (rows[0] as { page_count: number | null }).page_count;
}

function previewObjectPath(storageKey: string): string {
  return join(getDocumentConfig().storageRoot, "previews", storageKey.slice(0, 2), storageKey.slice(2, 4), `${storageKey}.bin`);
}

/** Every object file under previews/, by storage key. */
async function previewObjectKeys(): Promise<string[]> {
  const root = join(getDocumentConfig().storageRoot, "previews");
  let entries: string[];
  try {
    entries = await readdir(root, { recursive: true }) as string[];
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.endsWith(".bin")).map((entry) => entry.split("/").pop()!.replace(/\.bin$/, ""));
}

function envelopeOfRow(row: PreviewRow): CryptoEnvelope {
  return envelopeOf({
    envelopeVersion: row.envelope_version!,
    keyId: row.key_id!,
    contentIv: row.content_iv!,
    contentAuthTag: row.content_auth_tag!,
    wrappedDek: row.wrapped_dek!,
    wrapIv: row.wrap_iv!,
    wrapAuthTag: row.wrap_auth_tag!,
  });
}

function previewContextFor(fixture: Fixture, documentId: string, row: PreviewRow, page = row.page): DocumentEncryptionContext {
  return {
    documentId,
    householdId: fixture.household.id,
    itemId: fixture.item.id,
    mediaType: "image/jpeg",
    plaintextSize: row.plaintext_size!,
    purpose: "preview",
    page,
  } as unknown as DocumentEncryptionContext;
}

async function upload(fixture: Fixture, bytes: Buffer, filename = "kept.pdf") {
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
  const session = await fixture.session("member");
  const response = await callRouteForSession(uploadDocument, session, {
    url: `http://127.0.0.1:3000/api/households/${fixture.household.id}/items/${fixture.item.id}/documents`,
    method: "POST",
    headers: { "content-length": String(bytes.length), "content-type": "application/pdf", "x-orbit-filename": encodeURIComponent(filename) },
    body: new Uint8Array(bytes),
    params: { householdId: fixture.household.id, itemId: fixture.item.id },
  });
  expect(response.status).toBe(201);
  const payload = await response.json() as { document: { id: string } };
  return { session, documentId: payload.document.id };
}

type Session = Awaited<ReturnType<Fixture["session"]>>;

function askPreview(session: Session, documentId: string, page: number) {
  return callRouteForSession(previewDocument, session, {
    url: `http://127.0.0.1:3000/api/documents/${documentId}/preview?page=${page}`,
    params: { documentId },
  });
}

async function previewAudits(documentId: string) {
  return getDb().select({ changes: auditLog.changes }).from(auditLog)
    .where(and(eq(auditLog.entityId, documentId), eq(auditLog.action, "document_previewed")));
}

/** Waits up to 2 s for the in-flight count to drop to zero. */
async function settled(): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (pdfStructureSandboxInFlightForTests() !== 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
}

describe(`pages drawn once and kept, encrypted (#1433 §2.6) ${NEEDS_POPPLER}`, () => {
  popplerIt("line 1: uploading a 3-page PDF leaves the document available together with one pending preview job", async () => {
    const fixture = await createIntegrationFixture("kept-previews-enqueue");
    const { documentId } = await upload(fixture, textPagesPdf(3));
    const [document] = await getDb().select({ lifecycle: documents.lifecycle }).from(documents).where(eq(documents.id, documentId));
    expect(document?.lifecycle).toBe("available");
    const jobs = await previewJobs(documentId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe("pending");
  }, 60_000);

  popplerIt("line 2: one worker run draws pages 1-3: three drawn rows, three previews/ objects, each a 1,200 px JPEG under the preview context; job completed", async () => {
    const fixture = await createIntegrationFixture("kept-previews-worker");
    const { documentId } = await upload(fixture, textPagesPdf(3));
    await (await previewWorker()).runPreviewWorkerOnce();

    const rows = await previewRows(documentId);
    expect(rows.map((row) => [row.page, row.status])).toEqual([[1, "drawn"], [2, "drawn"], [3, "drawn"]]);
    const kek = getDocumentConfig().keyEncryptionKey;
    for (const row of rows) {
      expect(row.media_type).toBe("image/jpeg");
      const ciphertext = await readFile(previewObjectPath(row.storage_key!));
      const plaintext = decryptDocument(ciphertext, previewContextFor(fixture, documentId, row), envelopeOfRow(row), kek);
      const frame = jpegFrameSize(plaintext);
      expect(frame).toEqual({ width: row.width, height: row.height });
      expect(Math.max(frame!.width, frame!.height)).toBe(1_200);
    }
    expect((await previewJobs(documentId)).map((job) => job.status)).toEqual(["completed"]);
  }, 60_000);

  popplerIt("line 3: a kept page does not unseal with the document's context, nor as another page; the document object does not unseal with the preview context", async () => {
    const fixture = await createIntegrationFixture("kept-previews-aad");
    const { documentId } = await upload(fixture, textPagesPdf(3));
    await drainPreviewWorker();
    const [row] = (await previewRows(documentId)).filter((entry) => entry.page === 2);
    const kek = getDocumentConfig().keyEncryptionKey;
    const ciphertext = await readFile(previewObjectPath(row!.storage_key!));
    const asDocument = { ...previewContextFor(fixture, documentId, row!), purpose: "document" } as DocumentEncryptionContext;
    expect(() => decryptDocument(ciphertext, asDocument, envelopeOfRow(row!), kek)).toThrow(DocumentIntegrityError);
    expect(() => decryptDocument(ciphertext, previewContextFor(fixture, documentId, row!, 3), envelopeOfRow(row!), kek)).toThrow(DocumentIntegrityError);
  }, 60_000);

  popplerIt("line 4: a view of a kept page starts no child, answers the kept bytes with X-Orbit-Page-Count 3, and writes one document_previewed audit with changes.page 2", async () => {
    const fixture = await createIntegrationFixture("kept-previews-serve");
    const { session, documentId } = await upload(fixture, textPagesPdf(3));
    await drainPreviewWorker();
    const [row] = (await previewRows(documentId)).filter((entry) => entry.page === 2);
    const kept = decryptDocument(await readFile(previewObjectPath(row!.storage_key!)), previewContextFor(fixture, documentId, row!), envelopeOfRow(row!), getDocumentConfig().keyEncryptionKey);
    const auditsBefore = (await previewAudits(documentId)).length;
    await settled();
    const pidBefore = lastPdfSandboxChildPidForTests();

    const response = await askPreview(session, documentId, 2);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(kept)).toBe(true);
    expect(response.headers.get("x-orbit-page-count")).toBe("3");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(lastPdfSandboxChildPidForTests()).toBe(pidBefore);
    expect(pdfStructureSandboxInFlightForTests()).toBe(0);
    const audits = await previewAudits(documentId);
    expect(audits).toHaveLength(auditsBefore + 1);
    expect(audits.at(-1)!.changes).toMatchObject({ page: 2 });
  }, 60_000);

  popplerIt("line 5: a view before the worker ran draws on demand, stores the page, answers it and audits once; the worker then skips it (one row, one object)", async () => {
    const fixture = await createIntegrationFixture("kept-previews-on-demand");
    const { session, documentId } = await upload(fixture, textPagesPdf(3));
    const objectsBefore = (await previewObjectKeys()).length;

    const response = await askPreview(session, documentId, 2);
    expect(response.status).toBe(200);
    const served = Buffer.from(await response.arrayBuffer());
    const [stored] = await previewRows(documentId);
    expect(stored).toMatchObject({ page: 2, status: "drawn" });
    expect(await previewAudits(documentId)).toHaveLength(1);

    await drainPreviewWorker();
    const rows = await previewRows(documentId);
    expect(rows.map((row) => row.page)).toEqual([1, 2, 3]);
    expect(rows.find((row) => row.page === 2)!.storage_key).toBe(stored!.storage_key);
    const keptTwo = decryptDocument(await readFile(previewObjectPath(stored!.storage_key!)), previewContextFor(fixture, documentId, stored!), envelopeOfRow(stored!), getDocumentConfig().keyEncryptionKey);
    expect(keptTwo.equals(served)).toBe(true);
    expect((await previewObjectKeys()).length - objectsBefore).toBe(3);
  }, 60_000);

  popplerIt("line 6: a drawing stopped by the clock is a refused timeout row; the next view answers 422 without a child and still audits; the worker retries it once (attempts 2), then leaves it", async () => {
    const fixture = await createIntegrationFixture("kept-previews-timeout");
    const { session, documentId } = await upload(fixture, tinyStepTilingPdf());
    setDocumentPreviewRenderBudgetForTests(100);

    const first = await askPreview(session, documentId, 1);
    expect(first.status).toBe(422);
    expect((await previewRows(documentId))[0]).toMatchObject({ page: 1, status: "refused", refusal: "timeout", attempts: 1, storage_key: null });

    await settled();
    const pidBefore = lastPdfSandboxChildPidForTests();
    const auditsBefore = (await previewAudits(documentId)).length;
    const second = await askPreview(session, documentId, 1);
    expect(second.status).toBe(422);
    expect((await second.json()).error.code).toBe("document_preview_failed");
    expect(lastPdfSandboxChildPidForTests()).toBe(pidBefore);
    expect(await previewAudits(documentId)).toHaveLength(auditsBefore + 1);

    await drainPreviewWorker();
    expect((await previewRows(documentId))[0]).toMatchObject({ status: "refused", refusal: "timeout", attempts: 2 });
    await drainPreviewWorker();
    expect((await previewRows(documentId))[0]).toMatchObject({ attempts: 2 });
    expect((await previewJobs(documentId)).at(-1)!.status).toBe("completed");
  }, 60_000);

  popplerIt("line 7: a memory refusal (renderMemoryMb 8, the 300 dpi scan) is final: the worker does not retry it; the view answers 422", async () => {
    const fixture = await createIntegrationFixture("kept-previews-memory");
    const { session, documentId } = await upload(fixture, colourScanPdf(300));
    setPdfStructureSandboxLimitsForTests({ renderMemoryMb: 8 });
    await drainPreviewWorker();
    expect((await previewRows(documentId))[0]).toMatchObject({ page: 1, status: "refused", refusal: "memory", attempts: 1 });
    await drainPreviewWorker();
    expect((await previewRows(documentId))[0]).toMatchObject({ attempts: 1 });
    expect((await askPreview(session, documentId, 1)).status).toBe(422);
  }, 60_000);

  popplerIt("line 8: signed out, another household's member and a pending_deletion document get the download's answers, and no audit row", async () => {
    const fixture = await createIntegrationFixture("kept-previews-access");
    const { session, documentId } = await upload(fixture, textPagesPdf(3));
    await drainPreviewWorker();
    const auditsBefore = (await previewAudits(documentId)).length;
    const both = async (asker: Session | undefined) => {
      const request = (route: typeof previewDocument, path: string) => asker
        ? callRouteForSession(route, asker, { url: `http://127.0.0.1:3000/api/documents/${documentId}/${path}`, params: { documentId } })
        : callRoute(route, { url: `http://127.0.0.1:3000/api/documents/${documentId}/${path}`, params: { documentId } });
      const download = await request(downloadDocument, "download");
      const preview = await request(previewDocument, "preview?page=1");
      expect(preview.status).toBe(download.status);
      expect(preview.status).not.toBe(200);
      if (download.status !== 401) expect(await preview.json()).toEqual(await download.json());
    };
    await both(undefined);
    await both(await fixture.session("outsider"));
    const deletion = await callRouteForSession(deleteDocument, session, { url: `http://127.0.0.1:3000/api/documents/${documentId}`, method: "DELETE", params: { documentId } });
    expect(deletion.status).toBe(200);
    await both(session);
    expect(await previewAudits(documentId)).toHaveLength(auditsBefore);
  }, 60_000);

  popplerIt("line 9: a page past page_count answers 404 document_preview_page_not_found without reading storage", async () => {
    const fixture = await createIntegrationFixture("kept-previews-past-end");
    const { session, documentId } = await upload(fixture, textPagesPdf(3));
    const reads = [
      vi.spyOn(LocalDocumentStorage.prototype, "unsealIntoBuffer"),
      vi.spyOn(LocalDocumentStorage.prototype, "unsealToQuarantine"),
      vi.spyOn(LocalDocumentStorage.prototype, "streamVerifiedPlaintext"),
    ];
    const response = await askPreview(session, documentId, 4);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("document_preview_page_not_found");
    for (const spy of reads) expect(spy).not.toHaveBeenCalled();
  }, 60_000);

  popplerIt("line 10: with page_count null (pre-#1436), the first view fills it, the worker's slice fills it, and the summary then carries it", async () => {
    const fixture = await createIntegrationFixture("kept-previews-null-count");
    const viewed = await upload(fixture, textPagesPdf(3), "viewed.pdf");
    const sliced = await upload(fixture, textPagesPdf(3), "sliced.pdf");
    await getDb().execute(sql`update documents set page_count = null where id in (${viewed.documentId}, ${sliced.documentId})`);

    expect((await askPreview(viewed.session, viewed.documentId, 1)).status).toBe(200);
    expect(await pageCountOf(viewed.documentId)).toBe(3);
    await drainPreviewWorker();
    expect(await pageCountOf(sliced.documentId)).toBe(3);

    const list = await callRouteForSession(listDocuments, viewed.session, {
      url: `http://127.0.0.1:3000/api/households/${fixture.household.id}/items/${fixture.item.id}/documents`,
      params: { householdId: fixture.household.id, itemId: fixture.item.id },
    });
    const payload = await list.json() as { documents: Array<{ id: string; pageCount?: number | null }> };
    for (const id of [viewed.documentId, sliced.documentId]) expect(payload.documents.find((entry) => entry.id === id)?.pageCount).toBe(3);
  }, 60_000);

  popplerIt("line 11: KEK rotation rewraps every document_previews row; the pages still unseal; rotationRemaining counts previews and reaches zero", async () => {
    const fixture = await createIntegrationFixture("kept-previews-rotation");
    const { session, documentId } = await upload(fixture, textPagesPdf(3));
    await drainPreviewWorker();
    const current = getDocumentConfig();
    const nextKek = randomBytes(32);
    const keys: RotationKeys = { currentKek: current.keyEncryptionKey, currentKeyId: current.keyId, nextKek, nextKeyId: deriveDocumentKeyId(nextKek) };
    const originalKek = process.env.DOCUMENT_KEK;
    try {
      const before = await rotationRemaining(keys) as unknown as { previewsRemaining?: number };
      expect(before.previewsRemaining).toBeGreaterThanOrEqual(3);
      const after = await runKekRotationToCompletion(keys) as unknown as { previewsRemaining?: number };
      expect(after.previewsRemaining).toBe(0);
      const rows = await previewRows(documentId);
      expect(rows.every((row) => row.key_id === keys.nextKeyId)).toBe(true);
      for (const row of rows) {
        const plaintext = decryptDocument(await readFile(previewObjectPath(row.storage_key!)), previewContextFor(fixture, documentId, row), envelopeOfRow(row), nextKek);
        expect(jpegFrameSize(plaintext)).toBeDefined();
      }
      // Served by an application that holds only the next key.
      process.env.DOCUMENT_KEK = nextKek.toString("hex");
      delete process.env.DOCUMENT_KEK_NEXT;
      resetDocumentConfigForTests();
      expect((await askPreview(session, documentId, 3)).status).toBe(200);
    } finally {
      if (originalKek === undefined) delete process.env.DOCUMENT_KEK;
      else process.env.DOCUMENT_KEK = originalKek;
      delete process.env.DOCUMENT_KEK_NEXT;
      resetDocumentConfigForTests();
    }
  }, 120_000);

  popplerIt("line 12: deletion keeps rows and objects; restoring serves the kept pages; after purge no previews/ object of the document remains", async () => {
    const fixture = await createIntegrationFixture("kept-previews-purge");
    const { session, documentId } = await upload(fixture, textPagesPdf(3));
    await drainPreviewWorker();
    const keys = (await previewRows(documentId)).map((row) => row.storage_key!);
    expect(keys).toHaveLength(3);
    const documentUrl = `http://127.0.0.1:3000/api/documents/${documentId}`;

    expect((await callRouteForSession(deleteDocument, session, { url: documentUrl, method: "DELETE", params: { documentId } })).status).toBe(200);
    expect(await previewRows(documentId)).toHaveLength(3);
    for (const key of keys) await expect(readFile(previewObjectPath(key))).resolves.toBeInstanceOf(Buffer);

    expect((await callRouteForSession(restoreDocumentRoute, session, { url: `${documentUrl}/restore`, method: "POST", params: { documentId } })).status).toBe(200);
    await settled();
    const pidBefore = lastPdfSandboxChildPidForTests();
    expect((await askPreview(session, documentId, 2)).status).toBe(200);
    expect(lastPdfSandboxChildPidForTests()).toBe(pidBefore);

    expect((await callRouteForSession(deleteDocument, session, { url: documentUrl, method: "DELETE", params: { documentId } })).status).toBe(200);
    await getDb().update(documents).set({ deleteAfter: new Date(Date.now() - 1_000) }).where(eq(documents.id, documentId));
    await runDocumentMaintenanceCycle();
    const [terminal] = await getDb().select({ lifecycle: documents.lifecycle }).from(documents).where(eq(documents.id, documentId));
    expect(terminal?.lifecycle).toBe("deleted");
    const remaining = await previewObjectKeys();
    for (const key of keys) expect(remaining).not.toContain(key);
  }, 120_000);

  popplerIt("#1803 dead letter: a failed preview job does not block a new generation, and one worker pass then draws the pages", async () => {
    const fixture = await createIntegrationFixture("kept-previews-dead-letter-enqueue");
    const { documentId } = await upload(fixture, textPagesPdf(3));
    await getDb().execute(sql`update document_jobs set status = 'failed', attempts = 5 where document_id = ${documentId} and kind::text = 'preview'`);

    await enqueuePreviewJob(getDb(), documentId);
    expect((await previewJobs(documentId)).map((job) => [job.generation, job.status])).toEqual([[1, "failed"], [2, "pending"]]);

    await drainPreviewWorker();
    expect((await previewRows(documentId)).map((row) => [row.page, row.status])).toEqual([[1, "drawn"], [2, "drawn"], [3, "drawn"]]);
    expect((await previewJobs(documentId)).map((job) => [job.generation, job.status])).toEqual([[1, "failed"], [2, "completed"]]);
  }, 60_000);

  popplerIt("#1803 dead letter: an administrator's retry sets a failed preview job pending with no attempts, and one worker pass completes it", async () => {
    const fixture = await createIntegrationFixture("kept-previews-dead-letter-retry");
    const { documentId } = await upload(fixture, textPagesPdf(3));
    await getDb().execute(sql`update document_jobs set status = 'failed', attempts = 5 where document_id = ${documentId} and kind::text = 'preview'`);
    const [failed] = await getDb().execute(sql`select id from document_jobs where document_id = ${documentId} and kind::text = 'preview'`) as unknown as { id: string }[];

    await updateDocumentJob(fixture.users.admin.id, failed!.id, "retry", "failed");
    const [retried] = await getDb().execute(sql`select status::text as status, attempts from document_jobs where id = ${failed!.id}`) as unknown as { status: string; attempts: number }[];
    expect(retried).toMatchObject({ status: "pending", attempts: 0 });
    expect(await previewRows(documentId)).toHaveLength(0);

    await drainPreviewWorker();
    expect((await previewRows(documentId)).map((row) => [row.page, row.status])).toEqual([[1, "drawn"], [2, "drawn"], [3, "drawn"]]);
    expect((await previewJobs(documentId)).map((job) => job.status)).toEqual(["completed"]);
  }, 60_000);

  popplerIt("#1803 interrupted purge: preview objects go, rows stay, the job retries; restore and view answer 404; the next pass finalizes", async () => {
    const fixture = await createIntegrationFixture("kept-previews-purge-interrupted");
    const { session, documentId } = await upload(fixture, textPagesPdf(3));
    await drainPreviewWorker();
    const keys = (await previewRows(documentId)).map((row) => row.storage_key!);
    expect(keys).toHaveLength(3);
    const documentUrl = `http://127.0.0.1:3000/api/documents/${documentId}`;
    expect((await callRouteForSession(deleteDocument, session, { url: documentUrl, method: "DELETE", params: { documentId } })).status).toBe(200);
    await getDb().update(documents).set({ deleteAfter: new Date(Date.now() - 1_000) }).where(eq(documents.id, documentId));

    const outage = vi.spyOn(LocalDocumentStorage.prototype, "deleteCiphertext").mockRejectedValueOnce(new Error("injected ciphertext delete outage"));
    await runDocumentMaintenanceCycle();
    outage.mockRestore();

    const remaining = await previewObjectKeys();
    for (const key of keys) expect(remaining).not.toContain(key);
    expect(await previewRows(documentId)).toHaveLength(3);
    const purgeJobs = async () => await getDb().execute(sql`select status::text as status from document_jobs where document_id = ${documentId} and kind::text = 'purge'`) as unknown as { status: string }[];
    expect((await purgeJobs()).map((job) => job.status)).toEqual(["retry"]);

    expect((await callRouteForSession(restoreDocumentRoute, session, { url: `${documentUrl}/restore`, method: "POST", params: { documentId } })).status).toBe(404);
    expect((await askPreview(session, documentId, 1)).status).toBe(404);

    await runDocumentMaintenanceCycle();
    expect(await previewRows(documentId)).toHaveLength(0);
    expect((await purgeJobs()).map((job) => job.status)).toEqual(["completed"]);
    const [terminal] = await getDb().select({ lifecycle: documents.lifecycle }).from(documents).where(eq(documents.id, documentId));
    expect(terminal?.lifecycle).toBe("deleted");
    const after = await previewObjectKeys();
    for (const key of keys) expect(after).not.toContain(key);
  }, 120_000);

  popplerIt("line 13: reconciliation deletes an unreferenced previews/ object older than 24 h, keeps a 1 h old one, and turns a drawn row whose object is missing into a new pending preview job", async () => {
    const fixture = await createIntegrationFixture("kept-previews-reconcile");
    const { documentId } = await upload(fixture, textPagesPdf(3));
    await drainPreviewWorker();
    const plant = async (hoursOld: number) => {
      const key = randomBytes(32).toString("hex");
      const path = previewObjectPath(key);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, randomBytes(64));
      const at = new Date(Date.now() - hoursOld * 3_600_000);
      await utimes(path, at, at);
      return key;
    };
    const stale = await plant(25);
    const fresh = await plant(1);
    const [missing] = (await previewRows(documentId)).filter((row) => row.page === 2);
    await rm(previewObjectPath(missing!.storage_key!));
    const generationBefore = Math.max(...(await previewJobs(documentId)).map((job) => job.generation));

    await reconcileDocumentStorage();

    const objects = await previewObjectKeys();
    expect(objects).not.toContain(stale);
    expect(objects).toContain(fresh);
    expect((await previewRows(documentId)).map((row) => row.page)).toEqual([1, 3]);
    const jobs = await previewJobs(documentId);
    expect(jobs.at(-1)).toMatchObject({ status: "pending" });
    expect(jobs.at(-1)!.generation).toBeGreaterThan(generationBefore);
    await rm(previewObjectPath(fresh), { force: true });
  }, 60_000);

  popplerIt("line 15: with a 100-page document then ten one-page documents enqueued, after 20 pages drawn in all every one-page document is completed", async () => {
    const fixture = await createIntegrationFixture("kept-previews-fairness");
    await drainPreviewWorker();
    const long = await upload(fixture, textPagesPdf(100), "long.pdf");
    const short: string[] = [];
    for (let index = 0; index < 10; index += 1) short.push((await upload(fixture, textPagesPdf(1), `short-${index}.pdf`)).documentId);
    const worker = await previewWorker();
    const drawnInAll = async () => {
      let total = 0;
      for (const id of [long.documentId, ...short]) total += (await previewRows(id)).filter((row) => row.status === "drawn").length;
      return total;
    };
    for (let round = 0; round < 40 && await drawnInAll() < 20; round += 1) await worker.runPreviewWorkerOnce();
    expect(await drawnInAll()).toBe(20);
    for (const id of short) expect((await previewJobs(id)).at(-1)!.status).toBe("completed");
  }, 180_000);

  popplerIt("line 16: the background child runs at nice 10 (/proc/<pid>/stat field 19)", async () => {
    const fixture = await createIntegrationFixture("kept-previews-nice");
    await upload(fixture, textPagesPdf(20), "twenty.pdf");
    const niceOf = (pid: number) => {
      const stat = readFileSync(`/proc/${pid}/stat`, "latin1");
      return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[16]);
    };
    const own = niceOf(process.pid);
    const ownCmdline = readFileSync("/proc/self/cmdline", "latin1");
    const seen = new Set<number>();
    const before = lastPdfSandboxChildPidForTests();
    const sampler = setInterval(() => {
      const pid = lastPdfSandboxChildPidForTests();
      if (pid === undefined || pid === before) return;
      try {
        // Skip the instants before the child's own stages run: after fork and
        // before exec it is a copy of this process (same command line, own
        // priority), and `nice` itself runs at the inherited priority until it
        // has lowered it and executed the wrapper shell. Every stage after that
        // (the shell, then pdftoppm) must be at nice 10.
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, "latin1");
        if (cmdline === "" || cmdline === ownCmdline || cmdline.split("\0")[0]!.split("/").pop() === "nice") return;
        seen.add(niceOf(pid));
      } catch {
        // gone between polls
      }
    }, 2);
    try {
      await (await previewWorker()).runPreviewWorkerOnce();
    } finally {
      clearInterval(sampler);
    }
    expect([...seen]).toEqual([Math.min(19, own + 10)]);
  }, 60_000);

  popplerIt("line 17: a document deleted mid-slice: the job completes without error, draws no further page, and leaves no orphan object", async () => {
    const fixture = await createIntegrationFixture("kept-previews-deleted-mid-slice");
    const { session, documentId } = await upload(fixture, textPagesPdf(20), "twenty.pdf");
    const objectsBefore = new Set(await previewObjectKeys());
    const worker = await previewWorker();
    const slice = worker.runPreviewWorkerOnce();
    // Delete once the first page is in.
    const deadline = Date.now() + 10_000;
    while ((await previewRows(documentId)).length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await callRouteForSession(deleteDocument, session, { url: `http://127.0.0.1:3000/api/documents/${documentId}`, method: "DELETE", params: { documentId } })).status).toBe(200);
    await slice; // completes without error
    const drawnAtDelete = (await previewRows(documentId)).length;
    await drainPreviewWorker();
    expect((await previewRows(documentId)).length).toBe(drawnAtDelete);
    expect(drawnAtDelete).toBeLessThan(10);
    expect((await previewJobs(documentId)).at(-1)!.status).toBe("completed");
    const referenced = new Set((await previewRows(documentId)).map((row) => row.storage_key));
    // Object keys are random and say nothing of their document, so an orphan is an
    // object that appeared during the test and that NO row ever refers to. Other
    // tests' pages are written a moment before their row, so give every added
    // object until the deadline to be referenced; a real orphan never is.
    const added = (await previewObjectKeys()).filter((key) => !objectsBefore.has(key));
    const settleBy = Date.now() + 15_000;
    let unreferenced: string[] = added;
    for (;;) {
      const rows = await getDb().execute(sql`select storage_key from document_previews where storage_key is not null`) as unknown as Array<{ storage_key: string }>;
      const anyRow = new Set(rows.map((row) => row.storage_key));
      unreferenced = added.filter((key) => !anyRow.has(key) && !referenced.has(key));
      if (unreferenced.length === 0 || Date.now() > settleBy) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(unreferenced, "orphan preview objects").toEqual([]);
  }, 60_000);

  popplerIt("line 19: health reports previewBytes as the sum of ciphertext_size over drawn rows, and previewsPending as preview jobs not completed", async () => {
    const fixture = await createIntegrationFixture("kept-previews-health");
    await upload(fixture, textPagesPdf(3));
    await drainPreviewWorker();
    await upload(fixture, textPagesPdf(2), "pending.pdf");
    const [bytes] = await getDb().execute(sql`select coalesce(sum(ciphertext_size), 0)::bigint as total from document_previews where status = 'drawn'`) as unknown as Array<{ total: string | number }>;
    const [pending] = await getDb().execute(sql`select count(*)::int as count from document_jobs where kind::text = 'preview' and status::text <> 'completed'`) as unknown as Array<{ count: number }>;
    const health = await getDocumentHealth() as unknown as { previewBytes?: number; previewsPending?: number };
    expect(health.previewBytes).toBe(Number(bytes!.total));
    expect(health.previewsPending).toBe(pending!.count);
    expect(health.previewsPending).toBeGreaterThanOrEqual(1);
  }, 60_000);

  /**
   * Line 14 runs the backup's own document-tree steps (the in-container
   * adapter's `collectDocumentsArchive` and `replaceDocumentsFromArchive`,
   * tar only, no database tools) into a fresh DOCUMENTS_ROOT, so the shared
   * test root is never replaced. The database is the live one: it stands in
   * for the restored dump, which holds the same rows (D19).
   */
  async function restoredDocumentTree<T>(body: () => Promise<T>): Promise<T> {
    const scratch = await mkdtemp(join(tmpdir(), "orbit-kept-previews-restore-"));
    const passwordFile = join(scratch, "unused-password");
    await writeFile(passwordFile, "unused-placeholder\n", { mode: 0o600 });
    const archive = join(scratch, "documents.tar");
    const restoredRoot = join(scratch, "documents");
    await mkdir(restoredRoot);
    createInContainerAdapter({ env: process.env, documentsRoot: getDocumentConfig().storageRoot, passwordFile, emitEvent: () => undefined }).collectDocumentsArchive(archive);
    expect(createInContainerAdapter({ env: process.env, documentsRoot: restoredRoot, passwordFile, emitEvent: () => undefined }).replaceDocumentsFromArchive(archive)).toBe(true);
    const originalRoot = process.env.DOCUMENTS_ROOT;
    process.env.DOCUMENTS_ROOT = restoredRoot;
    resetDocumentConfigForTests();
    try {
      return await body();
    } finally {
      if (originalRoot === undefined) delete process.env.DOCUMENTS_ROOT;
      else process.env.DOCUMENTS_ROOT = originalRoot;
      resetDocumentConfigForTests();
      await rm(scratch, { recursive: true, force: true });
    }
  }

  popplerIt("line 14: a backup taken after the worker ran restores with the kept pages serving without a child", async () => {
    const fixture = await createIntegrationFixture("kept-previews-backup");
    const { session, documentId } = await upload(fixture, textPagesPdf(3));
    await drainPreviewWorker();
    const rows = await previewRows(documentId);
    expect(rows.map((row) => row.status)).toEqual(["drawn", "drawn", "drawn"]);

    await restoredDocumentTree(async () => {
      for (const row of rows) await expect(readFile(previewObjectPath(row.storage_key!))).resolves.toBeInstanceOf(Buffer);
      await settled();
      const pidBefore = lastPdfSandboxChildPidForTests();
      for (const page of [1, 2, 3]) {
        const response = await askPreview(session, documentId, page);
        expect(response.status, `page ${page} after restore`).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/jpeg");
      }
      expect(lastPdfSandboxChildPidForTests()).toBe(pidBefore);
      expect(pdfStructureSandboxInFlightForTests()).toBe(0);
    });
  }, 90_000);

  popplerIt("line 14: a backup taken with one preview object removed restores cleanly, and the first reconciliation re-enqueues that document", async () => {
    const fixture = await createIntegrationFixture("kept-previews-backup-missing");
    const { documentId } = await upload(fixture, textPagesPdf(3));
    await drainPreviewWorker();
    const [missing] = (await previewRows(documentId)).filter((row) => row.page === 2);
    await rm(previewObjectPath(missing!.storage_key!));
    const generationBefore = Math.max(...(await previewJobs(documentId)).map((job) => job.generation));

    await restoredDocumentTree(async () => {
      await reconcileDocumentStorage();
      expect((await previewRows(documentId)).map((row) => row.page)).toEqual([1, 3]);
      const jobs = await previewJobs(documentId);
      expect(jobs.at(-1)).toMatchObject({ status: "pending" });
      expect(jobs.at(-1)!.generation).toBeGreaterThan(generationBefore);
    });
  }, 90_000);

  popplerIt("line 18: a portable export of a household with kept previews holds no preview entry, and its import enqueues a preview job per imported document", async () => {
    const passphrase = "correct-horse-battery-staple";
    // The label ends up in the household and item names, which an export carries,
    // and the archive must hold no "preview" at all: so none in the label.
    const source = await createIntegrationFixture("portable-export-source");
    const target = await createIntegrationFixture("portable-export-target");
    // The shared fixture seeds one 128-byte document per household with no crypto
    // row and no preview job. It is not a real upload: a real export cannot read
    // its bytes, and the import has never queued a job for it. Only uploaded
    // documents are under test here, so the seeded ones are dropped.
    await getDb().delete(documents).where(inArray(documents.id, [source.document.id, target.document.id]));
    const uploaded = [await upload(source, textPagesPdf(3), "kept-a.pdf"), await upload(source, textPagesPdf(2), "kept-b.pdf")];
    await drainPreviewWorker();
    const keptPlaintexts: Buffer[] = [];
    for (const { documentId } of uploaded) {
      const rows = await previewRows(documentId);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        keptPlaintexts.push(decryptDocument(await readFile(previewObjectPath(row.storage_key!)), previewContextFor(source, documentId, row), envelopeOfRow(row), getDocumentConfig().keyEncryptionKey));
      }
    }

    const archive = await createPortableArchive({ userId: source.users.owner.id, householdId: source.household.id, passphrase, includeDocuments: true });
    const { bytes } = await readPortableArchive(source.users.owner.id, archive.id);
    const file = Buffer.from(bytes);
    // The archive is format v2 (#1390): a manifest, then each document's bytes.
    const payload = v2PayloadOf(file, passphrase) as { documents: unknown[]; documentBytes: unknown[] } & Record<string, unknown>;
    const { documentBytes, ...manifest } = payload;
    const manifestText = JSON.stringify(manifest);
    const plaintext = openV2(file, passphrase);
    // No entry type, key or field for previews anywhere in the archive...
    expect(manifestText).not.toMatch(/preview/i);
    // ...one byte entry per document and no more...
    expect(payload.documents.length).toBeGreaterThanOrEqual(uploaded.length);
    expect(documentBytes).toHaveLength(payload.documents.length);
    // ...and no kept page's bytes, in the encodings an archive might use.
    for (const kept of keptPlaintexts) {
      expect(plaintext.includes(kept)).toBe(false);
      expect(manifestText.includes(kept.toString("base64"))).toBe(false);
      expect(manifestText.includes(kept.toString("base64url"))).toBe(false);
    }

    const result = await importPortableArchive({
      userId: target.users.owner.id,
      householdId: target.household.id,
      archive: archiveStream(file),
      passphrase,
      conflictItemIds: [],
    });
    expect(result.importedItems).toBeGreaterThan(0);
    const imported = await getDb().select({ id: documents.id }).from(documents)
      .where(and(eq(documents.householdId, target.household.id), eq(documents.lifecycle, "available")));
    expect(imported.length).toBeGreaterThanOrEqual(uploaded.length);
    for (const { id } of imported) {
      const jobs = await previewJobs(id);
      expect(jobs, `preview jobs for imported document ${id}`).toHaveLength(1);
      expect(jobs[0]!.status).toBe("pending");
    }
  }, 120_000);
});

/**
 * #1803: a kept page whose object is missing or damaged is discarded and drawn
 * again on that view (read repair); a busy wait is not a preview-job attempt;
 * a legacy image gets its page count. Effects only: rows, objects, jobs and
 * the served page, so this compiles against code without the fix.
 */
async function overwriteLastBytes(storageKey: string): Promise<void> {
  const path = previewObjectPath(storageKey);
  const bytes = await readFile(path);
  for (let index = bytes.length - 16; index < bytes.length; index += 1) bytes[index] = bytes[index]! ^ 0xff;
  await writeFile(path, bytes);
}

async function expectRepairedOnView(damage: (storageKey: string) => Promise<void>, label: string): Promise<void> {
  const fixture = await createIntegrationFixture(label);
  const { session, documentId } = await upload(fixture, textPagesPdf(3));
  await drainPreviewWorker();
  const before = await previewRows(documentId);
  expect(before.map((row) => row.status)).toEqual(["drawn", "drawn", "drawn"]);
  const oldKey = before[0]!.storage_key!;
  await damage(oldKey);
  await settled();

  const response = await askPreview(session, documentId, 1);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/jpeg");
  const served = Buffer.from(await response.arrayBuffer());
  expect(jpegFrameSize(served)).not.toBeNull();

  const after = await previewRows(documentId);
  expect(after.map((row) => row.page)).toEqual([1, 2, 3]);
  const repaired = after.find((row) => row.page === 1)!;
  expect(repaired.status).toBe("drawn");
  expect(repaired.storage_key).not.toBe(oldKey);
  expect(await previewObjectKeys()).not.toContain(oldKey);
  expect(await previewObjectKeys()).toContain(repaired.storage_key);
  for (const page of [2, 3]) expect(after.find((row) => row.page === page)!.storage_key).toBe(before.find((row) => row.page === page)!.storage_key);

  // A second view is served from the new kept page with no child.
  await settled();
  const pidBefore = lastPdfSandboxChildPidForTests();
  const again = await askPreview(session, documentId, 1);
  expect(again.status).toBe(200);
  expect(Buffer.from(await again.arrayBuffer()).equals(served)).toBe(true);
  expect(lastPdfSandboxChildPidForTests()).toBe(pidBefore);

  // The job the eviction queued finds nothing owed: completed, no child, no page redrawn.
  const jobs = await previewJobs(documentId);
  expect(jobs.at(-1)!.status).toBe("pending");
  expect(jobs.length).toBeGreaterThan(1);
  await drainPreviewWorker();
  expect((await previewJobs(documentId)).at(-1)!.status).toBe("completed");
  expect(lastPdfSandboxChildPidForTests()).toBe(pidBefore);
  const final = await previewRows(documentId);
  expect(final.map((row) => row.storage_key)).toEqual(after.map((row) => row.storage_key));
}

describe(`read repair of kept pages and preview-job Lows (#1803) ${NEEDS_POPPLER}`, () => {
  popplerIt("I1: a kept page whose object's last 16 bytes were overwritten is redrawn on view: 200 JPEG, new storage_key, old object gone, no child on the next view, worker completes with nothing drawn", async () => {
    await expectRepairedOnView(overwriteLastBytes, "read-repair-damaged");
  }, 120_000);

  popplerIt("I2: a kept page whose object was deleted is redrawn on view the same way", async () => {
    await expectRepairedOnView((key) => rm(previewObjectPath(key)), "read-repair-missing");
  }, 120_000);

  popplerIt("I3: the sweep still turns a drawn row whose object is missing into a deleted row and a new pending preview job", async () => {
    const fixture = await createIntegrationFixture("read-repair-sweep");
    const { documentId } = await upload(fixture, textPagesPdf(3));
    await drainPreviewWorker();
    const [missing] = (await previewRows(documentId)).filter((row) => row.page === 3);
    await rm(previewObjectPath(missing!.storage_key!));
    const generationBefore = Math.max(...(await previewJobs(documentId)).map((job) => job.generation));

    await reconcileDocumentStorage();

    expect((await previewRows(documentId)).map((row) => row.page)).toEqual([1, 2]);
    const jobs = await previewJobs(documentId);
    expect(jobs.at(-1)).toMatchObject({ status: "pending" });
    expect(jobs.at(-1)!.generation).toBeGreaterThan(generationBefore);
  }, 90_000);

  popplerIt("I4: a busy wait is not an attempt: five busy claims leave the job retry with attempts 0, and a genuine decrypt error afterwards leaves it retry, not failed", async () => {
    const fixture = await createIntegrationFixture("read-repair-busy");
    const { documentId } = await upload(fixture, textPagesPdf(3));
    const busy = () => Object.assign(new Error("quarantine full"), { code: "document_upload_space_busy" });
    // The worker claims every due preview job in the database, other tests'
    // documents included, so the failures are scripted for this document only.
    const original = LocalDocumentStorage.prototype.unsealToQuarantine;
    const script: Array<() => Error> = [busy, busy, busy, busy, busy, () => new Error("disk read failed")];
    let calls = 0;
    const spy = vi.spyOn(LocalDocumentStorage.prototype, "unsealToQuarantine").mockImplementation(function (this: LocalDocumentStorage, ...args: Parameters<typeof original>) {
      if (args[1] !== documentId) return original.apply(this, args);
      calls += 1;
      const next = script.shift();
      return next ? Promise.reject(next()) : original.apply(this, args);
    });
    const makeDue = () => getDb().execute(sql`update document_jobs set next_attempt_at = now() - interval '1 second' where document_id = ${documentId} and kind::text = 'preview' and status::text = 'retry'`);
    const state = async () => {
      const rows = await getDb().execute(sql`select status::text as status, attempts from document_jobs where document_id = ${documentId} and kind::text = 'preview' order by generation desc limit 1`);
      return rows[0] as unknown as { status: string; attempts: number };
    };

    for (let claim = 1; claim <= 5; claim += 1) {
      if (claim > 1) await makeDue();
      expect(await (await previewWorker()).runPreviewWorkerOnce()).toBeTruthy();
      expect(await state(), `after busy claim ${claim}`).toEqual({ status: "retry", attempts: 0 });
    }
    await makeDue();
    expect(await (await previewWorker()).runPreviewWorkerOnce()).toBeTruthy();
    expect(await state()).toMatchObject({ status: "retry" });
    expect(calls).toBe(6);
    spy.mockRestore();
  }, 90_000);

  it("I5: a legacy image document with page_count null gets page_count 1 from one worker pass, the job completes, and no further job is queued by enqueuePreviewJobIfIncomplete", async () => {
    const fixture = await createIntegrationFixture("read-repair-legacy-image");
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
    const bytes = syntheticJpeg();
    const session = await fixture.session("member");
    const response = await callRouteForSession(uploadDocument, session, {
      url: `http://127.0.0.1:3000/api/households/${fixture.household.id}/items/${fixture.item.id}/documents`,
      method: "POST",
      headers: { "content-length": String(bytes.length), "content-type": "image/jpeg", "x-orbit-filename": "legacy.jpg" },
      body: new Uint8Array(bytes),
      params: { householdId: fixture.household.id, itemId: fixture.item.id },
    });
    expect(response.status).toBe(201);
    const { document } = await response.json() as { document: { id: string } };
    await getDb().execute(sql`update documents set page_count = null where id = ${document.id}`);
    await getDb().execute(sql`delete from document_previews where document_id = ${document.id}`);
    await getDb().execute(sql`update document_jobs set status = 'pending', next_attempt_at = now() where document_id = ${document.id} and kind::text = 'preview'`);

    await (await previewWorker()).runPreviewWorkerOnce();

    expect(await pageCountOf(document.id)).toBe(1);
    const jobs = await previewJobs(document.id);
    expect(jobs.at(-1)!.status).toBe("completed");
    await enqueuePreviewJobIfIncomplete(getDb(), document.id);
    expect(await previewJobs(document.id)).toEqual(jobs);
  }, 60_000);
});
