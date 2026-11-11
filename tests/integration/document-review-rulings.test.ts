import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { setPdfStructureSandboxLimitsForTests } from "@/server/documents/pdf-structure-sandbox";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import {
  askPreview, drainPreviewWorker, errorCodeOf, previewJobs, previewRows, previewWorker, removeDocument, restoreDocument, storedPageCount, upload,
} from "./support/kept-previews";
import { syntheticJpeg } from "../support/synthetic-documents";
import { textPagesPdf } from "../support/pdf-measure/fixtures";
import { NEEDS_POPPLER, popplerIt, writeStubTool } from "../support/poppler-sandbox";

/**
 * Owner rulings of the review of #1436 / #1433 that the code does not yet
 * keep (design D20 and answer 12a): a fault on Orbit's side is never stored,
 * a busy-host stop of the page-count read is a retry rather than a finished
 * job, and a restore queues the draw again whenever a page is still owed.
 */

const gate = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined, reached: undefined as (() => void) | undefined }));

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(),
}));
// Lets a test hold a preview job just before it is marked completed.
vi.mock("@/server/document-maintenance/claims", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/document-maintenance/claims")>();
  return {
    ...actual,
    completeJob: (async (...args: Parameters<typeof actual.completeJob>) => {
      if (gate.hold) {
        gate.reached?.();
        await gate.hold;
      }
      return actual.completeJob(...args);
    }) as typeof actual.completeJob,
  };
});

const scratch: string[] = [];

afterAll(async () => {
  await cleanupIntegrationEnvironment();
  for (const directory of scratch) await rm(directory, { recursive: true, force: true });
});

afterEach(() => {
  setPdfStructureSandboxLimitsForTests(undefined);
  gate.hold = undefined;
  gate.reached = undefined;
  vi.restoreAllMocks();
  vi.mocked(scanFileWithClamAv).mockReset();
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
});

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "orbit-review-rulings-"));
  scratch.push(directory);
  return directory;
}

describe(`the review rulings ${NEEDS_POPPLER}`, () => {
  it("an image backend that cannot load during a view answers 503 document_preview_busy and stores no refusal (D20)", async () => {
    const fixture = await createIntegrationFixture("ruling-image-backend");
    const { session, documentId } = await upload(fixture, syntheticJpeg(), "pixel.jpg", "image/jpeg");
    const directory = await scratchDirectory();
    const broken = join(directory, "throwing-canvas.mjs");
    await writeFile(broken, 'throw new Error("no addon");\n');
    setPdfStructureSandboxLimitsForTests({ canvasUrl: pathToFileURL(broken).href, wallMs: 8_000 });

    const busy = await askPreview(session, documentId, 1);

    expect(busy.status).toBe(503);
    expect(await errorCodeOf(busy)).toBe("document_preview_busy");
    expect(Number(busy.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await previewRows(documentId)).toEqual([]);

    setPdfStructureSandboxLimitsForTests(undefined);
    expect((await askPreview(session, documentId, 1)).status).toBe(200);
  }, 60_000);

  popplerIt.each([
    ["timeout", `/bin/sleep 5`, { wallMs: 400 }],
    ["memory", `/bin/echo "std::bad_alloc" 1>&2\nexit 1`, {}],
    ["crash", `ulimit -c 0\nkill -SEGV $$`, {}],
  ] as const)("a busy-host stop of pdfinfo (%s) during the background job leaves the job to be retried, not completed with nothing drawn and no count", async (_stop, body, limits) => {
    const fixture = await createIntegrationFixture("ruling-count-stop");
    const { documentId } = await upload(fixture, textPagesPdf(3));
    // A document from before #1436: no stored count, so the worker must ask pdfinfo.
    await getDb().execute(sql`update documents set page_count = null where id = ${documentId}`);
    const directory = await scratchDirectory();
    setPdfStructureSandboxLimitsForTests({ pdfinfoPath: writeStubTool(directory, `pdfinfo-${_stop}`, body), ...limits });

    await (await previewWorker()).runPreviewWorkerOnce();

    const job = (await previewJobs(documentId)).at(-1)!;
    expect(["pending", "retry"], `the job is ${job.status}`).toContain(job.status);
    expect(await storedPageCount(documentId)).toBeNull();
    expect(await previewRows(documentId)).toEqual([]);

    // The host calms down: the retry reads the count and draws every page.
    setPdfStructureSandboxLimitsForTests(undefined);
    await getDb().execute(sql`update document_jobs set next_attempt_at = now() - interval '1 second' where document_id = ${documentId} and kind::text = 'preview'`);
    await drainPreviewWorker();
    expect(await storedPageCount(documentId)).toBe(3);
    expect((await previewRows(documentId)).map((row) => row.status)).toEqual(["drawn", "drawn", "drawn"]);
  }, 90_000);

  popplerIt("a restore that commits while the worker is still finishing a slice that saw pending_deletion still gets its pages drawn, with a job queued again (12a)", async () => {
    const fixture = await createIntegrationFixture("ruling-restore-race");
    const { session, documentId } = await upload(fixture, textPagesPdf(3));
    expect((await removeDocument(session, documentId)).status).toBe(200);

    // The slice sees pending_deletion and is held just before it completes the job.
    let reached!: () => void;
    const holding = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void;
    gate.hold = new Promise<void>((resolve) => { release = resolve; });
    gate.reached = reached;
    const slice = (await previewWorker()).runPreviewWorkerOnce();
    await Promise.race([holding, new Promise((resolve) => setTimeout(resolve, 15_000))]);
    expect((await previewJobs(documentId)).at(-1)!.status).toBe("processing");

    // The restore commits while the job is still processing.
    expect((await restoreDocument(session, documentId)).status).toBe(200);
    gate.hold = undefined;
    release();
    await slice;

    expect((await previewJobs(documentId)).at(-1)!.status, "a job is open again").not.toBe("completed");
    await drainPreviewWorker();
    expect((await previewRows(documentId)).map((row) => [row.page, row.status])).toEqual([[1, "drawn"], [2, "drawn"], [3, "drawn"]]);
  }, 90_000);

  popplerIt.each([
    ["timeout with one attempt", "timeout", 1, true],
    ["crash with one attempt", "crash", 1, true],
    ["timeout with both attempts used", "timeout", 2, false],
    ["memory (final)", "memory", 1, false],
  ] as const)("on restore, a %s counts as missing only while it has a retry left: the draw is queued again only then", async (_name, refusal, attempts, queued) => {
    const fixture = await createIntegrationFixture(`ruling-restore-${refusal}-${attempts}`);
    const { session, documentId } = await upload(fixture, textPagesPdf(3));
    await drainPreviewWorker();
    expect((await previewJobs(documentId)).at(-1)).toMatchObject({ status: "completed", generation: 1 });
    await getDb().execute(sql`
      update document_previews
      set status = 'refused', refusal = ${refusal}, attempts = ${attempts}, storage_key = null
      where document_id = ${documentId} and page = 2
    `);
    expect((await removeDocument(session, documentId)).status).toBe(200);

    expect((await restoreDocument(session, documentId)).status).toBe(200);

    const jobs = await previewJobs(documentId);
    if (queued) expect(jobs.at(-1), "queued again").toMatchObject({ status: "pending", generation: 2 });
    else expect(jobs.at(-1), "not queued").toMatchObject({ status: "completed", generation: 1 });
  }, 90_000);
});
