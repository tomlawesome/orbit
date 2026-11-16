import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScratchTemporaryDirectory, type ScratchDirectory } from "../../tests/support/scratch-directory";
import { syntheticPdf } from "../../tests/support/synthetic-documents";
import { syntheticPdfWithNumberedPages } from "../../tests/support/generated-pdf-documents";

/**
 * The page-one preview's authorization and plaintext boundary (#476).
 *
 * Only the database, the document configuration, object storage and the
 * unsealer are stubbed (#1571: the page is read straight into one buffer
 * through `unsealIntoBuffer`, which is the stub standing in for storage). Authorization, the readiness gate, the
 * audit write and the real renderer all run, so these tests pin the endpoint's
 * own behaviour: a preview must be reachable exactly where a download is, and
 * the decrypted bytes must not survive the call in memory or on disk.
 */

const mocks = vi.hoisted(() => ({
  fromNames: [] as string[],
  audits: [] as Record<string, unknown>[],
  rows: {} as Record<string, unknown[]>,
  config: vi.fn(),
  unsealIntoBuffer: vi.fn(),
  createDocumentUnsealer: vi.fn(() => ({ update: vi.fn(), final: vi.fn() })),
  deletes: [] as { table: string; where: unknown }[],
  deletePreviewCiphertext: vi.fn(),
  enqueuePreviewJob: vi.fn(),
  storeDrawnPreview: vi.fn(),
  drawDocumentPage: undefined as undefined | ((...args: unknown[]) => unknown),
}));

vi.mock("@/db", async () => {
  const { getTableName } = await import("drizzle-orm");

  function makeSelectBuilder() {
    let rows: unknown[] = [];
    const builder: PromiseLike<unknown[]> & Record<string, unknown> = {
      from(table: unknown) {
        const name = getTableName(table as never);
        mocks.fromNames.push(name);
        rows = mocks.rows[name] ?? [];
        return builder;
      },
      innerJoin: () => builder,
      leftJoin: () => builder,
      where: () => builder,
      limit: () => builder,
      then: (onFulfilled: (value: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(onFulfilled, onRejected),
    } as never;
    return builder;
  }

  // A transaction (the fix evicts under the document's lock) sees the same
  // tables; deletes are recorded with their predicate for inspection.
  const transactionScope: Record<string, unknown> = {
    select: () => makeSelectBuilder(),
    execute: () => Promise.resolve(Object.assign([{ "?column?": 1, lifecycle: "available", deleteAfter: null, delete_after: null }], { count: 1 })),
    delete: (table: unknown) => ({
      where: (where: unknown) => {
        mocks.deletes.push({ table: getTableName(table as never), where });
        const done = Promise.resolve([{ page: 1 }]);
        return Object.assign(done, { returning: () => done });
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        if (getTableName(table as never) === "audit_log") mocks.audits.push(values);
        return Promise.resolve();
      },
    }),
  };
  const fakeDb: Record<string, unknown> = {
    transaction: async (work: (scope: unknown) => unknown) => work(transactionScope),
    execute: transactionScope.execute,
    delete: transactionScope.delete,
    select: () => makeSelectBuilder(),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        if (getTableName(table as never) === "audit_log") mocks.audits.push(values);
        return Promise.resolve();
      },
    }),
  };

  return { getDb: () => fakeDb };
});

vi.mock("@/server/documents/config", async (importActual) => ({
  ...await importActual<typeof import("@/server/documents/config")>(),
  getDocumentConfig: mocks.config,
}));
vi.mock("@/server/documents/crypto", async (importActual) => ({
  ...await importActual<typeof import("@/server/documents/crypto")>(),
  createDocumentUnsealer: mocks.createDocumentUnsealer,
}));
vi.mock("@/server/documents/storage", () => {
  class LocalDocumentStorage {
    unsealIntoBuffer = mocks.unsealIntoBuffer;
    ciphertextExists = vi.fn();
    deletePreviewCiphertext = mocks.deletePreviewCiphertext;
  }
  return {
    LocalDocumentStorage,
    openDocumentStorage: () => new LocalDocumentStorage(),
  };
});

vi.mock("@/server/documents/preview-store", async (importActual) => ({
  ...await importActual<typeof import("@/server/documents/preview-store")>(),
  storeDrawnPreview: mocks.storeDrawnPreview,
}));
vi.mock("@/server/document-maintenance/preview-queue", async (importActual) => ({
  ...await importActual<typeof import("@/server/document-maintenance/preview-queue")>(),
  enqueuePreviewJob: mocks.enqueuePreviewJob,
}));
vi.mock("@/server/documents/preview", async (importActual) => {
  const actual = await importActual<typeof import("@/server/documents/preview")>();
  return { ...actual, drawDocumentPage: (...args: Parameters<typeof actual.drawDocumentPage>) => (mocks.drawDocumentPage ?? actual.drawDocumentPage)(...args) };
});

