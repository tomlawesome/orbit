import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PortableArchiveStorage } from "./portable-archive-storage";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("portable archive storage", () => {
  it("stores private ciphertext by opaque key and enforces a read bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbit-portable-archive-"));
    roots.push(root);
    const storage = new PortableArchiveStorage(root);
    const key = storage.createStorageKey();
    await storage.write(key, Buffer.from("encrypted-content"));
    await expect(storage.read(key, 64)).resolves.toEqual(Buffer.from("encrypted-content"));
    await expect(storage.read(key, 4)).rejects.toThrow("exceeds its expected size");
    await storage.delete(key);
    await expect(storage.read(key, 64)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects traversal-like storage keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbit-portable-archive-"));
    roots.push(root);
    const storage = new PortableArchiveStorage(root);
    await expect(storage.write("../outside", Buffer.from("x"))).rejects.toThrow("Invalid portable archive storage key");
  });
});
