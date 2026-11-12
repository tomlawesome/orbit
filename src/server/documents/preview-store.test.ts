import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentConfig } from "./config";
import { DocumentIntegrityError } from "./crypto";
import { LocalDocumentStorage } from "./storage";

/**
 * The kept page previews (#1433 D14-D16, D18) through preview-store.ts. The
 * database is a recording stand-in: what is under test is what the store
 * writes, which row it answers, and that it never leaves an orphaned object.
 * The sealing and the volume are the real ones.
 */

type Recorded = { values?: Record<string, unknown>; conflict?: { set: Record<string, unknown>; setWhere: unknown } };

const db = vi.hoisted(() => ({
  /** Rows answered by `select 1 from documents ... lifecycle = 'available'`. */
  live: [{ "?column?": 1 }] as unknown[],
  /** Whether the insert lands: `returning()` then answers the written row, else nothing (the conflict update did not apply). */
  lands: false,
  /** Rows the fallback select answers. */
  earlier: [] as unknown[],
  executed: [] as unknown[],
  inserts: [] as Recorded[],
  failTransaction: null as Error | null,
}));

vi.mock("@/db", () => {
  function insertBuilder() {
    const recorded: Recorded = {};
    db.inserts.push(recorded);
    const afterConflict = {
      returning: async () => (db.lands ? [{ ...recorded.values }] : []),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(undefined).then(resolve, reject),
    };
    return {
      values(values: Record<string, unknown>) {
        recorded.values = values;
        return {
          onConflictDoUpdate(conflict: { set: Record<string, unknown>; setWhere: unknown }) {
            recorded.conflict = conflict;
            return afterConflict;
          },
        };
      },
    };
  }
  function selectBuilder() {
    const chain = {
      from: () => chain,
      where: () => chain,
      limit: async () => db.earlier,
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(db.earlier).then(resolve, reject),
    };
    return chain;
  }
  const transaction = {
    async execute(query: unknown) {
      db.executed.push(query);
      return db.executed.length === 1 ? [] : db.live;
    },
    insert: insertBuilder,
    select: selectBuilder,
  };
  return {
    getDb: () => ({
      insert: insertBuilder,
      select: selectBuilder,
      async transaction(fn: (tx: typeof transaction) => Promise<unknown>) {
        if (db.failTransaction) throw db.failTransaction;
        return fn(transaction);
      },
    }),
  };
});

const { PREVIEW_RENDERER, findPreview, listPreviews, previewContextFor, readPreview, storeDrawnPreview, storeRefusedPreview } = await import("./preview-store");

const dialect = new PgDialect();
const kek = randomBytes(32);
const nextKek = randomBytes(32);
const roots: string[] = [];
const owner = { documentId: randomUUID(), householdId: randomUUID(), itemId: randomUUID() };
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(3_000)]);

function configWith(next: boolean): DocumentConfig {
  return {
    keyEncryptionKey: kek,
    keyId: "current-key",
    nextKeyEncryptionKey: next ? nextKek : null,
    nextKeyId: next ? "next-key" : null,
  } as unknown as DocumentConfig;
}

async function createStorage(): Promise<LocalDocumentStorage> {
  const root = await mkdtemp(join(tmpdir(), "orbit-preview-store-"));
  roots.push(root);
  const storage = new LocalDocumentStorage(join(root, "documents"), join(root, "quarantine"));
  await storage.initialize();
  return storage;
}

function drawn() {
  return { outcome: "drawn" as const, bytes: Buffer.from(jpeg), mediaType: "image/jpeg" as const, width: 800, height: 1131 };
}

/** The row a real insert would have answered, from what the store wrote. */
function rowFromInsert(index = 0) {
  return { ...db.inserts[index]!.values };
}

