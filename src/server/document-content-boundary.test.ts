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
// The administrator's upload limit (#1285) is proven in
// src/server/upload-limit.test.ts; here it answers the configured default.
vi.mock("@/server/upload-limit", () => ({
  readEffectiveUploadLimit: async (config: { maxBytes: number }) => config.maxBytes,
}));
vi.mock("@/server/documents/crypto", async (importActual) => ({
  envelopeOf: (await importActual<typeof import("@/server/documents/crypto")>()).envelopeOf,
  decryptDocument: mocks.decryptDocument,
  encryptDocument: mocks.encryptDocument,
}));
vi.mock("@/server/documents/storage", () => {
  class LocalDocumentStorage {
    readCiphertext = mocks.readCiphertext;
    ciphertextExists = mocks.ciphertextExists;
  }
  return {
    LocalDocumentStorage,
    openDocumentStorage: () => new LocalDocumentStorage(),
  };
});
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
    // The caller is the uploader (#1151 A3-S1's deletion/restore gate), so
    // these boundary tests keep exercising the scan-status short-circuit
    // rather than the separate ownership check.
    uploadedByUserId: "user-id",
    membershipRole: "member",
    ...overrides,
  };
}

/** The document row, plus the household gate's answer from the users table. */
function seedAccess(row: { administrator: boolean; membershipRole?: unknown; member?: unknown }): void {
  mocks.rows.documents = [row];
  mocks.rows.users = [{ administrator: row.administrator, role: row.membershipRole ?? "member" }];
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
      seedAccess(accessRow({ scanStatus }));

      await expect(readDocumentDownload("user-id", "11111111-1111-4111-8111-111111111111")).rejects.toMatchObject({
        code: "document_not_found",
        status: 404,
        message: "That document is not available",
      });

      // Only the authorization/lifecycle lookup (`documents`, then the
      // household gate's `users`) ran; the crypto row query
      // (`document_crypto`) never happened.
      expect(mocks.fromNames).toEqual(["documents", "users"]);
      expect(mocks.readCiphertext).not.toHaveBeenCalled();
      expect(mocks.decryptDocument).not.toHaveBeenCalled();
      expect(mocks.insertNames).not.toContain("audit_log");
    },
  );

  it("does not treat a skipped scan as ready even when scan mode is required for an otherwise valid document", async () => {
    seedAccess(accessRow({ scanStatus: "skipped" }));

    await expect(readDocumentDownload("user-id", "11111111-1111-4111-8111-111111111111")).rejects.toMatchObject({
      code: "document_not_found",
      status: 404,
    });
    expect(mocks.fromNames).toEqual(["documents", "users"]);
  });
});

describe("createDocumentDraft boundary", () => {
  it.each(unsafeScanStatuses)(
    "rejects an authorized available document with a %s scan status before readDocumentDownload, Tika extraction, proposal parsing or draft insertion",
    async (scanStatus) => {
      seedAccess(draftMemberRow({ scanStatus }));

      await expect(createDocumentDraft("user-id", "11111111-1111-4111-8111-111111111111")).rejects.toMatchObject({
        code: "document_not_found",
        status: 404,
        message: "That document is not available",
      });

      // Only the membership/lifecycle lookup (`documents`, then the household
      // gate's `users`) ran, once. `readDocumentDownload` repeats that pair
      // and then reads the crypto row, so a longer list would mean it was
      // called; no
      // `document_drafts` select/insert (existing-draft check or creation) ran either.
      expect(mocks.fromNames).toEqual(["documents", "users"]);
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
      seedAccess(accessRow({
        lifecycle: "pending_deletion",
        scanStatus,
        deleteAfter: new Date(Date.now() + 86_400_000),
      }));

      await expect(restoreDocument("user-id", "11111111-1111-4111-8111-111111111111")).rejects.toMatchObject({
        code: "document_not_found",
        status: 404,
        message: "That document is not available",
      });

      expect(mocks.fromNames).toEqual(["documents", "users"]);
      expect(mocks.transactionCalls).toBe(0);
      expect(mocks.ciphertextExists).not.toHaveBeenCalled();
      expect(mocks.insertNames).not.toContain("audit_log");
    },
  );
});
