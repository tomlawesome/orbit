import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KDF_TEST_TIMEOUT_MS } from "../../scripts/process-budget.mjs";
import { archiveStream, trackedBody } from "../../tests/integration/support/portable-archive-upload";
import { sha256, V2_HEADER_BYTES, V2_SEGMENT_BYTES, V2_TAG_BYTES, v2Archive, type V2Body } from "../../tests/support/portable-archive-v2";

/**
 * #1390 (design note §4, unit lines 8, 9, 11 and 12; ADR-0045): preview and
 * import of a format v2 archive through the repository, with the database
 * mocked as src/server/portable-archive-import-stream.test.ts mocks it (that
 * file's harness, copied; that file keeps the v1 cases).
 *
 * v2 files are sealed by hand from the byte layout (tests/support/portable-archive-v2.ts).
 * The manifest is the v1 payload's fields with `version: 2`, no
 * `documentBytes`, and `body: [{ id, sizeBytes, contentSha256 }]`; each
 * document entry carries the same `sizeBytes` and `contentSha256`.
 */
vi.setConfig({ testTimeout: KDF_TEST_TIMEOUT_MS * 4 });

const passphrase = "correct-horse-battery-staple";
const MIB = 1_048_576;

const sandbox = vi.hoisted(() => ({ base: "", tmp: "", docs: "", quarantine: "", scratch: "" }));

const kdf = vi.hoisted(() => ({ calls: 0 }));

function mockCrypto(actual: typeof import("node:crypto")) {
  const scrypt = (...args: unknown[]) => { kdf.calls += 1; return (actual.scrypt as (...rest: unknown[]) => unknown)(...args); };
  const scryptSync = (...args: unknown[]) => { kdf.calls += 1; return (actual.scryptSync as (...rest: unknown[]) => unknown)(...args); };
  return { ...actual, scrypt, scryptSync, default: { ...actual, scrypt, scryptSync } };
}
vi.mock("node:crypto", async (importOriginal) => mockCrypto(await importOriginal<typeof import("node:crypto")>()));
vi.mock("crypto", async (importOriginal) => mockCrypto(await importOriginal<typeof import("node:crypto")>()));

const mocks = vi.hoisted(() => ({
  selectQueues: new Map<string, unknown[][]>(),
  insertCalls: [] as Array<{ table: string; values: unknown }>,
  updateCalls: [] as Array<{ table: string; values: unknown }>,
  deleteCalls: [] as Array<{ table: string }>,
  uploadItemDocument: vi.fn(async (_input: { filename: string; itemId: string; staged?: boolean; body?: unknown }) => ({ id: "uploaded" }) as Record<string, unknown>),
  requireMetadataWriter: vi.fn(),
  loadMetadataKey: vi.fn(),
  deleteCiphertext: vi.fn(async (_storageKey: string) => undefined),
}));

function queue(table: string, rows: unknown[]) {
  const existing = mocks.selectQueues.get(table) ?? [];
  existing.push(rows);
  mocks.selectQueues.set(table, existing);
}

vi.mock("@/db", async () => {
  const { getTableName } = await import("drizzle-orm");

  function selectBuilder() {
    let table = "";
    const chain: Record<string, unknown> = {
      from(t: unknown) { table = getTableName(t as never); return chain; },
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: () => chain,
      limit: () => chain,
      orderBy: () => chain,
      groupBy: () => chain,
      for: () => chain,
      then: (resolve: (rows: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(mocks.selectQueues.get(table)?.shift() ?? []).then(resolve, reject),
    };
    return chain;
  }

  /** A write that can be awaited as it is, or carry `.returning()` / `.onConflictDoNothing()`. */
  function settled() {
    const chain: Record<string, unknown> = {
      returning: () => Promise.resolve([]),
      onConflictDoNothing: () => chain,
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve([]).then(resolve, reject),
    };
    return chain;
  }

  const fakeDb: Record<string, unknown> = {
    select: () => selectBuilder(),
    insert: (t: unknown) => ({
      values: (values: unknown) => {
        mocks.insertCalls.push({ table: getTableName(t as never), values });
        return settled();
      },
    }),
    update: (t: unknown) => ({
      set: (values: unknown) => ({
        where: () => {
          mocks.updateCalls.push({ table: getTableName(t as never), values });
          return settled();
        },
      }),
    }),
    delete: (t: unknown) => ({
      where: () => {
        mocks.deleteCalls.push({ table: getTableName(t as never) });
        return settled();
      },
    }),
    execute: () => Promise.resolve([]),
    transaction: async (fn: (tx: unknown) => unknown) => fn(fakeDb),
  };

  return { getDb: () => fakeDb };
});

vi.mock("@/server/documents/config", () => ({
  getDocumentConfig: () => ({ storageRoot: sandbox.docs, quarantineRoot: sandbox.quarantine, householdQuotaBytes: 5 * 1024 * MIB, instanceQuotaBytes: 20 * 1024 * MIB, scanMode: "disabled" }),
}));

vi.mock("@/server/documents/storage", () => ({
  openDocumentStorage: () => ({ deleteCiphertext: (storageKey: string) => mocks.deleteCiphertext(storageKey) }),
}));

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
  return { ...original, metadataCryptoAvailable: () => true, loadMetadataKey: mocks.loadMetadataKey };
});

