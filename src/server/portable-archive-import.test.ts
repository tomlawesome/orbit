import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { AppError } from "@/lib/app-error";
import { COST_MINOR_MAX } from "@/lib/domain";
import { sealedArchiveFile } from "../../tests/support/sealed-archive";
import { KDF_TEST_TIMEOUT_MS } from "../../scripts/process-budget.mjs";
import { archiveStream } from "../../tests/integration/support/portable-archive-upload";

/**
 * Covers three A2 audit findings in the portable-archive import path:
 *
 * - A2-F2: a schema failure caused only by required fields coming back
 *   empty (an export taken while the metadata key was locked) must be
 *   told apart from a genuinely unsupported file.
 * - A2-F3: an archived section's `archivedAt` must survive the round trip
 *   instead of coming back live.
 * - A2-S2: a document whose bytes travelled with the archive is restored
 *   through the ordinary upload path; one whose target item was not
 *   imported is left unrestored and counted as such.
 *
 * scrypt N=16384 by design; see KDF_TEST_TIMEOUT_MS for the cost.
 */
vi.setConfig({ testTimeout: KDF_TEST_TIMEOUT_MS });

const passphrase = "correct-horse-battery-staple";

const mocks = vi.hoisted(() => ({
  selectQueues: new Map<string, unknown[][]>(),
  insertCalls: [] as Array<{ table: string; values: unknown }>,
  updateCalls: [] as Array<{ table: string; values: unknown }>,
  deleteCalls: [] as Array<{ table: string }>,
  // A staged upload the scanner passed: the import refuses anything else (#1390, #1605 RANGE-R2/2).
  uploadItemDocument: vi.fn(async (_input: { filename: string; itemId: string }) => ({ id: "uploaded", lifecycle: "available", scanStatus: "clean" })),
  documentMaxBytesCeiling: 100 * 1_048_576,
  requireMetadataWriter: vi.fn(),
  kekAvailable: true,
  loadMetadataKey: vi.fn(),
  deleteCiphertext: vi.fn(async (_storageKey: string) => undefined),
  raiseAdminAlert: vi.fn(async (_alert: unknown) => undefined),
  /** 1-based positions of `update` calls that throw, counted from the start of a case (#1421). */
  failUpdates: [] as number[],
  /** 1-based positions of `update` calls that touch 0 rows: the lease read as lost (#1390). */
  zeroUpdates: [] as number[],
  /** Makes every `delete` throw (#1421: the cleanup after a lost lease failing). */
  failDeletes: false,
  updateCount: 0,
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
      orderBy: () => chain,
      then: (resolve: (rows: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(nextRows(mocks.selectQueues, table)).then(resolve, reject),
      // The switch's idempotent-commit look ends in `.catch` (#1390).
      catch: (reject: (reason: unknown) => unknown) => Promise.resolve(nextRows(mocks.selectQueues, table)).catch(reject),
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

  function updateBuilder(table: string) {
    return {
      set: (v: unknown) => ({
        where: () => {
          mocks.updateCalls.push({ table, values: v });
          mocks.updateCount++;
          if (mocks.failUpdates.includes(mocks.updateCount)) return Promise.reject(new Error("write failed"));
          if (mocks.zeroUpdates.includes(mocks.updateCount)) return Promise.resolve({ count: 0 });
          return Promise.resolve([]);
        },
      }),
    };
  }

  function deleteBuilder(table: string) {
    return {
      where: () => {
        mocks.deleteCalls.push({ table });
        if (mocks.failDeletes) return Promise.reject(new Error("delete failed"));
        return Promise.resolve([]);
      },
    };
  }

  const fakeDb: Record<string, unknown> = {
    select: () => selectBuilder(),
    insert: (t: unknown) => insertBuilder(getTableName(t as never)),
    update: (t: unknown) => updateBuilder(getTableName(t as never)),
    delete: (t: unknown) => deleteBuilder(getTableName(t as never)),
    transaction: async (fn: (tx: unknown) => unknown) => fn(fakeDb),
    // The household owner lock a rollback takes itself (#1605 RANGE-R2/1).
    execute: async () => [],
  };

  return { getDb: () => fakeDb };
});

vi.mock("@/server/documents/config", () => ({
  // Read live, so a test can lower it to show the restore bound is capped by it.
  get DOCUMENT_MAX_BYTES_CEILING() { return mocks.documentMaxBytesCeiling; },
  getDocumentConfig: () => ({ storageRoot: "/test-document-storage", quarantineRoot: "/test-document-quarantine" }),
}));

vi.mock("@/server/documents/storage", () => ({
  openDocumentStorage: () => ({
    deleteCiphertext: (storageKey: string) => mocks.deleteCiphertext(storageKey),
  }),
}));

// The real household gate runs against the fake database (its answer is the
// `users` rows queued below); only the advisory-lock transaction step is stubbed.
vi.mock("@/server/workspace-access", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/workspace-access")>(),
  acquireActiveHouseholdLock: vi.fn(async () => undefined),
}));

vi.mock("@/server/metadata/fields", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/metadata/fields")>();
  return {
    MetadataCipher: original.MetadataCipher,
    openMetadataReader: async () => new original.MetadataCipher(undefined),
    requireMetadataWriter: mocks.requireMetadataWriter,
  };
});

