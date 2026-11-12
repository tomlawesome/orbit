/**
 * #1820 (v0.3.9 batch-b audit, A-S2, spec-A-S2.md): an upload spool no longer
 * reserves its whole declared size at admission. The admission check still
 * refuses 507 archive_storage_full when the root could not hold the declared
 * size beside what is reserved; space is then reserved one step
 * (SPOOL_RESERVE_STEP_BYTES, 64 MiB) at a time as the bytes arrive, each step
 * checked against the free space less every other reservation, and a failed
 * step is the same 507 with the spool file removed. The part granted but never
 * filled is released however the spool ends. Exports keep their whole-file
 * reservation.
 *
 * node:fs/promises is wrapped as in portable-archive-lows-1799.test.ts:
 * statfs reports a chosen amount of free space (bsize 1), so nothing here
 * depends on the host's free disk (#1822). Everything else is the real file
 * system.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as repository from "@/server/portable-archive-repository";
import { createPortableArchive, spoolPortableArchiveUpload } from "@/server/portable-archive-repository";
import { portableArchives } from "@/db/schema";
import { getDb } from "@/db";
import { eq } from "drizzle-orm";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";

const disk = vi.hoisted(() => ({
  /** Free bytes statfs reports; null reports the real disk. */
  free: null as number | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const wrapped = {
    ...original,
    statfs: (async (path: Parameters<typeof original.statfs>[0], options?: Parameters<typeof original.statfs>[1]) => {
      const real = await original.statfs(path, options as never);
      return disk.free === null ? real : Object.assign(Object.create(Object.getPrototypeOf(real)), real, { bavail: disk.free, bfree: disk.free, bsize: 1 });
    }) as typeof original.statfs,
  };
  return { ...wrapped, default: wrapped };
});

const KIB = 1024;
const MIB = 1_048_576;
const GIB = 1_073_741_824;
const MARGIN = 256 * MIB;
const passphrase = "correct-horse-battery-staple";
/** The free space the admission check asks for an upload of `bytes`. */
const need = (bytes: number) => bytes * 1.01 + MARGIN;
/**
 * The step the spec names. Read off the module rather than imported by name,
 * so that before the fix (when it is not exported yet) the tests fail on the
 * behaviour, not on the import; 64 MiB is the value the spec fixes.
 */
const STEP = (repository as { SPOOL_RESERVE_STEP_BYTES?: number }).SPOOL_RESERVE_STEP_BYTES ?? 64 * MIB;

type Spool = Awaited<ReturnType<typeof spoolPortableArchiveUpload>>;

/** A request body the test feeds by hand, as a client sending at its own pace. */
function body() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  return { stream, controller };
}

/** Admits a spool and sends it `firstBytes` (if any), waiting until they are on disk. */
async function spoolWith(declared: number, firstBytes = 0) {
  const source = body();
  const spool = await spoolPortableArchiveUpload(source.stream, declared);
  if (firstBytes > 0) {
    source.controller.enqueue(new Uint8Array(firstBytes));
    await spool.whenWritten(firstBytes);
  }
  return { ...source, spool };
}

async function end(spool: Spool | null | undefined) {
  if (!spool) return;
  spool.abort(new Error("done with the test"));
  await spool.done.then((written) => written.dispose(), () => undefined);
}

/** Whether `done` settles within `ms`, and how. */
function settledWithin(done: Promise<unknown>, ms: number) {
  return Promise.race([
    done.then(() => ({ outcome: "resolved" as const }), (error: unknown) => ({ outcome: "rejected" as const, error })),
    new Promise<{ outcome: "pending" }>((resolve) => setTimeout(() => resolve({ outcome: "pending" }), ms)),
  ]);
}

/** Upload spool files under the archive store. */
async function spoolFiles(): Promise<string[]> {
  const root = join(process.env.DOCUMENTS_ROOT!, "portable-archives");
  return (await readdir(root, { recursive: true }).catch(() => [] as string[])).map(String).filter((name) => name.endsWith(".upload.tmp")).sort();
}

/** Admits a spool of `declared` and lets it go: resolves true when admitted, false when refused 507. */
async function admits(declared: number): Promise<boolean> {
  try {
    const spool = await spoolPortableArchiveUpload(body().stream, declared);
    await end(spool);
    return true;
  } catch (error) {
    expect(error).toMatchObject({ code: "archive_storage_full", status: 507 });
    return false;
  }
}

beforeEach(() => {
  disk.free = null;
});

afterAll(async () => {
  disk.free = null;
  await cleanupIntegrationEnvironment();
});

