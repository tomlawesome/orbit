import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A2-Q1: `uploadItemDocument` read the quarantine file twice on every upload
 * -- once to validate structure, once to encrypt -- where the inspection
 * endpoint (`item-document-inspection.ts`) reads once. With scanning
 * `disabled` there is no ClamAV wait between the two reads, so the second
 * read bought nothing; this proves it is gone for that path while the
 * `required` path still re-reads deliberately (it zeroes the buffer before
 * the scan runs, rather than holding plaintext in memory for the scan's
 * duration).
 */

const mocks = vi.hoisted(() => ({
  selectQueues: new Map<string, unknown[][]>(),
  updateReturningQueues: new Map<string, unknown[][]>(),
  readQuarantineCalls: 0,
  scanStatus: "clean" as "clean" | "infected",
  structureValid: true,
  lastQuarantineBuffer: null as Buffer | null,
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
    const chain: Record<string, unknown> = {
      set: () => chain,
      where: () => chain,
      returning: () => Promise.resolve(nextRows(mocks.updateReturningQueues, table)),
      then: (resolve: (value: undefined) => unknown) => Promise.resolve(undefined).then(resolve),
    };
    return chain;
  }

  function insertBuilder() {
    return { values: () => Promise.resolve() };
  }

  const fakeDb: Record<string, unknown> = {
    select: () => selectBuilder(),
    update: (t: unknown) => updateBuilder(getTableName(t as never)),
    insert: () => insertBuilder(),
    execute: async () => undefined,
    transaction: async (fn: (tx: unknown) => unknown) => fn(fakeDb),
  };

  return { getDb: () => fakeDb };
});

vi.mock("@/server/documents/authorization", () => ({
  canAccessHouseholdDocuments: () => true,
}));

function makeConfig(scanMode: "disabled" | "required") {
  return {
    storageRoot: "/private/documents",
    quarantineRoot: "/private/quarantine",
    maxBytes: 25 * 1_048_576,
    householdQuotaBytes: 1_000_000_000,
    instanceQuotaBytes: 1_000_000_000,
    scanMode,
    clamAv: { host: "orbit-clamav", port: 3310, timeoutMs: 30_000 },
  };
}

const configState = { scanMode: "disabled" as "disabled" | "required" };

vi.mock("@/server/documents/config", () => ({
  getDocumentConfig: () => makeConfig(configState.scanMode),
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
  validateSupportedDocumentStructure: async () => mocks.structureValid,
}));

vi.mock("@/server/documents/crypto", () => ({
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

vi.mock("@/server/documents/scanner", () => ({
  scanFileWithClamAv: async () => ({ status: mocks.scanStatus }),
}));

vi.mock("@/server/documents/storage", () => ({
  LocalDocumentStorage: class {
    async receive() {
      return { quarantinePath: "/tmp/q", sizeBytes: 5, contentSha256: "hash", leadingBytes: Buffer.from("%PDF") };
    }
    async readQuarantine() {
      mocks.readQuarantineCalls += 1;
      const buffer = Buffer.from("plaintext");
      mocks.lastQuarantineBuffer = buffer;
      return buffer;
    }
    createStorageKey() {
      return "a".repeat(64);
    }
    async writeCiphertext() {}
    async deleteCiphertext() {}
    async deleteStagingCiphertext() {}
    async discardQuarantine() {}
  },
}));

const { uploadItemDocument } = await import("./document-repository");

const userId = "39a5fac9-38cb-4178-b68a-a8d8db97ed3b";
const householdId = "66a1f3d8-b79d-47a5-92fe-a4824270aa9a";
const itemId = "26f04310-3f96-4828-94b2-f2fc693bc89e";

function fakeBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array()); controller.close(); } });
}

function seedUploadHappyPath() {
  queue(mocks.selectQueues, "users", [{ itemId, administrator: true, membershipUserId: userId }]);
  queue(mocks.selectQueues, "documents", [{ total: 0 }]);
  queue(mocks.selectQueues, "documents", [{ total: 0 }]);
  queue(mocks.updateReturningQueues, "documents", [{ id: "doc-1" }]);
}

beforeEach(() => {
  mocks.selectQueues.clear();
  mocks.updateReturningQueues.clear();
  mocks.readQuarantineCalls = 0;
  mocks.scanStatus = "clean";
  mocks.structureValid = true;
  mocks.lastQuarantineBuffer = null;
  configState.scanMode = "disabled";
});

describe("uploadItemDocument quarantine reads (#1151 A2-Q1)", () => {
  it("reads the quarantine file once when scanning is disabled", async () => {
    configState.scanMode = "disabled";
    seedUploadHappyPath();

    await uploadItemDocument({
      userId, householdId, itemId, filename: "bill.pdf", body: fakeBody(), declaredBytes: 5,
    });

    expect(mocks.readQuarantineCalls).toBe(1);
  });

  it("still reads twice when a scan runs, to avoid holding plaintext across it", async () => {
    configState.scanMode = "required";
    seedUploadHappyPath();

    await uploadItemDocument({
      userId, householdId, itemId, filename: "bill.pdf", body: fakeBody(), declaredBytes: 5,
    });

    expect(mocks.readQuarantineCalls).toBe(2);
  });
});

describe("quarantine buffer zeroing on a rejected upload (#1151 F13)", () => {
  it("zeroes the reused validation buffer when structure validation fails with scanning disabled", async () => {
    configState.scanMode = "disabled";
    mocks.structureValid = false;
    seedUploadHappyPath();

    await expect(uploadItemDocument({
      userId, householdId, itemId, filename: "bill.pdf", body: fakeBody(), declaredBytes: 5,
    })).rejects.toMatchObject({ code: "document_structure_invalid" });

    // With scanning disabled the encrypt stage would have reused this same
    // buffer and zeroed it there -- but the throw above means that stage is
    // never reached, so it must be zeroed before this function exits instead
    // of being dropped unwiped.
    expect(mocks.lastQuarantineBuffer).not.toBeNull();
    expect(mocks.lastQuarantineBuffer!.every((byte) => byte === 0)).toBe(true);
  });
});
