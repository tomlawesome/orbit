import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, lstatSync, rmSync, watch, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { AppError } from "@/lib/app-error";
import { decryptPortableArchive, encryptPortableArchive, PortableArchiveSealer } from "@/server/portable-archive";
import { MAX_ARCHIVE_CIPHERTEXT_CHARACTERS } from "@/server/portable-archive-limits";
import { PayloadScratch } from "@/server/portable-archive-payload";
import { KDF_TEST_TIMEOUT_MS } from "../../scripts/process-budget.mjs";
import { archiveForm, archiveStream, chunkedStream, encodeForm } from "../../tests/integration/support/portable-archive-upload";

/**
 * Preview and import of an archive decrypt to a temporary file, verify the
 * authentication tag before anything decrypted is used, and clean up (#1521).
 * The archive's format and the functions' arguments and results are unchanged.
 *
 * What these tests pin, from the specification alone:
 *  - a changed ciphertext byte, a changed tag byte, a truncated tag and a wrong
 *    passphrase are all refused as "the passphrase or archive is invalid", and
 *    nothing decrypted reaches the preview result, the database or document
 *    storage -- including when the changed byte sits near the start of a large
 *    archive, where a reader that used the data while decrypting would already
 *    have acted;
 *  - any file the operation creates is private (0600; directories closed to
 *    group and others) and none is left behind: after a success, after a tag
 *    failure, after a not-an-Orbit-archive refusal, after a refusal before any
 *    document and after a document that fails to restore;
 *  - every document's bytes reach document storage exactly (a round trip of
 *    the restored bytes and names), and the preview counts are unchanged.
 *
 * Files are watched in a sandbox that holds the process temporary directory,
 * the document storage root and the quarantine root, so the check does not
 * depend on which of the three the temporary file is written in. The archive
 * is about 40 MiB so the operation lasts long enough to be seen.
 */
vi.setConfig({ testTimeout: KDF_TEST_TIMEOUT_MS * 4 });

const passphrase = "correct-horse-battery-staple";
const MIB = 1_048_576;

const sandbox = vi.hoisted(() => ({ base: "", tmp: "", docs: "", quarantine: "" }));