beforeEach(() => {
  db.live = [{ "?column?": 1 }];
  db.lands = false;
  db.earlier = [];
  db.executed = [];
  db.inserts = [];
  db.failTransaction = null;
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("previewContextFor (#1433 D15)", () => {
  it("binds the page to the document's own identity with purpose preview", () => {
    expect(previewContextFor(owner, 3, 1234)).toEqual({ ...owner, mediaType: "image/jpeg", plaintextSize: 1234, purpose: "preview", page: 3 });
  });
});

describe("storeDrawnPreview", () => {
  it("seals the page under the active wrapping key and records a drawn row naming it", async () => {
    const storage = await createStorage();
    db.lands = true;
    const draw = drawn();
    const answered = await storeDrawnPreview(storage, configWith(true), owner, 2, draw);
    const values = rowFromInsert();
    expect(answered).toEqual(values);
    expect(values).toMatchObject({
      documentId: owner.documentId,
      page: 2,
      status: "drawn",
      refusal: null,
      attempts: 1,
      renderer: PREVIEW_RENDERER,
      mediaType: "image/jpeg",
      width: 800,
      height: 1131,
      plaintextSize: jpeg.length,
      keyId: "next-key",
    });
    expect(await storage.previewExists(values.storageKey as string)).toBe(true);
    // The caller's bytes are left as they were.
    expect(draw.bytes.equals(jpeg)).toBe(true);
    // The check runs under the document's lock, then asks whether it is still available.
    expect(db.executed).toHaveLength(2);
    expect(dialect.sqlToQuery(db.executed[0] as never).sql).toContain("pg_advisory_xact_lock");
    expect(dialect.sqlToQuery(db.executed[1] as never).sql).toContain("lifecycle = 'available'");
  });

  it("replaces only a remembered refusal, never another drawing", async () => {
    const storage = await createStorage();
    db.lands = true;
    await storeDrawnPreview(storage, configWith(false), owner, 1, drawn());
    const { conflict } = db.inserts[0]!;
    expect(conflict?.set).toMatchObject({ status: "drawn", refusal: null, keyId: "current-key" });
    expect(dialect.sqlToQuery(conflict!.setWhere as never).sql).toContain("= 'refused'");
  });

  it("answers the earlier drawer's row and deletes its own object when another stored the page first", async () => {
    const storage = await createStorage();
    db.earlier = [{ storageKey: "earlier-object", status: "drawn" }];
    const answered = await storeDrawnPreview(storage, configWith(false), owner, 1, drawn());
    expect(answered).toEqual({ storageKey: "earlier-object", status: "drawn" });
    expect(await storage.previewExists(rowFromInsert().storageKey as string)).toBe(false);
    expect(await storage.listPreviewObjects()).toEqual([]);
  });

  it("stores nothing and leaves no object when the document is no longer available", async () => {
    const storage = await createStorage();
    db.live = [];
    expect(await storeDrawnPreview(storage, configWith(false), owner, 1, drawn())).toBeUndefined();
    expect(db.inserts).toEqual([]);
    expect(await storage.listPreviewObjects()).toEqual([]);
  });

  it("deletes its object again and rethrows when the transaction fails", async () => {
    const storage = await createStorage();
    db.failTransaction = new Error("connection lost");
    await expect(storeDrawnPreview(storage, configWith(false), owner, 1, drawn())).rejects.toThrow("connection lost");
    expect(await storage.listPreviewObjects()).toEqual([]);
  });
});

describe("storeRefusedPreview (D18)", () => {
  it("records a first refusal as attempts 1 with no object", async () => {
    await storeRefusedPreview(owner.documentId, 4, "timeout");
    expect(db.inserts[0]!.values).toMatchObject({ documentId: owner.documentId, page: 4, status: "refused", refusal: "timeout", attempts: 1, renderer: PREVIEW_RENDERER });
    expect(db.inserts[0]!.values).not.toHaveProperty("storageKey");
  });

  it("counts a retry's refusal up with the latest reason, and leaves a drawn page drawn", async () => {
    await storeRefusedPreview(owner.documentId, 4, "memory");
    const { conflict } = db.inserts[0]!;
    expect(conflict?.set).toMatchObject({ refusal: "memory", renderer: PREVIEW_RENDERER });
    expect(dialect.sqlToQuery(conflict!.set.attempts as never).sql).toMatch(/"attempts" \+ 1/);
    expect(conflict?.set).not.toHaveProperty("status");
    expect(dialect.sqlToQuery(conflict!.setWhere as never).sql).toContain("= 'refused'");
  });
});

describe("findPreview and listPreviews", () => {
  it("answer the rows the database holds", async () => {
    db.earlier = [{ page: 1 }, { page: 2 }];
    expect(await findPreview(owner.documentId, 1)).toEqual({ page: 1 });
    expect(await listPreviews(owner.documentId)).toEqual([{ page: 1 }, { page: 2 }]);
    db.earlier = [];
    expect(await findPreview(owner.documentId, 9)).toBeUndefined();
  });
});

describe("readPreview", () => {
  async function storedRow(storage: LocalDocumentStorage, page = 2) {
    db.lands = true;
    await storeDrawnPreview(storage, configWith(false), owner, page, drawn());
    return rowFromInsert() as Parameters<typeof readPreview>[2];
  }

  it("gives back the drawn page", async () => {
    const storage = await createStorage();
    const row = await storedRow(storage);
    expect((await readPreview(storage, owner, row, kek)).equals(jpeg)).toBe(true);
  });

  it("does not open the page as another page or for another document", async () => {
    const storage = await createStorage();
    const row = await storedRow(storage);
    await expect(readPreview(storage, owner, { ...row, page: 3 }, kek)).rejects.toBeInstanceOf(DocumentIntegrityError);
    await expect(readPreview(storage, { ...owner, documentId: randomUUID() }, row, kek)).rejects.toBeInstanceOf(DocumentIntegrityError);
  });

  it("refuses a row that is not a drawn page", async () => {
    const storage = await createStorage();
    const row = await storedRow(storage);
    for (const bad of [
      { ...row, status: "refused" },
      { ...row, storageKey: null },
      { ...row, plaintextSize: null },
      { ...row, ciphertextSize: null },
    ]) {
      await expect(readPreview(storage, owner, bad, kek)).rejects.toThrow("Preview row is not a drawn page");
    }
  });
});
