import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Watches the reads (to see the read buffer), and the order of fsync and the
// unsealer's final step on the way to a quarantine file; everything passes
// through.
const watched = vi.hoisted(() => ({
  readBuffers: [] as Uint8Array[],
  events: [] as string[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
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

import {
  createDocumentSealer,
  createDocumentUnsealer,
  DocumentIntegrityError,
  encryptDocument,
  type CryptoEnvelope,
  type DocumentEncryptionContext,
  type DocumentUnsealer,
} from "./crypto";
import { LocalDocumentStorage } from "./storage";

/**
 * #1571: `storage.unsealToQuarantine` and `storage.unsealIntoBuffer` read a
 * stored ciphertext object in pieces through one reusable 1 MiB buffer and
 * feed an unsealer, whose `final()` is the tag check. Plaintext pieces reach
 * only a sink the class owns (a quarantine file it opened, or a buffer it
 * allocated), and the caller gets the path or the buffer only once `final()`
 * has passed; any failure removes the file or zeroes the buffer.
 */

const MIB = 1_048_576;
const kek = randomBytes(32);
const temporaryRoots: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];

/** Watches `Buffer.alloc` (real behaviour, results kept) until the test ends. */
function watchBufferAlloc(): void {
  spies.push(vi.spyOn(Buffer, "alloc"));
}

afterEach(async () => {
  watched.readBuffers.length = 0;
  watched.events.length = 0;
  vi.clearAllMocks();
  for (const spy of spies.splice(0)) spy.mockRestore();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createStorage() {
  const root = await mkdtemp(join(tmpdir(), "orbit-unseal-"));
  temporaryRoots.push(root);
  const storageRoot = join(root, "objects-root");
  const quarantineRoot = join(root, "quarantine");
  const storage = new LocalDocumentStorage(storageRoot, quarantineRoot);
  await storage.initialize();
  return { root, storageRoot, quarantineRoot, storage };
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

interface Stored {
  storageKey: string;
  context: DocumentEncryptionContext;
  envelope: CryptoEnvelope;
  ciphertextSize: number;
  plaintext: Buffer;
  kind: "object" | "staging";
}

/** Seals `plaintext` and stores it as an object or a staging object, the way the app does. */
async function store(storage: LocalDocumentStorage, plaintext: Buffer, kind: "object" | "staging" = "object"): Promise<Stored> {
  const context = contextFor(plaintext, kind === "staging" ? "scanner_recovery" : undefined);
  const encrypted = encryptDocument(plaintext, context, kek, "key-1");
  const storageKey = storage.createStorageKey();
  if (kind === "object") await storage.writeCiphertext(storageKey, encrypted.ciphertext);
  else await storage.writeStagingCiphertext(storageKey, encrypted.ciphertext);
  return { storageKey, context, envelope: encrypted.envelope, ciphertextSize: encrypted.ciphertext.length, plaintext, kind };
}

function objectFile(storageRoot: string, key: string): string {
  return join(storageRoot, "objects", key.slice(0, 2), key.slice(2, 4), `${key}.bin`);
}

function fileOf(storageRoot: string, stored: Stored): string {
  return stored.kind === "object" ? objectFile(storageRoot, stored.storageKey) : join(storageRoot, "staging", `${stored.storageKey}.bin`);
}

function unsealerFor(stored: Stored): DocumentUnsealer {
  return createDocumentUnsealer(stored.context, stored.envelope, kek);
}

function expected(stored: Stored): { ciphertextSize: number; plaintextSize: number } {
  return { ciphertextSize: stored.ciphertextSize, plaintextSize: stored.plaintext.length };
}

async function flipByte(path: string, position: number): Promise<void> {
  const bytes = await readFile(path);
  bytes[position] ^= 0xff;
  await writeFile(path, bytes);
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1)).sort();
}

function mebibyteBuffers(): Uint8Array[] {
  return watched.readBuffers.filter((buffer) => buffer.length >= MIB);
}

function expectOneZeroedMebibyteBuffer(): void {
  const buffers = mebibyteBuffers();
  expect(buffers, "one reusable 1 MiB read buffer").toHaveLength(1);
  expect(buffers[0]!.length).toBe(MIB);
  expect(buffers[0]!.every((byte) => byte === 0)).toBe(true);
}

/** An unsealer that records the pieces it is fed and what it returned, around a real one. */
function recording(real: DocumentUnsealer): DocumentUnsealer & { fed: number[]; events: string[] } {
  const fed: number[] = [];
  const events: string[] = [];
  return {
    fed,
    events,
    update(chunk: Buffer): Buffer {
      fed.push(chunk.length);
      return real.update(chunk);
    },
    final(): void {
      events.push("final");
      watched.events.push("final");
      real.final();
    },
  };
}

describe("unsealToQuarantine (#1571)", () => {
  it.each([
    ["object", 1],
    ["object", MIB],
    ["staging", MIB + 1],
    ["staging", 2 * MIB + 5],
  ] as const)("from a %s of %i bytes: writes a 0600 .recovery file, byte for byte the plaintext, and returns its SHA-256", async (kind, size) => {
    const { quarantineRoot, storage } = await createStorage();
    const stored = await store(storage, randomBytes(size), kind);

    const result = await storage.unsealToQuarantine({ kind, storageKey: stored.storageKey }, stored.context.documentId, expected(stored), unsealerFor(stored));

    expect(result.contentSha256).toBe(sha256(stored.plaintext));
    expect(result.quarantinePath.startsWith(quarantineRoot)).toBe(true);
    expect(result.quarantinePath).toMatch(new RegExp(`/${stored.context.documentId}\\.[a-f0-9]{32}\\.recovery$`));
    expect((await readFile(result.quarantinePath)).equals(stored.plaintext)).toBe(true);
    if (process.platform !== "win32") expect((await stat(result.quarantinePath)).mode & 0o777).toBe(0o600);
    expect((await storage.listQuarantineFiles()).map((file) => file.path)).toEqual([result.quarantinePath]);
    expect(await filesUnder(quarantineRoot), "no temporary file beside it").toEqual([result.quarantinePath.slice(quarantineRoot.length + 1)]);
  }, 30_000);

  it("leaves the source object in place, and names a fresh file for every call", async () => {
    const { storageRoot, storage } = await createStorage();
    const stored = await store(storage, randomBytes(5_000), "staging");
    const first = await storage.unsealToQuarantine({ kind: "staging", storageKey: stored.storageKey }, stored.context.documentId, expected(stored), unsealerFor(stored));
    const second = await storage.unsealToQuarantine({ kind: "staging", storageKey: stored.storageKey }, stored.context.documentId, expected(stored), unsealerFor(stored));

    expect(first.quarantinePath).not.toBe(second.quarantinePath);
    expect(await storage.stagingExists(stored.storageKey)).toBe(true);
    expect((await readFile(fileOf(storageRoot, stored))).length).toBe(stored.ciphertextSize);
  });

  it("feeds the unsealer pieces of at most 1 MiB, calls final() once the last is in, and syncs the file after final()", async () => {
    const { storage } = await createStorage();
    const stored = await store(storage, randomBytes(2 * MIB + 5), "staging");
    const unsealer = recording(unsealerFor(stored));
    watched.events.length = 0;

    await storage.unsealToQuarantine({ kind: "staging", storageKey: stored.storageKey }, stored.context.documentId, expected(stored), unsealer);

    expect(unsealer.fed.reduce((sum, length) => sum + length, 0)).toBe(stored.ciphertextSize);
    expect(Math.max(...unsealer.fed)).toBeLessThanOrEqual(MIB);
    expect(unsealer.events).toEqual(["final"]);
    expect(watched.events.indexOf("final")).toBeGreaterThanOrEqual(0);
    const syncs = watched.events.map((event, index) => (event === "sync" ? index : -1)).filter((index) => index >= 0);
    expect(syncs.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...syncs), "the file is synced after the tag check").toBeGreaterThan(watched.events.indexOf("final"));
  }, 30_000);

  describe("a source that fails its tag", () => {
    it.each([
      ["a flipped byte in the first piece", 17],
      ["a flipped byte in a later piece", MIB + 3],
      ["a flipped byte in the last byte", 2 * MIB + 4],
    ])("%s: rejects with DocumentIntegrityError, and no quarantine file remains", async (_label, position) => {
      const { storageRoot, quarantineRoot, storage } = await createStorage();
      const stored = await store(storage, randomBytes(2 * MIB + 5), "staging");
      await flipByte(fileOf(storageRoot, stored), position);

      const failure = await storage.unsealToQuarantine({ kind: "staging", storageKey: stored.storageKey }, stored.context.documentId, expected(stored), unsealerFor(stored))
        .then(() => undefined, (error: unknown) => error);

      expect(failure).toBeInstanceOf(DocumentIntegrityError);
      expect(await filesUnder(quarantineRoot)).toEqual([]);
      expect(await storage.listQuarantineFiles()).toHaveLength(0);
    }, 30_000);

    it("a wrong tag in the envelope: rejects, and no quarantine file remains", async () => {
      const { quarantineRoot, storage } = await createStorage();
      const stored = await store(storage, randomBytes(10_000), "object");
      const tag = Buffer.from(stored.envelope.contentAuthTag, "base64url");
      tag[3] ^= 0x10;
      const unsealer = createDocumentUnsealer(stored.context, { ...stored.envelope, contentAuthTag: tag.toString("base64url") }, kek);

      await expect(storage.unsealToQuarantine({ kind: "object", storageKey: stored.storageKey }, stored.context.documentId, expected(stored), unsealer))
        .rejects.toBeInstanceOf(DocumentIntegrityError);

      expect(await filesUnder(quarantineRoot)).toEqual([]);
    });

    it("a context that does not match: rejects, and no quarantine file remains", async () => {
      const { quarantineRoot, storage } = await createStorage();
      const stored = await store(storage, randomBytes(10_000), "object");
      const unsealer = createDocumentUnsealer({ ...stored.context, itemId: randomUUID() }, stored.envelope, kek);

      await expect(storage.unsealToQuarantine({ kind: "object", storageKey: stored.storageKey }, stored.context.documentId, expected(stored), unsealer))
        .rejects.toBeInstanceOf(DocumentIntegrityError);

      expect(await filesUnder(quarantineRoot)).toEqual([]);
    });
  });

  describe("a source that is not what was recorded", () => {
    async function expectInvalid(storage: LocalDocumentStorage, stored: Stored, size: number): Promise<void> {
      const failure = await storage.unsealToQuarantine(
        { kind: stored.kind, storageKey: stored.storageKey },
        stored.context.documentId,
        { ciphertextSize: size, plaintextSize: stored.plaintext.length },
        unsealerFor(stored),
      ).then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("invalid");
    }

    it.each([
      ["smaller", 1],
      ["larger", -1],
    ] as const)("refuses a file %s than the recorded ciphertextSize with a message containing 'invalid', leaving no quarantine file", async (_which, delta) => {
      const { quarantineRoot, storage } = await createStorage();
      const stored = await store(storage, randomBytes(MIB + 100), "staging");

      await expectInvalid(storage, stored, stored.ciphertextSize + delta);

      expect(await filesUnder(quarantineRoot)).toEqual([]);
    });

    it("refuses a source that is a directory, not a file", async () => {
      const { storageRoot, quarantineRoot, storage } = await createStorage();
      const stored = await store(storage, randomBytes(100), "staging");
      const path = fileOf(storageRoot, stored);
      await rm(path);
      await mkdir(path);

      await expectInvalid(storage, stored, stored.ciphertextSize);

      expect(await filesUnder(quarantineRoot)).toEqual([]);
    });

    it("lets a missing source fail as ENOENT, leaving no quarantine file", async () => {
      const { quarantineRoot, storage } = await createStorage();
      const stored = await store(storage, randomBytes(100), "staging");
      await storage.deleteStagingCiphertext(stored.storageKey);

      await expect(storage.unsealToQuarantine({ kind: "staging", storageKey: stored.storageKey }, stored.context.documentId, expected(stored), unsealerFor(stored)))
        .rejects.toMatchObject({ code: "ENOENT" });

      expect(await filesUnder(quarantineRoot)).toEqual([]);
    });

    it("refuses an invalid storage key", async () => {
      const { storage } = await createStorage();
      const stored = await store(storage, randomBytes(100), "staging");

      await expect(storage.unsealToQuarantine({ kind: "staging", storageKey: "../escape" }, stored.context.documentId, expected(stored), unsealerFor(stored)))
        .rejects.toThrow("Invalid document storage key");
    });
  });

  describe("a failure along the way", () => {
    it("removes the quarantine file when the unsealer fails mid-pass, and rethrows its error", async () => {
      const { quarantineRoot, storage } = await createStorage();
      const stored = await store(storage, randomBytes(3 * MIB), "staging");
      let calls = 0;
      const failing: DocumentUnsealer = {
        update: (chunk) => {
          calls += 1;
          if (calls === 2) throw new Error("synthetic unsealer failure");
          return Buffer.from(chunk);
        },
        final: () => { throw new Error("final must not be reached"); },
      };

      await expect(storage.unsealToQuarantine({ kind: "staging", storageKey: stored.storageKey }, stored.context.documentId, expected(stored), failing))
        .rejects.toThrow("synthetic unsealer failure");

      expect(await filesUnder(quarantineRoot)).toEqual([]);
    });

    it("removes the quarantine file when final() fails, even though every piece was written", async () => {
      const { quarantineRoot, storage } = await createStorage();
      const stored = await store(storage, randomBytes(1_000), "staging");
      const failing: DocumentUnsealer = {
        update: (chunk) => Buffer.from(chunk),
        final: () => { throw new DocumentIntegrityError(); },
      };

      await expect(storage.unsealToQuarantine({ kind: "staging", storageKey: stored.storageKey }, stored.context.documentId, expected(stored), failing))
        .rejects.toBeInstanceOf(DocumentIntegrityError);

      expect(await filesUnder(quarantineRoot)).toEqual([]);
    });
  });

  describe("the read buffer is zeroed when the pass ends (#1151 F13)", () => {
    it("after a successful pass", async () => {
      const { storage } = await createStorage();
      const stored = await store(storage, randomBytes(2 * MIB + 5), "staging");
      watched.readBuffers.length = 0;

      await storage.unsealToQuarantine({ kind: "staging", storageKey: stored.storageKey }, stored.context.documentId, expected(stored), unsealerFor(stored));

      expectOneZeroedMebibyteBuffer();
    }, 30_000);

    it("after a pass that failed its tag", async () => {
      const { storageRoot, storage } = await createStorage();
      const stored = await store(storage, randomBytes(2 * MIB + 5), "staging");
      await flipByte(fileOf(storageRoot, stored), 2 * MIB);
      watched.readBuffers.length = 0;

      await expect(storage.unsealToQuarantine({ kind: "staging", storageKey: stored.storageKey }, stored.context.documentId, expected(stored), unsealerFor(stored)))
        .rejects.toBeInstanceOf(DocumentIntegrityError);

      expectOneZeroedMebibyteBuffer();
    }, 30_000);

    it("after a pass that failed in the unsealer", async () => {
      const { storage } = await createStorage();
      const stored = await store(storage, randomBytes(2 * MIB + 5), "staging");
      watched.readBuffers.length = 0;
      const failing: DocumentUnsealer = { update: () => { throw new Error("synthetic"); }, final: () => { throw new Error("unreachable"); } };

      await expect(storage.unsealToQuarantine({ kind: "staging", storageKey: stored.storageKey }, stored.context.documentId, expected(stored), failing)).rejects.toThrow("synthetic");

      expectOneZeroedMebibyteBuffer();
    }, 30_000);
  });
});

describe("unsealIntoBuffer (#1571)", () => {
  it.each([1, MIB, MIB + 1, 2 * MIB + 5])("returns exactly the %i bytes of plaintext, in a buffer of that size", async (size) => {
    const { storage } = await createStorage();
    const stored = await store(storage, randomBytes(size), "object");

    const bytes = await storage.unsealIntoBuffer(stored.storageKey, expected(stored), unsealerFor(stored));

    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.length).toBe(size);
    expect(bytes.equals(stored.plaintext)).toBe(true);
  }, 30_000);

  it("feeds the unsealer pieces of at most 1 MiB, then calls final() once", async () => {
    const { storage } = await createStorage();
    const stored = await store(storage, randomBytes(2 * MIB + 5), "object");
    const unsealer = recording(unsealerFor(stored));

    await storage.unsealIntoBuffer(stored.storageKey, expected(stored), unsealer);

    expect(unsealer.fed.reduce((sum, length) => sum + length, 0)).toBe(stored.ciphertextSize);
    expect(Math.max(...unsealer.fed)).toBeLessThanOrEqual(MIB);
    expect(unsealer.events).toEqual(["final"]);
  }, 30_000);

  describe("the plaintext buffer is zeroed on any failure", () => {
    // The one buffer of exactly the plaintext's size, as `Buffer.alloc(plaintextSize)` makes it.
    function plaintextBuffers(size: number): Buffer[] {
      return vi.mocked(Buffer.alloc).mock.results
        .map((result) => result.value as Buffer)
        .filter((buffer) => buffer.length === size);
    }

    it("a bad tag throws DocumentIntegrityError, after earlier pieces were already copied in, and leaves that buffer all zero", async () => {
      const { storageRoot, storage } = await createStorage();
      const size = 2 * MIB + 1_234_567 + 5;
      const stored = await store(storage, randomBytes(size), "object");
      await flipByte(fileOf(storageRoot, stored), size - 2);
      watchBufferAlloc();
      const unsealer = recording(unsealerFor(stored));

      await expect(storage.unsealIntoBuffer(stored.storageKey, expected(stored), unsealer)).rejects.toBeInstanceOf(DocumentIntegrityError);

      expect(unsealer.fed.length, "pieces were fed before the tag was checked").toBeGreaterThan(1);
      const buffers = plaintextBuffers(size);
      expect(buffers, "one buffer of the plaintext's size was allocated").toHaveLength(1);
      expect(buffers[0]!.every((byte) => byte === 0)).toBe(true);
    }, 30_000);

    it("a good pass leaves that buffer holding the plaintext, which is what is returned", async () => {
      const { storage } = await createStorage();
      const size = MIB + 1_234_567;
      const stored = await store(storage, randomBytes(size), "object");
      watchBufferAlloc();

      const bytes = await storage.unsealIntoBuffer(stored.storageKey, expected(stored), unsealerFor(stored));

      const buffers = plaintextBuffers(size);
      expect(buffers).toHaveLength(1);
      expect(buffers[0]).toBe(bytes);
      expect(bytes.some((byte) => byte !== 0)).toBe(true);
    }, 30_000);

    it("an unsealer that hands back more plaintext than plaintextSize is refused, not written past the buffer", async () => {
      const { storage } = await createStorage();
      const size = MIB + 1_000_003;
      const stored = await store(storage, randomBytes(size), "object");
      watchBufferAlloc();
      const generous: DocumentUnsealer = {
        update: (chunk) => Buffer.concat([chunk, chunk]),
        final: () => undefined,
      };

      await expect(storage.unsealIntoBuffer(stored.storageKey, expected(stored), generous)).rejects.toThrow();

      const buffers = plaintextBuffers(size);
      expect(buffers).toHaveLength(1);
      expect(buffers[0]!.every((byte) => byte === 0)).toBe(true);
    }, 30_000);

    it("a failing final() is rethrown as it is, with the buffer zeroed", async () => {
      const { storage } = await createStorage();
      const size = MIB + 1_000_007;
      const stored = await store(storage, randomBytes(size), "object");
      watchBufferAlloc();
      const failing: DocumentUnsealer = {
        update: (chunk) => Buffer.from(chunk),
        final: () => { throw new Error("synthetic final failure"); },
      };

      await expect(storage.unsealIntoBuffer(stored.storageKey, expected(stored), failing)).rejects.toThrow("synthetic final failure");

      const buffers = plaintextBuffers(size);
      expect(buffers).toHaveLength(1);
      expect(buffers[0]!.every((byte) => byte === 0)).toBe(true);
    }, 30_000);

    it("an object shorter than ciphertextSize is refused as invalid, with the buffer zeroed", async () => {
      const { storageRoot, storage } = await createStorage();
      const size = MIB + 1_000_011;
      const stored = await store(storage, randomBytes(size), "object");
      const path = fileOf(storageRoot, stored);
      await writeFile(path, (await readFile(path)).subarray(0, MIB + 10));
      watchBufferAlloc();

      const failure = await storage.unsealIntoBuffer(stored.storageKey, expected(stored), unsealerFor(stored)).then(() => undefined, (error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("invalid");
      const buffers = plaintextBuffers(size);
      expect(buffers).toHaveLength(1);
      expect(buffers[0]!.every((byte) => byte === 0)).toBe(true);
    }, 30_000);
  });

  describe("the read buffer is zeroed when the pass ends (#1151 F13)", () => {
    it("after a successful pass", async () => {
      const { storage } = await createStorage();
      const stored = await store(storage, randomBytes(2 * MIB + 5), "object");
      watched.readBuffers.length = 0;

      await storage.unsealIntoBuffer(stored.storageKey, expected(stored), unsealerFor(stored));

      expectOneZeroedMebibyteBuffer();
    }, 30_000);

    it("after a pass that failed its tag", async () => {
      const { storageRoot, storage } = await createStorage();
      const stored = await store(storage, randomBytes(2 * MIB + 5), "object");
      await flipByte(fileOf(storageRoot, stored), 5);
      watched.readBuffers.length = 0;

      await expect(storage.unsealIntoBuffer(stored.storageKey, expected(stored), unsealerFor(stored))).rejects.toBeInstanceOf(DocumentIntegrityError);

      expectOneZeroedMebibyteBuffer();
    }, 30_000);
  });

  it("refuses an invalid storage key", async () => {
    const { storage } = await createStorage();
    const stored = await store(storage, randomBytes(100), "object");

    await expect(storage.unsealIntoBuffer("../escape", expected(stored), unsealerFor(stored))).rejects.toThrow("Invalid document storage key");
  });

  it("lets a missing object fail as ENOENT", async () => {
    const { storage } = await createStorage();
    const stored = await store(storage, randomBytes(100), "object");
    await storage.deleteCiphertext(stored.storageKey);

    await expect(storage.unsealIntoBuffer(stored.storageKey, expected(stored), unsealerFor(stored))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
