/**
 * The portable-archive export is written as a stream and its format does not
 * change (#1506). Specification: the export holds roughly one document plus
 * fixed buffers, never the archive whole; the file is still JSON with exactly
 * version, algorithm, kdf, salt, iv, authTag and ciphertext; the recorded
 * SHA-256 is that of the bytes on disk; a changed byte in the ciphertext fails
 * authentication.
 *
 * Real documents are stored (not mocked) because the memory test runs the
 * export in another process, where no mock can reach.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { items, portableArchives } from "@/db/schema";
import { decryptPortableArchive } from "@/server/portable-archive";
import { createPortableArchive, importPortableArchive, previewPortableArchive, readPortableArchive } from "@/server/portable-archive-repository";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { seedStoredDocuments } from "./support/stored-documents";

const MIB = 1_048_576;
const passphrase = "correct-horse-battery-staple";
const ARCHIVE_FIELDS = ["algorithm", "authTag", "ciphertext", "iv", "kdf", "salt", "version"];

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;

async function exportArchive(fixture: Fixture, includeDocuments: boolean) {
  return createPortableArchive({
    userId: fixture.users.owner.id,
    householdId: fixture.household.id,
    passphrase,
    includeDocuments,
  });
}

/** The one stored file for an archive: the file under the document root whose path carries its storage key. */
async function storedFilePath(archiveId: string): Promise<string> {
  const [row] = await getDb().select({ storageKey: portableArchives.storageKey }).from(portableArchives)
    .where(eq(portableArchives.id, archiveId));
  const root = process.env.DOCUMENTS_ROOT!;
  for (const entry of await readdir(root, { recursive: true })) {
    if (!entry.includes(row.storageKey)) continue;
    const path = join(root, entry);
    if ((await stat(path)).isFile()) return path;
  }
  throw new Error(`no stored file found for archive ${archiveId}`);
}

/** Sizes that straddle any plausible chunk or base64 group boundary, plus an empty-ish one. */
const documentSizes = [1, 2, 3, 65_536, 65_537, MIB + 17, 3 * MIB - 1];

describe("an exported portable archive is the same format a reader already accepts (#1506)", () => {
  it("is JSON with exactly the seven fields, decrypts with the passphrase, and carries the exported items, documents and bytes", async () => {
    const fixture = await createIntegrationFixture("portable-archive-stream-compat");
    const contents = documentSizes.map((size) => randomBytes(size));
    const ids = await seedStoredDocuments(fixture, contents);

    const archive = await exportArchive(fixture, true);
    const { bytes } = await readPortableArchive(fixture.users.owner.id, archive.id);
    const parsed = JSON.parse(bytes.toString("utf8"));

    expect(Object.keys(parsed).sort()).toEqual(ARCHIVE_FIELDS);
    expect(parsed.version).toBe(1);
    expect(parsed.algorithm).toBe("aes-256-gcm");
    expect(parsed.kdf).toBe("scrypt");
    for (const field of ["salt", "iv", "authTag", "ciphertext"]) {
      expect(typeof parsed[field]).toBe("string");
      expect(parsed[field]).toMatch(/^[A-Za-z0-9_-]+$/u);
    }

    // The reader's own validation accepts it, and counts what was exported.
    const preview = previewPortableArchive(parsed, passphrase);
    expect(preview.documents).toBe(contents.length);

    const payload = JSON.parse(decryptPortableArchive(parsed, passphrase).toString("utf8"));
    expect(payload.format).toBe("orbit-portable-archive");
    expect((payload.items as Array<{ id: string }>).map((item) => item.id)).toContain(fixture.item.id);
    expect((payload.documents as Array<{ id: string }>).map((document) => document.id).sort()).toEqual([...ids].sort());
    const exported = payload.documentBytes as Array<{ id: string; contentBase64: string }>;
    expect(exported.map((document) => document.id).sort()).toEqual([...ids].sort());
    for (const [index, id] of ids.entries()) {
      const document = exported.find((candidate) => candidate.id === id)!;
      expect(Buffer.from(document.contentBase64, "base64").equals(contents[index])).toBe(true);
    }
  }, 120_000);

  it("imports into a fresh household when the export holds no documents", async () => {
    const source = await createIntegrationFixture("portable-archive-stream-import-source");
    const target = await createIntegrationFixture("portable-archive-stream-import-target");

    const archive = await exportArchive(source, false);
    const { bytes } = await readPortableArchive(source.users.owner.id, archive.id);
    const parsed = JSON.parse(bytes.toString("utf8"));
    expect(Object.keys(parsed).sort()).toEqual(ARCHIVE_FIELDS);

    const result = await importPortableArchive({
      userId: target.users.owner.id,
      householdId: target.household.id,
      archive: parsed,
      passphrase,
      conflictItemIds: [],
    });
    expect(result.importedItems).toBe(1);
  }, 60_000);
});

