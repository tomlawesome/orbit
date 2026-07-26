import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDocumentStorage } from "./storage";

const temporaryRoots: string[] = [];

async function createStorage(): Promise<{ root: string; storage: LocalDocumentStorage }> {
  const root = await mkdtemp(join(tmpdir(), "orbit-document-storage-"));
  temporaryRoots.push(root);
  return {
    root,
    storage: new LocalDocumentStorage(join(root, "objects-root"), join(root, "quarantine")),
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local document storage", () => {
  it("streams an upload to private quarantine and verifies its declared size", async () => {
    const { storage } = await createStorage();
    const bytes = Buffer.from("%PDF-1.7\nprivate policy");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 8));
        controller.enqueue(bytes.subarray(8));
        controller.close();
      },
    });

    const received = await storage.receive(body, randomUUID(), 1_024, bytes.length);
    expect(received.sizeBytes).toBe(bytes.length);
    expect(received.leadingBytes).toEqual(bytes);
    expect(await readFile(received.quarantinePath)).toEqual(bytes);
    if (process.platform !== "win32") {
      expect((await stat(received.quarantinePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("removes partial quarantine content when the size limit is exceeded", async () => {
    const { root, storage } = await createStorage();
    const documentId = randomUUID();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(17));
        controller.close();
      },
    });

    await expect(storage.receive(body, documentId, 16)).rejects.toMatchObject({ code: "document_too_large" });
    await expect(stat(join(root, "quarantine", `${documentId}.upload`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes opaque ciphertext atomically and rejects invalid storage keys", async () => {
    const { storage } = await createStorage();
    const key = storage.createStorageKey();
    const ciphertext = Buffer.from("ciphertext only");

    await storage.writeCiphertext(key, ciphertext);
    expect(await storage.readCiphertext(key, 1_024)).toEqual(ciphertext);
    expect(await storage.ciphertextExists(key)).toBe(true);
    expect((await storage.listCiphertextObjects()).map((entry) => entry.storageKey)).toEqual([key]);
    await expect(storage.writeCiphertext("../escape", ciphertext)).rejects.toThrow("Invalid document storage key");
    await storage.deleteCiphertext(key);
    expect(await storage.ciphertextExists(key)).toBe(false);
    await expect(storage.readCiphertext(key, 1_024)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