vi.mock("@/server/metadata/keys", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/metadata/keys")>();
  return {
    ...original,
    metadataCryptoAvailable: () => mocks.kekAvailable,
    loadMetadataKey: mocks.loadMetadataKey,
  };
});

vi.mock("@/server/admin-alert", () => ({ raiseAdminAlert: mocks.raiseAdminAlert }));

vi.mock("@/server/document-repository", () => ({
  readDocumentDownload: vi.fn(),
  uploadItemDocument: mocks.uploadItemDocument,
}));

const {
  previewPortableImport,
  importPortableArchive,
  createPortableArchive,
  rollBackPortableImport,
  rollBackUnfinishedPortableImports,
  rollBackStaleUnfinishedPortableImports,
} = await import("./portable-archive-repository");

const userId = "39a5fac9-38cb-4178-b68a-a8d8db97ed3b";
const householdId = "66a1f3d8-b79d-47a5-92fe-a4824270aa9a";
const sectionId = "be56a287-919c-4237-ab23-e5897488e6a2";
const item1Id = "26f04310-3f96-4828-94b2-f2fc693bc89e";
const item2Id = "7fbbdc92-9e4b-4b98-9cfc-d6043a91f0d8";
const item3Id = "9a7a9d84-6cb0-4c3b-9b64-1f4f3e9b9b2a";
const doc1Id = "d8ae2faf-babd-4035-ba11-63ed9deb84d0";
const doc2Id = "7112fcd4-6865-4bf4-a7c0-acb2e38edbd3";
const doc3Id = "0b6c6f2b-6f0a-4b36-9f8b-3e9f9e0f9c2a";
const orphanSectionId = "f71d534e-156f-414c-91cc-9c60f155f6e1";

/** The archive file as preview and import take it since #1566: a stream, read once. */
function encrypted(payload: unknown) {
  // Sealed on the first read, so callers stay synchronous and the stream is still read once.
  const plaintext = Buffer.from(JSON.stringify(payload));
  let source: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      source ??= archiveStream(await sealedArchiveFile(plaintext, passphrase)).getReader();
      const next = await source.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
  }, { highWaterMark: 0 });
}

function seedHouseholdAccess() {
  queue(mocks.selectQueues, "users", [{ administrator: true, role: null }]);
  // The gate's own look for an import running in the household (#1316): none.
  queue(mocks.selectQueues, "portable_archive_imports", []);
}

beforeEach(() => {
  mocks.selectQueues.clear();
  mocks.insertCalls.length = 0;
  mocks.updateCalls.length = 0;
  mocks.deleteCalls.length = 0;
  mocks.uploadItemDocument.mockClear();
  mocks.deleteCiphertext.mockClear();
  mocks.raiseAdminAlert.mockClear();
  mocks.failUpdates = [];
  mocks.zeroUpdates = [];
  mocks.failDeletes = false;
  mocks.updateCount = 0;
  mocks.requireMetadataWriter.mockReset();
  mocks.requireMetadataWriter.mockResolvedValue({
    encryptText: () => Buffer.from("enc"),
    encryptNumber: () => Buffer.from("enc"),
    referenceIndex: () => null,
  });
  mocks.kekAvailable = true;
  mocks.loadMetadataKey.mockReset();
  /* No key minted for the household: nothing of its was ever encrypted, so
     its plaintext rows export as they are. */
  mocks.loadMetadataKey.mockResolvedValue(undefined);
});

