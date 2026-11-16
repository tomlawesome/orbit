import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetDocumentConfigForTests } from "@/server/documents/config";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { classifyDocumentStructure } from "@/server/documents/validation";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { syntheticPdf } from "../../../tests/support/synthetic-documents";
import { PgDialect } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";
import { imapIngestionAttachments } from "@/db/schema";
import { flagStagingPurgeFailed, readHeldImapAttachment, scanAndHoldImapAttachment } from "./imap-attachment-holding";
import { encryptDocument } from "@/server/documents/crypto";

// #726: this is the only place that proves the mailbox path calls the real
// ClamAV client (scanner.ts's live TCP scanner) at all, rather than a stub or
// a skipped check. Mocked the same way tests/integration/document-lifecycle.test.ts
// mocks it -- the socket protocol itself is scanner.test.ts's job -- but
// nothing previously exercised scanAndHoldImapAttachment in "required" mode,
// mailbox or not, so a regression that stopped calling it, or that ignored an
// infected verdict, would have passed every existing test here.
vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(),
}));

// ADR-0033: the structure check is where pdf.js and the image decoders first
// open the bytes, so it is spied on (still real) to prove the scan comes first.
// The boolean form answers through the spied classification, so a stub of the
// classification reaches whichever of the two the holding step calls.
vi.mock("@/server/documents/validation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/documents/validation")>();
  const classify = vi.fn(actual.classifyDocumentStructure);
  return {
    ...actual,
    classifyDocumentStructure: classify,
    validateSupportedDocumentStructure: async (...args: Parameters<typeof actual.classifyDocumentStructure>) =>
      (await classify(...args)).reason === "supported_structure",
  };
});

// #1571: a held attachment is sealed in pieces from its quarantine file, so
// the whole-buffer `encryptDocument` must never be called on this path. Spied
// on (still real), like the structure check above.
vi.mock("@/server/documents/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/documents/crypto")>();
  return { ...actual, encryptDocument: vi.fn(actual.encryptDocument) };
});

// The mail limit (#1388) is read once per ingestion cycle and passed in as
// `maxBytes`; the upload limit no longer reaches this path.

const originalEnvironment = { ...process.env };
let root: string;

afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  for (const [key, value] of Object.entries(originalEnvironment)) process.env[key] = value;
  resetDocumentConfigForTests();
  vi.mocked(scanFileWithClamAv).mockReset();
  vi.mocked(classifyDocumentStructure).mockClear();
  vi.mocked(encryptDocument).mockClear();
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});

function configure(scanMode: "required" | "disabled" = "disabled") {
  process.env.DOCUMENT_KEK = "11".repeat(32);
  process.env.DOCUMENTS_ROOT = join(root, "objects");
  process.env.DOCUMENTS_QUARANTINE_ROOT = join(root, "quarantine");
  process.env.DOCUMENT_SCAN_MODE = scanMode;
  resetDocumentConfigForTests();
}