describe("an exported portable archive refuses a changed ciphertext (#1506)", () => {
  it("fails authentication when one character inside the ciphertext is changed, and imports nothing", async () => {
    const source = await createIntegrationFixture("portable-archive-stream-tamper-source");
    const target = await createIntegrationFixture("portable-archive-stream-tamper-target");
    await seedStoredDocuments(source, [randomBytes(MIB + 5)]);

    const archive = await exportArchive(source, true);
    const { bytes } = await readPortableArchive(source.users.owner.id, archive.id);
    const parsed = JSON.parse(bytes.toString("utf8")) as { ciphertext: string };

    // Control: the untouched file opens, so the failures below come from the change.
    expect(() => decryptPortableArchive(parsed as never, passphrase)).not.toThrow();

    for (const position of [0, 100, Math.floor(parsed.ciphertext.length / 2), parsed.ciphertext.length - 20]) {
      const original = parsed.ciphertext[position];
      const changed = original === "A" ? "B" : "A";
      const tampered = {
        ...parsed,
        ciphertext: parsed.ciphertext.slice(0, position) + changed + parsed.ciphertext.slice(position + 1),
      };
      expect(tampered.ciphertext).not.toBe(parsed.ciphertext);
      expect(tampered.ciphertext).toHaveLength(parsed.ciphertext.length);
      expect(() => decryptPortableArchive(tampered as never, passphrase)).toThrow();
      expect(() => previewPortableArchive(tampered, passphrase)).toThrow();
      await expect(importPortableArchive({
        userId: target.users.owner.id,
        householdId: target.household.id,
        archive: tampered,
        passphrase,
        conflictItemIds: [],
      })).rejects.toBeInstanceOf(Error);
    }

    expect(await getDb().select({ id: items.id }).from(items).where(eq(items.householdId, target.household.id)))
      .toEqual([{ id: target.item.id }]);
  }, 120_000);
});

describe("the hash an export records is the hash of the file on disk (#1506)", () => {
  it.each([
    ["with documents", true],
    ["without documents", false],
  ])("matches the SHA-256 and the length of the stored bytes, %s", async (label, includeDocuments) => {
    const fixture = await createIntegrationFixture(`portable-archive-stream-hash-${includeDocuments}`);
    if (includeDocuments) await seedStoredDocuments(fixture, [randomBytes(MIB + 3), randomBytes(70_001)]);

    const archive = await exportArchive(fixture, includeDocuments);
    const [row] = await getDb().select({ contentSha256: portableArchives.contentSha256, sizeBytes: portableArchives.sizeBytes })
      .from(portableArchives).where(eq(portableArchives.id, archive.id));
    const onDisk = await readFile(await storedFilePath(archive.id));

    expect(row.contentSha256).toBe(createHash("sha256").update(onDisk).digest("hex"));
    expect(row.sizeBytes).toBe(onDisk.length);
    expect(label).toBeTruthy();
  }, 120_000);
});

describe("the export holds about one document in memory, not the archive (#1506)", () => {
  it("raises the exporting process's peak memory by less than the archive's plaintext size when the documents total more than 100 MiB", async () => {
    const fixture = await createIntegrationFixture("portable-archive-stream-memory");
    const documentBytes = 30 * MIB;
    const documentCount = 4;
    // Seeded one at a time here, in this process; the export below runs in a
    // fresh one, so this process's peak (and the vitest runner's) is not counted.
    const ids: string[] = [];
    for (let index = 0; index < documentCount; index += 1) {
      ids.push(...await seedStoredDocuments(fixture, [randomBytes(documentBytes)]));
    }
    expect(ids).toHaveLength(documentCount);
    expect(documentBytes * documentCount).toBeGreaterThan(100 * MIB);

    // The archive's plaintext is the JSON holding every document as base64; its
    // size is at least the base64 length of the documents alone.
    const plaintextKiB = (Math.ceil(documentBytes / 3) * 4 * documentCount) / 1024;

    const tsx = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
    const child = fileURLToPath(new URL("./support/archive-export-memory-child.ts", import.meta.url));
    const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const proc = spawn(process.execPath, [tsx, child, fixture.users.owner.id, fixture.household.id], {
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      proc.on("error", reject);
      proc.on("close", (code) => resolve({ code, stdout, stderr }));
    });

    expect(run.code, run.stderr).toBe(0);
    const line = run.stdout.split("\n").find((candidate) => candidate.startsWith("MEMORY_RESULT "));
    expect(line, `child output: ${run.stdout}\n${run.stderr}`).toBeDefined();
    const { beforeKiB, afterKiB, archiveId } = JSON.parse(line!.slice("MEMORY_RESULT ".length)) as {
      beforeKiB: number; afterKiB: number; archiveId: string;
    };

    // The export did produce the archive, and it holds every document.
    const [row] = await getDb().select({ sizeBytes: portableArchives.sizeBytes, includesDocuments: portableArchives.includesDocuments })
      .from(portableArchives).where(eq(portableArchives.id, archiveId));
    expect(row.includesDocuments).toBe(true);
    expect(row.sizeBytes).toBeGreaterThan(documentBytes * documentCount);

    const growthKiB = afterKiB - beforeKiB;
    expect(
      growthKiB,
      `peak RSS grew ${(growthKiB / 1024).toFixed(0)} MiB; bound is ${(plaintextKiB / 1024).toFixed(0)} MiB (the archive's plaintext)`,
    ).toBeLessThan(plaintextKiB);
  }, 600_000);
});