describe("portable archive export refusal (#1151 A2-F2)", () => {
  it("refuses to export while the metadata key is locked, rather than writing blank titles", async () => {
    queue(mocks.selectQueues, "users", [{ administrator: true, role: "owner" }]);
    queue(mocks.selectQueues, "households", [{ id: householdId, name: "Home", timezone: "Europe/London", defaultCurrency: "GBP" }]);
    queue(mocks.selectQueues, "sections", []);
    queue(mocks.selectQueues, "items", []);
    queue(mocks.selectQueues, "due_events", []);
    queue(mocks.selectQueues, "reminder_rules", []);
    queue(mocks.selectQueues, "documents", []);
    mocks.kekAvailable = false;

    let caught: unknown;
    try {
      await createPortableArchive({ userId, householdId, passphrase, includeDocuments: false });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("archive_metadata_locked");
  });

  it("refuses when no key row exists but a row still carries ciphertext", async () => {
    queue(mocks.selectQueues, "users", [{ administrator: true, role: "owner" }]);
    queue(mocks.selectQueues, "households", [{ id: householdId, name: "Home", timezone: "Europe/London", defaultCurrency: "GBP" }]);
    queue(mocks.selectQueues, "sections", []);
    queue(mocks.selectQueues, "items", [{ id: "item-1", sectionId: "section-1", title: null, titleEnc: Buffer.from("enc"), provider: null, providerEnc: null, reference: null, referenceEnc: null, notes: null, notesEnc: null, costMinor: null, costMinorEnc: null }]);
    queue(mocks.selectQueues, "due_events", []);
    queue(mocks.selectQueues, "reminder_rules", []);
    queue(mocks.selectQueues, "documents", []);

    await expect(createPortableArchive({ userId, householdId, passphrase, includeDocuments: false }))
      .rejects.toMatchObject({ code: "archive_metadata_locked", status: 503 });
  });

  it("refuses when the household's key exists but will not unwrap", async () => {
    queue(mocks.selectQueues, "users", [{ administrator: true, role: "owner" }]);
    queue(mocks.selectQueues, "households", [{ id: householdId, name: "Home", timezone: "Europe/London", defaultCurrency: "GBP" }]);
    queue(mocks.selectQueues, "sections", []);
    queue(mocks.selectQueues, "items", []);
    queue(mocks.selectQueues, "due_events", []);
    queue(mocks.selectQueues, "reminder_rules", []);
    queue(mocks.selectQueues, "documents", []);
    const { MetadataKeyLockedError } = await import("@/server/metadata/keys");
    mocks.loadMetadataKey.mockRejectedValueOnce(new MetadataKeyLockedError());

    await expect(createPortableArchive({ userId, householdId, passphrase, includeDocuments: false }))
      .rejects.toMatchObject({ code: "archive_metadata_locked", status: 503 });
  });
});

describe("portable archive import error (#1151 A2-F2)", () => {
  it("tells empty required fields (a locked-key export) apart from an unsupported file", async () => {
    seedHouseholdAccess();
    const archive = encrypted({
      format: "orbit-portable-archive",
      version: 1,
      household: { name: "Home" },
      sections: [],
      items: [{
        id: item1Id, sectionId, title: "", subtype: null, provider: null, reference: null,
        currency: "GBP", status: "active",
      }],
      documents: [],
    });

    let caught: unknown;
    try {
      await previewPortableImport(userId, householdId, archive, passphrase);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("archive_fields_empty");
  });

  it("still reports an unsupported file as unsupported, not as empty fields", async () => {
    seedHouseholdAccess();
    const archive = encrypted({ format: "not-an-orbit-archive", version: 1 });

    let caught: unknown;
    try {
      await previewPortableImport(userId, householdId, archive, passphrase);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("archive_invalid");
  });
});

describe("portable archive export holds the passphrase floor (#1333)", () => {
  it("refuses a passphrase of twelve UTF-16 units but six characters, in words, before reading the household", async () => {
    seedHouseholdAccess();
    await expect(createPortableArchive({ userId, householdId, passphrase: "\u{1F44D}".repeat(6), includeDocuments: false }))
      .rejects.toMatchObject({ code: "archive_passphrase_too_short", status: 422 });
  });
});

describe("portable archive import refuses what the engine would not store (#1333)", () => {
  const archiveWith = (item: Record<string, unknown>) => encrypted({
    format: "orbit-portable-archive",
    version: 1,
    household: { name: "Home" },
    sections: [{ id: sectionId, slug: "home", name: "Home", icon: "home", accent: "sage", position: 0, visible: true, archivedAt: null }],
    items: [{ id: item1Id, sectionId, title: "Boiler", subtype: null, provider: null, reference: null, currency: "GBP", status: "active", ...item }],
    documents: [],
  });
  const caught = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it.each(["startDate", "expiryDate", "renewalDate", "serviceDate", "snoozedUntil"])(
    "refuses a %s that is not a real day, in words that name the problem",
    async (field) => {
      seedHouseholdAccess();
      const error = await caught(() => previewPortableImport(userId, householdId, archiveWith({ [field]: "2026-02-31" }), passphrase));
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: "archive_date_invalid", status: 422 });
      expect((error as AppError).message).toMatch(/not a real calendar day/u);
    },
  );

  it("refuses the same on the import itself, before anything is written", async () => {
    seedHouseholdAccess();
    const error = await caught(() => importPortableArchive({
      userId, householdId, archive: archiveWith({ renewalDate: "2026-13-45" }), passphrase, conflictItemIds: [],
    }));
    expect(error).toMatchObject({ code: "archive_date_invalid", status: 422 });
    expect(mocks.insertCalls).toEqual([]);
  });

  it("refuses a currency the platform does not list as an unsupported archive", async () => {
    seedHouseholdAccess();
    const error = await caught(() => previewPortableImport(userId, householdId, archiveWith({ currency: "ZZZ" }), passphrase));
    expect(error).toMatchObject({ code: "archive_invalid", status: 422 });
  });

  it("refuses a field over a bound the item schema keeps", async () => {
    seedHouseholdAccess();
    const error = await caught(() => previewPortableImport(userId, householdId, archiveWith({ costMinor: COST_MINOR_MAX + 1 }), passphrase));
    expect(error).toMatchObject({ code: "archive_invalid", status: 422 });
  });

  it("takes an archive Orbit wrote: real days, leap day included, nulls and absences", async () => {
    seedHouseholdAccess();
    const preview = await previewPortableImport(userId, householdId, archiveWith({
      startDate: "2024-02-29", expiryDate: "2026-12-31", renewalDate: null, serviceDate: undefined, snoozedUntil: "2026-07-01", costMinor: COST_MINOR_MAX,
    }), passphrase);
    expect(preview).toBeDefined();
  });
});

describe("portable archive import keeps the household within the reader's 12 live sections (#1316)", () => {
  const liveRows = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `live-${index}`, slug: `live-${index}`, archivedAt: null }));
  const archiveWithSections = (count: number) => encrypted({
    format: "orbit-portable-archive",
    version: 1,
    household: { name: "Home" },
    sections: Array.from({ length: count }, (_, index) => ({
      id: index === 0 ? sectionId : randomUUID(), slug: `imported-${index}`, name: `Imported ${index}`, icon: "home", accent: "sage", position: index, visible: true, archivedAt: null,
    })),
    items: [{ id: item1Id, sectionId, title: "Boiler", subtype: null, provider: null, reference: null, currency: "GBP", status: "active" }],
    documents: [],
  });

  it("refuses with a 422 naming the limit before writing anything", async () => {
    seedHouseholdAccess();
    queue(mocks.selectQueues, "sections", liveRows(9));
    const error = await importPortableArchive({ userId, householdId, archive: archiveWithSections(4), passphrase, conflictItemIds: [] })
      .then(() => undefined, (caught: unknown) => caught);
    expect(error).toMatchObject({ code: "archive_sections_over_limit", status: 422 });
    expect((error as AppError).message).toContain("12");
    expect(mocks.insertCalls).toEqual([]);
  });

  it("does not count archived sections, which the reader never loads", async () => {
    seedHouseholdAccess();
    const archived = Array.from({ length: 3 }, (_, index) => ({ id: `old-${index}`, slug: `old-${index}`, archivedAt: new Date("2024-01-01T00:00:00.000Z") }));
    queue(mocks.selectQueues, "sections", [...liveRows(11), ...archived]);
    queue(mocks.selectQueues, "items", []);
    await importPortableArchive({ userId, householdId, archive: archiveWithSections(1), passphrase, conflictItemIds: [] });
    expect(mocks.insertCalls.filter((call) => call.table === "sections")).toHaveLength(1);
  });
});

