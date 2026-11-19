import { beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "@/lib/logger";

/**
 * #1920: the open check reads no whole file. A PDF is checked by the sandbox
 * from the file on disk (readQuarantine never called); a JPEG or PNG has its
 * header parsed from a read of at most the first 1 MiB (readQuarantineHead),
 * with one whole-file readQuarantine only when the header lies beyond it. Every
 * buffer the check read is detached before the seal starts.
 *
 * A2-Q1: `uploadItemDocument` read the quarantine file twice on every upload
 * -- once to validate structure, once to encrypt -- where the inspection
 * endpoint (`item-document-inspection.ts`) reads once. Since ADR-0033 the
 * scan runs before anything reads the file, so one read after the scan
 * serves both the structure check and the encrypt stage on either scan mode,
 * and no plaintext is held in memory for the scan's duration.
 */

const MIB = 1_048_576;

/** SOI, then a baseline frame header (SOF0) at once: 48 x 64, three components. */
const JPEG_FRONT = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x30, 0x00, 0x40, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);

/** A PNG signature and IHDR: 64 x 48. */
const PNG_FRONT = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
  Buffer.from("IHDR", "latin1"),
  Buffer.from([0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x30, 0x08, 0x06, 0x00, 0x00, 0x00]),
]);

/** SOI then APP1 segments of 65,533 data bytes, running past the end of the buffer: no frame header in it. */
function fillAppChain(buffer: Buffer): void {
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  for (let at = 2; at < buffer.length; at += 65_537) {
    buffer[at] = 0xff;
    buffer[at + 1] = 0xe1;
    buffer.writeUInt16BE(65_535, at + 2);
  }
}

