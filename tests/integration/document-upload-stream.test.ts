/**
 * #1567: one ordinary document upload holds the file once, for the open check,
 * and seals it into the store in pieces from the quarantine file, verifying its
 * digest as it goes. The import of a portable archive restores each document
 * through the same path (#1566), so one fix covers both.
 *
 * Here, with the real database, the real document store and the real sandbox
 * (no test inspector): the scanner-recovery stage stores a staging object the
 * recovery worker opens and publishes unchanged; a refused file leaves nothing
 * behind; and, measured the way #1521's tests measure it, a second upload of a
 * PDF at the size limit, in a warmed process, raises the server process's peak
 * memory by less than the document's base64 size, and the document is stored
 * whole.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { documentCrypto, documentJobs, documentStagingObjects, documents } from "@/db/schema";
import { readDocumentDownload, uploadItemDocument } from "@/server/document-repository";
import { runDocumentMaintenanceCycle } from "@/server/document-worker";
import { getDocumentConfig, resetDocumentConfigForTests } from "@/server/documents/config";
import { decryptDocument, envelopeOf } from "@/server/documents/crypto";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { validateSupportedDocumentStructure } from "@/server/documents/validation";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { paddedPdfOfSize, writePaddedPdfFile } from "../support/large-pdf";
import { syntheticPdf } from "../support/synthetic-documents";

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(),
}));

// #1571: the recovery worker's open check is spied on (still real) to see the
// file it is handed.
vi.mock("@/server/documents/validation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/documents/validation")>();
  return { ...actual, validateSupportedDocumentStructure: vi.fn(actual.validateSupportedDocumentStructure) };
});

const MIB = 1_048_576;

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(scanFileWithClamAv).mockReset();
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
});

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;

/** The body the route hands the repository: a web stream, here in 1 MiB pieces. */
function bodyOf(bytes: Buffer): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(bytes.subarray(at, Math.min(at + MIB, bytes.length))));
      at += MIB;
    },
  });
}

function upload(fixture: Fixture, bytes: Buffer, documentId?: string) {
  return uploadItemDocument({
    userId: fixture.users.member.id,
    householdId: fixture.household.id,
    itemId: fixture.item.id,
    filename: "policy.pdf",
    body: bodyOf(bytes),
    declaredBytes: bytes.length,
    ...(documentId ? { documentId } : {}),
  });
}

function storage(): LocalDocumentStorage {
  return new LocalDocumentStorage(getDocumentConfig().storageRoot, getDocumentConfig().quarantineRoot);
}

/** Every file under the document store and the quarantine, so a refused upload can be shown to have left none. */
async function storedFiles(): Promise<string[]> {
  const config = getDocumentConfig();
  const listing = async (root: string) => (await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  return [...await listing(config.storageRoot), ...await listing(config.quarantineRoot)].sort();
}

async function withRequiredScanMode<T>(work: () => Promise<T>): Promise<T> {
  const previous = process.env.DOCUMENT_SCAN_MODE;
  process.env.DOCUMENT_SCAN_MODE = "required";
  resetDocumentConfigForTests();
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.DOCUMENT_SCAN_MODE;
    else process.env.DOCUMENT_SCAN_MODE = previous;
    resetDocumentConfigForTests();
  }
}