describe("portable archive import (#1151 A2-F3, A2-S2)", () => {
  function fullArchive() {
    return encrypted({
      format: "orbit-portable-archive",
      version: 1,
      household: { name: "Home" },
      sections: [{
        id: sectionId, slug: "insurance", name: "Insurance", icon: "service", accent: "blue",
        position: 0, visible: true, archivedAt: "2024-01-01T00:00:00.000Z",
      }],
      items: [
        {
          id: item1Id, sectionId, title: "Policy A", subtype: null, provider: null, reference: null,
          currency: "GBP", status: "active",
        },
        // Points at a section that was not exported: this item (and its
        // document) cannot be imported.
        {
          id: item2Id, sectionId: orphanSectionId, title: "Policy B", subtype: null, provider: null,
          reference: null, currency: "GBP", status: "active",
        },
      ],
      documents: [
        { id: doc1Id, itemId: item1Id, displayName: "policy-a.pdf", mediaType: "application/pdf", lifecycle: "available" },
        { id: doc2Id, itemId: item2Id, displayName: "policy-b.pdf", mediaType: "application/pdf", lifecycle: "available" },
      ],
      documentBytes: [
        { id: doc1Id, contentBase64: Buffer.from("hello").toString("base64") },
        { id: doc2Id, contentBase64: Buffer.from("world").toString("base64") },
      ],
    });
  }

  it("carries archivedAt through to the inserted section", async () => {
    seedHouseholdAccess();
    queue(mocks.selectQueues, "sections", []); // no existing sections
    queue(mocks.selectQueues, "items", []); // existingItemTitles: no existing items

    await importPortableArchive({ userId, householdId, archive: fullArchive(), passphrase, conflictItemIds: [] });

    const sectionInsert = mocks.insertCalls.find((call) => call.table === "sections");
    const values = sectionInsert?.values as { archivedAt: Date | null };
    expect(values.archivedAt).toBeInstanceOf(Date);
    expect(values.archivedAt?.toISOString()).toBe("2024-01-01T00:00:00.000Z");
  });

  it("restores a document whose item was imported, and leaves one unrestored when its item was not", async () => {
    seedHouseholdAccess();
    queue(mocks.selectQueues, "sections", []);
    queue(mocks.selectQueues, "items", []);

    const result = await importPortableArchive({ userId, householdId, archive: fullArchive(), passphrase, conflictItemIds: [] });

    expect(mocks.uploadItemDocument).toHaveBeenCalledTimes(1);
    const call = mocks.uploadItemDocument.mock.calls[0][0];
    expect(call.filename).toBe("policy-a.pdf");
    expect(call.itemId).not.toBe(item1Id); // the new, re-generated item id, not the archive's
    // Policy B's section does not exist in this household, so it (and its
    // document) was never imported; that document is left unrestored and
    // counted, not silently claimed as included.
    expect(result.importedItems).toBe(1);
    expect(result.documentsExcluded).toBe(1);
  });

  it("#1784 FR-1: restores a document under its decoded length, capped at the hard ceiling, not under the current upload limit", async () => {
    seedHouseholdAccess();
    queue(mocks.selectQueues, "sections", []);
    queue(mocks.selectQueues, "items", []);

    await importPortableArchive({ userId, householdId, archive: fullArchive(), passphrase, conflictItemIds: [] });

    expect(mocks.uploadItemDocument).toHaveBeenCalledTimes(1);
    const call = mocks.uploadItemDocument.mock.calls[0][0] as { maxBytes?: number; declaredBytes?: number };
    // Policy A's document is "hello" in the archive.
    expect(call.maxBytes).toBe(Buffer.from("hello").length);
    expect(call.declaredBytes).toBe(call.maxBytes);
    expect(call.maxBytes).toBeLessThanOrEqual(mocks.documentMaxBytesCeiling);
  });

  it("#1784 FR-1: never passes a restore bound above the hard ceiling, however long the archive says the document is", async () => {
    seedHouseholdAccess();
    queue(mocks.selectQueues, "sections", []);
    queue(mocks.selectQueues, "items", []);
    mocks.documentMaxBytesCeiling = 3;
    try {
      await importPortableArchive({ userId, householdId, archive: fullArchive(), passphrase, conflictItemIds: [] });
    } finally {
      mocks.documentMaxBytesCeiling = 100 * 1_048_576;
    }

    const call = mocks.uploadItemDocument.mock.calls[0][0] as { maxBytes?: number; declaredBytes?: number };
    // declaredBytes still carries the true length, so storage refuses it as too large.
    expect(call.declaredBytes).toBe(Buffer.from("hello").length);
    expect(call.maxBytes).toBe(3);
  });
});