const mocks = vi.hoisted(() => ({
  selectQueues: new Map<string, unknown[][]>(),
  updateReturningQueues: new Map<string, unknown[][]>(),
  readQuarantineCalls: 0,
  readHeadCalls: [] as unknown[][],
  /** Every buffer the check read: the head and, in the late-header fallback, the whole file. */
  checkBuffers: [] as Buffer[],
  bufferLengthsWhenSealing: [] as number[],
  mediaType: "application/pdf" as string,
  fileSize: 5,
  headKind: "front" as "front" | "late" | "jpegLarge" | "pngLarge",
  readFailure: null as Error | null,
  scanStatus: "clean" as "clean" | "infected",
  structureValid: true as boolean | "no_verdict" | "password_required",
  lastQuarantineBuffer: null as Buffer | null,
  order: [] as string[],
  inserts: [] as string[],
  insertedRows: [] as Array<{ table: string; values: unknown }>,
  classifyCalls: [] as unknown[][],
  sealerContexts: [] as unknown[],
  sealCalls: [] as unknown[][],
  bufferLengthWhenSealing: null as number | null,
  sealFailure: null as Error | null,
  discarded: [] as string[],
  encryptCalls: 0,
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
    mocks.inserts.push(table);
    return { values: (values: unknown) => { mocks.insertedRows.push({ table, values }); return Promise.resolve(); } };
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

/* #1437: an upload keys its fingerprint with the household's metadata key and
   asks whether the household already holds the bytes. Neither is under test
   here; no key means no fingerprint and no match. #1771 seals the hash with
   the same writer: an opaque stand-in. */
vi.mock("@/server/metadata/fields", async (importActual) => ({
  ...await importActual<typeof import("@/server/metadata/fields")>(),
  openMetadataWriter: async () => ({ contentIndex: () => null, encryptText: () => "sealed-hash" }),
  openMetadataReader: async () => ({ contentIndex: () => null }),
}));

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

vi.mock("@/server/documents/validation", async (importActual) => ({
  ...await importActual<typeof import("@/server/documents/validation")>(),
  detectDocumentMediaType: () => mocks.mediaType,
  normalizedDocumentFilename: (name: string) => name,
  classifyDocumentStructure: async (...args: unknown[]) => {
    mocks.order.push("open");
    mocks.classifyCalls.push(args);
    // The check answers { reason, pageCount } since #1436 D3.
    if (mocks.structureValid === "no_verdict") return { reason: "structure_check_unavailable" };
    if (mocks.structureValid === "password_required") return { reason: "password_required" };
    return mocks.structureValid ? { reason: "supported_structure", pageCount: 1 } : { reason: "unsupported_structure" };
  },
}));

const SEALED_ENVELOPE = {
  algorithm: "aes-256-gcm",
  keyId: "key-1",
  iv: Buffer.alloc(12, 2),
  authTag: Buffer.alloc(16, 3),
  wrappedKey: Buffer.alloc(32, 4),
  wrappedKeyIv: Buffer.alloc(12, 5),
  wrappedKeyAuthTag: Buffer.alloc(16, 6),
};

vi.mock("@/server/documents/crypto", async (importActual) => ({
  envelopeOf: (await importActual<typeof import("@/server/documents/crypto")>()).envelopeOf,
  // The document path no longer calls the one-shot encrypt: a call is a failure.
  encryptDocument: () => {
    mocks.encryptCalls += 1;
    throw new Error("encryptDocument must not be used for an uploaded document");
  },
  // The sealer is a stand-in: the bytes are sealed inside the mocked storage below.
  createDocumentSealer: (context: unknown) => {
    mocks.sealerContexts.push(context);
    return {
    update: () => Buffer.alloc(0),
    final: () => ({ tail: Buffer.alloc(0), envelope: SEALED_ENVELOPE }),
    };
  },
}));

vi.mock("@/server/documents/scanner", () => ({
  scanFileWithClamAv: async () => {
    mocks.order.push("scan");
    return { status: mocks.scanStatus };
  },
}));

vi.mock("@/server/documents/storage", async (importActual) => {
  class LocalDocumentStorage {
    async receive() {
      return { quarantinePath: "/tmp/q", sizeBytes: mocks.fileSize, contentSha256: "hash", leadingBytes: Buffer.from("%PDF") };
    }
    async readQuarantine() {
      mocks.readQuarantineCalls += 1;
      if (mocks.readFailure) throw mocks.readFailure;
      // Not from Node's shared pool, as a real read of a file is not: the whole
      // ArrayBuffer is this buffer's, so it can be detached.
      const buffer = Buffer.alloc(9, "plaintext");
      mocks.lastQuarantineBuffer = buffer;
      mocks.checkBuffers.push(buffer);
      return buffer;
    }
    async readQuarantineHead(...args: unknown[]) {
      mocks.readHeadCalls.push(args);
      const head = Buffer.alloc(mocks.headKind === "front" ? JPEG_FRONT.length : MIB);
      if (mocks.headKind === "late") fillAppChain(head);
      else if (mocks.headKind === "pngLarge") PNG_FRONT.copy(head);
      else JPEG_FRONT.copy(head);
      mocks.lastQuarantineBuffer = head;
      mocks.checkBuffers.push(head);
      return { head, sizeBytes: mocks.fileSize };
    }
    createStorageKey() {
      return "a".repeat(64);
    }
    async sealQuarantine(...args: unknown[]) {
      mocks.sealCalls.push(args);
      // The check's buffer must already be released (detached) before the sealing pass starts.
      mocks.bufferLengthWhenSealing = mocks.lastQuarantineBuffer?.byteLength ?? null;
      mocks.bufferLengthsWhenSealing = mocks.checkBuffers.map((buffer) => buffer.byteLength);
      if (mocks.sealFailure) throw mocks.sealFailure;
      return { ciphertextSize: 10, envelope: SEALED_ENVELOPE };
    }
    async writeCiphertext() {}
    async deleteCiphertext() {}
    async deleteStagingCiphertext() {}
    async discardQuarantine(path: string) {
      mocks.discarded.push(path);
    }
  }
  return {
    LocalDocumentStorage,
    openDocumentStorage: () => new LocalDocumentStorage(),
    // The real one: freeing the buffer is what the upload is being held to.
    releaseBuffer: (await importActual<typeof import("@/server/documents/storage")>()).releaseBuffer,
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
  // requireHouseholdAndItemAccess: the household gate answers from the users
  // table, then the item is looked up in that household.
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
  mocks.readHeadCalls = [];
  mocks.checkBuffers = [];
  mocks.bufferLengthsWhenSealing = [];
  mocks.mediaType = "application/pdf";
  mocks.fileSize = 5;
  mocks.headKind = "front";
  mocks.readFailure = null;
  mocks.scanStatus = "clean";
  mocks.structureValid = true;
  mocks.lastQuarantineBuffer = null;
  mocks.order = [];
  mocks.inserts = [];
  mocks.insertedRows = [];
  mocks.classifyCalls = [];
  mocks.sealerContexts = [];
  mocks.sealCalls = [];
  mocks.bufferLengthWhenSealing = null;
  mocks.sealFailure = null;
  mocks.discarded = [];
  mocks.encryptCalls = 0;
  configState.scanMode = "disabled";
});

describe("uploadItemDocument scans before anything opens the file (ADR-0033)", () => {
  it("scans, then lets the renderer open the file", async () => {
    configState.scanMode = "required";
    seedUploadHappyPath();

    await uploadItemDocument({
      userId, householdId, itemId, filename: "bill.pdf", body: fakeBody(), declaredBytes: 5,
    });

    expect(mocks.order).toEqual(["scan", "open"]);
  });

  it("never opens a file the scanner found malware in", async () => {
    configState.scanMode = "required";
    mocks.scanStatus = "infected";
    seedUploadHappyPath();

    await expect(uploadItemDocument({
      userId, householdId, itemId, filename: "bill.pdf", body: fakeBody(), declaredBytes: 5,
    })).rejects.toMatchObject({ code: "document_malware_detected" });

    expect(mocks.order).toEqual(["scan"]);
  });

  it("refuses a file the renderer cannot open after its scan, before any metadata is written", async () => {
    configState.scanMode = "required";
    mocks.structureValid = false;
    seedUploadHappyPath();

    await expect(uploadItemDocument({
      userId, householdId, itemId, filename: "bill.pdf", body: fakeBody(), declaredBytes: 5,
    })).rejects.toMatchObject({ code: "document_structure_invalid" });

    expect(mocks.order).toEqual(["scan", "open"]);
    expect(mocks.inserts).toEqual([]);
  });

  it("answers 503 document_check_unavailable, 'please try again', when the structure check reached no verdict, writing no metadata (D-S1, #1593)", async () => {
    configState.scanMode = "required";
    mocks.structureValid = "no_verdict";
    seedUploadHappyPath();

    const error = await uploadItemDocument({
      userId, householdId, itemId, filename: "bill.pdf", body: fakeBody(), declaredBytes: 5,
    }).then(() => null, (caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "document_check_unavailable",
      status: 503,
      message: "The file couldn't be uploaded. Please try again.",
    });
    expect((error as Error).message).not.toMatch(/choose another/iu);
    expect(mocks.order).toEqual(["scan", "open"]);
    // Nothing is stored: no row, no seal, and the quarantine copy goes.
    expect(mocks.inserts).toEqual([]);
    expect(mocks.sealCalls).toEqual([]);
    expect(mocks.discarded).toEqual(["/tmp/q"]);
  });

  it("answers the same 503 with scanning disabled", async () => {
    configState.scanMode = "disabled";
    mocks.structureValid = "no_verdict";
    seedUploadHappyPath();

    await expect(uploadItemDocument({
      userId, householdId, itemId, filename: "bill.pdf", body: fakeBody(), declaredBytes: 5,
    })).rejects.toMatchObject({ code: "document_check_unavailable", status: 503 });

    expect(mocks.inserts).toEqual([]);
    expect(mocks.sealCalls).toEqual([]);
  });

  it("writes one warn-level line with the real reason and the 'look at the host' action (inspect_admin_diagnostics), carrying none of the member's words (#1593)", async () => {
    configState.scanMode = "required";
    mocks.structureValid = "no_verdict";
    seedUploadHappyPath();
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    await expect(uploadItemDocument({
      userId, householdId, itemId, filename: "bill.pdf", body: fakeBody(), declaredBytes: 5,
    })).rejects.toMatchObject({ code: "document_check_unavailable" });

    const lines = warnSpy.mock.calls.filter(([line]) => line.reason === "structure_check_unavailable");
    expect(lines).toHaveLength(1);
    expect(lines[0][0]).toMatchObject({ reason: "structure_check_unavailable", action: "inspect_admin_diagnostics" });
    const everything = JSON.stringify(warnSpy.mock.calls);
    expect(everything).not.toContain("bill.pdf");
    expect(everything).not.toContain("try again");
  });

  it("keeps the 422 and its message for a password-protected document, and logs no structure_check_unavailable (#1593)", async () => {
    configState.scanMode = "required";
    mocks.structureValid = "password_required";
    seedUploadHappyPath();
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    await expect(uploadItemDocument({
      userId, householdId, itemId, filename: "bill.pdf", body: fakeBody(), declaredBytes: 5,
    })).rejects.toMatchObject({
      code: "document_password_required",
      status: 422,
      message: "This document needs a password to open. Choose a copy without a password.",
    });

    expect(mocks.inserts).toEqual([]);
    expect(warnSpy.mock.calls.filter(([line]) => line.reason === "structure_check_unavailable")).toEqual([]);
  });

  it("keeps the 422 and its message for an invalid structure, and logs no structure_check_unavailable (#1593)", async () => {
    configState.scanMode = "required";
    mocks.structureValid = false;
    seedUploadHappyPath();
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    await expect(uploadItemDocument({
      userId, householdId, itemId, filename: "bill.pdf", body: fakeBody(), declaredBytes: 5,
    })).rejects.toMatchObject({
      code: "document_structure_invalid",
      status: 422,
      message: "Orbit could not open this document. Choose another PDF, JPEG, or PNG.",
    });

    expect(warnSpy.mock.calls.filter(([line]) => line.reason === "structure_check_unavailable")).toEqual([]);
  });
});

function uploadFile(filename = "bill.pdf") {
  return uploadItemDocument({ userId, householdId, itemId, filename, body: fakeBody(), declaredBytes: 5 });
}

/** The three ways an image's header can be found: at the front, or beyond the first MiB (whole-file fallback). */
const imageCases = [
  { name: "a JPEG with its header at the front", headKind: "front", whole: 0 },
  { name: "a JPEG whose header lies beyond the first MiB", headKind: "late", whole: 1 },
] as const;

function useImage(headKind: "front" | "late") {
  mocks.mediaType = "image/jpeg";
  mocks.headKind = headKind;
  if (headKind === "late") mocks.fileSize = 1_200_000;
}

describe("uploadItemDocument quarantine reads (#1151 A2-Q1, #1920)", () => {
  it.each(["disabled", "required"] as const)("reads no quarantine file into the server for a PDF, scanning %s", async (scanMode) => {
    configState.scanMode = scanMode;
    seedUploadHappyPath();

    await uploadFile();

    expect(mocks.readQuarantineCalls).toBe(0);
    expect(mocks.readHeadCalls).toHaveLength(0);
    expect(mocks.classifyCalls).toHaveLength(1);
  });

  it("reads nothing before the scan runs, so no plaintext is held across it (ADR-0033)", async () => {
    configState.scanMode = "required";
    seedUploadHappyPath();
    useImage("front");
    let readsWhenScanned = -1;
    const scanned = mocks.order.push.bind(mocks.order);
    mocks.order.push = (...entries: string[]) => {
      if (entries.includes("scan")) readsWhenScanned = mocks.readQuarantineCalls + mocks.readHeadCalls.length;
      return scanned(...entries);
    };

    await uploadFile("photo.jpg");

    expect(readsWhenScanned).toBe(0);
    expect(mocks.readHeadCalls).toHaveLength(1);
  });

  it.each(imageCases)("reads the front of the file for $name, with readQuarantine called $whole time(s)", async ({ headKind, whole }) => {
    useImage(headKind);
    seedUploadHappyPath();

    await uploadFile("photo.jpg");

    expect(mocks.readHeadCalls).toHaveLength(1);
    const [path, , headBytes] = mocks.readHeadCalls[0]!;
    expect(path).toBe("/tmp/q");
    expect(headBytes as number, "at most the first 1 MiB").toBeLessThanOrEqual(MIB);
    expect(mocks.readQuarantineCalls).toBe(whole);
    expect(mocks.classifyCalls).toHaveLength(1);
  });
});

describe("an image over 1 MiB with its header at the front is not read whole (#1920)", () => {
  it.each([
    ["image/jpeg", "jpegLarge", "photo.jpg"],
    ["image/png", "pngLarge", "photo.png"],
  ] as const)("reads only the head of a large %s, and never calls readQuarantine", async (mediaType, headKind, filename) => {
    mocks.mediaType = mediaType;
    mocks.headKind = headKind;
    mocks.fileSize = 5 * MIB;
    seedUploadHappyPath();

    await uploadFile(filename);

    expect(mocks.readQuarantineCalls).toBe(0);
    expect(mocks.readHeadCalls).toHaveLength(1);
    expect(mocks.readHeadCalls[0]![2] as number).toBeLessThanOrEqual(MIB);
    expect(mocks.checkBuffers).toHaveLength(1);
    expectEveryCheckBufferDetached();
  });
});

describe("the late-header fallback's whole-file read fails (#1920)", () => {
  it("fails the upload with that error, and the head buffer is still zeroed and detached", async () => {
    useImage("late");
    mocks.readFailure = new AppError("document_quarantine_invalid", "The quarantined document is invalid", 422);
    seedUploadHappyPath();

    await expect(uploadFile("photo.jpg")).rejects.toMatchObject({ code: "document_quarantine_invalid", status: 422 });

    expect(mocks.readQuarantineCalls).toBe(1);
    expect(mocks.checkBuffers).toHaveLength(1);
    expectEveryCheckBufferDetached();
    expect(mocks.sealCalls).toEqual([]);
  });
});

describe("uploadItemDocument page bound (#1801 A-F14)", () => {
  it("T5: an upload given maxPages 1000 hands classifyDocumentStructure a fourth argument { maxPages: 1000 }", async () => {
    seedUploadHappyPath();

    await uploadItemDocument({
      userId, householdId, itemId, filename: "bill.pdf", body: fakeBody(), declaredBytes: 5, maxPages: 1000,
    });

    expect(mocks.classifyCalls).toHaveLength(1);
    expect(mocks.classifyCalls[0][3]).toEqual({ maxPages: 1000 });
  });

  it("L3: a plain upload gives the check no page bound, so the current cap applies", async () => {
    seedUploadHappyPath();

    await uploadItemDocument({
      userId, householdId, itemId, filename: "bill.pdf", body: fakeBody(), declaredBytes: 5,
    });

    expect(mocks.classifyCalls).toHaveLength(1);
    const options = mocks.classifyCalls[0][3] as { maxPages?: number } | undefined;
    expect(options?.maxPages).toBeUndefined();
  });
});

describe("quarantine buffer zeroing on a rejected upload (#1151 F13)", () => {
  it.each(imageCases)("releases every buffer the check read for $name when structure validation fails", async ({ headKind }) => {
    configState.scanMode = "disabled";
    mocks.structureValid = false;
    useImage(headKind);
    seedUploadHappyPath();

    await expect(uploadFile("photo.jpg")).rejects.toMatchObject({ code: "document_structure_invalid" });

    expectEveryCheckBufferDetached();
  });

  it("reads no buffer at all for a refused PDF", async () => {
    configState.scanMode = "disabled";
    mocks.structureValid = false;
    seedUploadHappyPath();

    await expect(uploadFile()).rejects.toMatchObject({ code: "document_structure_invalid" });

    expect(mocks.readQuarantineCalls).toBe(0);
    expect(mocks.checkBuffers).toHaveLength(0);
  });
});

function expectEveryCheckBufferDetached() {
  expect(mocks.checkBuffers.length, "the check read at least one buffer").toBeGreaterThan(0);
  for (const buffer of mocks.checkBuffers) {
    expect(buffer.byteLength, "no plaintext copy remains: the check's buffer is detached").toBe(0);
    expect(buffer.buffer.byteLength).toBe(0);
  }
}

describe("uploadItemDocument seals from quarantine in pieces (#1567, #1920)", () => {
  function upload() {
    seedUploadHappyPath();
    return uploadFile();
  }

  it("hands the check the quarantine file's path and size for a PDF, so the sandbox opens the file on disk, and reads none of it itself", async () => {
    await upload();

    expect(mocks.classifyCalls).toHaveLength(1);
    const [, mediaType, file] = mocks.classifyCalls[0]!;
    expect(mediaType).toBe("application/pdf");
    expect(file).toEqual({ path: "/tmp/q", sizeBytes: 5 });
    expect(mocks.readQuarantineCalls).toBe(0);
  });

  it.each(imageCases)("hands the check the quarantine file's path and size for $name", async ({ headKind }) => {
    useImage(headKind);
    seedUploadHappyPath();

    await uploadFile("photo.jpg");

    const [, mediaType, file] = mocks.classifyCalls[0]!;
    expect(mediaType).toBe("image/jpeg");
    expect(file).toEqual({ path: "/tmp/q", sizeBytes: mocks.fileSize });
  });

  it("seals from the quarantine file through a document sealer, with the expected size and digest, and never with the one-shot encrypt", async () => {
    await upload();

    expect(mocks.encryptCalls).toBe(0);
    expect(mocks.sealerContexts).toHaveLength(1);
    expect(mocks.sealerContexts[0]).toMatchObject({ householdId, itemId, mediaType: "application/pdf", plaintextSize: 5 });
    expect(mocks.sealCalls).toHaveLength(1);
    const [path, expected, sealer, destination] = mocks.sealCalls[0]!;
    expect(path).toBe("/tmp/q");
    expect(expected).toEqual({ sizeBytes: 5, contentSha256: "hash" });
    expect(sealer).toEqual(expect.objectContaining({ update: expect.any(Function), final: expect.any(Function) }));
    expect(destination).toEqual({ kind: "object", storageKey: "a".repeat(64) });
  });

  it.each(imageCases)("releases every buffer the check read for $name before the sealing pass starts", async ({ headKind }) => {
    useImage(headKind);
    seedUploadHappyPath();

    await uploadFile("photo.jpg");

    expect(mocks.bufferLengthsWhenSealing.length, "the check read a buffer before the seal").toBeGreaterThan(0);
    expect(mocks.bufferLengthsWhenSealing.every((length) => length === 0), "all detached by the time sealQuarantine is called").toBe(true);
    expectEveryCheckBufferDetached();
  });

  it("stores the ciphertext size and the envelope that the sealing pass produced", async () => {
    await upload();

    const crypto = mocks.insertedRows.find((entry) => entry.table === "document_crypto");
    expect(crypto, "a document_crypto row was written").toBeDefined();
    expect(crypto!.values).toMatchObject({ storageKey: "a".repeat(64), ciphertextSize: 10, keyId: SEALED_ENVELOPE.keyId });
  });

  it.each(imageCases)("releases every buffer the check read for $name when the sealing pass refuses the file, and passes the refusal on as it is", async ({ headKind }) => {
    useImage(headKind);
    mocks.sealFailure = new AppError("document_quarantine_invalid", "The quarantined document is invalid", 422);
    seedUploadHappyPath();

    await expect(uploadFile("photo.jpg")).rejects.toMatchObject({ code: "document_quarantine_invalid", status: 422 });

    expectEveryCheckBufferDetached();
    expect(mocks.discarded).toContain("/tmp/q");
  });
});

describe("the upload's check buffers are freed, not only zeroed (A-Q1, A-Q4, #1920)", () => {
  it.each(imageCases)("leaves every buffer detached after a clean upload of $name", async ({ headKind }) => {
    configState.scanMode = "disabled";
    useImage(headKind);
    seedUploadHappyPath();

    await uploadFile("photo.jpg");

    expect(mocks.bufferLengthsWhenSealing.every((length) => length === 0)).toBe(true);
    expectEveryCheckBufferDetached();
  });

  it.each(imageCases)("detaches every check buffer for $name when the check reached no verdict and the upload answers 503 (#1593)", async ({ headKind }) => {
    configState.scanMode = "disabled";
    mocks.structureValid = "no_verdict";
    useImage(headKind);
    seedUploadHappyPath();

    await expect(uploadFile("photo.jpg")).rejects.toMatchObject({ code: "document_check_unavailable", status: 503 });

    expectEveryCheckBufferDetached();
  });

  it.each(imageCases)("detaches every check buffer for $name when the check refuses the upload with a 422", async ({ headKind }) => {
    configState.scanMode = "disabled";
    mocks.structureValid = false;
    useImage(headKind);
    seedUploadHappyPath();

    await expect(uploadFile("photo.jpg")).rejects.toMatchObject({ code: "document_structure_invalid", status: 422 });

    expectEveryCheckBufferDetached();
  });
});