describe("the scanner-recovery stage seals from the quarantine file (#1567)", () => {
  it("stores a staging object whose size and envelope match its file, which the recovery worker opens and publishes unchanged", async () => {
    const fixture = await createIntegrationFixture("doc-upload-stream-recovery");
    const documentId = randomUUID();
    const bytes = paddedPdfOfSize(2 * MIB + 5);
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "unavailable" });
    await withRequiredScanMode(async () => {
      const staged = await upload(fixture, bytes, documentId);
      expect(staged).toMatchObject({ lifecycle: "scanning" });

      const [stage] = await getDb().select().from(documentStagingObjects).where(eq(documentStagingObjects.documentId, documentId));
      expect(stage).toMatchObject({ status: "pending", purpose: "scanner_recovery" });
      const staging = await readFile(join(getDocumentConfig().storageRoot, "staging", `${stage!.storageKey}.bin`));
      expect(stage!.ciphertextSize).toBe(staging.length);
      expect(staging.length).toBe(bytes.length);
      const opened = decryptDocument(staging, {
        documentId,
        householdId: fixture.household.id,
        itemId: fixture.item.id,
        mediaType: "application/pdf",
        plaintextSize: bytes.length,
        purpose: "scanner_recovery",
      }, envelopeOf(stage!), getDocumentConfig().keyEncryptionKey);
      expect(opened.equals(bytes)).toBe(true);
      expect(await storage().listQuarantineFiles(), "the quarantine file is discarded").toHaveLength(0);

      await getDb().update(documentJobs).set({ nextAttemptAt: new Date(Date.now() - 1_000) })
        .where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan")));
      vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
      await runDocumentMaintenanceCycle();

      const [document] = await getDb().select({ lifecycle: documents.lifecycle, scanStatus: documents.scanStatus })
        .from(documents).where(eq(documents.id, documentId));
      expect(document).toEqual({ lifecycle: "available", scanStatus: "clean" });
      expect(await getDb().select({ id: documentStagingObjects.documentId }).from(documentStagingObjects).where(eq(documentStagingObjects.documentId, documentId))).toHaveLength(0);
      const downloaded = await readDocumentDownload(fixture.users.member.id, documentId);
      expect(downloaded.bytes.equals(bytes)).toBe(true);
    });
  }, 300_000);
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Stages `bytes` as an upload the scanner could not reach, and returns the staging row. */
async function stageForRecovery(fixture: Fixture, bytes: Buffer, documentId: string) {
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "unavailable" });
  expect(await upload(fixture, bytes, documentId)).toMatchObject({ lifecycle: "scanning" });
  const [stage] = await getDb().select().from(documentStagingObjects).where(eq(documentStagingObjects.documentId, documentId));
  expect(stage).toMatchObject({ status: "pending", purpose: "scanner_recovery" });
  return stage!;
}

async function makeScanJobDue(documentId: string): Promise<void> {
  await getDb().update(documentJobs).set({ nextAttemptAt: new Date(Date.now() - 1_000) })
    .where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan")));
}

function stagingFile(storageKey: string): string {
  return join(getDocumentConfig().storageRoot, "staging", `${storageKey}.bin`);
}

/** The worker's end state for a stage it gave up on: rejected, stage row and file gone, nothing in quarantine, the scanner never asked. */
async function expectRejectedAsInvalidStage(documentId: string, storageKey: string): Promise<void> {
  expect(await getDb().select({ lifecycle: documents.lifecycle, failureCode: documents.failureCode }).from(documents).where(eq(documents.id, documentId)))
    .toEqual([{ lifecycle: "rejected", failureCode: "staging_object_invalid" }]);
  expect(await getDb().select({ id: documentStagingObjects.documentId }).from(documentStagingObjects).where(eq(documentStagingObjects.documentId, documentId)), "the stage is purged").toHaveLength(0);
  expect(await storage().stagingExists(storageKey), "the staging file is gone").toBe(false);
  expect(await getDb().select({ id: documentCrypto.documentId }).from(documentCrypto).where(eq(documentCrypto.documentId, documentId))).toHaveLength(0);
  expect(await storage().listQuarantineFiles(), "no quarantine file remains").toHaveLength(0);
  expect(vi.mocked(scanFileWithClamAv), "the scanner never saw the bytes").not.toHaveBeenCalled();
}

