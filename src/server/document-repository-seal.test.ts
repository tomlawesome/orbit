import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #1567: the upload reads the quarantine file once, for the pre-parse open
 * check; encryption no longer reuses that buffer but reads the file again in
 * pieces (`storage.sealQuarantine`), verifying its digest as it goes, so no
 * whole-file plaintext copy is kept for encryption. Same harness as
 * document-repository-upload-quarantine-reads.test.ts. The scanner-recovery
 * stage and the real sandbox are proven in
 * tests/integration/document-upload-stream.test.ts.
 */

const mocks = vi.hoisted(() => ({
  selectQueues: new Map<string, unknown[][]>(),
  updateReturningQueues: new Map<string, unknown[][]>(),
  readQuarantineCalls: 0,
  scanStatus: "clean" as "clean" | "infected",
  structureValid: true,
  lastQuarantineBuffer: null as Buffer | null,
  order: [] as string[],
  inserts: [] as Array<{ table: string; values: unknown }>,
  classifyCalls: [] as unknown[][],
  sealerContexts: [] as unknown[],
  sealCalls: [] as unknown[][],
  sealFailure: null as Error | null,
  discarded: [] as string[],
  encryptCalls: 0,
  writeCiphertextCalls: 0,
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

  function insertBuilder(table: string) {
    return { values: (values: unknown) => { mocks.inserts.push({ table, values }); return Promise.resolve(); } };
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
  classifyDocumentStructure: async (...args: unknown[]) => {
    mocks.order.push("open");
    mocks.classifyCalls.push(args);
    return mocks.structureValid ? "supported_structure" : "unsupported_structure";
  },
}));

const ENVELOPE = {
  envelopeVersion: 1,
  algorithm: "aes-256-gcm",
  keyId: "key-1",
  contentIv: "iv",
  contentAuthTag: "tag",
  wrappedDek: "dek",
  wrapIv: "wiv",
  wrapAuthTag: "wtag",
};

vi.mock("@/server/documents/crypto", async (importActual) => ({
  envelopeOf: (await importActual<typeof import("@/server/documents/crypto")>()).envelopeOf,
  // The document path no longer calls the one-shot encrypt: a call is a failure.
  encryptDocument: () => {
    mocks.encryptCalls += 1;
    throw new Error("encryptDocument must not be used for an uploaded document");
  },
  createDocumentSealer: (context: unknown) => {
    mocks.sealerContexts.push(context);
    return { update: () => Buffer.alloc(0), final: () => ({ tail: Buffer.alloc(0), envelope: ENVELOPE }) };
  },
}));

vi.mock("@/server/documents/scanner", () => ({
  scanFileWithClamAv: async () => {
    mocks.order.push("scan");
    return { status: mocks.scanStatus };
  },
}));

vi.mock("@/server/documents/storage", () => {
  class LocalDocumentStorage {
    async receive() {
      return { quarantinePath: "/tmp/q", sizeBytes: 5, contentSha256: "hash", leadingBytes: Buffer.from("%PDF-") };
    }
    async readQuarantine() {
      mocks.readQuarantineCalls += 1;
      const buffer = Buffer.from("%PDF-");
      mocks.lastQuarantineBuffer = buffer;
      return buffer;
    }
    createStorageKey() {
      return "a".repeat(64);
    }
    async sealQuarantine(...args: unknown[]) {
      mocks.sealCalls.push(args);
      if (mocks.sealFailure) throw mocks.sealFailure;
      const sealer = args[2] as { final(): { envelope: unknown } };
      return { ciphertextSize: 5, envelope: sealer.final().envelope };
    }
    async writeCiphertext() {
      mocks.writeCiphertextCalls += 1;
    }
    async writeStagingCiphertext() {
      mocks.writeCiphertextCalls += 1;
    }
    async deleteCiphertext() {}
    async deleteStagingCiphertext() {}
    async discardQuarantine(path: string) {
      mocks.discarded.push(path);
    }
  }
  return {
    LocalDocumentStorage,
    openDocumentStorage: () => new LocalDocumentStorage(),
  };
});

const { uploadItemDocument } = await import("./document-repository");
const { AppError } = await import("@/lib/errors");

const userId = "39a5fac9-38cb-4178-b68a-a8d8db97ed3b";
const householdId = "66a1f3d8-b79d-47a5-92fe-a4824270aa9a";
const itemId = "26f04310-3f96-4828-94b2-f2fc693bc89e";

function fakeBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array()); controller.close(); } });
}

