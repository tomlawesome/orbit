import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Watches the quarantine reads (to see the read buffer), and the order of
// fsync and rename on the way to an object; everything passes through.
const watched = vi.hoisted(() => ({
  readBuffers: [] as Uint8Array[],
  events: [] as string[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
      watched.events.push("rename");
      return actual.rename(...args);
    }),
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const read = handle.read.bind(handle) as (...readArgs: unknown[]) => Promise<unknown>;
      (handle as unknown as { read: unknown }).read = (...readArgs: unknown[]) => {
        const first = readArgs[0];
        const buffer = first instanceof Uint8Array ? first : (first as { buffer?: Uint8Array } | undefined)?.buffer;
        if (buffer && !watched.readBuffers.includes(buffer)) watched.readBuffers.push(buffer);
        return read(...readArgs);
      };
      const sync = handle.sync.bind(handle);
      (handle as unknown as { sync: unknown }).sync = () => {
        watched.events.push("sync");
        return sync();
      };
      return handle;
    }),
  };
});

import { AppError } from "../../lib/errors";
import { createDocumentSealer, decryptDocument, type DocumentEncryptionContext, type DocumentSealer } from "./crypto";
import { LocalDocumentStorage } from "./storage";

/**
 * #1567: `storage.sealQuarantine(path, expected, sealer, destination)` reads the
 * quarantine file in pieces through one reusable 1 MiB buffer, hashes each
 * piece, feeds the sealer, and appends the ciphertext to a temporary file that
 * is fsynced and renamed into place; the digest must match what was received
 * or the document is refused, and nothing is left behind either way.
 */

const MIB = 1_048_576;
const kek = randomBytes(32);
const temporaryRoots: string[] = [];

afterEach(async () => {
  watched.readBuffers.length = 0;
  watched.events.length = 0;
  vi.clearAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createStorage() {
  const root = await mkdtemp(join(tmpdir(), "orbit-seal-quarantine-"));
  temporaryRoots.push(root);
  const storageRoot = join(root, "objects-root");
  const storage = new LocalDocumentStorage(storageRoot, join(root, "quarantine"));
  await storage.initialize();
  return { root, storageRoot, storage };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function contextFor(plaintext: Buffer, purpose?: "scanner_recovery"): DocumentEncryptionContext {
  return {
    documentId: randomUUID(),
    householdId: randomUUID(),
    itemId: randomUUID(),
    mediaType: "application/pdf",
    plaintextSize: plaintext.length,
    ...(purpose ? { purpose } : {}),
  };
}

/** Every regular file under `root`, relative, sorted. */
async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1)).sort();
}

/** A quarantine file as `receive` leaves one: `<id>.<hex>.upload`, owner-only. */
async function writeQuarantineFile(storage: LocalDocumentStorage, bytes: Buffer): Promise<string> {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close(); } });
  return (await storage.receive(body, randomUUID(), 8 * MIB)).quarantinePath;
}

async function quarantineFile(storage: LocalDocumentStorage, plaintext: Buffer): Promise<{ path: string; expected: { sizeBytes: number; contentSha256: string } }> {
  const path = await writeQuarantineFile(storage, plaintext);
  return { path, expected: { sizeBytes: plaintext.length, contentSha256: sha256(plaintext) } };
}

async function expectInvalidQuarantine(promise: Promise<unknown>): Promise<void> {
  const failure = await promise.then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(AppError);
  expect(failure).toMatchObject({ code: "document_quarantine_invalid", status: 422 });
}

