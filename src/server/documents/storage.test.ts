import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

import { AppError } from "../../lib/errors";
import { LocalDocumentStorage, openDocumentStorage } from "./storage";

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

  // #1316: the quarantine is a small tmpfs. When it fills, the raw ENOSPC used
  // to reach the caller as a bare Error (an unexplained 500). It must surface
  // as an AppError telling the user the upload space is busy and to retry.
  it.each(["opening the quarantine file", "writing a chunk to it"])(
    "turns a full quarantine (ENOSPC while %s) into a try-again-shortly AppError, not a raw error",
    async (stage) => {
      const { root, storage } = await createStorage();
      const documentId = randomUUID();
      const full = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      if (stage === "opening the quarantine file") {
        vi.mocked(open).mockRejectedValueOnce(full);
      } else {
        const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        vi.mocked(open).mockImplementationOnce(async (...args) => {
          const real = await actual.open(...(args as Parameters<typeof actual.open>));
          vi.spyOn(real, "write").mockRejectedValueOnce(full);
          return real;
        });
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
          controller.close();
        },
      });

      const failure = await storage.receive(body, documentId, 1_024).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AppError);
      expect((failure as AppError).message).toMatch(/busy/i);
      expect((failure as AppError).message).toMatch(/try again/i);
      expect((failure as AppError).code).not.toBe("ENOSPC");
      const entries = await readdir(join(root, "quarantine")).catch(() => [] as string[]);
      expect(entries.filter((entry) => entry.startsWith(`${documentId}.`))).toHaveLength(0);
    },
  );

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

// #1316 (PR1-10): a kill between a temporary write and its rename leaves a
// `*.tmp` file that nothing else ever names. The sweep removes the stale ones
// and must leave real content and in-flight (fresh) writes alone.
describe("sweeping abandoned temporary files (#1316 PR1-10)", () => {
  const HOUR_MS = 3_600_000;

  async function plant(path: string, ageMs: number): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "unfinished write");
    const when = new Date(Date.now() - ageMs);
    await utimes(path, when, when);
  }

  async function exists(path: string): Promise<boolean> {
    return stat(path).then(
      () => true,
      () => false,
    );
  }

  async function seed() {
    const { root, storage } = await createStorage();
    await storage.initialize();
    const objectKey = storage.createStorageKey();
    const stagingKey = storage.createStorageKey();
    await storage.writeCiphertext(objectKey, Buffer.from("real object"));
    await storage.writeStagingCiphertext(stagingKey, Buffer.from("real staging"));
    const documentId = randomUUID();
    const recoveryPath = await storage.writeQuarantineBytes(documentId, Buffer.from("real recovery"));
    const objectDir = join(root, "objects-root", "objects", objectKey.slice(0, 2), objectKey.slice(2, 4));
    const stagingDir = join(root, "objects-root", "staging");
    const quarantineDir = join(root, "quarantine");
    return { root, storage, objectKey, stagingKey, documentId, recoveryPath, objectDir, stagingDir, quarantineDir };
  }

  it("removes tmp files older than the boundary from objects, staging and quarantine, keeping real content", async () => {
    const s = await seed();
    const staleObject = join(s.objectDir, `${s.objectKey}.bin.0123456789abcdef.tmp`);
    const staleStaging = join(s.stagingDir, `${s.stagingKey}.bin.0123456789abcdef.tmp`);
    const staleRecovery = join(
      s.quarantineDir,
      `${s.documentId}.0123456789abcdef0123456789abcdef.recovery.0123456789abcdef.tmp`,
    );
    for (const path of [staleObject, staleStaging, staleRecovery]) await plant(path, 2 * HOUR_MS);
    const realUpload = join(s.quarantineDir, `${randomUUID()}.0123456789abcdef0123456789abcdef.upload`);
    await plant(realUpload, 2 * HOUR_MS);

    await s.storage.sweepTemporaryFiles(HOUR_MS);

    expect(await exists(staleObject)).toBe(false);
    expect(await exists(staleStaging)).toBe(false);
    expect(await exists(staleRecovery)).toBe(false);
    // Real content is never touched, however old.
    expect(await s.storage.readCiphertext(s.objectKey, 1_024)).toEqual(Buffer.from("real object"));
    expect(await s.storage.readStagingCiphertext(s.stagingKey, 1_024)).toEqual(Buffer.from("real staging"));
    expect(await exists(s.recoveryPath)).toBe(true);
    expect(await exists(realUpload)).toBe(true);
  });

  it("keeps a tmp file newer than the boundary, because its write may still be in flight", async () => {
    const s = await seed();
    const freshObject = join(s.objectDir, `${s.objectKey}.bin.fedcba9876543210.tmp`);
    const freshStaging = join(s.stagingDir, `${s.stagingKey}.bin.fedcba9876543210.tmp`);
    const freshRecovery = join(
      s.quarantineDir,
      `${s.documentId}.0123456789abcdef0123456789abcdef.recovery.fedcba9876543210.tmp`,
    );
    const staleObject = join(s.objectDir, `${s.objectKey}.bin.0123456789abcdef.tmp`);
    for (const path of [freshObject, freshStaging, freshRecovery]) await plant(path, 60_000);
    await plant(staleObject, 2 * HOUR_MS);

    await s.storage.sweepTemporaryFiles(HOUR_MS);

    expect(await exists(freshObject)).toBe(true);
    expect(await exists(freshStaging)).toBe(true);
    expect(await exists(freshRecovery)).toBe(true);
    expect(await exists(staleObject)).toBe(false);
  });
});

describe("openDocumentStorage (engine-27)", () => {
  it("roots the store and its quarantine where the configuration says", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbit-open-storage-"));
    temporaryRoots.push(root);
    const storage = openDocumentStorage({ storageRoot: join(root, "store"), quarantineRoot: join(root, "quarantine") });
    expect(storage).toBeInstanceOf(LocalDocumentStorage);
    await storage.initialize();
    expect((await readdir(root)).sort()).toEqual(["quarantine", "store"]);
    expect((await readdir(join(root, "store"))).sort()).toEqual(["objects", "staging"]);
  });
});
