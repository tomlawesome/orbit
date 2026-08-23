import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScratchTemporaryDirectory, type ScratchDirectory } from "../../tests/support/scratch-directory";
import { syntheticPdf } from "../../tests/support/synthetic-documents";

/**
 * The page-one preview's authorization and plaintext boundary (#476).
 *
 * Only the database, the document configuration, object storage and the
 * decryption primitive are stubbed. Authorization, the readiness gate, the
 * audit write and the real renderer all run, so these tests pin the endpoint's
 * own behaviour: a preview must be reachable exactly where a download is, and
 * the decrypted bytes must not survive the call in memory or on disk.
 */

const mocks = vi.hoisted(() => ({
  fromNames: [] as string[],
  audits: [] as Record<string, unknown>[],
  rows: {} as Record<string, unknown[]>,
  config: vi.fn(),
  readCiphertext: vi.fn(),
  decryptDocument: vi.fn(),
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

  const fakeDb: Record<string, unknown> = {
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

vi.mock("@/server/documents/config", () => ({ getDocumentConfig: mocks.config }));
vi.mock("@/server/documents/crypto", () => ({
  decryptDocument: mocks.decryptDocument,
  encryptDocument: vi.fn(),
}));
vi.mock("@/server/documents/storage", () => ({
  LocalDocumentStorage: class {
    readCiphertext = mocks.readCiphertext;
    ciphertextExists = vi.fn();
  },
}));

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
    contentIv: Buffer.alloc(12),
    contentAuthTag: Buffer.alloc(16),
    wrappedDek: Buffer.alloc(32),
    wrapIv: Buffer.alloc(12),
    wrapAuthTag: Buffer.alloc(16),
  };
}

/** Arranges a readable document whose plaintext is the supplied bytes. */
function arrangeReadable(plaintext: Buffer, rowOverrides: Record<string, unknown> = {}): Buffer {
  mocks.rows.users = [accessRow(rowOverrides)];
  mocks.rows.document_crypto = [cryptoRow()];
  mocks.readCiphertext.mockResolvedValue(Buffer.alloc(plaintext.length + 64));
  mocks.decryptDocument.mockReturnValue(plaintext);
  return plaintext;
}

let scratch: ScratchDirectory;

beforeEach(() => {
  scratch = useScratchTemporaryDirectory("orbit-preview-boundary");
  vi.clearAllMocks();
  mocks.fromNames.length = 0;
  mocks.audits.length = 0;
  mocks.rows = {};
  mocks.config.mockReturnValue(config);
});

afterEach(() => {
  scratch.restore();
});

describe("readDocumentPagePreview", () => {
  it("renders page one for a member of the document's household", async () => {
    arrangeReadable(syntheticPdf("Household preview"));

    const preview = await readDocumentPagePreview(READER, DOCUMENT);

    expect(preview.mediaType).toBe("image/png");
    expect(preview.width).toBeGreaterThan(0);
    expect(preview.bytes.length).toBeGreaterThan(0);
  });

  it("refuses a document in a household the reader does not belong to, before any decryption", async () => {
    mocks.rows.users = [accessRow({ administrator: false, membershipUserId: null })];
    mocks.rows.document_crypto = [cryptoRow()];

    await expect(readDocumentPagePreview(READER, DOCUMENT)).rejects.toMatchObject({
      code: "document_not_found",
      status: 404,
      message: "That document is not available",
    });

    // Only the authorization lookup ran: the crypto row was never read, so
    // nothing reached storage, decryption or the renderer.
    expect(mocks.fromNames).toEqual(["users"]);
    expect(mocks.readCiphertext).not.toHaveBeenCalled();
    expect(mocks.decryptDocument).not.toHaveBeenCalled();
    expect(mocks.audits).toEqual([]);
  });

  it("refuses a document that no household row matched at all", async () => {
    mocks.rows.users = [];

    await expect(readDocumentPagePreview(READER, DOCUMENT)).rejects.toMatchObject({
      code: "document_not_found",
      status: 404,
    });
    expect(mocks.fromNames).toEqual(["users"]);
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
      expect(mocks.decryptDocument).not.toHaveBeenCalled();
    },
  );

  it("records the read as a preview rather than as a whole-document download", async () => {
    arrangeReadable(syntheticPdf("Audited preview"));

    await readDocumentPagePreview(READER, DOCUMENT);

    expect(mocks.audits).toEqual([{
      householdId: HOUSEHOLD,
      actorUserId: READER,
      entityType: "document",
      entityId: DOCUMENT,
      action: "document_previewed",
      changes: { itemId: ITEM },
    }]);
  });

  it("zeroes the decrypted plaintext and leaves no temporary file behind", async () => {
    const plaintext = arrangeReadable(syntheticPdf("Zeroed after preview"));

    await readDocumentPagePreview(READER, DOCUMENT);

    expect(plaintext.every((byte) => byte === 0)).toBe(true);
    expect(scratch.entries()).toEqual([]);
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