import { PgDialect } from "drizzle-orm/pg-core";
import { readDocumentPagePreview } from "./document-preview";

const READER = "22222222-2222-4222-8222-222222222222";
const DOCUMENT = "11111111-1111-4111-8111-111111111111";
const HOUSEHOLD = "33333333-3333-4333-8333-333333333333";
const ITEM = "44444444-4444-4444-8444-444444444444";

const config = {
  storageRoot: "/private/documents",
  quarantineRoot: "/private/quarantine",
  maxBytes: 25 * 1_048_576,
  householdQuotaBytes: 1_000_000,
  instanceQuotaBytes: 1_000_000,
  retentionDays: 30,
  scanRecoveryRetentionHours: 24,
  scanMode: "required" as const,
  clamAv: { host: "clamav", port: 3310, timeoutMs: 30_000 },
  tika: { url: null, timeoutMs: 45_000 },
  keyEncryptionKey: Buffer.alloc(32, 1),
  keyId: "test-key-id",
  nextKeyEncryptionKey: null,
  nextKeyId: null,
};

function accessRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DOCUMENT,
    householdId: HOUSEHOLD,
    itemId: ITEM,
    displayName: "policy.pdf",
    mediaType: "application/pdf",
    sizeBytes: 1024,
    lifecycle: "available",
    scanStatus: "clean",
    contentSha256: "not-returned-to-client",
    deleteAfter: null,
    availableAt: new Date("2026-07-31T12:00:00.000Z"),
    administrator: false,
    membershipUserId: READER,
    ...overrides,
  };
}

function cryptoRow() {
  return {
    documentId: DOCUMENT,
    envelopeVersion: 1,
    keyId: config.keyId,
    storageKey: "a".repeat(64),
    ciphertextSize: 1024,
    contentIv: Buffer.alloc(12),
    contentAuthTag: Buffer.alloc(16),
    wrappedDek: Buffer.alloc(32),
    wrapIv: Buffer.alloc(12),
    wrapAuthTag: Buffer.alloc(16),
  };
}

/** The document row, plus the household gate's answer from the users table. */
function seedAccess(row: { administrator: boolean; membershipUserId: unknown }): void {
  mocks.rows.documents = [row];
  mocks.rows.users = [{ administrator: row.administrator, role: row.membershipUserId ? "member" : null }];
}

/** Arranges a readable document whose plaintext is the supplied bytes. */
function arrangeReadable(plaintext: Buffer, rowOverrides: Record<string, unknown> = {}): Buffer {
  seedAccess(accessRow(rowOverrides));
  mocks.rows.document_crypto = [cryptoRow()];
  mocks.unsealIntoBuffer.mockResolvedValue(plaintext);
  return plaintext;
}

let scratch: ScratchDirectory;

beforeEach(() => {
  scratch = useScratchTemporaryDirectory("orbit-preview-boundary");
  vi.clearAllMocks();
  mocks.fromNames.length = 0;
  mocks.audits.length = 0;
  mocks.rows = {};
  mocks.deletes.length = 0;
  mocks.drawDocumentPage = undefined;
  mocks.deletePreviewCiphertext.mockResolvedValue(undefined);
  mocks.enqueuePreviewJob.mockResolvedValue(undefined);
  mocks.storeDrawnPreview.mockResolvedValue(undefined);
  mocks.config.mockReturnValue(config);
});

afterEach(() => {
  scratch.restore();
});

