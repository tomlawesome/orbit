import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/app-error";

/**
 * A2-R2: `readHeldImapAttachmentPreview`'s own docstring says every case
 * that is not the recipient's own live, stored attachment answers the same
 * `inbox_receipt_not_found` 404 a missing receipt does -- "a discarded or
 * expired receipt, a purge-pending or already-assigned attachment" and so
 * on. A concurrent purge removing the ciphertext between the row read and
 * the decrypt was not one of those cases: it threw uncaught, which an API
 * route would turn into a raw 500 instead of the documented 404.
 */

const mocks = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
  readHeldImapAttachment: vi.fn(),
}));

vi.mock("@/db", async () => {
  function selectBuilder() {
    const chain: Record<string, unknown> = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      limit: () => chain,
      then: (resolve: (rows: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(mocks.row ? [mocks.row] : []).then(resolve, reject),
    };
    return chain;
  }
  return { getDb: () => ({ select: () => selectBuilder() }) };
});

vi.mock("@/server/workspace-access", () => ({
  validUuid: (value: string) => /^[0-9a-f-]{36}$/iu.test(value),
}));

vi.mock("@/server/mail-in/imap-inbox", () => ({
  privateMailboxUser: async (userId: string) => ({ id: userId, isInstanceAdmin: false }),
}));

vi.mock("@/server/mail-in/imap-attachment-holding", () => ({
  readHeldImapAttachment: mocks.readHeldImapAttachment,
}));

vi.mock("@/server/documents/preview", () => ({
  renderDocumentPagePreview: vi.fn(async () => ({ pageCount: 1, pageOneImage: Buffer.from("x") })),
}));

const { readHeldImapAttachmentPreview } = await import("./imap-attachment-preview");

const userId = "39a5fac9-38cb-4178-b68a-a8d8db97ed3b";
const receiptId = "66a1f3d8-b79d-47a5-92fe-a4824270aa9a";
const attachmentId = "be56a287-919c-4237-ab23-e5897488e6a2";

beforeEach(() => {
  mocks.readHeldImapAttachment.mockReset();
  mocks.row = {
    id: attachmentId,
    mediaType: "application/pdf",
    sizeBytes: 100,
    storageKey: "a".repeat(64),
    envelopeVersion: 1,
    contentIv: "iv",
    contentAuthTag: "tag",
    wrappedDek: "dek",
    wrapIv: "wrapiv",
    wrapAuthTag: "wraptag",
    keyId: "key-1",
  };
});

describe("readHeldImapAttachmentPreview (#1151 A2-R2)", () => {
  it("answers the documented 404 when a concurrent purge removes the ciphertext mid-read", async () => {
    mocks.readHeldImapAttachment.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    let caught: unknown;
    try {
      await readHeldImapAttachmentPreview(userId, receiptId, attachmentId);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("inbox_receipt_not_found");
    expect((caught as AppError).status).toBe(404);
  });

  it("still renders the preview when the read succeeds", async () => {
    mocks.readHeldImapAttachment.mockResolvedValue(Buffer.from("plaintext"));

    const preview = await readHeldImapAttachmentPreview(userId, receiptId, attachmentId);
    expect(preview).toEqual({ pageCount: 1, pageOneImage: Buffer.from("x") });
  });

  it("hands the renderer the page it was asked for, page one when none (#1300)", async () => {
    mocks.readHeldImapAttachment.mockResolvedValue(Buffer.from("plaintext"));
    const { renderDocumentPagePreview } = await import("@/server/documents/preview");

    await readHeldImapAttachmentPreview(userId, receiptId, attachmentId);
    expect(renderDocumentPagePreview).toHaveBeenLastCalledWith(expect.any(Buffer), "application/pdf", 1);
    await readHeldImapAttachmentPreview(userId, receiptId, attachmentId, 2);
    expect(renderDocumentPagePreview).toHaveBeenLastCalledWith(expect.any(Buffer), "application/pdf", 2);
  });
});
