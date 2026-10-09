import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/app-error";
import { COST_MINOR_MAX } from "@/lib/domain";
import { encryptPortableArchive } from "@/server/portable-archive";
import { KDF_TEST_TIMEOUT_MS } from "../../scripts/process-budget.mjs";

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
  uploadItemDocument: vi.fn(async (_input: { filename: string; itemId: string }) => ({ id: "uploaded" })),
  requireMetadataWriter: vi.fn(),
  kekAvailable: true,
  loadMetadataKey: vi.fn(),
  deleteCiphertext: vi.fn(async (_storageKey: string) => undefined),
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
          return Promise.resolve([]);
        },
      }),
    };
  }

  function deleteBuilder(table: string) {
    return {
      where: () => {
        mocks.deleteCalls.push({ table });
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
  };

  return { getDb: () => fakeDb };
});

vi.mock("@/server/documents/config", () => ({
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

function encrypted(payload: unknown) {
  return encryptPortableArchive(Buffer.from(JSON.stringify(payload)), passphrase);
}

function seedHouseholdAccess() {
  queue(mocks.selectQueues, "users", [{ administrator: true, role: null }]);
}

beforeEach(() => {
  mocks.selectQueues.clear();
  mocks.insertCalls.length = 0;
  mocks.updateCalls.length = 0;
  mocks.deleteCalls.length = 0;
  mocks.uploadItemDocument.mockClear();
  mocks.deleteCiphertext.mockClear();
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
    queue(mocks.selectQueues, "households", [{ id: householdId, administrator: true, membershipUserId: null, role: "owner" }]);
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

describe("portable archive import (#1151 A2-F3, A2-S2)", () => {
  function fullArchive() {
    return encrypted({
      format: "orbit-portable-archive",
      version: 1,
      household: { name: "Home" },
      sections: [{
        id: sectionId, slug: "insurance", name: "Insurance", icon: "shield", accent: "blue",
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
});

describe("portable archive import is all-or-nothing (#1151 RANGE-R2)", () => {
  function threeDocumentArchive() {
    return encrypted({
      format: "orbit-portable-archive",
      version: 1,
      household: { name: "Home" },
      sections: [{
        id: sectionId, slug: "insurance", name: "Insurance", icon: "shield", accent: "blue",
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
    // rollBackPortableImport's own lookup of the import row it is closing:
    // the mock ignores WHERE clauses, so only the values matter, not that
    // these ids match what the real transaction generated internally.
    queue(mocks.selectQueues, "portable_archive_imports", [{
      id: "import-1", householdId, actorUserId: userId, finishedAt: null,
      createdItemIds: ["item-a", "item-b", "item-c"], createdSectionIds: ["section-a"],
    }]);
    // The documents rollback finds for those created items: only the first
    // one restored before the second failed.
    queue(mocks.selectQueues, "documents", [{ documentId: "document-a", storageKey: "storage-key-a" }]);
    // The remaining-items check for the one created section, after its items
    // are deleted: none remain, so the section is removed too.
    queue(mocks.selectQueues, "items", []);

    mocks.uploadItemDocument
      .mockResolvedValueOnce({ id: "uploaded-a" })
      .mockRejectedValueOnce(new AppError("document_malware_detected", "Orbit rejected that document because malware was detected", 422));

    await expect(importPortableArchive({ userId, householdId, archive: threeDocumentArchive(), passphrase, conflictItemIds: [] }))
      .rejects.toMatchObject({ code: "archive_import_failed" });

    // The third document was never attempted once the second failed.
    expect(mocks.uploadItemDocument).toHaveBeenCalledTimes(2);

    expect(mocks.deleteCalls.map((call) => call.table)).toEqual(expect.arrayContaining(["documents", "items", "sections"]));
    expect(mocks.deleteCiphertext).toHaveBeenCalledWith("storage-key-a");

    const rolledBackUpdate = mocks.updateCalls.find((call) => call.table === "portable_archive_imports");
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
    const completedUpdate = mocks.updateCalls.find((call) => call.table === "portable_archive_imports");
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
    // rollBackPortableImport's lookup of that same row -- nothing was
    // created by it, so rollback has nothing to delete, only to close.
    queue(mocks.selectQueues, "portable_archive_imports", [{
      id: "stale-import-1", householdId, actorUserId: userId, finishedAt: null,
      createdItemIds: [], createdSectionIds: [],
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1_000),
    }]);
    queue(mocks.selectQueues, "sections", []);
    queue(mocks.selectQueues, "items", []);

    const emptyArchive = encrypted({
      format: "orbit-portable-archive", version: 1, household: { name: "Home" },
      sections: [], items: [], documents: [],
    });

    await importPortableArchive({ userId, householdId, archive: emptyArchive, passphrase, conflictItemIds: [] });

    const outcomes = mocks.updateCalls.filter((call) => call.table === "portable_archive_imports").map((call) => (call.values as { outcome: string }).outcome);
    expect(outcomes).toEqual(["rolled_back", "completed"]);
    expect(mocks.insertCalls.some((call) => call.table === "audit_log" && (call.values as { action: string }).action === "portable_archive_import_rolled_back")).toBe(true);
  });

  it("rolls back every unfinished import a crash left open", async () => {
    queue(mocks.selectQueues, "portable_archive_imports", [{ id: "unfinished-1" }, { id: "unfinished-2" }]);
    queue(mocks.selectQueues, "portable_archive_imports", [{
      id: "unfinished-1", householdId, actorUserId: userId, finishedAt: null, createdItemIds: [], createdSectionIds: [],
    }]);
    queue(mocks.selectQueues, "portable_archive_imports", [{
      id: "unfinished-2", householdId, actorUserId: userId, finishedAt: null, createdItemIds: [], createdSectionIds: [],
    }]);

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