function seedUploadHappyPath() {
  queue(mocks.selectQueues, "users", [{ administrator: true, role: "owner" }]);
  queue(mocks.selectQueues, "items", [{ id: itemId }]);
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
  mocks.order = [];
  mocks.inserts = [];
  mocks.classifyCalls = [];
  mocks.sealerContexts = [];
  mocks.sealCalls = [];
  mocks.sealFailure = null;
  mocks.discarded = [];
  mocks.encryptCalls = 0;
  mocks.writeCiphertextCalls = 0;
  configState.scanMode = "disabled";
});

function upload() {
  seedUploadHappyPath();
  return uploadItemDocument({ userId, householdId, itemId, filename: "bill.pdf", body: fakeBody(), declaredBytes: 5 });
}

describe("uploadItemDocument reads the file once for the open check and seals it from quarantine in pieces (#1567)", () => {
  it("hands the check the bytes it read and the quarantine file's path and size, so the sandbox can open it by descriptor", async () => {
    await upload();

    expect(mocks.readQuarantineCalls).toBe(1);
    expect(mocks.classifyCalls).toHaveLength(1);
    const [bytes, mediaType, file] = mocks.classifyCalls[0]!;
    expect(bytes).toBe(mocks.lastQuarantineBuffer);
    expect(mediaType).toBe("application/pdf");
    expect(file).toEqual({ path: "/tmp/q", sizeBytes: 5 });
  });

  it("encrypts from the quarantine file through a document sealer, verifying what it received, and never with the one-shot encrypt", async () => {
    await upload();

    expect(mocks.encryptCalls).toBe(0);
    expect(mocks.writeCiphertextCalls).toBe(0);
    expect(mocks.sealerContexts).toHaveLength(1);
    expect(mocks.sealerContexts[0]).toMatchObject({ householdId, itemId, mediaType: "application/pdf", plaintextSize: 5 });
    expect((mocks.sealerContexts[0] as { purpose?: string }).purpose ?? "document").toBe("document");
    expect(mocks.sealCalls).toHaveLength(1);
    const [path, expected, sealer, destination] = mocks.sealCalls[0]!;
    expect(path).toBe("/tmp/q");
    expect(expected).toEqual({ sizeBytes: 5, contentSha256: "hash" });
    expect(sealer).toEqual(expect.objectContaining({ update: expect.any(Function), final: expect.any(Function) }));
    expect(destination).toEqual({ kind: "object", storageKey: "a".repeat(64) });
  });

  it("stores the ciphertext size and envelope that the sealing pass produced", async () => {
    await upload();

    const crypto = mocks.inserts.find((entry) => entry.table === "document_crypto");
    expect(crypto, "a document_crypto row was written").toBeDefined();
    expect(crypto!.values).toMatchObject({
      storageKey: "a".repeat(64),
      ciphertextSize: 5,
      envelopeVersion: ENVELOPE.envelopeVersion,
      contentIv: ENVELOPE.contentIv,
      contentAuthTag: ENVELOPE.contentAuthTag,
      wrappedDek: ENVELOPE.wrappedDek,
      wrapIv: ENVELOPE.wrapIv,
      wrapAuthTag: ENVELOPE.wrapAuthTag,
      keyId: ENVELOPE.keyId,
    });
  });

  it("zeroes and drops the check's buffer once the check has answered, on an accepted upload", async () => {
    await upload();

    expect(mocks.lastQuarantineBuffer).not.toBeNull();
    expect(mocks.lastQuarantineBuffer!.every((byte) => byte === 0)).toBe(true);
  });

  it("zeroes the check's buffer when the check refuses the file, and writes nothing", async () => {
    mocks.structureValid = false;

    await expect(upload()).rejects.toMatchObject({ code: "document_structure_invalid" });

    expect(mocks.lastQuarantineBuffer!.every((byte) => byte === 0)).toBe(true);
    expect(mocks.sealCalls).toHaveLength(0);
    expect(mocks.inserts).toEqual([]);
  });

  it("zeroes the check's buffer when the sealing pass refuses the file, and passes the refusal on as it is", async () => {
    mocks.sealFailure = new AppError("document_quarantine_invalid", "The quarantined document is invalid", 422);

    await expect(upload()).rejects.toMatchObject({ code: "document_quarantine_invalid", status: 422 });

    expect(mocks.lastQuarantineBuffer!.every((byte) => byte === 0)).toBe(true);
    expect(mocks.discarded).toContain("/tmp/q");
  });
});