describe("the recovery worker decrypts into a quarantine file and verifies it before anything reads it (#1571)", () => {
  it("hands the scanner a .recovery file holding the plaintext, runs the check with its path and size, seals from that same file, and the published document round-trips byte for byte", async () => {
    const fixture = await createIntegrationFixture("doc-recovery-quarantine-file");
    const documentId = randomUUID();
    const bytes = paddedPdfOfSize(2 * MIB + 5);
    await withRequiredScanMode(async () => {
      const stage = await stageForRecovery(fixture, bytes, documentId);
      const seen: { path?: string; content?: Buffer; mode?: number } = {};
      vi.mocked(scanFileWithClamAv).mockReset();
      vi.mocked(scanFileWithClamAv).mockImplementation(async (path) => {
        seen.path = path;
        seen.content = await readFile(path);
        seen.mode = (await stat(path)).mode & 0o777;
        return { status: "clean" };
      });
      vi.mocked(validateSupportedDocumentStructure).mockClear();
      const unseals = vi.spyOn(LocalDocumentStorage.prototype, "unsealToQuarantine");
      const seals = vi.spyOn(LocalDocumentStorage.prototype, "sealQuarantine");
      await makeScanJobDue(documentId);

      await runDocumentMaintenanceCycle();

      expect(vi.mocked(scanFileWithClamAv)).toHaveBeenCalledTimes(1);
      expect(seen.path).toMatch(new RegExp(`${documentId}\\.[a-f0-9]{32}\\.recovery$`));
      expect(seen.content!.equals(bytes), "the scanner is handed the plaintext").toBe(true);
      expect(seen.mode).toBe(0o600);

      expect(unseals).toHaveBeenCalledTimes(1);
      expect(unseals.mock.calls[0]![0]).toEqual({ kind: "staging", storageKey: stage.storageKey });
      expect(unseals.mock.calls[0]![1]).toBe(documentId);
      expect(unseals.mock.calls[0]![2]).toEqual({ ciphertextSize: stage.ciphertextSize, plaintextSize: bytes.length });

      expect(vi.mocked(validateSupportedDocumentStructure)).toHaveBeenCalledTimes(1);
      const [checked, mediaType, options] = vi.mocked(validateSupportedDocumentStructure).mock.calls[0]!;
      expect(mediaType).toBe("application/pdf");
      expect(options).toEqual({ path: seen.path, sizeBytes: bytes.length });
      expect((checked as Buffer).byteLength === 0 || (checked as Buffer).every((byte) => byte === 0), "the check's copy is wiped").toBe(true);

      expect(seals).toHaveBeenCalledTimes(1);
      const [sealedPath, expectedContent, , destination] = seals.mock.calls[0]!;
      expect(sealedPath).toBe(seen.path);
      expect(expectedContent).toEqual({ sizeBytes: bytes.length, contentSha256: sha256(bytes) });
      expect(destination).toMatchObject({ kind: "object" });

      const [document] = await getDb().select({ lifecycle: documents.lifecycle, scanStatus: documents.scanStatus }).from(documents).where(eq(documents.id, documentId));
      expect(document).toEqual({ lifecycle: "available", scanStatus: "clean" });
      const [crypto] = await getDb().select().from(documentCrypto).where(eq(documentCrypto.documentId, documentId));
      expect(crypto!.storageKey).toBe((destination as { storageKey: string }).storageKey);
      expect(crypto!.ciphertextSize).toBe((await stat(join(getDocumentConfig().storageRoot, "objects", crypto!.storageKey.slice(0, 2), crypto!.storageKey.slice(2, 4), `${crypto!.storageKey}.bin`))).size);
      expect(await storage().stagingExists(stage.storageKey)).toBe(false);
      expect(await storage().listQuarantineFiles(), "the .recovery file is discarded once the seal is done").toHaveLength(0);
      const downloaded = await readDocumentDownload(fixture.users.member.id, documentId);
      expect(downloaded.bytes.equals(bytes)).toBe(true);
    });
  }, 300_000);

  it.each([
    ["near the start", 100],
    ["in the middle", 2 * MIB + 5 - 1_000_000],
    ["in the last byte", 2 * MIB + 5 - 1],
  ])("a flipped byte %s of the staging object ends in staging_object_invalid, with the stage purged, no quarantine file, and the scanner never called", async (_where, position) => {
    const fixture = await createIntegrationFixture("doc-recovery-tampered");
    const documentId = randomUUID();
    const bytes = paddedPdfOfSize(2 * MIB + 5);
    await withRequiredScanMode(async () => {
      const stage = await stageForRecovery(fixture, bytes, documentId);
      const stored = await readFile(stagingFile(stage.storageKey));
      expect(stored.length).toBe(bytes.length);
      stored[position] ^= 0xff;
      await writeFile(stagingFile(stage.storageKey), stored);
      vi.mocked(scanFileWithClamAv).mockReset();
      vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
      vi.mocked(validateSupportedDocumentStructure).mockClear();
      await makeScanJobDue(documentId);

      await runDocumentMaintenanceCycle();

      await expectRejectedAsInvalidStage(documentId, stage.storageKey);
      expect(vi.mocked(validateSupportedDocumentStructure)).not.toHaveBeenCalled();
    });
  }, 300_000);

  it("a stage whose plaintext digest differs from documents.content_sha256 ends the same way, though its tag is good", async () => {
    const fixture = await createIntegrationFixture("doc-recovery-digest-mismatch");
    const documentId = randomUUID();
    const bytes = paddedPdfOfSize(2 * MIB + 5);
    await withRequiredScanMode(async () => {
      const stage = await stageForRecovery(fixture, bytes, documentId);
      // Built by hand: the staged ciphertext is untouched and authenticates,
      // but the digest the upload recorded is that of other bytes.
      await getDb().update(documents).set({ contentSha256: sha256(Buffer.from("not this document")) }).where(eq(documents.id, documentId));
      vi.mocked(scanFileWithClamAv).mockReset();
      vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
      vi.mocked(validateSupportedDocumentStructure).mockClear();
      const unseals = vi.spyOn(LocalDocumentStorage.prototype, "unsealToQuarantine");
      await makeScanJobDue(documentId);

      await runDocumentMaintenanceCycle();

      expect(unseals, "the tag passed: the unseal itself succeeded").toHaveBeenCalledTimes(1);
      await expect(unseals.mock.results[0]!.value).resolves.toMatchObject({ contentSha256: sha256(bytes) });
      await expectRejectedAsInvalidStage(documentId, stage.storageKey);
      expect(vi.mocked(validateSupportedDocumentStructure)).not.toHaveBeenCalled();
    });
  }, 300_000);

  it("a retryable scanner outage still reschedules the job, keeps the stage, and leaves no quarantine file", async () => {
    const fixture = await createIntegrationFixture("doc-recovery-outage");
    const documentId = randomUUID();
    const bytes = paddedPdfOfSize(MIB + 5);
    await withRequiredScanMode(async () => {
      const stage = await stageForRecovery(fixture, bytes, documentId);
      vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "unavailable" });
      await makeScanJobDue(documentId);

      await runDocumentMaintenanceCycle();

      expect(vi.mocked(scanFileWithClamAv)).toHaveBeenCalled();
      expect(await getDb().select({ status: documentJobs.status, lastError: documentJobs.lastError }).from(documentJobs)
        .where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan"))))
        .toEqual([{ status: "retry", lastError: "scanner_unavailable" }]);
      expect(await getDb().select({ lifecycle: documents.lifecycle }).from(documents).where(eq(documents.id, documentId))).toEqual([{ lifecycle: "scanning" }]);
      expect(await storage().stagingExists(stage.storageKey)).toBe(true);
      expect(await storage().listQuarantineFiles()).toHaveLength(0);
    });
  }, 300_000);

  it("a stage under a key this instance does not hold is still retried as key_unavailable, and leaves no quarantine file", async () => {
    const fixture = await createIntegrationFixture("doc-recovery-unheld-key");
    const documentId = randomUUID();
    const bytes = paddedPdfOfSize(MIB + 5);
    await withRequiredScanMode(async () => {
      const stage = await stageForRecovery(fixture, bytes, documentId);
      await getDb().update(documentStagingObjects).set({ keyId: "key-this-instance-never-held" }).where(eq(documentStagingObjects.documentId, documentId));
      vi.mocked(scanFileWithClamAv).mockReset();
      vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
      await makeScanJobDue(documentId);

      await runDocumentMaintenanceCycle();

      expect(vi.mocked(scanFileWithClamAv)).not.toHaveBeenCalled();
      expect(await getDb().select({ status: documentJobs.status, lastError: documentJobs.lastError }).from(documentJobs)
        .where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan"))))
        .toEqual([{ status: "retry", lastError: "key_unavailable" }]);
      expect(await storage().stagingExists(stage.storageKey)).toBe(true);
      expect(await storage().listQuarantineFiles()).toHaveLength(0);
    });
  }, 300_000);
});

