import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/app-error";

/**
 * A2-R1: `uploadItemDocument`'s publish step moved a document to `available`
 * unconditionally. If a slow encrypt ran past the maintenance sweep's
 * interrupted-upload boundary (`rejectInterruptedDocuments`), the row was no
 * longer `encrypting` by the time this update ran, but nothing checked that:
 * the caller was told "available" for a document whose bytes the next
 * reconciliation sweep deletes as unreferenced.
 *
 * A fake `@/db` (and the surrounding storage/crypto/validation modules)
 * exercises the real function body rather than a real database, which is
 * out of scope here.
 */

const mocks = vi.hoisted(() => ({
  selectQueues: new Map<string, unknown[][]>(),
  updateReturningQueues: new Map<string, unknown[][]>(),
  updateCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
  insertCalls: [] as Array<{ table: string; values: unknown }>,
}));

function queue(map: Map<string, unknown[][]>, table: string, rows: unknown[]) {
  const existing = map.get(table) ?? [];
  existing.push(rows);
  map.set(table, existing);
}

function nextRows(map: Map<string, unknown[][]>, table: string): unknown[] {
  const list = map.get(table);
  if (!list || list.length === 0) return [];
  return list.shift()!;
}

vi.mock("@/db", async () => {
  const { getTableName } = await import("drizzle-orm");

  function selectBuilder() {
    let table = "";
    const chain: Record<string, unknown> = {
      from(t: unknown) {
        table = getTableName(t as never);
        return chain;
      },
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      limit: () => chain,
      then: (resolve: (rows: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(nextRows(mocks.selectQueues, table)).then(resolve, reject),
    };
    return chain;
  }

  function updateBuilder(table: string) {
    let values: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {
      set(v: Record<string, unknown>) {
        values = v;
        return chain;
      },
      where: () => chain,
      returning: () => {
        mocks.updateCalls.push({ table, values });
        return Promise.resolve(nextRows(mocks.updateReturningQueues, table));
      },
      then: (resolve: (value: undefined) => unknown, reject?: (reason: unknown) => unknown) => {
        mocks.updateCalls.push({ table, values });
        return Promise.resolve(undefined).then(resolve, reject);
      },
    };
    return chain;
  }

  function insertBuilder(table: string) {
    return {
      values: (v: unknown) => {
        mocks.insertCalls.push({ table, values: v });
        return Promise.resolve();
      },
    };
  }

  const fakeDb: Record<string, unknown> = {
    select: () => selectBuilder(),
    update: (t: unknown) => updateBuilder(getTableName(t as never)),
    insert: (t: unknown) => insertBuilder(getTableName(t as never)),
    execute: async () => undefined,
    transaction: async (fn: (tx: unknown) => unknown) => fn(fakeDb),
  };

  return { getDb: () => fakeDb };
});

vi.mock("@/server/documents/authorization", () => ({
  canAccessHouseholdDocuments: () => true,
}));

vi.mock("@/server/documents/config", () => ({
  getDocumentConfig: () => ({
    storageRoot: "/private/documents",
    quarantineRoot: "/private/quarantine",
    maxBytes: 25 * 1_048_576,
    householdQuotaBytes: 1_000_000_000,
    instanceQuotaBytes: 1_000_000_000,
    scanMode: "disabled" as const,
  }),
  wrappingKey: () => ({ keyEncryptionKey: Buffer.alloc(32, 1), keyId: "key-1" }),
  keyEncryptionKeyFor: () => Buffer.alloc(32, 1),
}));
// The administrator's upload limit (#1285) is proven in
// src/server/upload-limit.test.ts; here it answers the configured default.
vi.mock("@/server/upload-limit", () => ({
  readEffectiveUploadLimit: async (config: { maxBytes: number }) => config.maxBytes,
}));

vi.mock("@/server/documents/validation", () => ({
  detectDocumentMediaType: () => "application/pdf",
  normalizedDocumentFilename: (name: string) => name,
  classifyDocumentStructure: async () => "supported_structure",
}));

vi.mock("@/server/documents/crypto", async (importActual) => ({
  envelopeOf: (await importActual<typeof import("@/server/documents/crypto")>()).envelopeOf,
  encryptDocument: () => ({
    ciphertext: Buffer.from("ciphertext"),
    envelope: {
      algorithm: "aes-256-gcm",
      keyId: "key-1",
      iv: Buffer.alloc(12, 2),
      authTag: Buffer.alloc(16, 3),
      wrappedKey: Buffer.alloc(32, 4),
      wrappedKeyIv: Buffer.alloc(12, 5),
      wrappedKeyAuthTag: Buffer.alloc(16, 6),
    },
  }),
}));

vi.mock("@/server/documents/storage", () => {
  class LocalDocumentStorage {
    async receive() {
      return { quarantinePath: "/tmp/q", sizeBytes: 5, contentSha256: "hash", leadingBytes: Buffer.from("%PDF") };
    }
    async readQuarantine() {
      return Buffer.from("plaintext");
    }
    createStorageKey() {
      return "a".repeat(64);
    }
    async writeCiphertext() {}
    async deleteCiphertext() {}
    async deleteStagingCiphertext() {}
    async discardQuarantine() {}
  }
  return {
    LocalDocumentStorage,
    openDocumentStorage: () => new LocalDocumentStorage(),
  };
});

const { uploadItemDocument } = await import("./document-repository");

const userId = "39a5fac9-38cb-4178-b68a-a8d8db97ed3b";
const householdId = "66a1f3d8-b79d-47a5-92fe-a4824270aa9a";
const itemId = "26f04310-3f96-4828-94b2-f2fc693bc89e";

function fakeBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array()); controller.close(); } });
}