describe("readDocumentPagePreview", () => {
  it("renders page one for a member of the document's household", async () => {
    arrangeReadable(syntheticPdf("Household preview"));

    const preview = await readDocumentPagePreview(READER, DOCUMENT);

    expect(preview.mediaType).toBe("image/jpeg");
    expect(preview.width).toBeGreaterThan(0);
    expect(preview.bytes.length).toBeGreaterThan(0);
  });

  it("refuses a document in a household the reader does not belong to, before any decryption", async () => {
    seedAccess(accessRow({ administrator: false, membershipUserId: null }));
    mocks.rows.document_crypto = [cryptoRow()];

    await expect(readDocumentPagePreview(READER, DOCUMENT)).rejects.toMatchObject({
      code: "document_not_found",
      status: 404,
      message: "That document is not available",
    });

    // Only the authorization lookups ran (the document, then the household
    // gate): the crypto row was never read, so nothing reached storage,
    // decryption or the renderer.
    expect(mocks.fromNames).toEqual(["documents", "users"]);
    expect(mocks.unsealIntoBuffer).not.toHaveBeenCalled();
    expect(mocks.audits).toEqual([]);
  });

  it("refuses a document that no household access row matched at all", async () => {
    mocks.rows.documents = [accessRow()];
    mocks.rows.users = [];

    await expect(readDocumentPagePreview(READER, DOCUMENT)).rejects.toMatchObject({
      code: "document_not_found",
      status: 404,
    });
    expect(mocks.fromNames).toEqual(["documents", "users"]);
  });

  it("refuses a malformed document identifier the same bounded way as an unknown one", async () => {
    await expect(readDocumentPagePreview(READER, "not-a-uuid")).rejects.toMatchObject({
      code: "document_not_found",
      status: 404,
    });
    expect(mocks.fromNames).toEqual([]);
  });

  it.each(["pending", "error", "infected", "skipped"])(
    "refuses an otherwise-authorized document whose scan status is %s",
    async (scanStatus) => {
      arrangeReadable(syntheticPdf("Household preview"), { scanStatus });

      await expect(readDocumentPagePreview(READER, DOCUMENT)).rejects.toMatchObject({
        code: "document_not_found",
        status: 404,
      });
      expect(mocks.unsealIntoBuffer).not.toHaveBeenCalled();
    },
  );

  it("reads the stored object straight into one buffer, handing storage the key, both sizes and an unsealer for this document", async () => {
    arrangeReadable(syntheticPdf("One buffer"));

    await readDocumentPagePreview(READER, DOCUMENT);

    expect(mocks.unsealIntoBuffer).toHaveBeenCalledTimes(1);
    expect(mocks.unsealIntoBuffer).toHaveBeenCalledWith("a".repeat(64), { ciphertextSize: 1024, plaintextSize: 1024 }, mocks.createDocumentUnsealer.mock.results[0]!.value);
    expect(mocks.createDocumentUnsealer).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: DOCUMENT, householdId: HOUSEHOLD, itemId: ITEM, mediaType: "application/pdf", plaintextSize: 1024 }),
      expect.anything(),
      config.keyEncryptionKey,
    );
  });

  it("answers a failed integrity check as 503 document_integrity_failed, and any other storage failure as document_unavailable, auditing neither", async () => {
    arrangeReadable(syntheticPdf("Tampered"));
    const { DocumentIntegrityError } = await import("@/server/documents/crypto");
    mocks.unsealIntoBuffer.mockRejectedValueOnce(new DocumentIntegrityError());
    await expect(readDocumentPagePreview(READER, DOCUMENT)).rejects.toMatchObject({ code: "document_integrity_failed", status: 503 });

    mocks.unsealIntoBuffer.mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ENOENT" }));
    await expect(readDocumentPagePreview(READER, DOCUMENT)).rejects.toMatchObject({ code: "document_unavailable", status: 503 });
    expect(mocks.audits).toEqual([]);
  });

  it("records the read as a preview rather than as a whole-document download", async () => {
    arrangeReadable(syntheticPdf("Audited preview"));

    await readDocumentPagePreview(READER, DOCUMENT);

    expect(mocks.audits).toEqual([{
      householdId: HOUSEHOLD,
      actorUserId: READER,
      entityType: "document",
      entityId: DOCUMENT,
      action: "document_previewed",
      // The page is recorded too since #1433 (D21).
      changes: { itemId: ITEM, page: 1 },
    }]);
  });

  it("zeroes the decrypted plaintext and leaves no temporary file behind", async () => {
    const plaintext = arrangeReadable(syntheticPdf("Zeroed after preview"));

    await readDocumentPagePreview(READER, DOCUMENT);

    expect(plaintext.every((byte) => byte === 0)).toBe(true);
    expect(scratch.entries()).toEqual([]);
  });

  it("draws the page asked for and says how many there are; past the end is refused, and still zeroed (#1300)", async () => {
    arrangeReadable(syntheticPdfWithNumberedPages(3));
    const second = await readDocumentPagePreview(READER, DOCUMENT, 2);
    expect(second).toMatchObject({ mediaType: "image/jpeg", pageCount: 3 });

    const plaintext = arrangeReadable(syntheticPdfWithNumberedPages(3));
    await expect(readDocumentPagePreview(READER, DOCUMENT, 4)).rejects.toMatchObject({
      code: "document_preview_page_not_found",
      status: 404,
    });
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
  });

  it("zeroes the decrypted plaintext even when the document cannot be previewed", async () => {
    const plaintext = arrangeReadable(Buffer.from("not a document at all"), { mediaType: "application/pdf" });

    await expect(readDocumentPagePreview(READER, DOCUMENT)).rejects.toMatchObject({
      code: "document_preview_unsupported",
      status: 415,
    });

    expect(plaintext.every((byte) => byte === 0)).toBe(true);
    expect(scratch.entries()).toEqual([]);
  });
});

/**
 * Read repair of a kept page (#1803): a drawn row whose object is missing or
 * fails its check is evicted and the page drawn now; any other read error is
 * a 503 that keeps the row. Only effects are asserted (the row delete, the
 * storage and queue calls, the answer, the audits).
 */