const mocks = vi.hoisted(() => ({
  selectQueues: new Map<string, unknown[][]>(),
  insertCalls: [] as Array<{ table: string; values: unknown }>,
  updateCalls: [] as Array<{ table: string; values: unknown }>,
  deleteCalls: [] as Array<{ table: string }>,
  uploadItemDocument: vi.fn(async (_input: { filename: string; itemId: string; body?: unknown }) => ({ id: "uploaded" })),
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
      then: (resolve: (rows: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(mocks.selectQueues.get(table)?.shift() ?? []).then(resolve, reject),
    };
    return chain;
  }

  const fakeDb: Record<string, unknown> = {
    select: () => selectBuilder(),
    insert: (t: unknown) => ({
      values: (values: unknown) => {
        mocks.insertCalls.push({ table: getTableName(t as never), values });
        return Promise.resolve();
      },
    }),
    update: (t: unknown) => ({
      set: (values: unknown) => ({
        where: () => {
          mocks.updateCalls.push({ table: getTableName(t as never), values });
          return Promise.resolve([]);
        },
      }),
    }),
    delete: (t: unknown) => ({
      where: () => {
        mocks.deleteCalls.push({ table: getTableName(t as never) });
        return Promise.resolve([]);
      },
    }),
    transaction: async (fn: (tx: unknown) => unknown) => fn(fakeDb),
  };

  return { getDb: () => fakeDb };
});

vi.mock("@/server/documents/config", () => ({
  getDocumentConfig: () => ({ storageRoot: sandbox.docs, quarantineRoot: sandbox.quarantine }),
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
  uploadItemDocument: mocks.uploadItemDocument,
}));

const { previewPortableImport, importPortableArchive } = await import("./portable-archive-repository");

const userId = "39a5fac9-38cb-4178-b68a-a8d8db97ed3b";
const householdId = "66a1f3d8-b79d-47a5-92fe-a4824270aa9a";
const sectionId = "be56a287-919c-4237-ab23-e5897488e6a2";
const itemId = "26f04310-3f96-4828-94b2-f2fc693bc89e";

// ---------------------------------------------------------------------------
// The files the operation creates, watched from outside.

interface SeenEntry { path: string; directory: boolean; mode: number }

function walk(root: string, visit: (path: string, directory: boolean, mode: number) => void): void {
  let names: string[];
  try { names = readdirSync(root); } catch { return; }
  for (const name of names) {
    const path = join(root, name);
    let details;
    try { details = lstatSync(path); } catch { continue; }
    visit(path, details.isDirectory(), details.mode & 0o777);
    if (details.isDirectory()) walk(path, visit);
  }
}

/** Records every entry under the sandbox with the mode it had when first seen. */
function observe() {
  const before = new Set<string>();
  walk(sandbox.base, (path) => before.add(path));
  const seen = new Map<string, SeenEntry>();
  const scan = () => walk(sandbox.base, (path, directory, mode) => {
    if (!before.has(path) && !seen.has(path)) seen.set(path, { path, directory, mode });
  });
  const timer = setInterval(scan, 1);
  let watcher: FSWatcher | undefined;
  try { watcher = watch(sandbox.base, { recursive: true }, scan); } catch { /* polling alone is enough */ }
  return {
    stop() {
      clearInterval(timer);
      watcher?.close();
      scan();
      const remaining: string[] = [];
      walk(sandbox.base, (path, directory) => { if (!before.has(path) && !directory) remaining.push(relative(sandbox.base, path)); });
      const entries = [...seen.values()];
      return { files: entries.filter((entry) => !entry.directory), directories: entries.filter((entry) => entry.directory), remaining };
    },
  };
}

/** Whatever was created is private, and what is left is only what was there before (directories made for storage may stay; files may not). */
function expectPrivateAndGone(result: ReturnType<ReturnType<typeof observe>["stop"]>) {
  for (const file of result.files) {
    expect(file.mode.toString(8), `${file.path} must be created 0600`).toBe("600");
  }
  for (const directory of result.directories) {
    expect(directory.mode & 0o077, `${directory.path} must be closed to group and others`).toBe(0);
  }
  expect(result.remaining, `files left behind: ${result.remaining.join(", ")}`).toEqual([]);
}

// ---------------------------------------------------------------------------
// An archive that takes a measurable time to open.

const DOCUMENT_COUNT = 8;
const DOCUMENT_BYTES = 4 * MIB;

interface Built { archive: ReturnType<typeof encryptPortableArchive>; contents: Buffer[]; documentIds: string[] }

let built: Built;

function buildArchive(): Built {
  const contents = Array.from({ length: DOCUMENT_COUNT }, (_, index) => randomBytes(index === 0 ? 3 * 65_536 + 1 : DOCUMENT_BYTES - index));
  const documentIds = contents.map(() => randomUUID());
  const payload = {
    format: "orbit-portable-archive",
    version: 1,
    household: { name: "Streamed home" },
    sections: [{ id: sectionId, slug: "insurance", name: "Insurance", icon: "service", accent: "blue", position: 0, visible: true, archivedAt: null }],
    items: [{ id: itemId, sectionId, title: "Policy A", subtype: null, provider: null, reference: null, currency: "GBP", status: "active" }],
    documents: documentIds.map((id, index) => ({ id, itemId, displayName: `policy-${index}.pdf`, mediaType: "application/pdf", lifecycle: "available" })),
    documentBytes: documentIds.map((id, index) => ({ id, contentBase64: contents[index].toString("base64") })),
  };
  return { archive: encryptPortableArchive(Buffer.from(JSON.stringify(payload)), passphrase), contents, documentIds };
}

function withCiphertextCharChanged(archive: Built["archive"], position: number): Built["archive"] {
  const original = archive.ciphertext[position];
  const changed = original === "A" ? "B" : "A";
  return { ...archive, ciphertext: archive.ciphertext.slice(0, position) + changed + archive.ciphertext.slice(position + 1) };
}

function withTagBytes(archive: Built["archive"], keep: number): Built["archive"] {
  return { ...archive, authTag: Buffer.from(archive.authTag, "base64url").subarray(0, keep).toString("base64url") };
}

function withTagBitFlipped(archive: Built["archive"]): Built["archive"] {
  const tag = Buffer.from(archive.authTag, "base64url");
  tag[0] ^= 0x01;
  return { ...archive, authTag: tag.toString("base64url") };
}

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

const restored: Array<{ filename: string; itemId: string; bytes: Buffer }> = [];

function seedHouseholdAccess() {
  queue("users", [{ administrator: true, role: null }]);
  queue("portable_archive_imports", []);
}

function seedEmptyHousehold() {
  seedHouseholdAccess();
  queue("sections", []);
  queue("items", []);
}

const run = (action: () => Promise<unknown>) => action().then(() => undefined, (caught: unknown) => caught);

// #1566: preview and import take the archive file as a stream. Every case in
// this file is moved to that interface here, in one place; the archive object
// is serialised as `encryptPortableArchive` returns it (authTag before
// ciphertext, the order written before #1506).
const previewOf = (archive: Built["archive"] | Buffer | string, secret = passphrase) =>
  previewPortableImport(userId, householdId, archiveStream(archive), secret);
const importOf = (archive: Built["archive"] | Buffer | string, secret = passphrase) =>
  importPortableArchive({ userId, householdId, archive: archiveStream(archive), passphrase: secret, conflictItemIds: [] });

let savedTmpdir: string | undefined;

beforeAll(() => {
  savedTmpdir = process.env.TMPDIR;
  sandbox.base = mkdtempSync(join(tmpdir(), "orbit-1521-"));
  sandbox.tmp = join(sandbox.base, "tmp");
  sandbox.docs = join(sandbox.base, "documents");
  sandbox.quarantine = join(sandbox.base, "quarantine");
  for (const directory of [sandbox.tmp, sandbox.docs, sandbox.quarantine]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  process.env.TMPDIR = sandbox.tmp;
  built = buildArchive();
});

afterAll(() => {
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
  rmSync(sandbox.base, { recursive: true, force: true });
});

beforeEach(() => {
  mocks.selectQueues.clear();
  mocks.insertCalls.length = 0;
  mocks.updateCalls.length = 0;
  mocks.deleteCalls.length = 0;
  restored.length = 0;
  mocks.uploadItemDocument.mockReset();
  mocks.uploadItemDocument.mockImplementation(async (input) => {
    restored.push({ filename: input.filename, itemId: input.itemId, bytes: await drain((input as { body?: unknown }).body) });
    return { id: "uploaded" };
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

describe("a good archive is opened through a private temporary file that is removed (#1521)", () => {
  it("previews with the same counts, creating only 0600 files and leaving none behind", async () => {
    seedEmptyHousehold();
    const watcher = observe();
    const preview = await previewOf(built.archive);
    const result = watcher.stop();

    expect(preview).toMatchObject({ householdName: "Streamed home", sections: 1, items: 1, documents: DOCUMENT_COUNT, conflicts: [], documentsExcluded: false });
    expect(result.files.length, "the decrypted payload goes to a temporary file, and one was seen").toBeGreaterThanOrEqual(1);
    expectPrivateAndGone(result);
  });

  it("imports and restores every document's exact bytes and name, creating only 0600 files and leaving none behind", async () => {
    seedEmptyHousehold();
    const watcher = observe();
    const outcome = await importOf(built.archive);
    const result = watcher.stop();

    expect(outcome).toEqual({ importedItems: 1, documentsExcluded: 0 });
    expect(restored).toHaveLength(DOCUMENT_COUNT);
    for (const [index, content] of built.contents.entries()) {
      const document = restored.find((candidate) => candidate.filename === `policy-${index}.pdf`);
      expect(document, `policy-${index}.pdf was restored`).toBeDefined();
      expect(document!.itemId).not.toBe(itemId);
      expect(document!.bytes.equals(content), `policy-${index}.pdf has the exported bytes`).toBe(true);
    }
    const completed = mocks.updateCalls.find((call) => call.table === "portable_archive_imports");
    expect((completed?.values as { outcome: string }).outcome).toBe("completed");
    expect(result.files.length, "the decrypted payload goes to a temporary file, and one was seen").toBeGreaterThanOrEqual(1);
    expectPrivateAndGone(result);
  });
});

describe("nothing decrypted is used until the tag verifies (#1521)", () => {
  const refusals: Array<[string, (archive: Built["archive"]) => Built["archive"]]> = [
    ["a ciphertext character changed near the start", (archive) => withCiphertextCharChanged(archive, 40)],
    ["a ciphertext character changed in the middle", (archive) => withCiphertextCharChanged(archive, Math.floor(archive.ciphertext.length / 2))],
    ["a ciphertext character changed near the end", (archive) => withCiphertextCharChanged(archive, archive.ciphertext.length - 100)],
    ["a tag bit flipped", withTagBitFlipped],
    ["a tag cut to 8 bytes", (archive) => withTagBytes(archive, 8)],
    ["a tag cut to 15 bytes", (archive) => withTagBytes(archive, 15)],
  ];

  it.each(refusals)("refuses an import with %s: nothing reaches the database or document storage, and no file is left", async (_label, tamper) => {
    seedEmptyHousehold();
    const watcher = observe();
    const error = await run(() => importOf(tamper(built.archive)));
    const result = watcher.stop();

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "archive_passphrase_invalid", status: 422 });
    expect(mocks.uploadItemDocument).not.toHaveBeenCalled();
    expect(restored).toEqual([]);
    expect(mocks.insertCalls).toEqual([]);
    expect(mocks.updateCalls).toEqual([]);
    expectPrivateAndGone(result);
  });

  it.each(refusals)("refuses a preview with %s: no result is returned, and no file is left", async (_label, tamper) => {
    seedEmptyHousehold();
    const watcher = observe();
    const error = await run(() => previewOf(tamper(built.archive)));
    const result = watcher.stop();

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "archive_passphrase_invalid", status: 422 });
    expectPrivateAndGone(result);
  });

  it("refuses a wrong passphrase the same way, writing nothing and leaving no file", async () => {
    seedEmptyHousehold();
    const watcher = observe();
    const error = await run(() => importOf(built.archive, "an-entirely-different-passphrase"));
    const result = watcher.stop();

    expect(error).toMatchObject({ code: "archive_passphrase_invalid", status: 422 });
    expect(mocks.uploadItemDocument).not.toHaveBeenCalled();
    expect(mocks.insertCalls).toEqual([]);
    expectPrivateAndGone(result);
  });

  it("refuses an authentic payload that is not an Orbit archive, as before, and leaves no file", async () => {
    seedEmptyHousehold();
    const notOrbit = encryptPortableArchive(Buffer.from(JSON.stringify({ format: "something-else", version: 1, padding: "x".repeat(2 * MIB) })), passphrase);
    const watcher = observe();
    const error = await run(() => importOf(notOrbit));
    const result = watcher.stop();

    expect(error).toMatchObject({ code: "archive_invalid", status: 422 });
    expect(mocks.insertCalls).toEqual([]);
    expectPrivateAndGone(result);
  });
});

describe("the temporary file is removed when the import fails part-way (#1521)", () => {
  it("removes it when the second document fails to restore, after rolling back, with only 0600 files created", async () => {
    seedEmptyHousehold();
    mocks.uploadItemDocument.mockReset();
    mocks.uploadItemDocument
      .mockImplementationOnce(async (input) => {
        restored.push({ filename: input.filename, itemId: input.itemId, bytes: await drain((input as { body?: unknown }).body) });
        return { id: "uploaded" };
      })
      .mockImplementationOnce(async (input) => {
        await drain((input as { body?: unknown }).body);
        throw new AppError("document_malware_detected", "Orbit rejected that document because malware was detected", 422);
      });
    const watcher = observe();
    const error = await run(() => importOf(built.archive));
    const result = watcher.stop();

    expect(error).toMatchObject({ code: "archive_import_failed" });
    expect(mocks.uploadItemDocument).toHaveBeenCalledTimes(2);
    expect(result.files.length, "the decrypted payload goes to a temporary file, and one was seen").toBeGreaterThanOrEqual(1);
    expectPrivateAndGone(result);
  });

  it("removes it when the import is refused before any document is restored (too many sections)", async () => {
    seedHouseholdAccess();
    queue("sections", Array.from({ length: 12 }, (_, index) => ({ id: `live-${index}`, slug: `live-${index}`, archivedAt: null })));
    queue("items", []);
    const watcher = observe();
    const error = await run(() => importOf(built.archive));
    const result = watcher.stop();

    expect(error).toMatchObject({ code: "archive_sections_over_limit", status: 422 });
    expect(mocks.uploadItemDocument).not.toHaveBeenCalled();
    expect(mocks.insertCalls).toEqual([]);
    expectPrivateAndGone(result);
  });
});

// ---------------------------------------------------------------------------
// #1566 (plan in note 46292): the archive file arrives as a stream and its
// envelope is read in pieces. `ciphertext` is decoded, decrypted and written
// to the scratch as it arrives; every other field is kept. The file format is
// unchanged, and both field orders Orbit has written open.

/** The archive file exactly as today's export writes it (PortableArchiveSealer: authTag after ciphertext). */
async function sealedFile(payload: object, pieceBytes = 65_536): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sealer = new PortableArchiveSealer(passphrase, async (chunk) => { chunks.push(Buffer.from(chunk)); });
  const plaintext = Buffer.from(JSON.stringify(payload));
  for (let offset = 0; offset < plaintext.length; offset += pieceBytes) await sealer.push(plaintext.subarray(offset, offset + pieceBytes));
  await sealer.finish();
  return Buffer.concat(chunks);
}

function smallPayload(content: Buffer) {
  const documentId = randomUUID();
  return {
    format: "orbit-portable-archive",
    version: 1,
    household: { name: "Small home" },
    sections: [{ id: sectionId, slug: "insurance", name: "Insurance", icon: "service", accent: "blue", position: 0, visible: true, archivedAt: null }],
    items: [{ id: itemId, sectionId, title: "Policy A", subtype: null, provider: null, reference: null, currency: "GBP", status: "active" }],
    documents: [{ id: documentId, itemId, displayName: "small.pdf", mediaType: "application/pdf", lifecycle: "available" }],
    documentBytes: [{ id: documentId, contentBase64: content.toString("base64") }],
  };
}

const smallPreview = { householdName: "Small home", sections: 1, items: 1, documents: 1, conflicts: [], documentsExcluded: false };

describe("both field orders Orbit has written open from the stream (#1566)", () => {
  it("opens an archive written by today's export (authTag after ciphertext), and imports its document's exact bytes", async () => {
    // Catches: a reader that needs authTag before ciphertext, as slicing a held string did.
    const content = randomBytes(70_001);
    const file = await sealedFile(smallPayload(content));
    expect(file.indexOf('"ciphertext"'), "fixture: ciphertext comes first").toBeLessThan(file.indexOf('"authTag"'));

    seedEmptyHousehold();
    await expect(previewOf(file)).resolves.toMatchObject(smallPreview);

    seedEmptyHousehold();
    await expect(importOf(file)).resolves.toEqual({ importedItems: 1, documentsExcluded: 0 });
    expect(restored).toHaveLength(1);
    expect(restored[0].bytes.equals(content)).toBe(true);
  });

  it("opens an archive written by encryptPortableArchive (authTag before ciphertext)", async () => {
    // Catches: a reader that sets the tag only when it follows the ciphertext.
    const archive = encryptPortableArchive(Buffer.from(JSON.stringify(smallPayload(randomBytes(70_001)))), passphrase);
    const file = JSON.stringify(archive);
    expect(file.indexOf('"authTag"'), "fixture: authTag comes first").toBeLessThan(file.indexOf('"ciphertext"'));

    seedEmptyHousehold();
    await expect(previewOf(file)).resolves.toMatchObject(smallPreview);
  });

  it("opens a ciphertext in the standard base64 alphabet as well as base64url", async () => {
    // Catches: an alphabet check that accepts only base64url, which today's decode does not require.
    const archive = encryptPortableArchive(Buffer.from(JSON.stringify(smallPayload(randomBytes(70_001)))), passphrase);
    const standard = { ...archive, ciphertext: archive.ciphertext.replaceAll("-", "+").replaceAll("_", "/") };
    expect(standard.ciphertext, "fixture: the standard alphabet's own characters are present").toMatch(/[+/]/u);

    seedEmptyHousehold();
    await expect(previewOf(standard)).resolves.toMatchObject(smallPreview);
  });

  it.each(["salt", "iv"] as const)("refuses an archive whose %s follows the ciphertext as archive_invalid, writing nothing", async (moved) => {
    // Catches: a reader that buffers the ciphertext until the key material arrives (holding the archive whole).
    const archive = encryptPortableArchive(Buffer.from(JSON.stringify(smallPayload(randomBytes(70_001)))), passphrase);
    const { [moved]: value, ...rest } = archive;
    const file = JSON.stringify({ ...rest, [moved]: value });
    expect(file.indexOf(`"${moved}"`), `fixture: ${moved} follows the ciphertext`).toBeGreaterThan(file.indexOf('"ciphertext"'));

    seedEmptyHousehold();
    await expect(previewOf(file)).rejects.toMatchObject({ code: "archive_invalid", status: 422 });
    seedEmptyHousehold();
    await expect(importOf(file)).rejects.toMatchObject({ code: "archive_invalid", status: 422 });
    expect(mocks.uploadItemDocument).not.toHaveBeenCalled();
    expect(mocks.insertCalls).toEqual([]);
  });

  it.each([
    ["not JSON", "this is not an Orbit archive"],
    ["a JSON object that is not an archive", JSON.stringify({ hello: "world" })],
    ["a JSON array", "[1,2,3]"],
    ["an envelope with no ciphertext", JSON.stringify({ version: 1, algorithm: "aes-256-gcm", kdf: "scrypt", salt: "c2FsdA", iv: "aXY", authTag: "dGFn" })],
  ])("refuses %s as archive_invalid", async (_label, file) => {
    seedEmptyHousehold();
    await expect(previewOf(file)).rejects.toMatchObject({ code: "archive_invalid", status: 422 });
  });
});

describe("an oversized ciphertext is refused the moment it passes the limit (#1566)", () => {
  /**
   * An envelope whose ciphertext is `characters` long, produced lazily (never
   * held), with how far the reader pulled it.
   */
  function oversizedEnvelope(characters: number) {
    const head = Buffer.from(`{"version":1,"algorithm":"aes-256-gcm","kdf":"scrypt","salt":"${randomBytes(16).toString("base64url")}","iv":"${randomBytes(12).toString("base64url")}","ciphertext":"`);
    const tail = Buffer.from(`","authTag":"${randomBytes(16).toString("base64url")}"}`);
    const block = Buffer.alloc(65_536, "A");
    const stats = { pulledBytes: 0 };
    let headSent = false;
    let written = 0;
    let tailSent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        let chunk: Buffer;
        if (!headSent) { headSent = true; chunk = head; }
        else if (written < characters) {
          const size = Math.min(block.length, characters - written);
          written += size;
          chunk = block.subarray(0, size);
        } else if (!tailSent) { tailSent = true; chunk = tail; }
        else { controller.close(); return; }
        stats.pulledBytes += chunk.length;
        controller.enqueue(new Uint8Array(chunk));
      },
    }, { highWaterMark: 0 });
    return { stream, stats, limitOffset: head.length + MAX_ARCHIVE_CIPHERTEXT_CHARACTERS };
  }

  it("refuses a ciphertext one character longer than MAX_ARCHIVE_CIPHERTEXT_CHARACTERS with 413 archive_too_large", async () => {
    // Catches: no running count (the garbage would decrypt to the end and fail its tag as 422 instead), or an off-by-one count.
    const { stream } = oversizedEnvelope(MAX_ARCHIVE_CIPHERTEXT_CHARACTERS + 1);
    seedEmptyHousehold();
    await expect(previewPortableImport(userId, householdId, stream, passphrase))
      .rejects.toMatchObject({ code: "archive_too_large", status: 413 });
  }, 300_000);

  it("stops reading the file at that character, not at the end of the file", async () => {
    // Catches: a count checked only once the whole ciphertext has been read and decrypted.
    const { stream, stats, limitOffset } = oversizedEnvelope(MAX_ARCHIVE_CIPHERTEXT_CHARACTERS + 64 * MIB);
    seedEmptyHousehold();
    await expect(previewPortableImport(userId, householdId, stream, passphrase))
      .rejects.toMatchObject({ code: "archive_too_large", status: 413 });
    expect(stats.pulledBytes, "bytes of the file read before the refusal").toBeLessThanOrEqual(limitOffset + 1 + MIB);
  }, 300_000);
});

