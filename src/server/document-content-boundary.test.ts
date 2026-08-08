import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fromNames: [] as string[],
  insertNames: [] as string[],
  transactionCalls: 0,
  rows: {} as Record<string, unknown[]>,
  config: vi.fn(),
  readCiphertext: vi.fn(),
  ciphertextExists: vi.fn(),
  decryptDocument: vi.fn(),
  encryptDocument: vi.fn(),
  extractTextWithTika: vi.fn(),
  proposalFromText: vi.fn(),
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
      orderBy: () => builder,
      limit: () => builder,
      then: (onFulfilled: (value: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(onFulfilled, onRejected),
    } as never;
    return builder;
  }

  function makeInsertBuilder(table: unknown) {
    mocks.insertNames.push(getTableName(table as never));
    return { values: () => Promise.resolve() };
  }

  const fakeDb: Record<string, unknown> = {
    select: () => makeSelectBuilder(),
    insert: (table: unknown) => makeInsertBuilder(table),
    transaction: async (fn: (tx: unknown) => unknown) => {
      mocks.transactionCalls += 1;
      return fn(fakeDb);
    },
  };

  return { getDb: () => fakeDb };
});

vi.mock("@/server/documents/config", () => ({ getDocumentConfig: mocks.config }));
vi.mock("@/server/documents/crypto", () => ({
  decryptDocument: mocks.decryptDocument,
  encryptDocument: mocks.encryptDocument,
}));
vi.mock("@/server/documents/storage", () => ({
  LocalDocumentStorage: class {
    readCiphertext = mocks.readCiphertext;
    ciphertextExists = mocks.ciphertextExists;
  },
}));
vi.mock("@/server/documents/tika", () => ({ extractTextWithTika: mocks.extractTextWithTika }));
vi.mock("@/server/documents/suggestions", async () => ({
  ...await vi.importActual<typeof import("@/server/documents/suggestions")>("@/server/documents/suggestions"),
  proposalFromText: mocks.proposalFromText,
}));

import { readDocumentDownload, restoreDocument } from "./document-repository";
import { createDocumentDraft } from "./document-drafts";

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

const unsafeScanStatuses = ["pending", "error", "infected", "skipped"] as const;

function accessRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    householdId: "33333333-3333-4333-8333-333333333333",
    itemId: "22222222-2222-4222-8222-222222222222",
    displayName: "policy.pdf",
    mediaType: "application/pdf",
    sizeBytes: 1024,
    lifecycle: "available",
    scanStatus: "clean",
    contentSha256: "not-returned-to-client",
    deleteAfter: null,
    availableAt: new Date("2026-07-31T12:00:00.000Z"),
    administrator: false,
    membershipUserId: "user-id",
    ...overrides,
  };
}

function draftMemberRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    householdId: "33333333-3333-4333-8333-333333333333",
    displayName: "policy.pdf",
    mediaType: "application/pdf",
    lifecycle: "available",
    scanStatus: "clean",
    administrator: false,
    member: "user-id",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fromNames.length = 0;
  mocks.insertNames.length = 0;
  mocks.transactionCalls = 0;
  mocks.rows = {};
  mocks.config.mockReturnValue(config);
});

describe("readDocumentDownload boundary", () => {
  it.each(unsafeScanStatuses)(
    "rejects an authorized available document with a %s scan status before any crypto, storage, decryption or audit access",
    async (scanStatus) => {
      mocks.rows.users = [accessRow({ scanStatus })];

      await expect(readDocumentDownload("user-id", "11111111-1111-4111-8111-111111111111")).rejects.toMatchObject({
        code: "document_not_found",
        status: 404,
        message: "That document is not available",
      });

      // Only the authorization/lifecycle lookup (`users`) ran; the crypto row
      // query (`document_crypto`) never happened.
      expect(mocks.fromNames).toEqual(["users"]);
      expect(mocks.readCiphertext).not.toHaveBeenCalled();
      expect(mocks.decryptDocument).not.toHaveBeenCalled();
      expect(mocks.insertNames).not.toContain("audit_log");
    },
  );

  it("does not treat a skipped scan as ready even when scan mode is required for an otherwise valid document", async () => {
    mocks.rows.users = [accessRow({ scanStatus: "skipped" })];

    await expect(readDocumentDownload("user-id", "11111111-1111-4111-8111-111111111111")).rejects.toMatchObject({
      code: "document_not_found",
      status: 404,
    });
    expect(mocks.fromNames).toEqual(["users"]);
  });
});

describe("createDocumentDraft boundary", () => {
  it.each(unsafeScanStatuses)(
    "rejects an authorized available document with a %s scan status before readDocumentDownload, Tika extraction, proposal parsing or draft insertion",
    async (scanStatus) => {
      mocks.rows.documents = [draftMemberRow({ scanStatus })];

      await expect(createDocumentDraft("user-id", "11111111-1111-4111-8111-111111111111")).rejects.toMatchObject({
        code: "document_not_found",
        status: 404,
        message: "That document is not available",
      });

      // Only the membership/lifecycle lookup (`documents`) ran. `readDocumentDownload`
      // begins with a `users` lookup, so its absence proves it was never called;
      // no `document_drafts` select/insert (existing-draft check or creation) ran either.
      expect(mocks.fromNames).toEqual(["documents"]);
      expect(mocks.insertNames).toEqual([]);
      expect(mocks.extractTextWithTika).not.toHaveBeenCalled();
      expect(mocks.proposalFromText).not.toHaveBeenCalled();
      expect(mocks.readCiphertext).not.toHaveBeenCalled();
      expect(mocks.decryptDocument).not.toHaveBeenCalled();
    },
  );
});

describe("restoreDocument boundary", () => {
  it.each(unsafeScanStatuses)(
    "rejects an authorized pending_deletion document with a %s scan status before opening a transaction, checking ciphertext, updating lifecycle or writing audit",
    async (scanStatus) => {
      mocks.rows.users = [accessRow({
        lifecycle: "pending_deletion",
        scanStatus,
        deleteAfter: new Date(Date.now() + 86_400_000),
      })];

      await expect(restoreDocument("user-id", "11111111-1111-4111-8111-111111111111")).rejects.toMatchObject({
        code: "document_not_found",
        status: 404,
        message: "That document is not available",
      });

      expect(mocks.fromNames).toEqual(["users"]);
      expect(mocks.transactionCalls).toBe(0);
      expect(mocks.ciphertextExists).not.toHaveBeenCalled();
      expect(mocks.insertNames).not.toContain("audit_log");
    },
  );
});