vi.mock("@/server/document-repository", () => ({
  readDocumentDownload: vi.fn(),
  openDocumentDownload: vi.fn(),
  uploadItemDocument: mocks.uploadItemDocument,
}));

const { previewPortableImport, importPortableArchive } = await import("./portable-archive-repository");

const userId = "39a5fac9-38cb-4178-b68a-a8d8db97ed3b";
const householdId = "66a1f3d8-b79d-47a5-92fe-a4824270aa9a";
const sectionId = "be56a287-919c-4237-ab23-e5897488e6a2";
const itemId = "26f04310-3f96-4828-94b2-f2fc693bc89e";

async function drain(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  const parts: Buffer[] = [];
  if (body && typeof (body as ReadableStream).getReader === "function") {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value));
    }
  } else if (body && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function") {
    for await (const part of body as AsyncIterable<Uint8Array>) parts.push(Buffer.from(part));
  } else {
    throw new Error("unrecognised document body");
  }
  return Buffer.concat(parts);
}

const restored: Array<{ filename: string; itemId: string; staged: boolean | undefined; bytes: Buffer }> = [];
const resolvedUploads: string[] = [];

function seedEmptyHousehold() {
  queue("users", [{ administrator: true, role: null }]);
  queue("portable_archive_imports", []);
  queue("sections", []);
  queue("items", []);
}

const run = (action: () => Promise<unknown>) => action().then(() => undefined, (caught: unknown) => caught);

let savedTmpdir: string | undefined;
let savedScratch: string | undefined;

