import { randomUUID } from "node:crypto";
import { mkdtemp, open, readFile, readdir, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

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
  it("validates and reads quarantine content through one open handle", async () => {
    const storage = new LocalDocumentStorage("unused-objects-root", "unused-quarantine-root");
    const bytes = Buffer.from("quarantine content");
    const handle = {
      stat: vi.fn().mockResolvedValue({ isFile: () => true, size: bytes.length }),
      readFile: vi.fn().mockResolvedValue(bytes),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileHandle;
    const openMock = vi.mocked(open).mockResolvedValueOnce(handle);

    await expect(storage.readQuarantine("quarantine-path", 1_024)).resolves.toEqual(bytes);

    expect(openMock).toHaveBeenCalledWith("quarantine-path", "r");
    expect(handle.stat).toHaveBeenCalledTimes(1);
    expect(handle.readFile).toHaveBeenCalledTimes(1);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("validates and reads ciphertext through one open handle", async () => {
    const storage = new LocalDocumentStorage("objects-root", "unused-quarantine-root");
    const key = "a".repeat(64);
    const bytes = Buffer.from("ciphertext content");
    const handle = {
      stat: vi.fn().mockResolvedValue({ isFile: () => true, size: bytes.length }),
      readFile: vi.fn().mockResolvedValue(bytes),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileHandle;
    const openMock = vi.mocked(open).mockResolvedValueOnce(handle);

    await expect(storage.readCiphertext(key, 1_024)).resolves.toEqual(bytes);

    expect(openMock).toHaveBeenCalledWith(join("objects-root", "objects", "aa", "aa", `${key}.bin`), "r");
    expect(handle.stat).toHaveBeenCalledTimes(1);
    expect(handle.readFile).toHaveBeenCalledTimes(1);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

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
    const entries = await readdir(join(root, "quarantine"));
    expect(entries.filter((entry) => entry.startsWith(`${documentId}.`))).toHaveLength(0);
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
    await storage.deleteCiphertext(key);
    await expect(storage.readCiphertext(key, 1_024)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps staging ciphertext in a separate opaque namespace", async () => {
    const { storage } = await createStorage();
    const key = storage.createStorageKey();
    const ciphertext = Buffer.from("authenticated staging ciphertext");

    await storage.writeStagingCiphertext(key, ciphertext);
    expect(await storage.readStagingCiphertext(key, 1_024)).toEqual(ciphertext);
    expect(await storage.stagingExists(key)).toBe(true);
    expect(await storage.listCiphertextObjects()).toHaveLength(0);
    expect((await storage.listStagingObjects()).map((entry) => entry.storageKey)).toEqual([key]);
    await storage.deleteStagingCiphertext(key);
    expect(await storage.stagingExists(key)).toBe(false);
  });
});