describe("#1820 A-S2: an upload spool reserves in steps, not its declared size", () => {
  it("T1: a trickling upload holds at most one step, not its declared size", async () => {
    // Catches the declared size reserved at admission: one owner trickling 1 KiB/s holds a whole quota and every other household's upload is refused.
    disk.free = Math.ceil(need(5 * GIB) + STEP + MIB);
    let a: Spool | undefined;
    let b: Spool | undefined;
    try {
      a = (await spoolWith(5 * GIB, KIB)).spool;
      // 1 GiB fits beside one step held by A, but not beside A's whole 5 GiB.
      b = await spoolPortableArchiveUpload(body().stream, GIB).catch((error: unknown) => {
        throw new Error(`B was refused beside a trickling A: ${JSON.stringify(error)} ${(error as Error).message}`);
      });
      expect(b).toHaveProperty("done");
    } finally {
      await end(a);
      await end(b);
    }
  }, 60_000);

  it("T2: the step check refuses an upload part-way, with the same 507 and no spool file", async () => {
    // Catches a spool that is never checked again after admission, so it writes on into a disk others have filled.
    const original = Math.ceil(need(GIB));
    disk.free = original;
    const a = await spoolWith(GIB, KIB);
    try {
      disk.free = MARGIN + STEP / 2; // the disk shrank
      a.controller.enqueue(new Uint8Array(STEP));
      a.controller.enqueue(new Uint8Array(KIB));
      const settled = await settledWithin(a.spool.done, 5_000);
      expect(settled.outcome, "not refused part-way").toBe("rejected");
      expect((settled as { error: unknown }).error).toMatchObject({ code: "archive_storage_full", status: 507 });
      expect(await spoolFiles(), "no spool file after the refusal").toEqual([]);
    } finally {
      await end(a.spool);
    }
    disk.free = original;
    expect(await admits(GIB), "the reservation is back to where it started").toBe(true);
  }, 60_000);

  it("T3: a step is never granted into the margin shared with another spool", async () => {
    // Catches two spools each granted a step on the same free figure, so together they write the volume past the margin.
    disk.free = Math.ceil(need(2 * GIB));
    let a: Awaited<ReturnType<typeof spoolWith>> | undefined;
    let b: Awaited<ReturnType<typeof spoolWith>> | undefined;
    try {
      a = await spoolWith(2 * GIB);
      b = await spoolWith(2 * GIB).catch((error: unknown) => {
        throw new Error(`B was refused at admission beside a byte-less A: ${JSON.stringify(error)} ${(error as Error).message}`);
      });
      disk.free = Math.ceil(MARGIN + 2 * STEP * 1.01 + MIB);
      a.controller.enqueue(new Uint8Array(KIB));
      await a.spool.whenWritten(KIB);
      b.controller.enqueue(new Uint8Array(KIB));
      await b.spool.whenWritten(KIB);
      // A's second step does not fit beside B's first.
      a.controller.enqueue(new Uint8Array(STEP));
      const settled = await settledWithin(a.spool.done, 5_000);
      expect(settled.outcome, "A's second step was not refused").toBe("rejected");
      expect((settled as { error: unknown }).error).toMatchObject({ code: "archive_storage_full", status: 507 });
      expect((await settledWithin(b.spool.done, 200)).outcome, "B is still open").toBe("pending");
      // A's unfilled grant was released: B's second step now fits.
      b.controller.enqueue(new Uint8Array(STEP));
      const written = await Promise.race([b.spool.whenWritten(KIB + STEP), b.spool.done.then(() => -1, () => -1)]);
      expect(written, "B took a step-sized chunk once A had ended").toBeGreaterThanOrEqual(KIB + STEP);
      expect((await settledWithin(b.spool.done, 200)).outcome, "B is still open after its second step").toBe("pending");
    } finally {
      await end(a?.spool);
      await end(b?.spool);
    }
  }, 60_000);

  it("T4: the unfilled grant is released however the spool ends", async () => {
    // Catches a release that misses one ending, so each such upload leaks its unfilled step until the disk reads as full.
    disk.free = Math.ceil(need(GIB));
    const endings: Array<[string, (run: Awaited<ReturnType<typeof spoolWith>>) => void]> = [
      ["the body ends", (run) => run.controller.close()],
      ["the body errors", (run) => run.controller.error(new Error("the body broke"))],
      ["the spool is aborted", (run) => run.spool.abort(new Error("gone"))],
    ];
    for (const [how, finish] of endings) {
      const run = await spoolWith(GIB, KIB);
      finish(run);
      await run.spool.done.then((written) => written.dispose(), () => undefined);
      expect(await admits(GIB), `everything was released when ${how}`).toBe(true);
    }
  }, 60_000);

  it("T5: another household's export is not refused while an upload trickles", async () => {
    // Catches the export preflight subtracting a trickling upload's whole declared size, so a stalled upload blocks every household's export.
    const fixture = await createIntegrationFixture("arch1820-export-beside-spool");
    const input = { userId: fixture.users.owner.id, householdId: fixture.household.id, passphrase, includeDocuments: false };
    const measured = await createPortableArchive(input);
    const [{ sizeBytes: fileBytes }] = await getDb().select({ sizeBytes: portableArchives.sizeBytes }).from(portableArchives).where(eq(portableArchives.id, measured.id));
    expect(fileBytes).toBeGreaterThan(0);

    disk.free = Math.ceil(need(5 * GIB)); // the upload is admitted
    let spool: Spool | undefined;
    try {
      spool = (await spoolWith(5 * GIB, KIB)).spool;
      disk.free = Math.ceil(need(fileBytes) + STEP + MIB); // the export fits beside one step, not beside 5 GiB
      await expect(createPortableArchive(input), "the export was refused beside a trickling upload").resolves.toBeDefined();
    } finally {
      await end(spool);
    }
  }, 120_000);

  it("T6: the declared size is still checked before a byte is written", async () => {
    // Catches a fix that drops the admission check and assumes every upload is small.
    disk.free = Math.floor(need(100 * MIB)) - 1;
    await expect(spoolPortableArchiveUpload(body().stream, 100 * MIB)).rejects.toMatchObject({
      code: "archive_storage_full",
      status: 507,
      message: "Orbit's disk has no room to take in an archive of this size (about 0.1 GiB)",
    });
    expect(await spoolFiles(), "no spool file").toEqual([]);
  });
});
