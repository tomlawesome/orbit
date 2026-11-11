import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, vi } from "vitest";
import { getDb } from "@/db";
import { reconcileDocumentStorage } from "@/server/document-worker";
import { lastPdfSandboxChildPidForTests, setPdfStructureSandboxLimitsForTests } from "@/server/documents/pdf-structure-sandbox";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { seedStoredDocuments } from "./support/stored-documents";
import { enqueuePreviewJob } from "@/server/document-maintenance/preview-queue";
import {
  askPreview, drainPreviewWorker, errorCodeOf, previewJobs, previewRows, removeDocument, restoreDocument, storedPageCount, upload,
} from "./support/kept-previews";
import { syntheticPdfWithPages } from "../support/generated-pdf-documents";
import { textPagesPdf } from "../support/pdf-measure/fixtures";
import { NEEDS_POPPLER, popplerIt, writeStubTool } from "../support/poppler-sandbox";
import { scanFileWithClamAv } from "@/server/documents/scanner";

/**
 * The review fixes of #1436 and #1433 (commit bdd4b8a2). Every case draws with
 * the real pdfinfo/pdftoppm unless it says it stands one in, so all go
 * through `popplerIt`.
 *
 * Documents past 100 pages exist only from before #1436 (the upload check now
 * refuses them), so those cases seed them straight into the store, as an
 * upload under the old 1,000-page cap once left them.
 */

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(),
}));

const scratch: string[] = [];

afterAll(async () => {
  await cleanupIntegrationEnvironment();
  for (const directory of scratch) await rm(directory, { recursive: true, force: true });
});

afterEach(() => {
  setPdfStructureSandboxLimitsForTests(undefined);
  vi.restoreAllMocks();
  vi.mocked(scanFileWithClamAv).mockReset();
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
});

