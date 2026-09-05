import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetDocumentConfigForTests } from "@/server/documents/config";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { syntheticPdf } from "../../../tests/support/synthetic-documents";
import { readHeldImapAttachment, holdImapAttachment, scanAndHoldImapAttachment } from "./imap-attachment-holding";

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

const originalEnvironment = { ...process.env };
let root: string;

afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  for (const [key, value] of Object.entries(originalEnvironment)) process.env[key] = value;
  resetDocumentConfigForTests();
  vi.mocked(scanFileWithClamAv).mockReset();
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
  it("binds encryption to the verified recipient and receipt, and stores ciphertext only", async () => {
    root = await mkdtemp(join(tmpdir(), "orbit-imap-holding-"));
    configure();
    const bytes = syntheticPdf("private staging");
    const held = await holdImapAttachment({ bytes, displayName: "receipt.pdf", mediaType: "application/pdf", recipientUserId: "10000000-0000-4000-8000-000000000001", receiptId: "20000000-0000-4000-8000-000000000002" });
    const object = join(root, "objects");
    const files = await readdir(object, { recursive: true });
    expect(files.some((file) => String(file).endsWith(".bin"))).toBe(true);
    const ciphertext = await new LocalDocumentStorage(object, join(root, "quarantine")).readCiphertext(held.storageKey, held.ciphertextSize);
    expect(ciphertext).not.toEqual(bytes);
    await expect(readHeldImapAttachment(held, { recipientUserId: "10000000-0000-4000-8000-000000000003", receiptId: held.receiptId })).rejects.toThrow();
    await expect(readHeldImapAttachment(held, { recipientUserId: held.recipientUserId, receiptId: "20000000-0000-4000-8000-000000000003" })).rejects.toThrow();
    await expect(readHeldImapAttachment(held, { recipientUserId: held.recipientUserId, receiptId: held.receiptId })).resolves.toEqual(bytes);
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

  it("allocates the storage key before writing and removes it when registration fails", async () => {
    root = await mkdtemp(join(tmpdir(), "orbit-imap-allocation-"));
    configure();
    const storage = new LocalDocumentStorage(join(root, "objects"), join(root, "quarantine"));
    let allocatedKey = "";
    const held = await holdImapAttachment({
      bytes: Buffer.from("allocated before write"), displayName: "allocated.pdf", mediaType: "application/pdf",
      recipientUserId: "10000000-0000-4000-8000-000000000001", receiptId: "20000000-0000-4000-8000-000000000002",
      onCiphertextAllocated: async ({ storageKey }) => {
        allocatedKey = storageKey;
        expect(await storage.ciphertextExists(storageKey)).toBe(false);
      },
    });
    expect(await storage.ciphertextExists(held.storageKey)).toBe(true);
    await storage.deleteCiphertext(held.storageKey);
    await expect(holdImapAttachment({
      bytes: Buffer.from("registration failed"), displayName: "failed.pdf", mediaType: "application/pdf",
      recipientUserId: "10000000-0000-4000-8000-000000000001", receiptId: "20000000-0000-4000-8000-000000000002",
      onCiphertextAllocated: async ({ storageKey }) => { allocatedKey = storageKey; throw new Error("registration failed"); },
    })).rejects.toThrow("registration failed");
    expect(await storage.ciphertextExists(allocatedKey)).toBe(false);
  });
});