describe("sealQuarantine (#1567)", () => {
  it.each([1, MIB, MIB + 1, 2 * MIB + 5])(
    "writes objects/aa/bb/<key>.bin for a %i byte file, atomically, with owner-only permissions and no temporary file left",
    async (size) => {
      const { storageRoot, storage } = await createStorage();
      const plaintext = randomBytes(size);
      const context = contextFor(plaintext);
      const { path, expected } = await quarantineFile(storage, plaintext);
      const key = storage.createStorageKey();

      const result = await storage.sealQuarantine(path, expected, createDocumentSealer(context, kek, "key-1"), { kind: "object", storageKey: key });
      expect(result.ciphertextSize).toBe(size);

      const file = join(storageRoot, "objects", key.slice(0, 2), key.slice(2, 4), `${key}.bin`);
      expect((await stat(file)).size).toBe(result.ciphertextSize);
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await filesUnder(storageRoot), "no temporary file is left").toEqual([join("objects", key.slice(0, 2), key.slice(2, 4), `${key}.bin`)]);
      expect((await storage.listCiphertextObjects()).map((entry) => entry.storageKey)).toEqual([key]);
      expect(await storage.listStagingObjects()).toHaveLength(0);
      expect(await stat(path), "the quarantine file is the caller's to discard").toBeDefined();
    },
    30_000,
  );

  it("decrypts to the quarantined bytes with the envelope the sealer returns", async () => {
    const { storage } = await createStorage();
    const plaintext = randomBytes(MIB + 777);
    const context = contextFor(plaintext);
    const { path, expected } = await quarantineFile(storage, plaintext);
    const key = storage.createStorageKey();
    const sealer = createDocumentSealer(context, kek, "key-1");
    const captured: { envelope?: ReturnType<DocumentSealer["final"]>["envelope"] } = {};
    const finalOf = sealer.final.bind(sealer);
    sealer.final = () => {
      const done = finalOf();
      captured.envelope = done.envelope;
      return done;
    };

    const { ciphertextSize } = await storage.sealQuarantine(path, expected, sealer, { kind: "object", storageKey: key });

    const stored = await storage.readCiphertext(key, 10 * MIB);
    expect(stored.length).toBe(ciphertextSize);
    expect(captured.envelope, "sealQuarantine finished the sealer").toBeDefined();
    expect(decryptDocument(stored, context, captured.envelope!, kek).equals(plaintext)).toBe(true);
  }, 30_000);

  it("writes staging/<key>.bin for a scanner-recovery stage, and nothing under objects/", async () => {
    const { storageRoot, storage } = await createStorage();
    const plaintext = randomBytes(MIB + 9);
    const context = contextFor(plaintext, "scanner_recovery");
    const { path, expected } = await quarantineFile(storage, plaintext);
    const key = storage.createStorageKey();
    const sealer = createDocumentSealer(context, kek, "key-1");
    const finalOf = sealer.final.bind(sealer);
    let envelope: ReturnType<DocumentSealer["final"]>["envelope"] | undefined;
    sealer.final = () => {
      const done = finalOf();
      envelope = done.envelope;
      return done;
    };

    const { ciphertextSize } = await storage.sealQuarantine(path, expected, sealer, { kind: "staging", storageKey: key });

    expect(await filesUnder(storageRoot)).toEqual([join("staging", `${key}.bin`)]);
    expect((await stat(join(storageRoot, "staging", `${key}.bin`))).size).toBe(ciphertextSize);
    expect(await storage.stagingExists(key)).toBe(true);
    expect(await storage.ciphertextExists(key)).toBe(false);
    expect(await storage.listCiphertextObjects()).toHaveLength(0);
    const stored = await readFile(join(storageRoot, "staging", `${key}.bin`));
    expect(decryptDocument(stored, context, envelope!, kek).equals(plaintext)).toBe(true);
  }, 30_000);

  it("syncs the temporary file before it renames it into place", async () => {
    const { storage } = await createStorage();
    const plaintext = randomBytes(5_000);
    const { path, expected } = await quarantineFile(storage, plaintext);
    watched.events.length = 0;

    await storage.sealQuarantine(path, expected, createDocumentSealer(contextFor(plaintext), kek, "key-1"), { kind: "object", storageKey: storage.createStorageKey() });

    expect(watched.events.filter((event) => event === "rename")).toHaveLength(1);
    expect(watched.events.indexOf("sync")).toBeGreaterThanOrEqual(0);
    expect(watched.events.indexOf("sync")).toBeLessThan(watched.events.indexOf("rename"));
  });

  describe("a quarantine file that is not what was received", () => {
    it("refuses bytes that differ from contentSha256 with document_quarantine_invalid 422, leaving nothing in objects/ or staging/", async () => {
      const { storageRoot, storage } = await createStorage();
      const plaintext = randomBytes(2 * MIB + 3);
      const { path, expected } = await quarantineFile(storage, plaintext);
      const changed = Buffer.from(plaintext);
      changed[MIB + 11] ^= 0x01;
      const otherPath = await writeQuarantineFile(storage, changed);

      for (const kind of ["object", "staging"] as const) {
        await expectInvalidQuarantine(storage.sealQuarantine(
          otherPath, expected, createDocumentSealer(contextFor(plaintext), kek, "key-1"), { kind, storageKey: storage.createStorageKey() },
        ));
      }

      expect(await filesUnder(storageRoot), "no object, no staging file, no temporary file").toEqual([]);
      expect(await storage.listCiphertextObjects()).toHaveLength(0);
      expect(await storage.listStagingObjects()).toHaveLength(0);
      expect(path).not.toBe(otherPath);
    }, 30_000);

    it.each([
      ["larger", 1],
      ["smaller", -1],
    ] as const)("refuses a file whose size is %s than sizeBytes with document_quarantine_invalid 422, leaving nothing behind", async (_which, delta) => {
      const { storageRoot, storage } = await createStorage();
      const plaintext = randomBytes(MIB + 100);
      const { path, expected } = await quarantineFile(storage, plaintext);

      await expectInvalidQuarantine(storage.sealQuarantine(
        path, { ...expected, sizeBytes: expected.sizeBytes + delta },
        createDocumentSealer(contextFor(plaintext), kek, "key-1"), { kind: "object", storageKey: storage.createStorageKey() },
      ));

      expect(await filesUnder(storageRoot)).toEqual([]);
    });

    it("refuses a path that is not a regular file with document_quarantine_invalid 422", async () => {
      const { root, storage } = await createStorage();
      const directory = join(root, "a-directory");
      await mkdir(directory);
      const plaintext = randomBytes(10);

      await expectInvalidQuarantine(storage.sealQuarantine(
        directory, { sizeBytes: plaintext.length, contentSha256: sha256(plaintext) },
        createDocumentSealer(contextFor(plaintext), kek, "key-1"), { kind: "object", storageKey: storage.createStorageKey() },
      ));
    });
  });

  describe("failures along the way", () => {
    it("removes the temporary file and writes nothing when the sealer fails mid-pass", async () => {
      const { storageRoot, storage } = await createStorage();
      const plaintext = randomBytes(3 * MIB);
      const { path, expected } = await quarantineFile(storage, plaintext);
      let calls = 0;
      const failing = {
        update: () => {
          calls += 1;
          if (calls === 2) throw new Error("synthetic sealer failure");
          return Buffer.alloc(0);
        },
        final: () => { throw new Error("final must not be reached"); },
      } as unknown as DocumentSealer;

      await expect(storage.sealQuarantine(path, expected, failing, { kind: "object", storageKey: storage.createStorageKey() }))
        .rejects.toThrow("synthetic sealer failure");

      expect(await filesUnder(storageRoot)).toEqual([]);
    });

    it("removes the temporary file when the sealer's final step fails", async () => {
      const { storageRoot, storage } = await createStorage();
      const plaintext = randomBytes(1_000);
      const { path, expected } = await quarantineFile(storage, plaintext);
      const failing = {
        update: (chunk: Buffer) => Buffer.from(chunk),
        final: () => { throw new Error("synthetic final failure"); },
      } as unknown as DocumentSealer;

      await expect(storage.sealQuarantine(path, expected, failing, { kind: "staging", storageKey: storage.createStorageKey() }))
        .rejects.toThrow("synthetic final failure");

      expect(await filesUnder(storageRoot)).toEqual([]);
    });

    it("refuses an invalid storage key, writing nothing", async () => {
      const { storageRoot, storage } = await createStorage();
      const plaintext = randomBytes(100);
      const { path, expected } = await quarantineFile(storage, plaintext);

      await expect(storage.sealQuarantine(path, expected, createDocumentSealer(contextFor(plaintext), kek, "key-1"), { kind: "object", storageKey: "../escape" }))
        .rejects.toThrow("Invalid document storage key");

      expect(await filesUnder(storageRoot)).toEqual([]);
    });
  });

  describe("the read buffer is zeroed when the pass ends (#1151 F13)", () => {
    function expectOneZeroedMebibyteBuffer(): void {
      const buffers = watched.readBuffers.filter((buffer) => buffer.length >= MIB);
      expect(buffers, "one reusable 1 MiB read buffer").toHaveLength(1);
      expect(buffers[0]!.length).toBe(MIB);
      expect(buffers[0]!.every((byte) => byte === 0)).toBe(true);
    }

    it("after a successful pass", async () => {
      const { storage } = await createStorage();
      const plaintext = randomBytes(2 * MIB + 5);
      const { path, expected } = await quarantineFile(storage, plaintext);
      watched.readBuffers.length = 0;

      await storage.sealQuarantine(path, expected, createDocumentSealer(contextFor(plaintext), kek, "key-1"), { kind: "object", storageKey: storage.createStorageKey() });

      expectOneZeroedMebibyteBuffer();
    }, 30_000);

    it("after a pass refused for its digest", async () => {
      const { storage } = await createStorage();
      const plaintext = randomBytes(2 * MIB + 5);
      const { expected } = await quarantineFile(storage, plaintext);
      const changed = Buffer.from(plaintext);
      changed[17] ^= 0xff;
      const otherPath = await writeQuarantineFile(storage, changed);
      watched.readBuffers.length = 0;

      await expectInvalidQuarantine(storage.sealQuarantine(otherPath, expected, createDocumentSealer(contextFor(plaintext), kek, "key-1"), { kind: "object", storageKey: storage.createStorageKey() }));

      expectOneZeroedMebibyteBuffer();
    }, 30_000);

    it("after a pass that failed in the sealer", async () => {
      const { storage } = await createStorage();
      const plaintext = randomBytes(2 * MIB + 5);
      const { path, expected } = await quarantineFile(storage, plaintext);
      watched.readBuffers.length = 0;
      const failing = { update: () => { throw new Error("synthetic"); }, final: () => { throw new Error("unreachable"); } } as unknown as DocumentSealer;

      await expect(storage.sealQuarantine(path, expected, failing, { kind: "object", storageKey: storage.createStorageKey() })).rejects.toThrow("synthetic");

      expectOneZeroedMebibyteBuffer();
    });
  });
});
