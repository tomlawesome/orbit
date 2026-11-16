import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDocumentSealer, createDocumentUnsealer, type DocumentEncryptionContext, DocumentIntegrityError, type DocumentSealer, type DocumentUnsealer } from "./crypto";
import { LocalDocumentStorage } from "./storage";

/**
 * #1433 D14, design note §2.5 storage notes and §2.6 lines 2-3 at the
 * store: one encrypted object per page under `previews/aa/bb/<key>.bin`,
 * sealed through the stage-then-rename `sealQuarantine` path with a third
 * destination kind, "preview"; `unsealIntoBuffer` takes a `{ kind,
 * storageKey }` source; `listPreviewObjects` and `deletePreviewCiphertext`
 * serve reconciliation and purge. None of these exist yet, so the calls go
 * through a loosely typed view of the class.
 */

type PreviewStorage = {
  initialize(): Promise<void>;
  receive(body: ReadableStream<Uint8Array>, documentId: string, maximumBytes: number): Promise<{ quarantinePath: string }>;
  sealQuarantine(path: string, expected: { sizeBytes: number; contentSha256: string }, sealer: DocumentSealer, destination: { kind: string; storageKey: string }): Promise<{ ciphertextSize: number; envelope: Parameters<typeof createDocumentUnsealer>[1] }>;
  unsealIntoBuffer(source: { kind: string; storageKey: string }, expected: { ciphertextSize: number; plaintextSize: number }, unsealer: DocumentUnsealer): Promise<Buffer>;
  listPreviewObjects(shard?: string): Promise<Array<{ storageKey: string; modifiedAt: Date }>>;
  listPreviewShards(): Promise<string[]>;
  previewExists(storageKey: string): Promise<boolean>;
  deletePreviewCiphertext(storageKey: string): Promise<void>;
  createStorageKey(): string;
};

const kek = randomBytes(32);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createStorage(): Promise<{ storageRoot: string; storage: PreviewStorage }> {
  const root = await mkdtemp(join(tmpdir(), "orbit-preview-store-"));
  roots.push(root);
  const storageRoot = join(root, "documents");
  const storage = new LocalDocumentStorage(storageRoot, join(root, "quarantine")) as unknown as PreviewStorage;
  await storage.initialize();
  return { storageRoot, storage };
}

function previewContext(page: number, plaintextSize: number): DocumentEncryptionContext {
  return { documentId: randomUUID(), householdId: randomUUID(), itemId: randomUUID(), mediaType: "image/jpeg", plaintextSize, purpose: "preview", page } as unknown as DocumentEncryptionContext;
}

async function sealPreview(storage: PreviewStorage, jpeg: Buffer, context: DocumentEncryptionContext) {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(jpeg)); controller.close(); } });
  const { quarantinePath } = await storage.receive(body, context.documentId, 8 * 1024 * 1024);
  const storageKey = storage.createStorageKey();
  const sealed = await storage.sealQuarantine(
    quarantinePath,
    { sizeBytes: jpeg.length, contentSha256: createHash("sha256").update(jpeg).digest("hex") },
    createDocumentSealer(context, kek, "test-key"),
    { kind: "preview", storageKey },
  );
  return { storageKey, ...sealed };
}

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(4_000)]);

describe("kept previews in the document store (#1433 D14)", () => {
  it("initialize creates previews/ beside objects/ and staging/", async () => {
    const { storageRoot } = await createStorage();
    expect((await stat(join(storageRoot, "previews"))).isDirectory()).toBe(true);
  });

  it("a sealed page lands at previews/aa/bb/<key>.bin, and nowhere under objects/", async () => {
    const { storage, storageRoot } = await createStorage();
    const { storageKey, ciphertextSize } = await sealPreview(storage, jpeg, previewContext(1, jpeg.length));
    const object = join(storageRoot, "previews", storageKey.slice(0, 2), storageKey.slice(2, 4), `${storageKey}.bin`);
    expect((await stat(object)).size).toBe(ciphertextSize);
    expect(await readdir(join(storageRoot, "objects"), { recursive: true })).toEqual([]);
  });

  it("§2.6 line 2: unsealIntoBuffer({ kind: preview }) with the preview context gives back the JPEG", async () => {
    const { storage } = await createStorage();
    const context = previewContext(2, jpeg.length);
    const { storageKey, ciphertextSize, envelope } = await sealPreview(storage, jpeg, context);
    const plaintext = await storage.unsealIntoBuffer({ kind: "preview", storageKey }, { ciphertextSize, plaintextSize: jpeg.length }, createDocumentUnsealer(context, envelope, kek));
    expect(plaintext.equals(jpeg)).toBe(true);
  });

  it("§2.6 line 3: the stored page unsealed as another page number is DocumentIntegrityError", async () => {
    const { storage } = await createStorage();
    const context = previewContext(2, jpeg.length);
    const { storageKey, ciphertextSize, envelope } = await sealPreview(storage, jpeg, context);
    const otherPage = { ...context, page: 3 } as unknown as DocumentEncryptionContext;
    await expect(storage.unsealIntoBuffer({ kind: "preview", storageKey }, { ciphertextSize, plaintextSize: jpeg.length }, createDocumentUnsealer(otherPage, envelope, kek)))
      .rejects.toBeInstanceOf(DocumentIntegrityError);
  });

  it("D20: listPreviewObjects lists the page; deletePreviewCiphertext removes it", async () => {
    const { storage } = await createStorage();
    const { storageKey } = await sealPreview(storage, jpeg, previewContext(1, jpeg.length));
    expect((await storage.listPreviewObjects()).map((object) => object.storageKey)).toEqual([storageKey]);
    await storage.deletePreviewCiphertext(storageKey);
    expect(await storage.listPreviewObjects()).toEqual([]);
  });

  it("D20: reconciliation walks previews/ one shard at a time, in order", async () => {
    const { storage } = await createStorage();
    expect(await storage.listPreviewShards()).toEqual([]);
    const keys: string[] = [];
    for (let page = 1; page <= 3; page += 1) keys.push((await sealPreview(storage, jpeg, previewContext(page, jpeg.length))).storageKey);
    const shards = [...new Set(keys.map((key) => key.slice(0, 2)))].sort();
    expect(await storage.listPreviewShards()).toEqual(shards);
    for (const shard of shards) {
      expect((await storage.listPreviewObjects(shard)).map((object) => object.storageKey).sort())
        .toEqual(keys.filter((key) => key.startsWith(shard)).sort());
    }
    const unused = ["00", "01", "02", "03"].find((shard) => !shards.includes(shard))!;
    expect(await storage.listPreviewObjects(unused)).toEqual([]);
  });

  it("D20: refuses a shard name that is not two hex digits, so nothing outside previews/ is listed", async () => {
    const { storage } = await createStorage();
    for (const shard of ["..", "a", "abc", "AB", "../objects"]) {
      await expect(storage.listPreviewObjects(shard), shard).rejects.toThrow("Invalid preview shard");
    }
  });

  it("previewExists is true for a kept page and false once it is deleted", async () => {
    const { storage } = await createStorage();
    const { storageKey } = await sealPreview(storage, jpeg, previewContext(1, jpeg.length));
    expect(await storage.previewExists(storageKey)).toBe(true);
    await storage.deletePreviewCiphertext(storageKey);
    expect(await storage.previewExists(storageKey)).toBe(false);
  });
});
