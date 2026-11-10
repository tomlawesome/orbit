/**
 * #1390 (design note §4 line 18): an export that cannot fit on the storage
 * root is refused as 507 archive_storage_full, before a byte is written when
 * the free space (statfs) is already below T + margin, and with the temp file
 * removed when the disk fills (ENOSPC) part-way through the write.
 *
 * node:fs/promises is wrapped, not replaced: statfs reports a nearly full
 * disk when asked to, and a write to a temp file under the archive store
 * fails with ENOSPC when asked to. Everything else is the real file system.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { documents } from "@/db/schema";
import { resetDocumentConfigForTests } from "@/server/documents/config";
import { portableArchives } from "@/db/schema";
import { createPortableArchive } from "@/server/portable-archive-repository";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { seedStoredDocuments } from "./support/stored-documents";
import { syntheticPdf } from "../support/synthetic-documents";

const disk = vi.hoisted(() => ({ nearlyFull: false, failWrites: false, statfsCalls: 0, failedWrites: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const enospc = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", errno: -28, syscall: "write" });
  const wrapped = {
    ...original,
    statfs: (async (path: Parameters<typeof original.statfs>[0], options?: Parameters<typeof original.statfs>[1]) => {
      disk.statfsCalls += 1;
      const real = await original.statfs(path, options as never);
      // 4 KiB free: below any archive plus margin.
      return disk.nearlyFull ? Object.assign(Object.create(Object.getPrototypeOf(real)), real, { bavail: 1, bfree: 1, bsize: 4096 }) : real;
    }) as typeof original.statfs,
    open: (async (path: Parameters<typeof original.open>[0], ...rest: unknown[]) => {
      const handle = await (original.open as (...args: unknown[]) => ReturnType<typeof original.open>)(path, ...rest);
      if (!disk.failWrites || !String(path).includes("portable-archives") || !String(path).endsWith(".tmp")) return handle;
      let written = 0;
      return new Proxy(handle, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (property !== "write" && property !== "writev" && property !== "appendFile" && property !== "writeFile") {
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async (...args: unknown[]) => {
            // Let the first chunk land, so a temp file exists when the disk fills.
            if (written > 0) { disk.failedWrites += 1; throw enospc(); }
            written += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    }) as typeof original.open,
  };
  return { ...wrapped, default: wrapped };
});

const passphrase = "correct-horse-battery-staple";

beforeEach(() => {
  disk.nearlyFull = false;
  disk.failWrites = false;
  disk.statfsCalls = 0;
  disk.failedWrites = 0;
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

async function archiveStoreFiles(): Promise<string[]> {
  const root = join(process.env.DOCUMENTS_ROOT!, "portable-archives");
  return (await readdir(root, { recursive: true }).catch(() => [] as string[])).map(String).sort();
}

async function seeded(name: string) {
  const fixture = await createIntegrationFixture(name);
  await seedStoredDocuments(fixture, [syntheticPdf(`${name} a ${"z".repeat(1_500_000)}`), syntheticPdf(`${name} b ${"z".repeat(1_500_000)}`)]);
  return fixture;
}

const archiveRows = async (householdId: string) =>
  (await getDb().select({ id: portableArchives.id }).from(portableArchives).where(eq(portableArchives.householdId, householdId))).map((row) => row.id).sort();

const refusalOf = (work: Promise<unknown>) => work.then(() => null, (error: unknown) => error);

describe("§4 line 18: an export that does not fit is refused with 507 archive_storage_full", () => {
  it("refuses before writing when statfs shows less free space than the archive needs, leaving no temp file", async () => {
    // Catches an export that only finds out by filling the disk (and every other household's uploads with it).
    const fixture = await seeded("arch1390-statfs-full");
    const before = await archiveStoreFiles();
    // The fixture already holds one archive row for the household; the refused export must add none.
    const rowsBefore = await archiveRows(fixture.household.id);
    disk.nearlyFull = true;
    const refusal = await refusalOf(createPortableArchive({ userId: fixture.users.owner.id, householdId: fixture.household.id, passphrase, includeDocuments: true }));
    expect(disk.statfsCalls, "the export asked the file system how much room there is").toBeGreaterThan(0);
    expect(refusal).toMatchObject({ code: "archive_storage_full", status: 507 });
    expect(await archiveStoreFiles()).toEqual(before);
    expect(await archiveRows(fixture.household.id)).toEqual(rowsBefore);
  }, 120_000);

  it("answers the same code when the disk fills during the write (ENOSPC), and removes the temp file", async () => {
    // Catches ENOSPC surfacing as a bare 500, or the half-written temp file left to fill the disk further.
    const fixture = await seeded("arch1390-enospc");
    const before = await archiveStoreFiles();
    disk.failWrites = true;
    const refusal = await refusalOf(createPortableArchive({ userId: fixture.users.owner.id, householdId: fixture.household.id, passphrase, includeDocuments: true }));
    expect(disk.failedWrites, "a write hit ENOSPC").toBeGreaterThan(0);
    expect(refusal).toMatchObject({ code: "archive_storage_full", status: 507 });
    expect((await archiveStoreFiles()).filter((name) => name.endsWith(".tmp")), "no temp file left").toEqual([]);
    expect(await archiveStoreFiles()).toEqual(before);
  }, 120_000);

  it("still refuses with archive_storage_full when the documents are over the quota (#1799: the size ceiling follows what is stored)", async () => {
    // Catches the size ceiling refusing first (archive_export_too_large), or a lifted ceiling skipping the disk check.
    const saved = process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES;
    process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES = String(25 * 1_048_576);
    resetDocumentConfigForTests();
    try {
      const fixture = await seeded("arch1799-statfs-over-quota");
      // The rows say 95 MiB: over 25 MiB + 64 MiB. The refusal comes before any document is read.
      await getDb().update(documents).set({ sizeBytes: 95 * 1_048_576 }).where(eq(documents.householdId, fixture.household.id));
      disk.nearlyFull = true;
      const refusal = await refusalOf(createPortableArchive({ userId: fixture.users.owner.id, householdId: fixture.household.id, passphrase, includeDocuments: true }));
      expect(refusal).toMatchObject({ code: "archive_storage_full", status: 507 });
    } finally {
      if (saved === undefined) delete process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES;
      else process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES = saved;
      resetDocumentConfigForTests();
    }
  }, 120_000);
});
