import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "@/lib/app-error";
import { encryptPortableArchive } from "@/server/portable-archive";
import { PayloadScratch } from "@/server/portable-archive-payload";

/**
 * Where the decrypted archive payload is written, and what a full disk there
 * looks like to the person importing. Written from the specification:
 *  - the directory is `ORBIT_ARCHIVE_SCRATCH_DIR`, and `tmpdir()` when the
 *    variable is unset or empty (the container mounts a small tmpfs there);
 *  - ENOSPC or EDQUOT from the scratch while preview or import is writing the
 *    payload is reported as an AppError saying the archive could not be
 *    stored, never as the raw system error (which the API turns into a 500).
 *
 * Which fault each test catches on the code before the change:
 *  - "creates the file in the directory the variable names": `create` joined
 *    `tmpdir()` unconditionally, so the named directory stays empty;
 *  - "reports a full scratch ...": the raw ENOSPC/EDQUOT error escaped
 *    `withImportArchive`, so the caller got a plain Error, not an AppError.
 */

const passphrase = "correct-horse-battery-staple";
const root = mkdtempSync(join(tmpdir(), "orbit-scratch-dir-"));
const scratchDirectory = join(root, "archive-scratch");
mkdirSync(scratchDirectory, { mode: 0o700 });

const mocks = vi.hoisted(() => ({
  selectQueues: new Map<string, unknown[][]>(),
}));

function queue(table: string, rows: unknown[]) {
  const existing = mocks.selectQueues.get(table) ?? [];
  existing.push(rows);
  mocks.selectQueues.set(table, existing);
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

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
    insert: () => ({ values: () => Promise.resolve() }),
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
    delete: () => ({ where: () => Promise.resolve([]) }),
    transaction: async (fn: (tx: unknown) => unknown) => fn(fakeDb),
  };
  return { getDb: () => fakeDb };
});

vi.mock("@/server/documents/config", () => ({
  getDocumentConfig: () => ({ storageRoot: join(root, "documents"), quarantineRoot: join(root, "quarantine") }),
}));

vi.mock("@/server/documents/storage", () => ({
  openDocumentStorage: () => ({ deleteCiphertext: async () => undefined }),
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
    requireMetadataWriter: vi.fn(async () => ({
      encryptText: () => Buffer.from("enc"),
      encryptNumber: () => Buffer.from("enc"),
      referenceIndex: () => null,
    })),
  };
});

vi.mock("@/server/metadata/keys", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/metadata/keys")>();
  return { ...original, metadataCryptoAvailable: () => true, loadMetadataKey: vi.fn(async () => undefined) };
});

vi.mock("@/server/document-repository", () => ({
  readDocumentDownload: vi.fn(),
  uploadItemDocument: vi.fn(async () => ({ id: "uploaded" })),
}));

const { open } = await import("node:fs/promises");
const { previewPortableImport, importPortableArchive } = await import("./portable-archive-repository");

const userId = "39a5fac9-38cb-4178-b68a-a8d8db97ed3b";
const householdId = "66a1f3d8-b79d-47a5-92fe-a4824270aa9a";
const sectionId = "be56a287-919c-4237-ab23-e5897488e6a2";
const itemId = "26f04310-3f96-4828-94b2-f2fc693bc89e";

const archive = encryptPortableArchive(
  Buffer.from(JSON.stringify({
    format: "orbit-portable-archive",
    version: 1,
    household: { name: "Scratch home" },
    sections: [{ id: sectionId, slug: "insurance", name: "Insurance", icon: "service", accent: "blue", position: 0, visible: true, archivedAt: null }],
    items: [{ id: itemId, sectionId, title: "Policy A", subtype: null, provider: null, reference: null, currency: "GBP", status: "active" }],
    documents: [],
    documentBytes: [],
  })),
  passphrase,
);

const savedScratchDirectory = process.env.ORBIT_ARCHIVE_SCRATCH_DIR;

function restoreEnvironment() {
  if (savedScratchDirectory === undefined) delete process.env.ORBIT_ARCHIVE_SCRATCH_DIR;
  else process.env.ORBIT_ARCHIVE_SCRATCH_DIR = savedScratchDirectory;
}

beforeEach(() => {
  mocks.selectQueues.clear();
  vi.mocked(open).mockClear();
  restoreEnvironment();
});

afterAll(() => {
  restoreEnvironment();
  rmSync(root, { recursive: true, force: true });
});

describe("PayloadScratch.create chooses its directory from ORBIT_ARCHIVE_SCRATCH_DIR", () => {
  it("creates the file in the directory the variable names", async () => {
    process.env.ORBIT_ARCHIVE_SCRATCH_DIR = scratchDirectory;
    const before = readdirSync(scratchDirectory);
    const scratch = await PayloadScratch.create();
    try {
      await scratch.append(Buffer.from("payload"));
      const created = readdirSync(scratchDirectory).filter((name) => !before.includes(name));
      expect(created).toHaveLength(1);
      expect(created[0]).toMatch(/^orbit-archive-import-.*\.tmp$/u);
    } finally {
      await scratch.dispose();
    }
    expect(readdirSync(scratchDirectory)).toEqual(before);
  });

  it.each([["unset", undefined], ["empty", ""]])("uses the process temporary directory when the variable is %s", async (_label, value) => {
    if (value === undefined) delete process.env.ORBIT_ARCHIVE_SCRATCH_DIR;
    else process.env.ORBIT_ARCHIVE_SCRATCH_DIR = value;
    const scratch = await PayloadScratch.create();
    try {
      await scratch.append(Buffer.from("payload"));
      const created = readdirSync(tmpdir()).filter((name) => name.startsWith("orbit-archive-import-"));
      expect(created.length).toBeGreaterThanOrEqual(1);
    } finally {
      await scratch.dispose();
    }
  });
});

describe("a full scratch is reported as an archive that could not be stored", () => {
  function seedHousehold() {
    queue("users", [{ administrator: true, role: null }]);
    queue("portable_archive_imports", []);
    queue("sections", []);
    queue("items", []);
  }

  /** The next file opened for the payload writes nothing and fails with `code`. */
  async function scratchFailsWith(code: string) {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const real = await actual.open(...(args as Parameters<typeof actual.open>));
      vi.spyOn(real, "write").mockRejectedValueOnce(Object.assign(new Error(`${code}: scratch is full`), { code }));
      return real;
    });
  }

  const operations: Array<[string, () => Promise<unknown>]> = [
    ["preview", () => previewPortableImport(userId, householdId, archive, passphrase)],
    ["import", () => importPortableArchive({ userId, householdId, archive, passphrase, conflictItemIds: [] })],
  ];

  it.each(operations.flatMap(([name, run]) => ["ENOSPC", "EDQUOT"].map((code) => [name, code, run] as const)))(
    "%s: %s from the scratch becomes an AppError saying the archive could not be stored, not a raw error",
    async (_name, code, run) => {
      seedHousehold();
      await scratchFailsWith(code);
      const failure = await run().then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(AppError);
      expect((failure as AppError).code).not.toBe(code);
      expect((failure as AppError).message).toMatch(/could not be stored/iu);
    },
  );

  it("still reports other write failures as they are", async () => {
    seedHousehold();
    await scratchFailsWith("EIO");
    const failure = await previewPortableImport(userId, householdId, archive, passphrase).then(() => undefined, (error: unknown) => error);
    expect(failure).not.toBeInstanceOf(AppError);
    expect((failure as NodeJS.ErrnoException).code).toBe("EIO");
  });
});