describe("portable archive import is all-or-nothing (#1151 RANGE-R2)", () => {
  function threeDocumentArchive() {
    return encrypted({
      format: "orbit-portable-archive",
      version: 1,
      household: { name: "Home" },
      sections: [{
        id: sectionId, slug: "insurance", name: "Insurance", icon: "service", accent: "blue",
        position: 0, visible: true, archivedAt: null,
      }],
      items: [
        { id: item1Id, sectionId, title: "Policy A", subtype: null, provider: null, reference: null, currency: "GBP", status: "active" },
        { id: item2Id, sectionId, title: "Policy B", subtype: null, provider: null, reference: null, currency: "GBP", status: "active" },
        { id: item3Id, sectionId, title: "Policy C", subtype: null, provider: null, reference: null, currency: "GBP", status: "active" },
      ],
      documents: [
        { id: doc1Id, itemId: item1Id, displayName: "policy-a.pdf", mediaType: "application/pdf", lifecycle: "available" },
        { id: doc2Id, itemId: item2Id, displayName: "policy-b.pdf", mediaType: "application/pdf", lifecycle: "available" },
        { id: doc3Id, itemId: item3Id, displayName: "policy-c.pdf", mediaType: "application/pdf", lifecycle: "available" },
      ],
      documentBytes: [
        { id: doc1Id, contentBase64: Buffer.from("a").toString("base64") },
        { id: doc2Id, contentBase64: Buffer.from("b").toString("base64") },
        { id: doc3Id, contentBase64: Buffer.from("c").toString("base64") },
      ],
    });
  }

  it("rolls back items, the section it created and the first document when the second of three documents fails, then throws", async () => {
    seedHouseholdAccess();
    queue(mocks.selectQueues, "sections", []); // no existing sections
    queue(mocks.selectQueues, "items", []); // existingItemTitles: no existing items
    // rollBackStaleUnfinishedPortableImport's own check at the start of the
    // import: nothing stale for this household.
    queue(mocks.selectQueues, "portable_archive_imports", []);
    // The quota check's two usage sums (household, instance) before the
    // start record (#1390): nothing stored yet.
    queue(mocks.selectQueues, "documents", [{ total: 0 }]);
    queue(mocks.selectQueues, "documents", [{ total: 0 }]);
    // rollBackPortableImport's own lookup of the import row it is closing,
    // once for the household whose owner lock it takes and once more under
    // that lock (#1605 RANGE-R2/1): the mock ignores WHERE clauses, so only
    // the values matter, not that these ids match what the real transaction
    // generated internally.
    for (let read = 0; read < 2; read += 1) {
      queue(mocks.selectQueues, "portable_archive_imports", [{
        id: "import-1", householdId, actorUserId: userId, finishedAt: null,
        createdItemIds: ["item-a", "item-b", "item-c"], createdSectionIds: ["section-a"],
      }]);
    }
    // The documents rollback finds for those created items: only the first
    // one staged before the second failed.
    queue(mocks.selectQueues, "documents", [{ documentId: "document-a", storageKey: "storage-key-a" }]);
    // The remaining-items check for the one created section, after its items
    // are deleted: none remain, so the section is removed too.
    queue(mocks.selectQueues, "items", []);

    mocks.uploadItemDocument
      .mockResolvedValueOnce({ id: "uploaded-a", lifecycle: "available", scanStatus: "clean" })
      .mockRejectedValueOnce(new AppError("document_malware_detected", "Orbit rejected that document because malware was detected", 422));

    await expect(importPortableArchive({ userId, householdId, archive: threeDocumentArchive(), passphrase, conflictItemIds: [] }))
      .rejects.toMatchObject({ code: "archive_import_failed" });

    // The third document was never attempted once the second failed.
    expect(mocks.uploadItemDocument).toHaveBeenCalledTimes(2);

    expect(mocks.deleteCalls.map((call) => call.table)).toEqual(expect.arrayContaining(["documents", "items", "sections"]));
    expect(mocks.deleteCiphertext).toHaveBeenCalledWith("storage-key-a");

    // The first update that closes the row; the heartbeats before it only renew the lease (#1390).
    const rolledBackUpdate = mocks.updateCalls.find((call) => call.table === "portable_archive_imports" && "outcome" in (call.values as object));
    expect((rolledBackUpdate?.values as { outcome: string }).outcome).toBe("rolled_back");

    const rolledBackAudit = mocks.insertCalls.find((call) => call.table === "audit_log" && (call.values as { action: string }).action === "portable_archive_import_rolled_back");
    expect(rolledBackAudit).toBeDefined();
    expect((rolledBackAudit?.values as { changes: { itemsRemoved: number; sectionsRemoved: number; documentsRemoved: number } }).changes).toEqual({
      itemsRemoved: 3, sectionsRemoved: 1, documentsRemoved: 1,
    });
  });

  it("marks the import row completed once every document restores", async () => {
    seedHouseholdAccess();
    queue(mocks.selectQueues, "sections", []);
    queue(mocks.selectQueues, "items", []);

    await importPortableArchive({ userId, householdId, archive: threeDocumentArchive(), passphrase, conflictItemIds: [] });

    expect(mocks.uploadItemDocument).toHaveBeenCalledTimes(3);
    // The update that closes the row; the heartbeats before it only renew the lease (#1390).
    const completedUpdate = mocks.updateCalls.find((call) => call.table === "portable_archive_imports" && "outcome" in (call.values as object));
    expect(completedUpdate).toBeDefined();
    const values = completedUpdate?.values as { outcome: string; finishedAt: Date };
    expect(values.outcome).toBe("completed");
    expect(values.finishedAt).toBeInstanceOf(Date);
    // Nothing was rolled back on the success path.
    expect(mocks.deleteCalls).toHaveLength(0);
  });

  it("rolls back a stale unfinished import for the same household before starting a new one", async () => {
    seedHouseholdAccess();
    // rollBackStaleUnfinishedPortableImport's own select, over an hour old.
    queue(mocks.selectQueues, "portable_archive_imports", [{ id: "stale-import-1" }]);
    // rollBackPortableImport's lookup of that same row, before and under
    // the owner lock -- nothing was created by it, so rollback has nothing
    // to delete, only to close.
    for (let read = 0; read < 2; read += 1) {
      queue(mocks.selectQueues, "portable_archive_imports", [{
        id: "stale-import-1", householdId, actorUserId: userId, finishedAt: null,
        createdItemIds: [], createdSectionIds: [],
        startedAt: new Date(Date.now() - 2 * 60 * 60 * 1_000),
      }]);
    }
    queue(mocks.selectQueues, "sections", []);
    queue(mocks.selectQueues, "items", []);

    const emptyArchive = encrypted({
      format: "orbit-portable-archive", version: 1, household: { name: "Home" },
      sections: [], items: [], documents: [],
    });

    await importPortableArchive({ userId, householdId, archive: emptyArchive, passphrase, conflictItemIds: [] });

    const outcomes = mocks.updateCalls.filter((call) => call.table === "portable_archive_imports" && "outcome" in (call.values as object)).map((call) => (call.values as { outcome: string }).outcome);
    expect(outcomes).toEqual(["rolled_back", "completed"]);
    expect(mocks.insertCalls.some((call) => call.table === "audit_log" && (call.values as { action: string }).action === "portable_archive_import_rolled_back")).toBe(true);
  });

  it("rolls back every unfinished import a crash left open", async () => {
    queue(mocks.selectQueues, "portable_archive_imports", [{ id: "unfinished-1" }, { id: "unfinished-2" }]);
    // Each row is read twice: for its household's owner lock, then under it.
    for (const id of ["unfinished-1", "unfinished-1", "unfinished-2", "unfinished-2"]) {
      queue(mocks.selectQueues, "portable_archive_imports", [{
        id, householdId, actorUserId: userId, finishedAt: null, createdItemIds: [], createdSectionIds: [],
      }]);
    }

    await rollBackUnfinishedPortableImports();

    const rolledBack = mocks.updateCalls.filter((call) => call.table === "portable_archive_imports" && (call.values as { outcome: string }).outcome === "rolled_back");
    expect(rolledBack).toHaveLength(2);
    const audits = mocks.insertCalls.filter((call) => call.table === "audit_log" && (call.values as { action: string }).action === "portable_archive_import_rolled_back");
    expect(audits).toHaveLength(2);
  });

  it("is a no-op when the import row is missing or already finished", async () => {
    queue(mocks.selectQueues, "portable_archive_imports", []);
    await expect(rollBackPortableImport("missing-import")).resolves.toBeUndefined();
    expect(mocks.deleteCalls).toHaveLength(0);
    expect(mocks.updateCalls).toHaveLength(0);
  });
});