describe(`the review fixes ${NEEDS_POPPLER}`, () => {
  popplerIt("a document with a stored page count over 100 draws page 101 and page 1000 when viewed, and page 1001 is refused", async () => {
    const fixture = await createIntegrationFixture("review-over-100");
    const [documentId] = await seedStoredDocuments(fixture, [syntheticPdfWithPages(1_000)]);
    await getDb().execute(sql`update documents set page_count = 1000 where id = ${documentId}`);
    const session = await fixture.session("member");

    for (const page of [101, 1_000]) {
      const response = await askPreview(session, documentId, page);
      expect(response.status, `page ${page}`).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/jpeg");
      expect(response.headers.get("x-orbit-page-count")).toBe("1000");
    }
    expect((await previewRows(documentId)).map((row) => row.page)).toEqual([101, 1_000]);

    const past = await askPreview(session, documentId, 1_001);
    expect(past.status).toBe(400);
    expect(await errorCodeOf(past)).toBe("document_preview_page_invalid");
  }, 120_000);

  popplerIt("the background job on a document over 100 pages with no stored count stores the real count and draws exactly the first 100", async () => {
    const fixture = await createIntegrationFixture("review-count-unknown");
    const [documentId] = await seedStoredDocuments(fixture, [syntheticPdfWithPages(150)]);
    expect(await storedPageCount(documentId)).toBeNull();
    await enqueuePreviewJob(getDb(), documentId);

    await drainPreviewWorker(60);

    expect(await storedPageCount(documentId)).toBe(150);
    const rows = await previewRows(documentId);
    expect(rows.map((row) => row.page)).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
    expect(new Set(rows.map((row) => row.status))).toEqual(new Set(["drawn"]));
    expect((await previewJobs(documentId)).at(-1)!.status).toBe("completed");
  }, 240_000);

  popplerIt("restoring a document after a pending_deletion that the worker passed over queues the background draw again", async () => {
    const fixture = await createIntegrationFixture("review-restore-queues");
    const { session, documentId } = await upload(fixture, textPagesPdf(3));
    expect((await removeDocument(session, documentId)).status).toBe(200);
    await drainPreviewWorker();
    expect(await previewRows(documentId)).toEqual([]);
    expect((await previewJobs(documentId)).at(-1)!.status).toBe("completed");

    expect((await restoreDocument(session, documentId)).status).toBe(200);
    const jobs = await previewJobs(documentId);
    expect(jobs.at(-1)).toMatchObject({ status: "pending", generation: 2 });

    await drainPreviewWorker();
    expect((await previewRows(documentId)).map((row) => [row.page, row.status])).toEqual([[1, "drawn"], [2, "drawn"], [3, "drawn"]]);
  }, 90_000);

  popplerIt.each([
    ["a full quarantine tmpfs", "tmpfs"],
    ["a missing pdftoppm", "tool"],
  ] as const)("during a view, %s answers 503 document_preview_busy with Retry-After and stores no refusal; a later view after the fault clears draws the page", async (_name, fault) => {
    const fixture = await createIntegrationFixture(`review-busy-${fault}`);
    const { session, documentId } = await upload(fixture, textPagesPdf(3));

    const originalRoot = process.env.DOCUMENTS_QUARANTINE_ROOT;
    if (fault === "tmpfs") {
      // A path the sandbox cannot make its directory under, as a volume with no room for the descriptor's file.
      const directory = await mkdtemp(join(tmpdir(), "orbit-review-busy-"));
      scratch.push(directory);
      const blocker = join(directory, "not-a-directory");
      await writeFile(blocker, "x");
      process.env.DOCUMENTS_QUARANTINE_ROOT = blocker;
    } else {
      setPdfStructureSandboxLimitsForTests({ pdftoppmPath: join(tmpdir(), "orbit-no-such-pdftoppm") });
    }
    try {
      const busy = await askPreview(session, documentId, 1);
      expect(busy.status).toBe(503);
      expect(await errorCodeOf(busy)).toBe("document_preview_busy");
      expect(Number(busy.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(await previewRows(documentId)).toEqual([]);
    } finally {
      if (originalRoot === undefined) delete process.env.DOCUMENTS_QUARANTINE_ROOT;
      else process.env.DOCUMENTS_QUARANTINE_ROOT = originalRoot;
      setPdfStructureSandboxLimitsForTests(undefined);
    }

    const later = await askPreview(session, documentId, 1);
    expect(later.status).toBe(200);
    expect((await previewRows(documentId)).map((row) => [row.page, row.status])).toEqual([[1, "drawn"]]);
  }, 60_000);

  popplerIt("a page pdftoppm refuses as unsupported answers 415 document_preview_unsupported on the first view and on every later one", async () => {
    const fixture = await createIntegrationFixture("review-unsupported");
    const { session, documentId } = await upload(fixture, textPagesPdf(3));
    const directory = await mkdtemp(join(tmpdir(), "orbit-review-refuse-"));
    scratch.push(directory);
    // pdftoppm's own exit code 1: it could not open the file's page.
    const refuser = writeStubTool(directory, "pdftoppm-refuses", `/bin/echo "Syntax Error: Couldn't read xref table" 1>&2\nexit 1`);
    setPdfStructureSandboxLimitsForTests({ pdftoppmPath: refuser });

    const first = await askPreview(session, documentId, 2);
    expect(first.status).toBe(415);
    expect(await errorCodeOf(first)).toBe("document_preview_unsupported");
    expect((await previewRows(documentId))[0]).toMatchObject({ page: 2, status: "refused", refusal: "unsupported" });

    // The remembered answer, with no child, even once the real renderer is back.
    setPdfStructureSandboxLimitsForTests(undefined);
    const pidBefore = lastPdfSandboxChildPidForTests();
    for (let view = 0; view < 2; view += 1) {
      const again = await askPreview(session, documentId, 2);
      expect(again.status).toBe(415);
      expect(await errorCodeOf(again)).toBe("document_preview_unsupported");
    }
    expect(lastPdfSandboxChildPidForTests()).toBe(pidBefore);
  }, 60_000);

  popplerIt("storage reconciliation reads the preview rows in bounded batches: with more rows than one batch, every row is still checked", async () => {
    const fixture = await createIntegrationFixture("review-reconcile-batches");
    const { documentId } = await upload(fixture, textPagesPdf(2));
    await drainPreviewWorker();
    const kept = await previewRows(documentId);
    expect(kept).toHaveLength(2);
    // 1,200 more drawn rows (more than two batches of 500) whose objects were never written.
    await getDb().execute(sql`
      insert into document_previews (document_id, page, status, attempts, renderer, media_type, width, height, plaintext_size, ciphertext_size, storage_key, envelope_version, content_iv, content_auth_tag, wrapped_dek, wrap_iv, wrap_auth_tag, key_id)
      select document_id, 1000 + n, status, attempts, renderer, media_type, width, height, plaintext_size, ciphertext_size,
             md5(random()::text || n::text) || md5(n::text || random()::text), envelope_version, content_iv, content_auth_tag, wrapped_dek, wrap_iv, wrap_auth_tag, key_id
      from document_previews, generate_series(1, 1200) as n
      where document_id = ${documentId} and page = 1
    `);
    const exists = vi.spyOn(LocalDocumentStorage.prototype, "previewExists");
    // The volume is walked a first-level shard at a time, not as one listing.
    const shards = vi.spyOn(LocalDocumentStorage.prototype, "listPreviewShards" as never);

    await reconcileDocumentStorage();

    expect(exists.mock.calls.length).toBeGreaterThanOrEqual(1_202);
    expect(shards).toHaveBeenCalled();
    // Every missing object's row went, the two real pages stayed.
    expect((await previewRows(documentId)).map((row) => row.page)).toEqual([1, 2]);
  }, 120_000);
});