describe("a kept page that cannot be read", () => {
  const STORAGE_KEY = "b".repeat(64);

  function keptRow() {
    return {
      documentId: DOCUMENT,
      page: 1,
      status: "drawn",
      refusal: null,
      attempts: 1,
      renderer: "poppler-1",
      mediaType: "image/jpeg",
      width: 100,
      height: 140,
      plaintextSize: 500,
      ciphertextSize: 540,
      storageKey: STORAGE_KEY,
      envelopeVersion: 1,
      keyId: config.keyId,
      contentIv: Buffer.alloc(12),
      contentAuthTag: Buffer.alloc(16),
      wrappedDek: Buffer.alloc(32),
      wrapIv: Buffer.alloc(12),
      wrapAuthTag: Buffer.alloc(16),
    };
  }

  /** A readable document with a stored page count and a kept page one whose read fails with `failure`. */
  function arrangeKeptPageFailing(failure: unknown): void {
    arrangeReadable(syntheticPdf("Read repair"), { pageCount: 1 });
    mocks.rows.documents = [accessRow({ pageCount: 1 })];
    mocks.rows.document_previews = [keptRow()];
    mocks.unsealIntoBuffer.mockReset();
    mocks.unsealIntoBuffer
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(syntheticPdf("Read repair"));
  }

  function deletedPreviewRows() {
    const dialect = new PgDialect();
    return mocks.deletes.filter((entry) => entry.table === "document_previews").map((entry) => dialect.sqlToQuery(entry.where as never));
  }

  function expectEvictedByIdentity(): void {
    const deleted = deletedPreviewRows();
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.params).toEqual(expect.arrayContaining([DOCUMENT, 1, STORAGE_KEY]));
  }

  async function damage() {
    const { DocumentIntegrityError } = await import("@/server/documents/crypto");
    return new DocumentIntegrityError();
  }

  it("U1: a kept page whose object is missing (ENOENT) is evicted and drawn now, with one audit, a queued job and no 503", async () => {
    arrangeKeptPageFailing(Object.assign(new Error("gone"), { code: "ENOENT" }));

    const preview = await readDocumentPagePreview(READER, DOCUMENT, 1);

    expect(preview.mediaType).toBe("image/jpeg");
    expect(preview.bytes.length).toBeGreaterThan(0);
    expect(preview.width).toBeGreaterThan(0);
    expect(preview.pageCount).toBe(1);
    expect(mocks.audits.filter((audit) => audit.action === "document_previewed")).toHaveLength(1);
    expectEvictedByIdentity();
    expect(mocks.enqueuePreviewJob).toHaveBeenCalledTimes(1);
    expect(mocks.enqueuePreviewJob).toHaveBeenCalledWith(expect.anything(), DOCUMENT);
  });

  it("U2: a kept page that fails its integrity check is evicted (row and object), drawn now and kept again", async () => {
    arrangeKeptPageFailing(await damage());

    const preview = await readDocumentPagePreview(READER, DOCUMENT, 1);

    expect(preview.mediaType).toBe("image/jpeg");
    expect(preview.bytes.length).toBeGreaterThan(0);
    expect(mocks.audits.filter((audit) => audit.action === "document_previewed")).toHaveLength(1);
    expectEvictedByIdentity();
    expect(mocks.enqueuePreviewJob).toHaveBeenCalledWith(expect.anything(), DOCUMENT);
    expect(mocks.deletePreviewCiphertext).toHaveBeenCalledWith(STORAGE_KEY);
    expect(mocks.storeDrawnPreview).toHaveBeenCalledTimes(1);
  });

  it("U3: any other read error (EACCES) answers 503 document_unavailable and sheds nothing, draws nothing, audits nothing", async () => {
    arrangeKeptPageFailing(Object.assign(new Error("denied"), { code: "EACCES" }));
    const draw = vi.fn();
    mocks.drawDocumentPage = draw;

    await expect(readDocumentPagePreview(READER, DOCUMENT, 1)).rejects.toMatchObject({ code: "document_unavailable", status: 503 });

    expect(deletedPreviewRows()).toEqual([]);
    expect(mocks.deletePreviewCiphertext).not.toHaveBeenCalled();
    expect(mocks.enqueuePreviewJob).not.toHaveBeenCalled();
    expect(draw).not.toHaveBeenCalled();
    expect(mocks.audits).toEqual([]);
  });

  it("U4: the row is evicted before the draw, so a busy renderer answers 503 document_preview_busy with the row already gone", async () => {
    arrangeKeptPageFailing(await damage());
    mocks.drawDocumentPage = vi.fn(async () => ({ outcome: "busy" }));

    await expect(readDocumentPagePreview(READER, DOCUMENT, 1)).rejects.toMatchObject({ code: "document_preview_busy", status: 503 });

    expectEvictedByIdentity();
  });
});