describe("the upload decrypts to the same bytes however it is split (#1566)", () => {
  /** Chunk-size runs: every size from 1 (a split at every offset) up, and seeded uneven runs up to 64 KiB. */
  function chunkRuns(): number[][] {
    let seed = 1566;
    const next = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed; };
    const uneven = Array.from({ length: 6 }, () => Array.from({ length: 40 }, () => 1 + (next() % 65_536)));
    const small = Array.from({ length: 6 }, () => Array.from({ length: 40 }, () => 1 + (next() % 97)));
    return [[1], [2], [3], [4], [5], [6], [7], [13], [64], [4_093], [65_536], ...uneven, ...small];
  }

  async function captureAppended(run: () => Promise<unknown>): Promise<Buffer> {
    const original = PayloadScratch.prototype.append;
    const captured: Buffer[] = [];
    const spy = vi.spyOn(PayloadScratch.prototype, "append").mockImplementation(async function (this: PayloadScratch, piece: Buffer) {
      captured.push(Buffer.from(piece));
      return original.call(this, piece);
    });
    try { await run(); } finally { spy.mockRestore(); }
    return Buffer.concat(captured);
  }

  it("splits of the file itself, at every offset of a base64 group and a JSON token", async () => {
    // Catches: a decode that loses the carry between 4-character groups, or a tokenizer that drops a split token.
    const file = await sealedFile(smallPayload(randomBytes(5_000)), 1_000);
    const expected = decryptPortableArchive(JSON.parse(file.toString("utf8")), passphrase);
    for (const sizes of chunkRuns()) {
      mocks.selectQueues.clear();
      seedEmptyHousehold();
      let preview: unknown;
      const decrypted = await captureAppended(async () => {
        preview = await previewPortableImport(userId, householdId, chunkedStream(file, sizes), passphrase);
      });
      expect(preview, `chunks ${sizes.slice(0, 4).join(",")}...`).toMatchObject(smallPreview);
      expect(decrypted.equals(expected), `chunks ${sizes.slice(0, 4).join(",")}...: decrypted bytes`).toBe(true);
    }
  }, 300_000);

  it("splits of the multipart upload, at every offset of the delimiter, a base64 group and a JSON token", async () => {
    // Catches: the same faults behind the multipart reader, whose file stream re-chunks what it is given.
    const { MultipartReader } = (await import("@/server/multipart-reader")) as unknown as {
      MultipartReader: new (body: ReadableStream<Uint8Array>, boundary: string, options: { maxFieldBytes: number }) => {
        fields(): Promise<Record<string, string>>;
        file(): Promise<{ name: string; stream: ReadableStream<Uint8Array> }>;
        dispose(): Promise<void>;
      };
    };
    const file = await sealedFile(smallPayload(randomBytes(5_000)), 1_000);
    const expected = decryptPortableArchive(JSON.parse(file.toString("utf8")), passphrase);
    const upload = await encodeForm(archiveForm({ householdId, passphrase }, file));
    for (const sizes of chunkRuns()) {
      mocks.selectQueues.clear();
      seedEmptyHousehold();
      const reader = new MultipartReader(chunkedStream(upload.bytes, sizes), upload.boundary, { maxFieldBytes: MIB });
      let preview: unknown;
      const decrypted = await captureAppended(async () => {
        expect(await reader.fields()).toEqual({ householdId, passphrase });
        const part = await reader.file();
        expect(part.name).toBe("archive");
        preview = await previewPortableImport(userId, householdId, part.stream, passphrase);
      });
      await reader.dispose();
      expect(preview, `chunks ${sizes.slice(0, 4).join(",")}...`).toMatchObject(smallPreview);
      expect(decrypted.equals(expected), `chunks ${sizes.slice(0, 4).join(",")}...: decrypted bytes`).toBe(true);
    }
  }, 300_000);
});
