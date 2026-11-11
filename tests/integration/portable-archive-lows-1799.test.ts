/**
 * #1799 "Spec for the Low fixes", the database- and disk-backed ones:
 *
 * L6: the audit row for a rolled-back import counts only what its deletes
 * removed; a rollback before anything was created logs zeros.
 * L10: the free-space check for an upload spool and for an export write
 * subtracts the declared bytes of those already in flight in the process; the
 * reservation is released when each finishes or fails.
 * L11: an export's expiry and the limits bounding it come from the retention
 * as it stands when its row is inserted, read in that transaction.
 *
 * node:fs/promises is wrapped as in portable-archive-upload-spool-disk-1792
 * .test.ts: statfs reports a chosen amount of free space, and the first write
 * to an archive temp file can be held until released. Everything else is the
 * real file system.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, portableArchiveImports, portableArchives } from "@/db/schema";
import { createPortableArchive, rollBackPortableImport, spoolPortableArchiveUpload } from "@/server/portable-archive-repository";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";

const disk = vi.hoisted(() => ({
  /** Free bytes statfs reports; null reports the real disk. */
  free: null as number | null,
  /** While set, the first write to an archive temp file waits for `release`. */
  hold: false,
  reached: null as null | (() => void),
  release: Promise.resolve() as Promise<void>,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const wrapped = {
    ...original,
    statfs: (async (path: Parameters<typeof original.statfs>[0], options?: Parameters<typeof original.statfs>[1]) => {
      const real = await original.statfs(path, options as never);
      return disk.free === null ? real : Object.assign(Object.create(Object.getPrototypeOf(real)), real, { bavail: disk.free, bfree: disk.free, bsize: 1 });
    }) as typeof original.statfs,
    open: (async (path: Parameters<typeof original.open>[0], ...rest: unknown[]) => {
      const handle = await (original.open as (...args: unknown[]) => ReturnType<typeof original.open>)(path, ...rest);
      if (!disk.hold || !String(path).includes("portable-archives") || !String(path).endsWith(".tmp")) return handle;
      let held = false;
      return new Proxy(handle, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (property !== "write" && property !== "writev" && property !== "appendFile" && property !== "writeFile") {
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async (...args: unknown[]) => {
            if (!held) { held = true; disk.reached?.(); await disk.release; }
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    }) as typeof original.open,
  };
  return { ...wrapped, default: wrapped };
});

const MIB = 1_048_576;
const passphrase = "correct-horse-battery-staple";
const HOUR_MS = 3_600_000;

type Values = { retentionHours: number; keepPerHousehold: number; maxTotalGigabytes: number };
type Settings = { version: number; defaults: { retentionHours: number; keepPerHousehold: number; maxTotalBytes: number } };
type RetentionModule = {
  setArchiveRetention(actorUserId: string, expectedVersion: number, values: Values | null): Promise<Settings>;
  readArchiveRetentionSettings(actorUserId: string): Promise<Settings>;
};
const retention = async () => (await import("@/server/archive-retention")) as unknown as RetentionModule;

let settingsAdmin: IntegrationFixture | null = null;
async function setRetention(values: Partial<Values> | null) {
  const module = await retention();
  settingsAdmin ??= await createIntegrationFixture("arch1799-lows-admin");
  const actor = settingsAdmin.users.admin.id;
  const current = await module.readArchiveRetentionSettings(actor);
  const { defaults } = current;
  const full = values === null ? null : {
    retentionHours: defaults.retentionHours,
    keepPerHousehold: defaults.keepPerHousehold,
    maxTotalGigabytes: defaults.maxTotalBytes / 1_073_741_824,
    ...values,
  };
  return module.setArchiveRetention(actor, current.version, full);
}

beforeEach(() => {
  disk.free = null;
  disk.hold = false;
  disk.reached = null;
  disk.release = Promise.resolve();
});

afterEach(async () => {
  disk.free = null;
  disk.hold = false;
  await setRetention(null).catch(() => undefined);
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

/** Holds the next archive write at its first chunk; resolves once an export has reached it. */
function holdNextWrite() {
  let open: () => void = () => undefined;
  disk.release = new Promise<void>((resolve) => { open = resolve; });
  const reached = new Promise<void>((resolve) => { disk.reached = resolve; });
  disk.hold = true;
  return { reached, open: () => { disk.hold = false; open(); } };
}

describe("L6: the rollback's audit row counts what was removed", () => {
  it("logs zeros when the import row names ids that were never created", async () => {
    // Catches the count taken from the row's planned ids, so a rollback before the switch claims items, sections and documents it never touched.
    const fixture = await createIntegrationFixture("arch1799-l6");
    const [row] = await getDb().insert(portableArchiveImports).values({
      householdId: fixture.household.id,
      actorUserId: fixture.users.owner.id,
      startedAt: new Date(),
      finishedAt: null,
      createdItemIds: [randomUUID(), randomUUID(), randomUUID()],
      createdSectionIds: [randomUUID(), randomUUID()],
    }).returning({ id: portableArchiveImports.id });

    await rollBackPortableImport(row.id);

    const [closed] = await getDb().select().from(portableArchiveImports).where(eq(portableArchiveImports.id, row.id));
    expect(closed.outcome).toBe("rolled_back");
    const audits = await getDb().select({ changes: auditLog.changes }).from(auditLog)
      .where(and(eq(auditLog.entityId, row.id), eq(auditLog.action, "portable_archive_import_rolled_back")));
    expect(audits).toHaveLength(1);
    expect(audits[0].changes).toEqual({ itemsRemoved: 0, sectionsRemoved: 0, documentsRemoved: 0 });
  });
});

describe("L10: free space is shared by what is in flight", () => {
  const neverEnding = () => new ReadableStream<Uint8Array>({ start() { /* stays open: the upload is still arriving */ } });

  it("refuses a second upload that fits alone but not beside the first still in flight, and fits again once the first fails", async () => {
    // Catches each preflight reading the same free space, so two uploads that each fit together fill the disk.
    const declared = 100 * MIB;
    const need = declared * 1.01 + 256 * MIB;
    disk.free = Math.ceil(need + declared / 2); // one fits; two do not
    const first = await spoolPortableArchiveUpload(neverEnding(), declared);
    try {
      await expect(spoolPortableArchiveUpload(neverEnding(), declared)).rejects.toMatchObject({ code: "archive_storage_full", status: 507 });
    } finally {
      first.abort(new Error("the client went away"));
      await first.done.catch(() => undefined);
    }
    // Released when the first fails: a new one fits again.
    const again = await spoolPortableArchiveUpload(neverEnding(), declared);
    again.abort(new Error("done with the test"));
    await again.done.catch(() => undefined);
  });

  it("refuses a second export that fits alone but not beside the first still being written, and fits again once the first finishes", async () => {
    // Catches the export preflight ignoring the exports already being written.
    const fixture = await createIntegrationFixture("arch1799-l10-export");
    const sizeOf = async (id: string) => (await getDb().select({ sizeBytes: portableArchives.sizeBytes }).from(portableArchives).where(eq(portableArchives.id, id)))[0].sizeBytes;
    const input = { userId: fixture.users.owner.id, householdId: fixture.household.id, passphrase, includeDocuments: false };
    const measured = await createPortableArchive(input);
    const fileBytes = await sizeOf(measured.id);
    expect(fileBytes).toBeGreaterThan(0);
    disk.free = Math.ceil(fileBytes * 1.01 + 256 * MIB + fileBytes / 2); // one fits; two do not

    const gate = holdNextWrite();
    const first = createPortableArchive(input);
    first.catch(() => undefined);
    await gate.reached;
    // A second export that is not refused would wait on the held write, so it is given a few seconds to answer.
    const second = createPortableArchive(input).then(() => "written" as const, (error: unknown) => error);
    const answer = await Promise.race([second, new Promise<string>((resolve) => setTimeout(() => resolve("not refused: waiting on the held write"), 5_000))]);
    gate.open();
    await second;
    expect(answer).toMatchObject({ code: "archive_storage_full", status: 507 });
    await first;
    await expect(createPortableArchive(input), "the reservation was released when the first finished").resolves.toBeDefined();
  }, 120_000);
});

describe("L11: the expiry and limits come from the retention at insert", () => {
  it("gives an export whose insert follows a retention change the new expiry and the new per-household limit", async () => {
    // Catches the retention read before the write: an export held while an administrator shortens the retention would still outlive it.
    const fixture = await createIntegrationFixture("arch1799-l11");
    await getDb().update(portableArchives).set({ purgedAt: new Date() }).where(eq(portableArchives.householdId, fixture.household.id));
    await setRetention({ retentionHours: 6, keepPerHousehold: 2 });
    const input = { userId: fixture.users.owner.id, householdId: fixture.household.id, passphrase, includeDocuments: false };
    const older = await createPortableArchive(input);

    const gate = holdNextWrite();
    const inFlight = createPortableArchive(input);
    inFlight.catch(() => undefined);
    await gate.reached;
    await setRetention({ retentionHours: 1, keepPerHousehold: 1 });
    gate.open();
    const created = await inFlight;

    const [row] = await getDb().select().from(portableArchives).where(eq(portableArchives.id, created.id));
    expect(Math.round((row.expiresAt.getTime() - row.createdAt.getTime()) / 1_000) * 1_000, "kept for the new 1 h").toBe(HOUR_MS);
    const live = await getDb().select({ id: portableArchives.id }).from(portableArchives)
      .where(and(eq(portableArchives.householdId, fixture.household.id), isNull(portableArchives.purgedAt), sql`${portableArchives.expiresAt} > now()`));
    expect(live.map((entry) => entry.id), "the new limit of 1 replaced the older export").toEqual([created.id]);
    expect(older.id).not.toBe(created.id);
  }, 120_000);
});