function seedUploadHappyPath() {
  // requireHouseholdAndItemAccess: the household gate answers from the users
  // table, then the item is looked up in that household.
  queue(mocks.selectQueues, "users", [{ administrator: true, role: "owner" }]);
  queue(mocks.selectQueues, "items", [{ id: itemId }]);
  // reserveDocumentMetadata's instance/household quota totals.
  queue(mocks.selectQueues, "documents", [{ total: 0 }]);
  queue(mocks.selectQueues, "documents", [{ total: 0 }]);
}

beforeEach(() => {
  mocks.selectQueues.clear();
  mocks.updateReturningQueues.clear();
  mocks.updateCalls.length = 0;
  mocks.insertCalls.length = 0;
});

describe("uploadItemDocument publish (#1151 A2-R1)", () => {
  it("publishes when the row is still encrypting", async () => {
    seedUploadHappyPath();
    queue(mocks.updateReturningQueues, "documents", [{ id: "doc-1" }]);

    const result = await uploadItemDocument({
      userId, householdId, itemId, filename: "bill.pdf", body: fakeBody(), declaredBytes: 5,
    });

    expect(result.lifecycle).toBe("available");
    const publish = mocks.updateCalls.find((call) => call.table === "documents" && call.values.lifecycle === "available");
    expect(publish).toBeDefined();
  });

  it("refuses to report available when the row left `encrypting` under it, instead of publishing blind (A2-R1)", async () => {
    seedUploadHappyPath();
    // The maintenance sweep already moved this row out of `encrypting`
    // (e.g. to `rejected`, having decided the upload was interrupted): the
    // conditional publish update matches no row.
    queue(mocks.updateReturningQueues, "documents", []);

    let caught: unknown;
    try {
      await uploadItemDocument({
        userId, householdId, itemId, filename: "bill.pdf", body: fakeBody(), declaredBytes: 5,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("document_publish_conflict");
    // No audit entry claiming the document became available.
    const availableAudit = mocks.insertCalls.find((call) => call.table === "audit_log"
      && (call.values as { action?: string }).action === "document_available");
    expect(availableAudit).toBeUndefined();
  });
});