beforeAll(() => {
  savedTmpdir = process.env.TMPDIR;
  savedScratch = process.env.ORBIT_ARCHIVE_SCRATCH_DIR;
  sandbox.base = mkdtempSync(join(tmpdir(), "orbit-1390-import-"));
  sandbox.tmp = join(sandbox.base, "tmp");
  sandbox.docs = join(sandbox.base, "documents");
  sandbox.quarantine = join(sandbox.base, "quarantine");
  sandbox.scratch = join(sandbox.base, "scratch");
  for (const directory of [sandbox.tmp, sandbox.docs, sandbox.quarantine, sandbox.scratch]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  process.env.TMPDIR = sandbox.tmp;
  process.env.ORBIT_ARCHIVE_SCRATCH_DIR = sandbox.scratch;
});

afterAll(() => {
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
  if (savedScratch === undefined) delete process.env.ORBIT_ARCHIVE_SCRATCH_DIR;
  else process.env.ORBIT_ARCHIVE_SCRATCH_DIR = savedScratch;
  rmSync(sandbox.base, { recursive: true, force: true });
});

beforeEach(() => {
  kdf.calls = 0;
  mocks.selectQueues.clear();
  mocks.insertCalls.length = 0;
  mocks.updateCalls.length = 0;
  mocks.deleteCalls.length = 0;
  restored.length = 0;
  resolvedUploads.length = 0;
  mocks.uploadItemDocument.mockReset();
  mocks.uploadItemDocument.mockImplementation(async (input) => {
    restored.push({ filename: input.filename, itemId: input.itemId, staged: input.staged, bytes: await drain(input.body) });
    const id = randomUUID();
    resolvedUploads.push(id);
    return { id, lifecycle: "available", scanStatus: "clean" };
  });
  mocks.deleteCiphertext.mockClear();
  mocks.requireMetadataWriter.mockReset();
  mocks.requireMetadataWriter.mockResolvedValue({
    encryptText: () => Buffer.from("enc"),
    encryptNumber: () => Buffer.from("enc"),
    referenceIndex: () => null,
  });
  mocks.loadMetadataKey.mockReset();
  mocks.loadMetadataKey.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// A v2 archive for a one-section, one-item household with `contents` as its documents.

function manifestFor(bodies: V2Body[], overrides: { documents?: Array<Record<string, unknown>> } = {}) {
  return {
    format: "orbit-portable-archive",
    version: 2,
    exportedAt: "2026-11-07T12:00:00.000Z",
    household: { name: "Streamed home" },
    sections: [{ id: sectionId, slug: "insurance", name: "Insurance", icon: "service", accent: "blue", position: 0, visible: true, archivedAt: null }],
    items: [{ id: itemId, sectionId, title: "Policy A", subtype: null, provider: null, reference: null, currency: "GBP", status: "active" }],
    dueEvents: [],
    reminderRules: [],
    documents: overrides.documents ?? bodies.map((body, index) => ({
      id: body.id, itemId, displayName: `policy-${index}.pdf`, mediaType: "application/pdf",
      sizeBytes: body.bytes.length, contentSha256: sha256(body.bytes), lifecycle: "available",
    })),
  };
}

const bodiesOf = (sizes: number[]): V2Body[] => sizes.map((size) => ({ id: randomUUID(), bytes: randomBytes(size) }));

const previewOf = (file: Buffer | string, secret = passphrase) => previewPortableImport(userId, householdId, archiveStream(file), secret);
const importOf = (file: Buffer | string | ReadableStream<Uint8Array>, secret = passphrase) =>
  importPortableArchive({ userId, householdId, archive: file instanceof ReadableStream ? file : archiveStream(file), passphrase: secret, conflictItemIds: [] });

const itemsOrSectionsWritten = () => mocks.insertCalls.filter((call) => call.table === "items" || call.table === "sections");

// ---------------------------------------------------------------------------

describe("control: a consistent v2 archive previews and imports, staging each body's exact bytes", () => {
  it("previews with today's preview object and imports every document's bytes as a staged upload", async () => {
    // The pair for every refusal below: the same shape, consistent, is accepted.
    const bodies = bodiesOf([70_001, 2 * MIB + 3]);
    const { file } = v2Archive(manifestFor(bodies), bodies, passphrase);

    seedEmptyHousehold();
    await expect(previewOf(file)).resolves.toMatchObject({ householdName: "Streamed home", sections: 1, items: 1, documents: 2, conflicts: [], documentsExcluded: false });

    seedEmptyHousehold();
    await expect(importOf(file)).resolves.toEqual({ importedItems: 1, documentsExcluded: 0 });
    expect(restored).toHaveLength(2);
    for (const [index, body] of bodies.entries()) {
      const document = restored.find((candidate) => candidate.filename === `policy-${index}.pdf`);
      expect(document, `policy-${index}.pdf was staged`).toBeDefined();
      expect(document!.staged, "restored as a staged upload (§2.3 phase 1)").toBe(true);
      expect(document!.itemId, "sealed to a new item id, not the archive's").not.toBe(itemId);
      expect(document!.bytes.equals(body.bytes)).toBe(true);
    }
  });
});

describe("§4 line 8: a manifest that disagrees with the header or with itself is archive_invalid after the manifest, before any body is read", () => {
  /** The pulled bytes may run to the manifest's segments plus one segment of read-ahead, never into the 4 MiB body. */
  const manifestEnd = (manifestBytes: number) => V2_HEADER_BYTES + Math.ceil(manifestBytes / V2_SEGMENT_BYTES) * (V2_SEGMENT_BYTES + V2_TAG_BYTES);
  const manifestReadLimit = (manifestBytes: number) => V2_HEADER_BYTES + (Math.ceil(manifestBytes / V2_SEGMENT_BYTES) + 1) * (V2_SEGMENT_BYTES + V2_TAG_BYTES);

  const cases: Array<[string, () => { file: Buffer; manifestBytes: number }]> = [
    ["T one byte more than M + the body sizes", () => {
      const bodies = bodiesOf([4 * MIB]);
      return v2Archive(manifestFor(bodies), bodies, passphrase, { trailing: Buffer.from([0x20]) });
    }],
    ["a body[] id that names no documents[] entry", () => {
      const bodies = bodiesOf([4 * MIB]);
      const manifest = { ...manifestFor(bodies), body: [{ id: randomUUID(), sizeBytes: bodies[0].bytes.length, contentSha256: sha256(bodies[0].bytes) }] };
      return v2Archive(manifest, bodies, passphrase);
    }],
    ["a body[] size different from its documents[] entry", () => {
      const bodies = bodiesOf([4 * MIB]);
      const manifest = manifestFor(bodies);
      manifest.documents[0] = { ...manifest.documents[0], sizeBytes: bodies[0].bytes.length + 1 };
      return v2Archive(manifest, bodies, passphrase);
    }],
    ["a body[] sha256 different from its documents[] entry", () => {
      const bodies = bodiesOf([4 * MIB]);
      const manifest = manifestFor(bodies);
      manifest.documents[0] = { ...manifest.documents[0], contentSha256: "0".repeat(64) };
      return v2Archive(manifest, bodies, passphrase);
    }],
  ];

  it.each(cases)("import: refuses %s, staging nothing and starting no import", async (_label, build) => {
    // Catches a manifest cross-check skipped, or done only after the bodies were streamed.
    const { file, manifestBytes } = build();
    const tracked = trackedBody(file);
    seedEmptyHousehold();
    const error = await run(() => importOf(tracked.body));

    expect(error).toMatchObject({ code: "archive_invalid", status: 422 });
    expect(mocks.uploadItemDocument).not.toHaveBeenCalled();
    expect(mocks.insertCalls.filter((call) => call.table === "portable_archive_imports"), "no start record").toEqual([]);
    expect(itemsOrSectionsWritten()).toEqual([]);
    expect(tracked.stats.pulledBytes, "bytes of the file read before the refusal").toBeLessThanOrEqual(manifestReadLimit(manifestBytes));
    // After the manifest, not at the first byte: the refusal comes from the cross-check, so the manifest's segments were read.
    expect(tracked.stats.pulledBytes, "the manifest's segments were read").toBeGreaterThanOrEqual(manifestEnd(manifestBytes));
  });

  it.each(cases)("preview: refuses %s, after reading the manifest", async (_label, build) => {
    const { file, manifestBytes } = build();
    const tracked = trackedBody(file);
    seedEmptyHousehold();
    await expect(previewPortableImport(userId, householdId, tracked.body, passphrase)).rejects.toMatchObject({ code: "archive_invalid", status: 422 });
    expect(tracked.stats.pulledBytes, "the manifest's segments were read").toBeGreaterThanOrEqual(manifestEnd(manifestBytes));
  });
});

describe("§4 line 9: a body whose bytes hash to something else than its contentSha256 is archive_invalid, and its staged document is removed", () => {
  it("refuses the import, writes no item or section, and removes the staged document", async () => {
    // Catches the belt-and-braces hash check missing (the AEAD alone accepts these bytes: they are what was sealed).
    const bodies = bodiesOf([70_001, 300_000]);
    const manifest = manifestFor(bodies);
    const claimed = sha256(randomBytes(16));
    manifest.documents[1] = { ...manifest.documents[1], contentSha256: claimed };
    const sealed = { ...manifest, body: bodies.map((body, index) => ({ id: body.id, sizeBytes: body.bytes.length, contentSha256: index === 1 ? claimed : sha256(body.bytes) })) };
    const { file } = v2Archive(sealed, bodies, passphrase);

    seedEmptyHousehold();
    const error = await run(() => importOf(file));

    expect(error).toMatchObject({ code: "archive_invalid", status: 422 });
    expect(mocks.uploadItemDocument).toHaveBeenCalled();
    expect(itemsOrSectionsWritten(), "no item or section reaches the database").toEqual([]);
    // Every staged upload that completed is undone: its row goes (the rollback's delete on documents).
    if (resolvedUploads.length > 0) {
      expect(mocks.deleteCalls.map((call) => call.table), "the staged documents are deleted").toContain("documents");
    }
    const finished = mocks.updateCalls.filter((call) => call.table === "portable_archive_imports").map((call) => (call.values as { outcome?: string }).outcome);
    expect(finished, "the import never closes as completed").not.toContain("completed");
  });
});

describe("§4 line 11: the file's first byte picks the reader", () => {
  const v1Fixture = readFileSync(new URL("../../tests/fixtures/portable-archive-v1.json", import.meta.url));
  const fixturePassphrase = "orbit-v1-fixture-passphrase-1390";

  it("a file starting with { takes the v1 path (the committed v1 fixture previews)", async () => {
    // Pins existing behaviour: v1 files keep opening through the dispatch.
    expect(v1Fixture[0]).toBe(0x7b);
    seedEmptyHousehold();
    await expect(previewOf(v1Fixture, fixturePassphrase)).resolves.toMatchObject({ householdName: "Fixture home", sections: 1, items: 1, documents: 1 });
  });

  it("a file starting with ORBITARC takes the v2 path", async () => {
    // Catches a dispatch that sends everything to the v1 envelope reader.
    const bodies = bodiesOf([5_000]);
    const { file } = v2Archive(manifestFor(bodies), bodies, passphrase);
    expect(file.subarray(0, 8).toString("ascii")).toBe("ORBITARC");
    seedEmptyHousehold();
    await expect(previewOf(file)).resolves.toMatchObject({ householdName: "Streamed home", documents: 1 });
  });

  it.each([
    ["[", Buffer.from("[1,2,3]")],
    ["P", Buffer.from("PK\u0003\u0004 not an Orbit archive")],
    ["an empty file", Buffer.alloc(0)],
  ])("a file starting with %s is archive_invalid, with no key derivation", async (_label, file) => {
    // Pins existing behaviour for [ and P (v1 already refuses them before scrypt); the empty file and the no-scrypt rule carry over to the dispatch.
    seedEmptyHousehold();
    const previewError = await run(() => previewOf(file));
    seedEmptyHousehold();
    const importError = await run(() => importOf(file));
    expect(previewError).toMatchObject({ code: "archive_invalid", status: 422 });
    expect(importError).toMatchObject({ code: "archive_invalid", status: 422 });
    expect(kdf.calls, "scrypt calls").toBe(0);
    expect(mocks.uploadItemDocument).not.toHaveBeenCalled();
  });
});

describe("§4 line 12: a file written by a released Orbit (format v1) still opens and restores", () => {
  // tests/fixtures/portable-archive-v1.json: one tiny PDF, sealed on 2026-11-07
  // by the v1 PortableArchiveSealer as released (before #1390), passphrase below.
  const v1Fixture = readFileSync(new URL("../../tests/fixtures/portable-archive-v1.json", import.meta.url));
  const fixturePassphrase = "orbit-v1-fixture-passphrase-1390";
  const FIXTURE_PDF_BYTES = 609;
  const FIXTURE_PDF_SHA256 = "343703ed9a7c56c5e461cf4258f3e66271f92b3b320c20589f1a422923d6fe75";

  it("imports the fixture and restores its document byte for byte", async () => {
    // Pins existing behaviour: today's v1 reader opens this file; the rewrite must keep it opening.
    seedEmptyHousehold();
    await expect(importOf(v1Fixture, fixturePassphrase)).resolves.toEqual({ importedItems: 1, documentsExcluded: 0 });
    expect(restored).toHaveLength(1);
    expect(restored[0].filename).toBe("fixture-policy.pdf");
    expect(restored[0].bytes.length).toBe(FIXTURE_PDF_BYTES);
    expect(sha256(restored[0].bytes)).toBe(FIXTURE_PDF_SHA256);
    expect(restored[0].bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("refuses the fixture with one ciphertext character changed as archive_passphrase_invalid, writing nothing", async () => {
    // Pins existing behaviour: the v1 tag check survives the move to stage-then-switch.
    const archive = JSON.parse(v1Fixture.toString("utf8")) as { ciphertext: string };
    const at = Math.floor(archive.ciphertext.length / 2);
    const tampered = JSON.stringify({ ...archive, ciphertext: archive.ciphertext.slice(0, at) + (archive.ciphertext[at] === "A" ? "B" : "A") + archive.ciphertext.slice(at + 1) });
    seedEmptyHousehold();
    const error = await run(() => importOf(tampered, fixturePassphrase));
    expect(error).toMatchObject({ code: "archive_passphrase_invalid", status: 422 });
    expect(mocks.uploadItemDocument).not.toHaveBeenCalled();
    expect(mocks.insertCalls).toEqual([]);
    expect(mocks.updateCalls).toEqual([]);
  });
});