describe("a file the open check refuses leaves nothing, and the check's buffer is wiped (#1567)", () => {
  it("leaves no object, no staging file, no quarantine file and no metadata, and zeroes the buffer it read", async () => {
    const fixture = await createIntegrationFixture("doc-upload-stream-refused");
    const documentId = randomUUID();
    const refused = Buffer.from("%PDF-1.7\ntruncated, nothing a reader can open");
    const filesBefore = await storedFiles();
    const reads = vi.spyOn(LocalDocumentStorage.prototype, "readQuarantine");

    await expect(upload(fixture, refused, documentId)).rejects.toMatchObject({ code: "document_structure_invalid" });

    expect(await storedFiles()).toEqual(filesBefore);
    expect(await getDb().select({ id: documents.id }).from(documents).where(eq(documents.id, documentId))).toHaveLength(0);
    expect(await getDb().select({ id: documentCrypto.documentId }).from(documentCrypto).where(eq(documentCrypto.documentId, documentId))).toHaveLength(0);
    expect(reads).toHaveBeenCalledTimes(1);
    const buffer = await reads.mock.results[0]!.value as Buffer;
    expect(buffer.length).toBe(refused.length);
    expect(buffer.every((byte) => byte === 0)).toBe(true);
  }, 60_000);

  it("zeroes the buffer the check read on an accepted upload too, and reads the quarantine file once through readQuarantine", async () => {
    const fixture = await createIntegrationFixture("doc-upload-stream-wiped");
    const bytes = syntheticPdf("wiped after the check");
    const reads = vi.spyOn(LocalDocumentStorage.prototype, "readQuarantine");

    await expect(upload(fixture, bytes)).resolves.toMatchObject({ lifecycle: "available" });

    expect(reads).toHaveBeenCalledTimes(1);
    const buffer = await reads.mock.results[0]!.value as Buffer;
    expect(buffer.length).toBe(bytes.length);
    expect(buffer.every((byte) => byte === 0)).toBe(true);
  }, 60_000);

  it("lets go of the buffer the check read before the seal starts, so the encrypt stage never runs beside it", async () => {
    const fixture = await createIntegrationFixture("doc-upload-stream-dropped");
    const bytes = paddedPdfOfSize(2 * MIB + 5);
    setFlagsFromString("--expose-gc");
    const collect = runInNewContext("gc") as () => void;

    // Wrapped by hand: a vi.spyOn would keep the returned buffer alive in mock.results.
    const originalRead = LocalDocumentStorage.prototype.readQuarantine;
    const originalSeal = LocalDocumentStorage.prototype.sealQuarantine;
    let reads = 0;
    let readLength = -1;
    let heldBuffer: WeakRef<Buffer> | undefined;
    let seals = 0;
    let bufferCleared: boolean | undefined;
    let readBeforeSeal = false;
    LocalDocumentStorage.prototype.readQuarantine = async function (this: LocalDocumentStorage, ...args: Parameters<typeof originalRead>) {
      reads += 1;
      const buffer = await originalRead.apply(this, args);
      readLength = buffer.length;
      heldBuffer = new WeakRef(buffer);
      return buffer;
    };
    LocalDocumentStorage.prototype.sealQuarantine = function (this: LocalDocumentStorage, ...args: Parameters<typeof originalSeal>) {
      seals += 1;
      readBeforeSeal = heldBuffer !== undefined;
      collect();
      collect();
      bufferCleared = heldBuffer?.deref() === undefined;
      return originalSeal.apply(this, args);
    } as typeof originalSeal;
    try {
      await expect(upload(fixture, bytes)).resolves.toMatchObject({ lifecycle: "available" });
    } finally {
      LocalDocumentStorage.prototype.readQuarantine = originalRead;
      LocalDocumentStorage.prototype.sealQuarantine = originalSeal;
    }

    expect(reads).toBe(1);
    expect(readLength).toBe(bytes.length);
    expect(seals).toBe(1);
    expect(readBeforeSeal, "the check read the quarantine file before the seal started").toBe(true);
    expect(bufferCleared, "the open check's buffer is still reachable when the seal starts").toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------

type Measured = { first: { beforeKiB: number; afterKiB: number }; beforeKiB: number; afterKiB: number; result: { id: string; lifecycle: string; sizeBytes: number } };

/** Runs two uploads in a child process and reads back the peak-memory growth of each. */
async function measure(fixture: Fixture, file: string): Promise<Measured> {
  const tsx = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const child = fileURLToPath(new URL("./support/document-upload-memory-child.ts", import.meta.url));
  const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const proc = spawn(process.execPath, [tsx, child, fixture.users.member.id, fixture.household.id, fixture.item.id, file], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
  return JSON.parse(line!.slice("MEMORY_RESULT ".length)) as Measured;
}

// The first upload after a process starts pays one check copy plus a working
// set of freed stream chunks that glibc keeps resident (20-50 MiB at the limit;
// heapTotal does not move, so it is not the document path). Later uploads reuse
// it. The pinned figure is a second upload in the same process, the cost an
// operator pays per upload; the first is pinned under the bound plus one copy,
// so a second whole copy still fails cold.
describe("one upload in a warmed process raises its peak memory by less than the document's base64 size (#1567)", () => {
  let scratch: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "orbit-1567-memory-"));
  });

  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("holds under ceil(size / 3) * 4 bytes for a second upload of a PDF at the size limit, under that plus one copy for the first, and the document is stored whole", async () => {
    const size = getDocumentConfig().maxBytes;
    const file = join(scratch, "limit.pdf");
    await writePaddedPdfFile(file, size);
    expect((await stat(file)).size).toBe(size);
    const fixture = await createIntegrationFixture("doc-upload-stream-memory");

    const measured = await measure(fixture, file);

    expect(measured.result).toMatchObject({ lifecycle: "available", sizeBytes: size });
    const growthKiB = measured.afterKiB - measured.beforeKiB;
    const boundKiB = (Math.ceil(size / 3) * 4) / 1024;
    const firstGrowthKiB = measured.first.afterKiB - measured.first.beforeKiB;
    console.info(`#1567 upload memory: warm ${(growthKiB / 1024).toFixed(1)} MiB, first ${(firstGrowthKiB / 1024).toFixed(1)} MiB, bound ${(boundKiB / 1024).toFixed(1)} MiB`);
    expect(
      growthKiB,
      `upload (warm): peak RSS grew ${(growthKiB / 1024).toFixed(0)} MiB; bound is ${(boundKiB / 1024).toFixed(1)} MiB (the document's base64 size)`,
    ).toBeLessThan(boundKiB);
    expect(
      firstGrowthKiB,
      `upload (first after start): peak RSS grew ${(firstGrowthKiB / 1024).toFixed(0)} MiB; bound is ${((boundKiB + size / 1024) / 1024).toFixed(1)} MiB (the base64 size plus one copy; the first upload also pays the allocator's working set from the body stream)`,
    ).toBeLessThan(boundKiB + size / 1024);
    const downloaded = await readDocumentDownload(fixture.users.member.id, measured.result.id);
    expect(downloaded.bytes.length).toBe(size);
    expect(downloaded.bytes.equals(paddedPdfOfSize(size))).toBe(true);
  }, 600_000);
});
