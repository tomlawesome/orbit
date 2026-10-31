/**
 * #1571: reading a stored document back verifies its tag before anything is
 * released, and holds no more than one copy of it. Measured the way #1567's
 * upload test measures it: a child process (tests/integration/support/
 * document-read-memory-child.ts) runs the operation twice, and the second run
 * is pinned as the growth in the process's peak resident memory over a
 * baseline taken after garbage collection, n being the document's size.
 *
 * - download: `openDocumentDownload` twice, each drained by a reader that
 *   keeps nothing. Warm under n / 2; the first under n (a whole copy fails
 *   both): the plaintext is only ever in flight in 1 MiB pieces.
 * - preview-read: `readDocumentDownload` twice, each buffer zeroed and
 *   dropped as a page preview does. Warm under ceil(n / 3) * 4 (one plaintext
 *   copy and a little: the ciphertext is no longer read whole beside it); the
 *   first under that plus n.
 * - recovery: the scanner-recovery worker processes two staged uploads of a
 *   PDF at the size limit. Warm under ceil(n / 3) * 4 (the document's base64
 *   size, one copy and a little); the first under that plus n.
 * - hold: a mailed attachment already in memory (the parser's buffer, outside
 *   the baseline) is scanned and held twice. Warm under ceil(n / 3) * 4.
 *
 * Recovery holds the check's one copy; every 1 MiB piece a pass produces is
 * zeroed and freed when it has been used, so the warm peak is that copy; the
 * scanner frees each chunk once the socket has written it, so the scan leaves
 * nothing for the collector. A whole extra copy fails both bounds. A figure within
 * 8 MiB of a bound is posted, never loosened (#1567's rule); every run logs
 * its figures.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { documentJobs } from "@/db/schema";
import { readDocumentDownload, uploadItemDocument } from "@/server/document-repository";
import { getDocumentConfig, resetDocumentConfigForTests } from "@/server/documents/config";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { paddedPdfOfSize, writePaddedPdfFile } from "../support/large-pdf";

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(),
}));

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type Measured<Result> = {
  first?: { beforeKiB: number; afterKiB: number };
  beforeKiB: number;
  afterKiB: number;
  result: Result;
};

/** Runs the child with `args` and reads back its one MEMORY_RESULT line. */
async function measure<Result>(args: string[]): Promise<Measured<Result>> {
  const tsx = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const child = fileURLToPath(new URL("./support/document-read-memory-child.ts", import.meta.url));
  const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const proc = spawn(process.execPath, [tsx, child, ...args], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  expect(run.code, run.stderr).toBe(0);
  const line = run.stdout.split("\n").find((candidate) => candidate.startsWith("MEMORY_RESULT "));
  expect(line, `child output: ${run.stdout}\n${run.stderr}`).toBeDefined();
  return JSON.parse(line!.slice("MEMORY_RESULT ".length)) as Measured<Result>;
}

function bounds(size: number): { warmKiB: number; firstKiB: number } {
  const warmKiB = (Math.ceil(size / 3) * 4) / 1024;
  return { warmKiB, firstKiB: warmKiB + size / 1024 };
}

function mib(kib: number): string {
  return (kib / 1024).toFixed(1);
}

describe("reading a stored document back holds one copy at most (#1571)", () => {
  let scratch: string;
  let file: string;
  const size = getDocumentConfig().maxBytes;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "orbit-1571-memory-"));
    file = join(scratch, "limit.pdf");
    await writePaddedPdfFile(file, size);
    expect((await stat(file)).size).toBe(size);
  });

  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  /** Uploads the limit-sized PDF the way a user would (the scanner mock answers clean) and returns the stored document's id. */
  async function storeLimitDocument(name: string): Promise<{ userId: string; documentId: string }> {
    const fixture = await createIntegrationFixture(name);
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
    const stored = await uploadItemDocument({
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      itemId: fixture.item.id,
      filename: "policy.pdf",
      body: Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>,
      declaredBytes: size,
    });
    expect(stored).toMatchObject({ lifecycle: "available", sizeBytes: size });
    return { userId: fixture.users.member.id, documentId: stored.id };
  }

  it("download: the second of two streamed downloads of a PDF at the size limit holds under n / 2 bytes, the first under n, and each delivers the whole document", async () => {
    const { userId, documentId } = await storeLimitDocument("doc-read-memory-download");

    const measured = await measure<{ sizeBytes: number; received: number }>(["download", userId, documentId]);

    expect(measured.result).toEqual({ sizeBytes: size, received: size });
    const warmKiB = size / 2 / 1024;
    const firstKiB = size / 1024;
    const growthKiB = measured.afterKiB - measured.beforeKiB;
    const firstGrowthKiB = measured.first!.afterKiB - measured.first!.beforeKiB;
    console.info(`#1571 download memory: warm ${mib(growthKiB)} MiB, first ${mib(firstGrowthKiB)} MiB, bounds ${mib(warmKiB)} / ${mib(firstKiB)} MiB`);
    expect(growthKiB, `download (warm): peak RSS grew ${mib(growthKiB)} MiB; bound is ${mib(warmKiB)} MiB (n / 2)`).toBeLessThan(warmKiB);
    expect(firstGrowthKiB, `download (first): peak RSS grew ${mib(firstGrowthKiB)} MiB; bound is ${mib(firstKiB)} MiB (n)`).toBeLessThan(firstKiB);
  }, 600_000);

  it("preview-read: the second of two reads of a PDF at the size limit holds under ceil(n / 3) * 4 bytes, the first under that plus n", async () => {
    const { userId, documentId } = await storeLimitDocument("doc-read-memory-preview");

    const measured = await measure<{ sizeBytes: number }>(["preview-read", userId, documentId]);

    expect(measured.result).toEqual({ sizeBytes: size });
    const { warmKiB, firstKiB } = bounds(size);
    const growthKiB = measured.afterKiB - measured.beforeKiB;
    const firstGrowthKiB = measured.first!.afterKiB - measured.first!.beforeKiB;
    console.info(`#1571 preview-read memory: warm ${mib(growthKiB)} MiB, first ${mib(firstGrowthKiB)} MiB, bounds ${mib(warmKiB)} / ${mib(firstKiB)} MiB`);
    expect(growthKiB, `preview-read (warm): peak RSS grew ${mib(growthKiB)} MiB; bound is ${mib(warmKiB)} MiB (the base64 size)`).toBeLessThan(warmKiB);
    expect(firstGrowthKiB, `preview-read (first): peak RSS grew ${mib(firstGrowthKiB)} MiB; bound is ${mib(firstKiB)} MiB (the base64 size plus one copy)`).toBeLessThan(firstKiB);
  }, 600_000);

  it("recovery: the second of two scanner-recovery runs of a PDF at the size limit holds under ceil(n / 3) * 4 bytes, the first under that plus n, and both documents are published whole", async () => {
    const fixture = await createIntegrationFixture("doc-read-memory-recovery");
    const documentIds = [randomUUID(), randomUUID()];
    const previous = process.env.DOCUMENT_SCAN_MODE;
    process.env.DOCUMENT_SCAN_MODE = "required";
    resetDocumentConfigForTests();
    try {
      // Staged under the scanner mock: the scanner is unreachable, so each upload waits for the recovery worker.
      vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "unavailable" });
      for (const documentId of documentIds) {
        const staged = await uploadItemDocument({
          userId: fixture.users.member.id,
          householdId: fixture.household.id,
          itemId: fixture.item.id,
          filename: "policy.pdf",
          body: Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>,
          declaredBytes: size,
          documentId,
        });
        expect(staged).toMatchObject({ lifecycle: "scanning" });
      }
    } finally {
      if (previous === undefined) delete process.env.DOCUMENT_SCAN_MODE;
      else process.env.DOCUMENT_SCAN_MODE = previous;
      resetDocumentConfigForTests();
    }
    // Due, and ahead of any other job in the shared database, so the child claims exactly these two.
    for (const documentId of documentIds) {
      await getDb().update(documentJobs).set({ nextAttemptAt: new Date(Date.now() - 365 * 86_400_000) })
        .where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan")));
    }

    const measured = await measure<{ documents: Array<{ id: string; lifecycle: string; failureCode: string | null }>; scannedBytes: number[] }>(["recovery", ...documentIds]);

    expect(measured.result.documents.map((document) => ({ lifecycle: document.lifecycle, failureCode: document.failureCode })))
      .toEqual([{ lifecycle: "available", failureCode: null }, { lifecycle: "available", failureCode: null }]);
    expect(measured.result.scannedBytes, "the fake clamd was given the whole recovered document, twice").toEqual([size, size]);
    const { warmKiB, firstKiB } = bounds(size);
    const growthKiB = measured.afterKiB - measured.beforeKiB;
    const firstGrowthKiB = measured.first!.afterKiB - measured.first!.beforeKiB;
    console.info(`#1571 recovery memory: warm ${mib(growthKiB)} MiB, first ${mib(firstGrowthKiB)} MiB, bounds ${mib(warmKiB)} / ${mib(firstKiB)} MiB`);
    expect(growthKiB, `recovery (warm): peak RSS grew ${mib(growthKiB)} MiB; bound is ${mib(warmKiB)} MiB (the document's base64 size)`).toBeLessThan(warmKiB);
    expect(firstGrowthKiB, `recovery (first): peak RSS grew ${mib(firstGrowthKiB)} MiB; bound is ${mib(firstKiB)} MiB (the base64 size plus one copy)`).toBeLessThan(firstKiB);

    const expected = paddedPdfOfSize(size);
    for (const documentId of documentIds) {
      const downloaded = await readDocumentDownload(fixture.users.member.id, documentId);
      expect(downloaded.bytes.length).toBe(size);
      expect(downloaded.bytes.equals(expected)).toBe(true);
    }
  }, 900_000);

  it("hold: the second of two holdings of a mailed PDF at the size limit, its bytes already in memory, holds under ceil(n / 3) * 4 bytes", async () => {
    const fixture = await createIntegrationFixture("doc-read-memory-hold");

    const measured = await measure<{ sizeBytes: number; ciphertextSize: number; contentLength: number }>(["hold", file, fixture.users.member.id, randomUUID()]);

    expect(measured.result).toEqual({ sizeBytes: size, ciphertextSize: size, contentLength: size });
    const { warmKiB } = bounds(size);
    const growthKiB = measured.afterKiB - measured.beforeKiB;
    const firstGrowthKiB = measured.first!.afterKiB - measured.first!.beforeKiB;
    console.info(`#1571 hold memory: warm ${mib(growthKiB)} MiB, first ${mib(firstGrowthKiB)} MiB, bound ${mib(warmKiB)} MiB`);
    expect(growthKiB, `hold (warm): peak RSS grew ${mib(growthKiB)} MiB; bound is ${mib(warmKiB)} MiB (the document's base64 size)`).toBeLessThan(warmKiB);
  }, 600_000);
});