describe("private IMAP attachment holding", () => {
  it("refuses a mailed attachment over the mail limit it is given, and leaves no quarantine (#1388)", async () => {
    root = await mkdtemp(join(tmpdir(), "orbit-imap-limit-"));
    configure("required");
    const bytes = Buffer.concat([syntheticPdf("over the limit"), Buffer.alloc(1_048_576, 0x20)]);
    await expect(scanAndHoldImapAttachment({
      maxBytes: 1_048_576,
      bytes,
      filename: "large.pdf",
      declaredMediaType: "application/pdf",
      recipientUserId: "10000000-0000-4000-8000-000000000001",
      receiptId: "20000000-0000-4000-8000-000000000002",
      mailboxIngestion: true,
    })).rejects.toMatchObject({ code: "document_too_large" });
    expect(scanFileWithClamAv).not.toHaveBeenCalled();
    await expect(readdir(join(root, "quarantine")).catch(() => [])).resolves.toEqual([]);
  });

  it("binds encryption to the verified recipient and receipt, and stores ciphertext only", async () => {
    root = await mkdtemp(join(tmpdir(), "orbit-imap-holding-"));
    configure();
    const bytes = syntheticPdf("private staging");
    const held = await scanAndHoldImapAttachment({ bytes, filename: "receipt.pdf", declaredMediaType: "application/pdf", recipientUserId: "10000000-0000-4000-8000-000000000001", receiptId: "20000000-0000-4000-8000-000000000002" });
    const object = join(root, "objects");
    const files = await readdir(object, { recursive: true });
    expect(files.some((file) => String(file).endsWith(".bin"))).toBe(true);
    const ciphertext = await new LocalDocumentStorage(object, join(root, "quarantine")).readCiphertext(held.storageKey, held.ciphertextSize);
    expect(ciphertext).not.toEqual(bytes);
    await expect(readHeldImapAttachment(held, { recipientUserId: "10000000-0000-4000-8000-000000000003", receiptId: held.receiptId })).rejects.toThrow();
    await expect(readHeldImapAttachment(held, { recipientUserId: held.recipientUserId, receiptId: "20000000-0000-4000-8000-000000000003" })).rejects.toThrow();
    await expect(readHeldImapAttachment(held, { recipientUserId: held.recipientUserId, receiptId: held.receiptId })).resolves.toEqual(bytes);
  });

  describe("sealed in pieces from the quarantine file (#1571)", () => {
    const recipientUserId = "10000000-0000-4000-8000-000000000001";
    const receiptId = "20000000-0000-4000-8000-000000000002";

    it("leaves no temporary file, a ciphertextSize equal to the object file, and the digest of the input", async () => {
      root = await mkdtemp(join(tmpdir(), "orbit-imap-sealed-"));
      configure();
      const bytes = syntheticPdf("sealed in pieces");

      const held = await scanAndHoldImapAttachment({ bytes, filename: "sealed.pdf", declaredMediaType: "application/pdf", recipientUserId, receiptId });

      const everything = (await readdir(root, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
      expect(everything.filter((entry) => entry.name.endsWith(".tmp")), "no .tmp file anywhere").toEqual([]);
      expect(everything.filter((entry) => entry.parentPath.startsWith(join(root, "quarantine"))), "no quarantine file").toEqual([]);
      const objectFile = join(root, "objects", "objects", held.storageKey.slice(0, 2), held.storageKey.slice(2, 4), `${held.storageKey}.bin`);
      expect((await stat(objectFile)).size).toBe(held.ciphertextSize);
      expect(held.ciphertextSize).toBe(bytes.length);
      expect(held.sizeBytes).toBe(bytes.length);
      expect(held.contentSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(held.envelope).toMatchObject({ envelopeVersion: 1, algorithm: "aes-256-gcm" });
    });

    it("never calls encryptDocument, and round-trips through readHeldImapAttachment", async () => {
      root = await mkdtemp(join(tmpdir(), "orbit-imap-sealed-"));
      configure();
      const bytes = Buffer.concat([syntheticPdf("round trip"), Buffer.alloc(2_500_000, 0x20)]);

      const held = await scanAndHoldImapAttachment({ bytes, filename: "round-trip.pdf", declaredMediaType: "application/pdf", recipientUserId, receiptId });

      expect(encryptDocument).not.toHaveBeenCalled();
      const opened = await readHeldImapAttachment(held, { recipientUserId, receiptId });
      expect(opened.length).toBe(bytes.length);
      expect(opened.equals(bytes)).toBe(true);
    }, 30_000);

    it("seals from the quarantine file `receive` made, with the size and digest it measured, into an object", async () => {
      root = await mkdtemp(join(tmpdir(), "orbit-imap-sealed-"));
      configure();
      const bytes = syntheticPdf("seal arguments");
      const seals = vi.spyOn(LocalDocumentStorage.prototype, "sealQuarantine");
      const receives = vi.spyOn(LocalDocumentStorage.prototype, "receive");

      const held = await scanAndHoldImapAttachment({ bytes, filename: "seal.pdf", declaredMediaType: "application/pdf", recipientUserId, receiptId });

      expect(seals).toHaveBeenCalledTimes(1);
      const received = await receives.mock.results[0]!.value as { quarantinePath: string };
      const [path, expected, , destination] = seals.mock.calls[0]!;
      expect(path).toBe(received.quarantinePath);
      expect(expected).toEqual({ sizeBytes: bytes.length, contentSha256: createHash("sha256").update(bytes).digest("hex") });
      expect(destination).toEqual({ kind: "object", storageKey: held.storageKey });
    });

    it("hands the quarantine file to the scanner and seals that same file, in required mode", async () => {
      root = await mkdtemp(join(tmpdir(), "orbit-imap-sealed-"));
      configure("required");
      const seals = vi.spyOn(LocalDocumentStorage.prototype, "sealQuarantine");
      vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });

      await scanAndHoldImapAttachment({ bytes: syntheticPdf("scanned then sealed"), filename: "scanned.pdf", declaredMediaType: "application/pdf", recipientUserId, receiptId, mailboxIngestion: true });

      expect(vi.mocked(scanFileWithClamAv).mock.calls[0]![0]).toBe(seals.mock.calls[0]![0]);
    });

    it("reads the quarantine file once for the check, and zeroes that copy by the time the hold returns", async () => {
      root = await mkdtemp(join(tmpdir(), "orbit-imap-sealed-"));
      configure();
      const reads = vi.spyOn(LocalDocumentStorage.prototype, "readQuarantine");

      await scanAndHoldImapAttachment({ bytes: syntheticPdf("wiped after the hold"), filename: "wiped.pdf", declaredMediaType: "application/pdf", recipientUserId, receiptId });

      expect(reads).toHaveBeenCalledTimes(1);
      const copy = await reads.mock.results[0]!.value as Buffer;
      expect(copy.byteLength === 0 || copy.every((byte) => byte === 0)).toBe(true);
    });

    it("leaves no object, no temporary file and no quarantine file when the seal fails", async () => {
      root = await mkdtemp(join(tmpdir(), "orbit-imap-sealed-"));
      configure();
      vi.spyOn(LocalDocumentStorage.prototype, "sealQuarantine").mockRejectedValueOnce(new Error("synthetic seal failure"));

      await expect(scanAndHoldImapAttachment({ bytes: syntheticPdf("seal fails"), filename: "fails.pdf", declaredMediaType: "application/pdf", recipientUserId, receiptId })).rejects.toThrow("synthetic seal failure");

      const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
      expect(files).toEqual([]);
    });
  });

  it("fails closed for disabled scanner on the mailbox path and leaves no quarantine", async () => {
    root = await mkdtemp(join(tmpdir(), "orbit-imap-scanner-"));
    configure("disabled");
    await expect(scanAndHoldImapAttachment({
      bytes: syntheticPdf("scanner policy"),
      filename: "scanner-policy.pdf",
      declaredMediaType: "application/pdf",
      recipientUserId: "10000000-0000-4000-8000-000000000001",
      receiptId: "20000000-0000-4000-8000-000000000002",
      mailboxIngestion: true,
    })).rejects.toThrow("scanner_disabled");
    expect(await readdir(join(root, "quarantine"))).toEqual([]);
  });

  it("required mode: routes every mailbox attachment through the live ClamAV client before holding it", async () => {
    root = await mkdtemp(join(tmpdir(), "orbit-imap-scanner-required-"));
    configure("required");
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
    const held = await scanAndHoldImapAttachment({
      bytes: syntheticPdf("scanner required"),
      filename: "scanner-required.pdf",
      declaredMediaType: "application/pdf",
      recipientUserId: "10000000-0000-4000-8000-000000000001",
      receiptId: "20000000-0000-4000-8000-000000000002",
      mailboxIngestion: true,
    });
    expect(scanFileWithClamAv).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scanFileWithClamAv).mock.calls[0][1]).toMatchObject({ host: "orbit-clamav" });
    expect(await new LocalDocumentStorage(join(root, "objects"), join(root, "quarantine")).ciphertextExists(held.storageKey)).toBe(true);
  });

  it("required mode: an infected verdict from the live scanner is honoured, not just logged", async () => {
    root = await mkdtemp(join(tmpdir(), "orbit-imap-scanner-infected-"));
    configure("required");
    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "infected", signature: "Eicar-Test-Signature" });
    await expect(scanAndHoldImapAttachment({
      bytes: syntheticPdf("scanner infected"),
      filename: "scanner-infected.pdf",
      declaredMediaType: "application/pdf",
      recipientUserId: "10000000-0000-4000-8000-000000000001",
      receiptId: "20000000-0000-4000-8000-000000000002",
      mailboxIngestion: true,
    })).rejects.toThrow("malware_detected");
    expect(scanFileWithClamAv).toHaveBeenCalledTimes(1);
    const written = await readdir(join(root, "objects"), { recursive: true });
    expect(written.some((file) => String(file).endsWith(".bin"))).toBe(false);
  });

  it("required mode: scans a mailed attachment before anything opens it (ADR-0033)", async () => {
    root = await mkdtemp(join(tmpdir(), "orbit-imap-scan-first-"));
    configure("required");
    const order: string[] = [];
    vi.mocked(scanFileWithClamAv).mockImplementation(async () => {
      order.push("scan");
      return { status: "clean" };
    });
    vi.mocked(classifyDocumentStructure).mockImplementationOnce(async () => {
      order.push("open");
      return { reason: "supported_structure", pageCount: 1 };
    });
    await scanAndHoldImapAttachment({
      bytes: syntheticPdf("scan first"),
      filename: "scan-first.pdf",
      declaredMediaType: "application/pdf",
      recipientUserId: "10000000-0000-4000-8000-000000000001",
      receiptId: "20000000-0000-4000-8000-000000000002",
      mailboxIngestion: true,
    });
    expect(order).toEqual(["scan", "open"]);
  });

  it.each([
    ["infected", { status: "infected", signature: "Eicar-Test-Signature" }, "malware_detected"],
    ["unreachable", { status: "error", reason: "unavailable" }, "scanner_unavailable"],
    ["timed out", { status: "error", reason: "timeout" }, "scanner_timeout"],
    ["a protocol error", { status: "error", reason: "protocol" }, "scanner_protocol"],
    ["a scanner-reported error", { status: "error", reason: "scanner" }, "scanner_failed"],
    ["an error with no reason", { status: "error" }, "scanner_failed"],
    ["an unknown status", { status: "quarantined" }, "scanner_failed"],
  ] as const)("required mode: never opens a mailed attachment whose scan was %s (ADR-0033)", async (_label, outcome, message) => {
    root = await mkdtemp(join(tmpdir(), "orbit-imap-scan-stops-"));
    configure("required");
    vi.mocked(scanFileWithClamAv).mockResolvedValue(outcome as never);
    await expect(scanAndHoldImapAttachment({
      bytes: syntheticPdf("scan stops"),
      filename: "scan-stops.pdf",
      declaredMediaType: "application/pdf",
      recipientUserId: "10000000-0000-4000-8000-000000000001",
      receiptId: "20000000-0000-4000-8000-000000000002",
      mailboxIngestion: true,
    })).rejects.toThrow(message);
    expect(classifyDocumentStructure).not.toHaveBeenCalled();
  });

  describe("a structure check that could not run is no verdict (D-S1)", () => {
    const held = (name: string) => scanAndHoldImapAttachment({
      bytes: syntheticPdf(name),
      filename: `${name}.pdf`,
      declaredMediaType: "application/pdf",
      recipientUserId: "10000000-0000-4000-8000-000000000001",
      receiptId: "20000000-0000-4000-8000-000000000002",
      mailboxIngestion: true,
    });

    it("rejects with structure_check_unavailable, not mime_structure_invalid, and holds no object and leaves no quarantine file", async () => {
      root = await mkdtemp(join(tmpdir(), "orbit-imap-unavailable-"));
      configure("required");
      vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
      vi.mocked(classifyDocumentStructure).mockResolvedValueOnce({ reason: "structure_check_unavailable" });

      await expect(held("check unavailable")).rejects.toMatchObject({ message: "structure_check_unavailable" });

      const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
      expect(files).toEqual([]);
    });

    it("still rejects with mime_structure_invalid when the check refuses the file", async () => {
      root = await mkdtemp(join(tmpdir(), "orbit-imap-refused-"));
      configure("required");
      vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
      vi.mocked(classifyDocumentStructure).mockResolvedValueOnce({ reason: "unsupported_structure" });

      await expect(held("check refuses")).rejects.toMatchObject({ message: "mime_structure_invalid" });

      const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
      expect(files).toEqual([]);
    });
  });

  it("allocates the storage key before writing and removes it when registration fails", async () => {
    root = await mkdtemp(join(tmpdir(), "orbit-imap-allocation-"));
    configure();
    const storage = new LocalDocumentStorage(join(root, "objects"), join(root, "quarantine"));
    let allocatedKey = "";
    const held = await scanAndHoldImapAttachment({
      bytes: syntheticPdf("allocated before write"), filename: "allocated.pdf", declaredMediaType: "application/pdf",
      recipientUserId: "10000000-0000-4000-8000-000000000001", receiptId: "20000000-0000-4000-8000-000000000002",
      onCiphertextAllocated: async ({ storageKey }) => {
        allocatedKey = storageKey;
        expect(await storage.ciphertextExists(storageKey)).toBe(false);
      },
    });
    expect(await storage.ciphertextExists(held.storageKey)).toBe(true);
    expect(held.storageKey).toBe(allocatedKey);
    await storage.deleteCiphertext(held.storageKey);
    await expect(scanAndHoldImapAttachment({
      bytes: syntheticPdf("registration failed"), filename: "failed.pdf", declaredMediaType: "application/pdf",
      recipientUserId: "10000000-0000-4000-8000-000000000001", receiptId: "20000000-0000-4000-8000-000000000002",
      onCiphertextAllocated: async ({ storageKey }) => { allocatedKey = storageKey; throw new Error("registration failed"); },
    })).rejects.toThrow("registration failed");
    expect(await storage.ciphertextExists(allocatedKey)).toBe(false);
    const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
    expect(files, "no object, temporary file or quarantine file").toEqual([]);
  });
});

describe("flagStagingPurgeFailed (engine-18)", () => {
  it("re-flags exactly the rows the caller's own predicate names, counting one attempt", async () => {
    const writes: { values?: Record<string, unknown>; where?: unknown } = {};
    const executor = {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          writes.values = values;
          return { where: async (where: unknown) => { writes.where = where; } };
        },
      }),
    };
    const at = new Date("2030-01-02T03:04:05.000Z");
    const where = eq(imapIngestionAttachments.id, "30000000-0000-4000-8000-000000000003");
    await flagStagingPurgeFailed(executor as never, where, at);

    expect(writes.where).toBe(where);
    expect(writes.values).toMatchObject({ purgePending: true, purgeFailureCode: "staging_purge_failed", updatedAt: at });
    const attempts = new PgDialect().sqlToQuery(writes.values!.purgeAttempts as never);
    expect(attempts.sql).toBe('"imap_ingestion_attachments"."purge_attempts" + 1');
  });
});