describe("an import whose undo fails tells the administrators (#1421, on #1390's flow)", () => {
  const importRow = {
    id: "import-1", householdId, actorUserId: userId, finishedAt: null,
    createdItemIds: [], createdSectionIds: [],
  };
  // #1390's own sentence, as the member reads it now: no "administrator has been notified".
  const tidySentence = "Orbit couldn't finish tidying up yet. The household stays closed to other members for up to an hour while Orbit finishes; then try the import again.";
  const malware = () => new AppError("document_malware_detected", "Orbit rejected that document because malware was detected", 422);

  function oneDocumentArchive() {
    return encrypted({
      format: "orbit-portable-archive",
      version: 1,
      household: { name: "Harlow" },
      sections: [{
        id: sectionId, slug: "insurance", name: "Insurance", icon: "service", accent: "blue",
        position: 0, visible: true, archivedAt: null,
      }],
      items: [{ id: item1Id, sectionId, title: "Policy A", subtype: null, provider: null, reference: null, currency: "GBP", status: "active" }],
      documents: [{ id: doc1Id, itemId: item1Id, displayName: "policy-a.pdf", mediaType: "application/pdf", lifecycle: "available" }],
      documentBytes: [{ id: doc1Id, contentBase64: Buffer.from("a").toString("base64") }],
    });
  }

  const runImport = () => importPortableArchive({ userId, householdId, archive: oneDocumentArchive(), passphrase, conflictItemIds: [] });

  /** Household gate, the sweep for this household's stale imports (none), then the plan's reads. */
  function seedImport() {
    seedHouseholdAccess();
    queue(mocks.selectQueues, "sections", []);
    queue(mocks.selectQueues, "items", []);
    queue(mocks.selectQueues, "portable_archive_imports", []); // nothing stale
  }

  /** The undo's own two looks at the import row: before and under the owner lock. */
  function seedUndoLooks() {
    for (let read = 0; read < 2; read += 1) queue(mocks.selectQueues, "portable_archive_imports", [importRow]);
  }

  /**
   * Update calls in the request, in order: 1 the heartbeat after the document,
   * 2 the bind of the staged documents, 3 the switch's closing write. When a
   * restore fails there is no heartbeat, so the undo's closing write is 1;
   * after a failed switch it is 4.
   */
  const UNDO_AFTER_RESTORE_FAILS = 1;
  const SWITCH_CLOSE = 3;
  const UNDO_AFTER_SWITCH_FAILS = 4;

  function importId(): string {
    const inserted = mocks.insertCalls.find((call) => call.table === "portable_archive_imports");
    return (inserted?.values as { id: string }).id;
  }

  const neverAnswers = () => new Promise<undefined>(() => undefined);
  const withinSeconds = <T,>(work: Promise<T>) =>
    Promise.race([work, new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 3_000))]);

  describe("point 1: a document fails to restore and the undo then fails", () => {
    function seed() {
      seedImport();
      seedUndoLooks();
      mocks.uploadItemDocument.mockRejectedValueOnce(malware());
      mocks.failUpdates = [UNDO_AFTER_RESTORE_FAILS];
    }

    it("raises import_undo_failed once, keyed by the import id", async () => {
      seed();
      await expect(runImport()).rejects.toBeDefined();
      expect(mocks.raiseAdminAlert).toHaveBeenCalledTimes(1);
      expect(mocks.raiseAdminAlert).toHaveBeenCalledWith(expect.objectContaining({ kind: "import_undo_failed", faultKey: importId() }));
    });

    it("tells the member #1390's restore-failure message, with no administrator promise", async () => {
      seed();
      const failure = await runImport().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AppError);
      expect(failure).toMatchObject({
        code: "archive_import_failed",
        status: 422,
        message: `Nothing was imported: restoring "policy-a.pdf" failed because malware was detected in that file, and ${tidySentence}`,
      });
      expect((failure as AppError).message).not.toContain("administrator");
    });

    it("does not make the member wait on the alert", async () => {
      seed();
      mocks.raiseAdminAlert.mockImplementationOnce(neverAnswers);
      const failure = await withinSeconds(runImport().catch((error: unknown) => error));
      expect(failure).toBeInstanceOf(AppError);
      expect(failure).toMatchObject({ code: "archive_import_failed" });
      expect(mocks.raiseAdminAlert).toHaveBeenCalledTimes(1);
    });
  });

  describe("point 2: the final switch fails and the undo then fails", () => {
    function seed() {
      seedImport();
      queue(mocks.selectQueues, "portable_archive_imports", []); // the idempotent-commit look: not completed
      seedUndoLooks();
      mocks.failUpdates = [SWITCH_CLOSE, UNDO_AFTER_SWITCH_FAILS];
    }

    it("raises import_undo_failed once, keyed by the import id", async () => {
      seed();
      await expect(runImport()).rejects.toBeDefined();
      expect(mocks.raiseAdminAlert).toHaveBeenCalledTimes(1);
      expect(mocks.raiseAdminAlert).toHaveBeenCalledWith(expect.objectContaining({ kind: "import_undo_failed", faultKey: importId() }));
    });

    it("tells the member #1390's tidy-failed message, with no administrator promise", async () => {
      seed();
      const failure = await runImport().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AppError);
      expect(failure).toMatchObject({
        code: "archive_import_failed",
        status: 422,
        message: `Nothing was imported, and ${tidySentence}`,
      });
      expect((failure as AppError).message).not.toContain("administrator");
    });

    it("does not make the member wait on the alert", async () => {
      seed();
      mocks.raiseAdminAlert.mockImplementationOnce(neverAnswers);
      const failure = await withinSeconds(runImport().catch((error: unknown) => error));
      expect(failure).toBeInstanceOf(AppError);
      expect(failure).toMatchObject({ code: "archive_import_failed", message: `Nothing was imported, and ${tidySentence}` });
      expect(mocks.raiseAdminAlert).toHaveBeenCalledTimes(1);
    });
  });

  it("point 3: raises for each import the start-up sweep cannot undo, and goes on to the next", async () => {
    queue(mocks.selectQueues, "portable_archive_imports", [{ id: "unfinished-1" }, { id: "unfinished-2" }]);
    // Each import is read twice: for its household's owner lock, then under it.
    for (const id of ["unfinished-1", "unfinished-1", "unfinished-2", "unfinished-2"]) {
      queue(mocks.selectQueues, "portable_archive_imports", [{ ...importRow, id }]);
    }
    mocks.failUpdates = [1]; // the first import's closing write

    await expect(rollBackUnfinishedPortableImports()).resolves.toBeUndefined();

    expect(mocks.raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(mocks.raiseAdminAlert).toHaveBeenCalledWith(expect.objectContaining({ kind: "import_undo_failed", faultKey: "unfinished-1" }));
    const rolledBack = mocks.updateCalls.filter((call) => (call.values as { outcome?: string }).outcome === "rolled_back");
    expect(rolledBack).toHaveLength(2);
  });

  it("point 3: raises once per import when the start-up sweep cannot undo either", async () => {
    queue(mocks.selectQueues, "portable_archive_imports", [{ id: "unfinished-1" }, { id: "unfinished-2" }]);
    for (const id of ["unfinished-1", "unfinished-1", "unfinished-2", "unfinished-2"]) {
      queue(mocks.selectQueues, "portable_archive_imports", [{ ...importRow, id }]);
    }
    mocks.failUpdates = [1, 2];

    await expect(rollBackUnfinishedPortableImports()).resolves.toBeUndefined();

    expect(mocks.raiseAdminAlert.mock.calls.map(([alert]) => alert)).toEqual([
      expect.objectContaining({ kind: "import_undo_failed", faultKey: "unfinished-1" }),
      expect.objectContaining({ kind: "import_undo_failed", faultKey: "unfinished-2" }),
    ]);
  });

  it("point 4: raises for each stale import the fifteen-minute sweep cannot undo, and goes on to the next", async () => {
    queue(mocks.selectQueues, "portable_archive_imports", [{ id: "stale-1" }, { id: "stale-2" }]);
    for (const id of ["stale-1", "stale-1", "stale-2", "stale-2"]) {
      queue(mocks.selectQueues, "portable_archive_imports", [{ ...importRow, id }]);
    }
    mocks.failUpdates = [1]; // the first import's closing write

    await expect(rollBackStaleUnfinishedPortableImports()).resolves.toBeUndefined();

    expect(mocks.raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(mocks.raiseAdminAlert).toHaveBeenCalledWith(expect.objectContaining({ kind: "import_undo_failed", faultKey: "stale-1" }));
    const rolledBack = mocks.updateCalls.filter((call) => (call.values as { outcome?: string }).outcome === "rolled_back");
    expect(rolledBack).toHaveLength(2);
  });

  describe("no alert", () => {
    it("when the undo succeeds after a document fails", async () => {
      seedImport();
      seedUndoLooks();
      mocks.uploadItemDocument.mockRejectedValueOnce(malware());

      await expect(runImport()).rejects.toMatchObject({
        message: 'Nothing was imported: restoring "policy-a.pdf" failed because malware was detected in that file. Fix the problem and try the import again.',
      });

      expect(mocks.raiseAdminAlert).not.toHaveBeenCalled();
    });

    it("when the final switch fails and the undo succeeds", async () => {
      seedImport();
      queue(mocks.selectQueues, "portable_archive_imports", []);
      seedUndoLooks();
      mocks.failUpdates = [SWITCH_CLOSE];

      await expect(runImport()).rejects.toMatchObject({
        message: "Nothing was imported: Orbit couldn't finish the import. Try the import again.",
      });

      expect(mocks.raiseAdminAlert).not.toHaveBeenCalled();
    });

    it("when only the cleanup after a lost lease fails: the sweep that took the row owns its undo", async () => {
      seedImport();
      queue(mocks.selectQueues, "documents", []);
      mocks.zeroUpdates = [1]; // the heartbeat touches 0 rows: the lease is lost
      mocks.failDeletes = true; // discardStagingAfterLostLease then fails

      await expect(runImport()).rejects.toMatchObject({
        code: "archive_import_failed",
        message: "Nothing was imported: the import took too long and Orbit stopped it. Try the import again.",
      });

      expect(mocks.deleteCalls.length).toBeGreaterThan(0); // the cleanup did run, and fail
      expect(mocks.raiseAdminAlert).not.toHaveBeenCalled();
    });

    it("when the start-up sweep undoes every import", async () => {
      queue(mocks.selectQueues, "portable_archive_imports", [{ id: "unfinished-1" }]);
      for (let read = 0; read < 2; read += 1) queue(mocks.selectQueues, "portable_archive_imports", [{ ...importRow, id: "unfinished-1" }]);

      await rollBackUnfinishedPortableImports();

      expect(mocks.raiseAdminAlert).not.toHaveBeenCalled();
    });

    it("when the fifteen-minute sweep undoes every import", async () => {
      queue(mocks.selectQueues, "portable_archive_imports", [{ id: "stale-1" }]);
      for (let read = 0; read < 2; read += 1) queue(mocks.selectQueues, "portable_archive_imports", [{ ...importRow, id: "stale-1" }]);

      await rollBackStaleUnfinishedPortableImports();

      expect(mocks.raiseAdminAlert).not.toHaveBeenCalled();
    });
  });
});
