/**
 * #1567: one ordinary document upload holds the file once, for the open check,
 * and seals it into the store in pieces from the quarantine file, verifying its
 * digest as it goes. The import of a portable archive restores each document
 * through the same path (#1566), so one fix covers both.
 *
 * Here, with the real database, the real document store and the real sandbox
 * (no test inspector): a PDF at the size limit round-trips byte for byte; the
 * stored envelope and ciphertext size match the file; the scanner-recovery
 * stage stores a staging object the recovery worker opens and publishes
 * unchanged; a refused file leaves nothing behind; and, measured the way
 * #1521's tests measure it, one upload raises the server process's peak
 * memory by less than the document's base64 size.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { documentCrypto, documentJobs, documentStagingObjects, documents } from "@/db/schema";
import { readDocumentDownload, uploadItemDocument } from "@/server/document-repository";
import { runDocumentMaintenanceCycle } from "@/server/document-worker";
import { getDocumentConfig, resetDocumentConfigForTests } from "@/server/documents/config";
import { decryptDocument, envelopeOf } from "@/server/documents/crypto";
import { lastPdfSandboxChildPidForTests } from "@/server/documents/pdf-structure-sandbox";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { paddedPdfOfSize, writePaddedPdfFile } from "../support/large-pdf";
import { syntheticPdf } from "../support/synthetic-documents";

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(),
}));

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

describe("an upload at the size limit, with the real sandbox (#1567)", () => {
  it("round-trips a PDF of getDocumentConfig().maxBytes byte for byte, and what is stored matches the file", async () => {
    const fixture = await createIntegrationFixture("doc-upload-stream-limit");
    const bytes = paddedPdfOfSize(getDocumentConfig().maxBytes);
    expect(bytes.length).toBe(getDocumentConfig().maxBytes);
    const childBefore = lastPdfSandboxChildPidForTests();

    const summary = await upload(fixture, bytes);

    expect(summary).toMatchObject({ lifecycle: "available", sizeBytes: bytes.length });
    expect(lastPdfSandboxChildPidForTests(), "the real sandbox ran the check").toEqual(expect.any(Number));
    expect(lastPdfSandboxChildPidForTests()).not.toBe(childBefore);
    const downloaded = await readDocumentDownload(fixture.users.member.id, summary.id);
    expect(downloaded.bytes.length).toBe(bytes.length);
    expect(downloaded.bytes.equals(bytes)).toBe(true);

    const [crypto] = await getDb().select().from(documentCrypto).where(eq(documentCrypto.documentId, summary.id));
    const ciphertext = await storage().readCiphertext(crypto!.storageKey, bytes.length + MIB);
    expect(crypto!.ciphertextSize).toBe(ciphertext.length);
    expect(ciphertext.length).toBe(bytes.length);
    expect((await storedFiles()).filter((file) => file.endsWith(".tmp")), "no temporary file").toEqual([]);
    expect((await storage().listQuarantineFiles())).toHaveLength(0);
  }, 300_000);

  it("stores an envelope the row's columns describe, and a ciphertext that opens to the upload", async () => {
    const fixture = await createIntegrationFixture("doc-upload-stream-envelope");
    const bytes = paddedPdfOfSize(2 * MIB + 17);

    const summary = await upload(fixture, bytes);

    const [crypto] = await getDb().select().from(documentCrypto).where(eq(documentCrypto.documentId, summary.id));
    const ciphertext = await storage().readCiphertext(crypto!.storageKey, 4 * MIB);
    expect(crypto!.ciphertextSize).toBe(ciphertext.length);
    const opened = decryptDocument(ciphertext, {
      documentId: summary.id,
      householdId: fixture.household.id,
      itemId: fixture.item.id,
      mediaType: "application/pdf",
      plaintextSize: bytes.length,
    }, envelopeOf(crypto!), getDocumentConfig().keyEncryptionKey);
    expect(opened.equals(bytes)).toBe(true);
  }, 120_000);
});

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
      const staging = await storage().readStagingCiphertext(stage!.storageKey, bytes.length + MIB);
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
});

// ---------------------------------------------------------------------------

type Measured = { beforeKiB: number; afterKiB: number; result: { id: string; lifecycle: string; sizeBytes: number } };

/** Runs one upload in a child process and reads back its peak-memory growth. */
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

describe("one upload raises the process's peak memory by less than the document's base64 size (#1567)", () => {
  let scratch: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "orbit-1567-memory-"));
  });

  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("holds under ceil(size / 3) * 4 bytes for a PDF at the size limit, and the document is stored whole", async () => {
    const size = getDocumentConfig().maxBytes;
    const file = join(scratch, "limit.pdf");
    await writePaddedPdfFile(file, size);
    expect((await stat(file)).size).toBe(size);
    const fixture = await createIntegrationFixture("doc-upload-stream-memory");

    const measured = await measure(fixture, file);

    expect(measured.result).toMatchObject({ lifecycle: "available", sizeBytes: size });
    const growthKiB = measured.afterKiB - measured.beforeKiB;
    const boundKiB = (Math.ceil(size / 3) * 4) / 1024;
    expect(
      growthKiB,
      `upload: peak RSS grew ${(growthKiB / 1024).toFixed(0)} MiB; bound is ${(boundKiB / 1024).toFixed(1)} MiB (the document's base64 size)`,
    ).toBeLessThan(boundKiB);
    const downloaded = await readDocumentDownload(fixture.users.member.id, measured.result.id);
    expect(downloaded.bytes.length).toBe(size);
    expect(downloaded.bytes.equals(paddedPdfOfSize(size))).toBe(true);
  }, 600_000);
});
