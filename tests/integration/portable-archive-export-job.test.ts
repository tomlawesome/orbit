/**
 * #1774 (design note d1774.md section 4, tests 1-12): the household export is
 * a leased background job. POST /api/households/{id}/portable-archives
 * inserts a row in `portable_archive_exports` and answers 202; the document
 * worker's export seam claims it, takes the archive slot, writes the file and
 * completes the row in one transaction. Written from the specification
 * alone, before any of it exists: every test here fails today.
 *
 * THE CONTRACT THE BUILDER MUST PROVIDE (names the design fixes are marked
 * [design]; the rest are this file's smallest choices and are the builder's
 * to provide as written, or to come back and change here):
 *
 *  [design] table `portable_archive_exports` (drizzle/0024), its columns as the
 *    design's section 2.1 table; only id, household_id, requested_by_user_id,
 *    include_documents and status need a value on insert (the rest default or
 *    are nullable: attempts 0, next_attempt_at/created_at/updated_at now()).
 *    Partial unique index `portable_archive_exports_one_live`.
 *  [design] routes: POST and GET on households/[householdId]/portable-archives;
 *    POST .../portable-archives/[jobId]/retry (params householdId, jobId).
 *    POST answers 202 `{ export }`; GET answers `{ export, latest }`; retry
 *    answers 200 or 202 `{ export }`. `export` is
 *    { id, status, bytesDone, bytesTotal, createdAt, failureCode,
 *      failureMessage, canRetry } (numbers, not strings, for the bytes).
 *  [design] `requeueInterruptedExports()`, `notifyExportWorker()`.
 *  [design] `writePortableArchiveForJob` exported from
 *    @/server/portable-archive-repository (only its existence is checked).
 *  [chosen] `@/server/document-maintenance/export-jobs` exports
 *    `runExportWorkerOnce(): Promise<number>`, mirroring
 *    `runPreviewWorkerOnce`: claim at most ONE due export (pending, or retry
 *    with next_attempt_at <= now, or processing with an expired lease), wait
 *    for the archive slot up to ORBIT_ARCHIVE_SLOT_WAIT_MS (read from
 *    process.env at call time), run it to its end, resolve with the number of
 *    exports it took (0 when none is due; a slot wait that ran out puts the
 *    row to `retry`, next_attempt_at about now + 60 s, attempts as before
 *    the claim, and resolves). `requeueInterruptedExports` and
 *    `notifyExportWorker` are exported from the same module.
 *  [chosen] `@/server/portable-archive-repository` exports
 *    `setPortableArchiveExportHooksForTests(hooks | null)`, hooks being
 *      { afterDocument?(ctx: { jobId: string; index: number }): void | Promise<void>;
 *        inCompletion?(ctx: { jobId: string }): void | Promise<void> }
 *    `afterDocument` runs after document `index` (0-based) was pushed to the
 *    writer and AFTER the writer has made its fenced progress/lease update
 *    for it (a heartbeat that is unconditional here: tests have documents
 *    far smaller than 64 MiB and finish well inside a second). `inCompletion`
 *    runs inside the completing transaction after the archive row and the
 *    audit row are inserted and the job row is set completed.
 *    `PortableArchiveExportCrash` (an Error subclass, same module) thrown from
 *    either hook simulates the process dying: the runner writes nothing more
 *    to the job row, rolls back any open transaction, and rethrows it out of
 *    `runExportWorkerOnce`. Any other error follows the real failure path.
 *  [chosen] `enqueuePortableArchiveExport({ userId, householdId, passphrase,
 *    includeDocuments }): Promise<{ id: string }>` from the same repository
 *    module: what the route does after its checks (insert the job with the
 *    wrapped key). Used by the memory child only.
 *  [chosen] a failed job's key is kept one hour measured from `updated_at`
 *    (the failure write is the last write to a failed row); the sweep that
 *    nulls it and the one that deletes final rows after 24 h (also
 *    `updated_at`, and `created_at` for the GET's window) both run in
 *    `runDocumentMaintenanceCycle()`.
 *  [chosen] slot core exported from @/server/archive-slot:
 *    `claimArchiveSlot()`, `archiveSlotHeld()`.
 *  [chosen] `failure_message` of a three-times interrupted job contains
 *    "Orbit restarted while writing this archive".
 */

import { randomBytes, scryptSync } from "node:crypto";
import { readdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, items, portableArchives } from "@/db/schema";
import { claimArchiveSlot } from "@/server/archive-slot";
import { runDocumentMaintenanceCycle } from "@/server/document-worker";
import {
  readPortableArchive,
  reconcilePortableArchiveStorage,
  setPortableArchiveExportHooksForTests,
  PortableArchiveExportCrash,
} from "@/server/portable-archive-repository";
import * as repository from "@/server/portable-archive-repository";
import { requeueInterruptedExports, runExportWorkerOnce } from "@/server/document-maintenance/export-jobs";
import { paddedPdfOfSize } from "../support/large-pdf";
import { v2PayloadOf } from "../support/portable-archive-v2";
import { ORIGIN } from "./support/auth";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture, type IntegrationSession } from "./support/fixtures";
import { proofCookie } from "./support/portable-archive-routes";
import { callRouteForSession, loadRoute } from "./support/request-event";
import { seedStoredDocuments } from "./support/stored-documents";

const { POST: startExport, GET: readExportState } = await loadRoute("households/[householdId]/portable-archives");
const { POST: retryExport } = await loadRoute("households/[householdId]/portable-archives/[jobId]/retry");
const { GET: downloadArchive } = await loadRoute("portable-archives/[archiveId]/download");

// node:fs/promises is wrapped, not replaced: statfs reports a nearly full
// disk when asked to (the same device as portable-archive-v2-export-disk).
const disk = vi.hoisted(() => ({ nearlyFull: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const wrapped = {
    ...original,
    statfs: (async (path: Parameters<typeof original.statfs>[0], options?: Parameters<typeof original.statfs>[1]) => {
      const real = await original.statfs(path, options as never);
      return disk.nearlyFull ? Object.assign(Object.create(Object.getPrototypeOf(real)), real, { bavail: 1, bfree: 1, bsize: 4096 }) : real;
    }) as typeof original.statfs,
  };
  return { ...wrapped, default: wrapped };
});

const MIB = 1_048_576;
const HOUR_MS = 3_600_000;
const PASSPHRASE = "correct-horse-battery-staple";
const SETTLE_MS = 120_000;

beforeAll(() => {
  expect(typeof repository.writePortableArchiveForJob, "writePortableArchiveForJob is exported").toBe("function");
});

afterEach(async () => {
  disk.nearlyFull = false;
  setPortableArchiveExportHooksForTests(null);
  // A leftover live job of one test must not be the next test's claim.
  await getDb().execute(sql`delete from portable_archive_exports`);
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type ExportState = {
  id: string; status: string; bytesDone: number | null; bytesTotal: number | null; createdAt: string;
  failureCode: string | null; failureMessage: string | null; canRetry: boolean;
};
type JobRow = Record<string, unknown> & {
  id: string; status: string; attempts: number; next_attempt_at: Date; lease_expires_at: Date | null; lease_token: string | null;
  bytes_total: string | number | null; bytes_done: string | number | null; salt: Buffer | null; key_wrapped: unknown; key_id: string | null;
  archive_id: string | null; failure_code: string | null; failure_message: string | null; updated_at: Date; created_at: Date;
};

const errorCode = async (response: Response) => ((await response.clone().json()) as { error?: { code?: string } }).error?.code ?? "";

async function start(session: IntegrationSession, fixture: IntegrationFixture, options: { includeDocuments?: boolean; proof?: boolean } = {}): Promise<Response> {
  const cookie = options.proof === false ? undefined : await proofCookie(session, "archive_export");
  return callRouteForSession(startExport, session, {
    url: `${ORIGIN}/api/households/${fixture.household.id}/portable-archives`,
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ passphrase: PASSPHRASE, includeDocuments: options.includeDocuments ?? false }),
    params: { householdId: fixture.household.id },
  });
}

async function started(session: IntegrationSession, fixture: IntegrationFixture, includeDocuments = false): Promise<string> {
  const response = await start(session, fixture, { includeDocuments });
  expect(response.status).toBe(202);
  return ((await response.json()) as { export: ExportState }).export.id;
}

function readState(session: IntegrationSession, fixture: IntegrationFixture): Promise<Response> {
  return callRouteForSession(readExportState, session, {
    url: `${ORIGIN}/api/households/${fixture.household.id}/portable-archives`,
    params: { householdId: fixture.household.id },
  });
}

async function stateOf(session: IntegrationSession, fixture: IntegrationFixture) {
  const response = await readState(session, fixture);
  expect(response.status).toBe(200);
  return (await response.json()) as { export: ExportState | null; latest: { id: string; expiresAt: string; includesDocuments: boolean; downloadUrl: string; keepPerHousehold: number } | null };
}

async function retry(session: IntegrationSession, fixture: IntegrationFixture, jobId: string, options: { proof?: boolean; expectedStatus?: string } = {}): Promise<Response> {
  const cookie = options.proof === false ? undefined : await proofCookie(session, "archive_export");
  return callRouteForSession(retryExport, session, {
    url: `${ORIGIN}/api/households/${fixture.household.id}/portable-archives/${jobId}/retry`,
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ expectedStatus: options.expectedStatus ?? "failed" }),
    params: { householdId: fixture.household.id, jobId },
  });
}

async function job(id: string): Promise<JobRow> {
  const rows = await getDb().execute(sql`select * from portable_archive_exports where id = ${id}`);
  expect(rows.length, `job ${id} exists`).toBe(1);
  return rows[0] as unknown as JobRow;
}

async function jobExists(id: string): Promise<boolean> {
  return (await getDb().execute(sql`select 1 from portable_archive_exports where id = ${id}`)).length === 1;
}

const archiveDirectory = () => join(process.env.DOCUMENTS_ROOT!, "portable-archives");

async function archiveFiles(): Promise<string[]> {
  try {
    return (await readdir(archiveDirectory(), { recursive: true })).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function archiveCount(householdId: string): Promise<number> {
  return (await getDb().select({ id: portableArchives.id }).from(portableArchives).where(eq(portableArchives.householdId, householdId))).length;
}

async function withDocuments(label: string, count: number, bytes: number): Promise<IntegrationFixture> {
  const fixture = await createIntegrationFixture(label);
  // Distinct sizes, so no two documents are the same file.
  await seedStoredDocuments(fixture, Array.from({ length: count }, (_, index) => paddedPdfOfSize(bytes + index)));
  return fixture;
}

async function withEnv<T>(name: string, value: string, work: () => Promise<T>): Promise<T> {
  const saved = process.env[name];
  process.env[name] = value;
  try {
    return await work();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

/** Held until `release()`; resolves `reached` the first time the hook is entered. */
function pausingHook(onReached?: (index: number) => Promise<void>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => { reach = resolve; });
  let calls = 0;
  return {
    release,
    reached,
    hook: async ({ index }: { index: number }) => {
      calls += 1;
      if (calls === 1) {
        reach();
        await onReached?.(index);
        await gate;
      }
    },
  };
}

describe("test 1: the POST returns at once with a pending job and no plaintext key", () => {
  it("answers 202 within 2 s for 200 MiB of documents, writes no file, and stores the key only wrapped", async () => {
    const fixture = await withDocuments("export-job-fast-202", 20, 10 * MIB);
    const owner = await fixture.session("owner");
    const archivesBefore = await archiveCount(fixture.household.id);
    const filesBefore = await archiveFiles();

    const began = Date.now();
    const response = await start(owner, fixture, { includeDocuments: true });
    expect(Date.now() - began, "the POST does not write the archive").toBeLessThan(2_000);
    expect(response.status).toBe(202);
    const body = (await response.json()) as { export: ExportState };
    expect(body.export).toMatchObject({ status: "pending", failureCode: null, failureMessage: null });
    expect(Object.keys(body.export).sort()).toEqual(["bytesDone", "bytesTotal", "canRetry", "createdAt", "failureCode", "failureMessage", "id", "status"]);

    expect(await archiveCount(fixture.household.id), "no archive row yet").toBe(archivesBefore);
    expect(await archiveFiles(), "no file yet").toEqual(filesBefore);

    const row = await job(body.export.id);
    expect(row.status).toBe("pending");
    expect(Buffer.from(row.salt!).length, "the 16 byte salt").toBe(16);
    expect(row.key_wrapped, "the wrapped key").not.toBeNull();
    expect(row.key_id).toEqual(expect.any(String));

    // Nothing in the row, or the household's audit lines, holds the passphrase or the derived key, in any spelling.
    const key = scryptSync(PASSPHRASE, Buffer.from(row.salt!), 32, { N: 2 ** 14, r: 8, p: 5, maxmem: 128 * MIB });
    const needles = [Buffer.from(PASSPHRASE, "utf8"), key];
    const audit = await getDb().select().from(auditLog).where(eq(auditLog.householdId, fixture.household.id));
    const blobs = (value: unknown): Buffer[] => {
      if (value === null || value === undefined || value instanceof Date) return [];
      if (Buffer.isBuffer(value)) return [value];
      if (typeof value === "object") return [Buffer.from(JSON.stringify(value)), ...Object.values(value as object).flatMap(blobs)];
      return [Buffer.from(String(value), "utf8")];
    };
    for (const blob of [...blobs(row), ...blobs(audit)]) {
      const text = blob.toString("latin1");
      for (const needle of needles) {
        const spelled = [needle.toString("latin1"), needle.toString("hex"), needle.toString("base64")];
        expect(blob.includes(needle) || spelled.some((spelling) => text.includes(spelling)), "a secret was stored in plain").toBe(false);
      }
    }
  }, SETTLE_MS);
});

describe("test 2: one worker pass completes the job, in one commit", () => {
  it("records the archive and completes the job together, nulls the key, and the file opens with the passphrase", async () => {
    const fixture = await createIntegrationFixture("export-job-complete");
    const owner = await fixture.session("owner");
    const id = await started(owner, fixture);

    expect(await runExportWorkerOnce()).toBe(1);

    const done = await job(id);
    expect(done.status).toBe("completed");
    expect(done.archive_id).toEqual(expect.any(String));
    expect(Number(done.bytes_done)).toBe(Number(done.bytes_total));
    expect(Number(done.bytes_total)).toBeGreaterThan(0);
    expect([done.salt, done.key_wrapped, done.key_id], "the key columns are null once completed").toEqual([null, null, null]);

    const [archive] = await getDb().select().from(portableArchives).where(eq(portableArchives.id, done.archive_id!));
    expect(archive).toMatchObject({ householdId: fixture.household.id, requestedByUserId: fixture.users.owner.id, includesDocuments: false });
    expect(archive.sizeBytes).toBe(Number(done.bytes_total));

    const file = Buffer.from((await readPortableArchive(fixture.users.owner.id, archive.id)).bytes);
    expect(file.subarray(0, 8).toString("latin1")).toBe("ORBITARC");
    const payload = v2PayloadOf(file, PASSPHRASE) as unknown as { items: Array<{ id: string }>; household: { name: string } };
    expect(payload.household.name).toBe(fixture.household.name);
    expect(payload.items.map((item) => item.id)).toContain(fixture.item.id);
  }, SETTLE_MS);

  it("leaves no archive row and an unfinished job when the completing transaction dies on its last statements", async () => {
    const fixture = await createIntegrationFixture("export-job-atomic");
    const owner = await fixture.session("owner");
    const id = await started(owner, fixture);
    const before = await archiveCount(fixture.household.id);
    const auditBefore = await fixture.auditCount();
    setPortableArchiveExportHooksForTests({ inCompletion: () => { throw new PortableArchiveExportCrash("the audit insert failed"); } });

    await expect(runExportWorkerOnce()).rejects.toBeInstanceOf(PortableArchiveExportCrash);

    expect(await archiveCount(fixture.household.id), "no archive row").toBe(before);
    expect((await job(id)).status, "the job is not completed").toBe("processing");
    expect((await job(id)).archive_id).toBeNull();
    // Only the route's own "started" line may be new: the completion's audit row rolled back with the rest.
    const requested = await getDb().execute(sql`select 1 from audit_log where household_id = ${fixture.household.id} and action = 'portable_archive_requested'`);
    expect(requested.length).toBe(0);
    expect(await fixture.auditCount()).toBeLessThanOrEqual(auditBefore + 1);
  }, SETTLE_MS);
});

describe("test 3: one live export per household", () => {
  it("refuses a second start while one is pending or processing, accepts another household, and replaces a final row", async () => {
    const first = await createIntegrationFixture("export-job-once-a");
    const second = await createIntegrationFixture("export-job-once-b");
    const ownerA = await first.session("owner");
    const ownerB = await second.session("owner");
    const id = await started(ownerA, first);

    const again = await start(ownerA, first);
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("archive_export_in_progress");

    const other = await start(ownerB, second);
    expect(other.status, "another household is not held up").toBe(202);

    // Processing counts as live too.
    await getDb().execute(sql`update portable_archive_exports set status = 'processing', lease_token = gen_random_uuid(), lease_expires_at = now() + interval '10 minutes' where id = ${id}`);
    const whileProcessing = await start(ownerA, first);
    expect(whileProcessing.status).toBe(409);
    expect(await errorCode(whileProcessing)).toBe("archive_export_in_progress");

    // Run it to the end (the lease is forced due, the other household's job may go first), then a new start is accepted and the old final row goes.
    await getDb().execute(sql`update portable_archive_exports set status = 'pending', lease_token = null, lease_expires_at = null where id = ${id}`);
    await getDb().execute(sql`delete from portable_archive_exports where household_id = ${second.household.id}`);
    expect(await runExportWorkerOnce()).toBe(1);
    expect((await job(id)).status).toBe("completed");

    const next = await start(ownerA, first);
    expect(next.status).toBe(202);
    expect(await jobExists(id), "the old final row is gone").toBe(false);
  }, SETTLE_MS);
});

describe("test 4: the archive slot", () => {
  it("waits while the slot is held and runs when it is released", async () => {
    const fixture = await createIntegrationFixture("export-job-slot-wait");
    const owner = await fixture.session("owner");
    const id = await started(owner, fixture);
    const held = claimArchiveSlot();
    expect(held, "the test took the slot").not.toBeNull();
    try {
      const pass = runExportWorkerOnce();
      let settled = false;
      void pass.then(() => { settled = true; }, () => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(settled, "the pass is still waiting").toBe(false);
      expect((await job(id)).status).not.toBe("completed");
      held!.release();
      await pass;
    } finally {
      held?.release();
    }
    expect((await job(id)).status).toBe("completed");
  }, SETTLE_MS);

  it("goes back to retry when the wait runs out, counts no attempt, and runs on the next pass", async () => {
    const fixture = await createIntegrationFixture("export-job-slot-expired");
    const owner = await fixture.session("owner");
    const id = await started(owner, fixture);
    const attemptsBefore = (await job(id)).attempts;
    const held = claimArchiveSlot();
    expect(held).not.toBeNull();
    try {
      const began = Date.now();
      await withEnv("ORBIT_ARCHIVE_SLOT_WAIT_MS", "150", () => runExportWorkerOnce());
      const row = await job(id);
      expect(row.status).toBe("retry");
      expect(row.attempts, "a slot that never came is not an attempt").toBe(attemptsBefore);
      const delayMs = new Date(row.next_attempt_at).getTime() - began;
      expect(delayMs).toBeGreaterThan(50_000);
      expect(delayMs).toBeLessThan(70_000);
      expect(row.lease_expires_at === null || new Date(row.lease_expires_at).getTime() <= Date.now() + 1_000).toBe(true);
    } finally {
      held?.release();
    }
    // The clock: the retry is due now.
    await getDb().execute(sql`update portable_archive_exports set next_attempt_at = now() where id = ${id}`);
    expect(await runExportWorkerOnce()).toBe(1);
    expect((await job(id)).status).toBe("completed");
  }, SETTLE_MS);
});

describe("test 5: progress", () => {
  it("shows bytes between 0 and the total and a renewed lease between two documents, and the GET says the same", async () => {
    const fixture = await withDocuments("export-job-progress", 3, MIB);
    const owner = await fixture.session("owner");
    const id = await started(owner, fixture, true);
    const seen: Array<{ index: number; done: number; total: number; lease: number; reported: ExportState | null }> = [];
    setPortableArchiveExportHooksForTests({
      afterDocument: async ({ index }) => {
        const row = await job(id);
        const reported = (await stateOf(owner, fixture)).export;
        seen.push({ index, done: Number(row.bytes_done), total: Number(row.bytes_total), lease: new Date(row.lease_expires_at!).getTime(), reported });
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
    });

    await runExportWorkerOnce();

    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const entry of seen) {
      expect(entry.total).toBeGreaterThan(0);
      expect(entry.done).toBeGreaterThan(0);
      expect(entry.done).toBeLessThan(entry.total);
      expect(entry.reported).toMatchObject({ id, status: "processing", bytesDone: entry.done, bytesTotal: entry.total });
    }
    expect(seen[1].done, "progress moves forward").toBeGreaterThan(seen[0].done);
    expect(seen[1].lease, "the lease is renewed with it").toBeGreaterThan(seen[0].lease);
    expect((await job(id)).status).toBe("completed");
  }, SETTLE_MS);
});

describe("test 6: a lost lease aborts the write and records nothing", () => {
  it("another claim takes the row mid-write: the first writer's next fenced update changes 0 rows, it removes its file and the job ends with exactly one archive", async () => {
    const fixture = await withDocuments("export-job-lost-lease", 3, MIB);
    const owner = await fixture.session("owner");
    const id = await started(owner, fixture, true);
    const archivesBefore = await archiveCount(fixture.household.id);
    const filesBefore = await archiveFiles();
    const pause = pausingHook(async () => {
      // A sweep gave the job to a new claim: a new token, one more attempt.
      await getDb().execute(sql`update portable_archive_exports set lease_token = gen_random_uuid(), attempts = attempts + 1 where id = ${id}`);
    });
    setPortableArchiveExportHooksForTests({ afterDocument: pause.hook });

    const first = runExportWorkerOnce().then(() => null, (error: unknown) => error);
    await pause.reached;
    pause.release();
    const outcome = await first;
    expect(outcome, "the lost lease ends the write quietly, not as a crash").not.toBeInstanceOf(PortableArchiveExportCrash);

    const row = await job(id);
    expect(row.status, "the other claim's row is not touched by the writer that lost it").toBe("processing");
    expect(row.archive_id).toBeNull();
    expect(await archiveCount(fixture.household.id), "nothing recorded").toBe(archivesBefore);
    expect(await archiveFiles(), "the temporary file is removed").toEqual(filesBefore);

    // The other claim's lease runs out in turn and the job is taken once more: one archive in the end.
    setPortableArchiveExportHooksForTests(null);
    await getDb().execute(sql`update portable_archive_exports set lease_expires_at = now() - interval '1 minute' where id = ${id}`);
    await runExportWorkerOnce();
    expect((await job(id)).status).toBe("completed");
    expect(await archiveCount(fixture.household.id)).toBe(archivesBefore + 1);
  }, SETTLE_MS);
});

describe("test 7: a restart mid-write", () => {
  async function crashOnce(): Promise<void> {
    setPortableArchiveExportHooksForTests({ afterDocument: () => { throw new PortableArchiveExportCrash("killed mid-document"); } });
    await expect(runExportWorkerOnce()).rejects.toBeInstanceOf(PortableArchiveExportCrash);
    setPortableArchiveExportHooksForTests(null);
  }

  it("requeues the processing row at boot, re-runs it from nothing and completes on attempt 2, the orphan temp file going with the next tidy", async () => {
    const fixture = await withDocuments("export-job-restart", 2, MIB);
    const owner = await fixture.session("owner");
    const id = await started(owner, fixture, true);
    const filesBefore = await archiveFiles();

    await crashOnce();
    const killed = await job(id);
    expect(killed.status).toBe("processing");
    expect(new Date(killed.lease_expires_at!).getTime(), "the lease is live").toBeGreaterThan(Date.now());

    await requeueInterruptedExports();
    const requeued = await job(id);
    expect(requeued.status).toBe("retry");
    expect(Number(requeued.bytes_done)).toBe(0);
    expect(new Date(requeued.next_attempt_at).getTime()).toBeLessThanOrEqual(Date.now() + 1_000);

    await runExportWorkerOnce();
    const done = await job(id);
    expect(done.status).toBe("completed");
    expect(done.attempts).toBe(2);

    // The first run's temp file: an hour old by the clock, then gone after the tidy.
    for (const name of await archiveFiles()) {
      if (!name.endsWith(".tmp")) continue;
      const old = new Date(Date.now() - 2 * HOUR_MS);
      await utimes(join(archiveDirectory(), name), old, old);
    }
    await reconcilePortableArchiveStorage();
    const left = (await archiveFiles()).filter((name) => !filesBefore.includes(name));
    expect(left.filter((name) => name.endsWith(".tmp")), "no temp file is left").toEqual([]);
    expect(left, "only the finished archive is new").toHaveLength(1);
  }, SETTLE_MS);

  it("ends as failed after three interruptions in a row, in words the person can read", async () => {
    const fixture = await withDocuments("export-job-restart-thrice", 2, MIB);
    const owner = await fixture.session("owner");
    const id = await started(owner, fixture, true);

    for (const expected of ["retry", "retry", "failed"]) {
      await crashOnce();
      await requeueInterruptedExports();
      expect((await job(id)).status).toBe(expected);
    }
    const row = await job(id);
    expect(row.attempts).toBe(3);
    expect(row.failure_message).toContain("Orbit restarted while writing this archive");
    const reported = (await stateOf(owner, fixture)).export;
    expect(reported).toMatchObject({ id, status: "failed", canRetry: true });
    expect(reported!.failureMessage).toContain("Orbit restarted while writing this archive");
  }, SETTLE_MS);
});

describe("test 8: failures the export already knows end the job at once", () => {
  async function expectFailedAtOnce(id: string, code: string) {
    const row = await job(id);
    expect(row.status).toBe("failed");
    expect(row.failure_code).toBe(code);
    expect(row.failure_message).toEqual(expect.any(String));
    // Nothing automatic retries it: a further pass takes nothing and changes nothing.
    expect(await runExportWorkerOnce()).toBe(0);
    const after = await job(id);
    expect([after.status, after.attempts, new Date(after.next_attempt_at).getTime(), new Date(after.updated_at).getTime()])
      .toEqual([row.status, row.attempts, new Date(row.next_attempt_at).getTime(), new Date(row.updated_at).getTime()]);
  }

  it("a damaged item field fails the job with archive_metadata_damaged and the existing words", async () => {
    const fixture = await createIntegrationFixture("export-job-damaged");
    const owner = await fixture.session("owner");
    await getDb().update(items).set({ titleEnc: randomBytes(48).toString("base64") }).where(eq(items.id, fixture.item.id));
    const id = await started(owner, fixture);

    await runExportWorkerOnce();

    await expectFailedAtOnce(id, "archive_metadata_damaged");
    expect((await job(id)).failure_message).toContain("an item's stored details are damaged");
    expect(await archiveCount(fixture.household.id)).toBe(1); // the fixture's own
    const reported = (await stateOf(owner, fixture)).export;
    expect(reported).toMatchObject({ status: "failed", failureCode: "archive_metadata_damaged" });
  }, SETTLE_MS);

  it("free space below the margin fails the job with archive_storage_full", async () => {
    const fixture = await createIntegrationFixture("export-job-storage-full");
    const owner = await fixture.session("owner");
    const id = await started(owner, fixture);
    disk.nearlyFull = true;

    await runExportWorkerOnce();
    disk.nearlyFull = false;

    await expectFailedAtOnce(id, "archive_storage_full");
  }, SETTLE_MS);
});

describe("test 9: retry", () => {
  async function failedJob(label: string) {
    const fixture = await createIntegrationFixture(label);
    const owner = await fixture.session("owner");
    const [original] = await getDb().select({ titleEnc: items.titleEnc }).from(items).where(eq(items.id, fixture.item.id));
    await getDb().update(items).set({ titleEnc: randomBytes(48).toString("base64") }).where(eq(items.id, fixture.item.id));
    const id = await started(owner, fixture);
    await runExportWorkerOnce();
    expect((await job(id)).status).toBe("failed");
    return { fixture, owner, id, repair: () => getDb().update(items).set({ titleEnc: original.titleEnc }).where(eq(items.id, fixture.item.id)) };
  }

  it("asks for the step-up as the start does, then sets the job pending, runs it and completes", async () => {
    const { fixture, owner, id, repair } = await failedJob("export-job-retry");
    await repair();

    const bare = await retry(owner, fixture, id, { proof: false });
    expect(bare.status).toBe(403);
    expect(await errorCode(bare)).toBe("recent_authentication_required");
    expect((await job(id)).status, "nothing moved").toBe("failed");

    const response = await retry(owner, fixture, id);
    expect([200, 202]).toContain(response.status);
    expect(((await response.json()) as { export: ExportState }).export).toMatchObject({ id, status: "pending", failureCode: null });
    const pending = await job(id);
    expect(pending.status).toBe("pending");
    expect(pending.attempts).toBe(0);
    expect(pending.failure_code).toBeNull();
    expect(pending.key_wrapped, "the key was still there").not.toBeNull();

    await runExportWorkerOnce();
    expect((await job(id)).status).toBe("completed");
  }, SETTLE_MS);

  it("is 409 when the status has moved, for a completed job and for one already pending", async () => {
    const { fixture, owner, id, repair } = await failedJob("export-job-retry-moved");
    await repair();
    expect((await retry(owner, fixture, id)).status).toBeLessThan(300);
    const pending = await retry(owner, fixture, id);
    expect(pending.status, "already pending: the compare-and-swap loses").toBe(409);

    await runExportWorkerOnce();
    expect((await job(id)).status).toBe("completed");
    const completed = await retry(owner, fixture, id);
    expect(completed.status).toBe(409);
    expect(await errorCode(completed)).not.toBe("archive_export_key_gone");
  }, SETTLE_MS);

  it("after an hour the key is swept and the retry is 409 archive_export_key_gone", async () => {
    const { fixture, owner, id } = await failedJob("export-job-retry-key-gone");
    await getDb().execute(sql`update portable_archive_exports set updated_at = now() - interval '61 minutes' where id = ${id}`);

    await runDocumentMaintenanceCycle();

    const swept = await job(id);
    expect(swept.status).toBe("failed");
    expect([swept.salt, swept.key_wrapped, swept.key_id]).toEqual([null, null, null]);
    const response = await retry(owner, fixture, id);
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("archive_export_key_gone");
    expect((await stateOf(owner, fixture)).export).toMatchObject({ id, status: "failed", canRetry: false });
  }, SETTLE_MS);
});

describe("test 10: access and the 24 hour window", () => {
  it("refuses a plain member, shows the owner the last archive after a reload with a working download, and drops a job older than 24 h", async () => {
    const fixture = await createIntegrationFixture("export-job-access");
    const owner = await fixture.session("owner");
    const member = await fixture.session("member");

    const refused = await readState(member, fixture);
    expect(refused.status).toBe(403);
    expect(await errorCode(refused)).toBe("owner_required");

    const id = await started(owner, fixture);
    expect((await stateOf(owner, fixture)).export).toMatchObject({ id, status: "pending" });
    await runExportWorkerOnce();

    // "After reload": a fresh read with nothing but the session.
    const state = await stateOf(owner, fixture);
    expect(state.export).toMatchObject({ id, status: "completed" });
    expect(state.latest).toMatchObject({ includesDocuments: false, downloadUrl: expect.stringMatching(/^\/api\/portable-archives\/[0-9a-f-]+\/download$/) });
    expect(state.latest!.keepPerHousehold).toEqual(expect.any(Number));
    expect(Date.parse(state.latest!.expiresAt)).toBeGreaterThan(Date.now());
    const download = await callRouteForSession(downloadArchive, owner, {
      url: `${ORIGIN}${state.latest!.downloadUrl}`,
      params: { archiveId: state.latest!.id },
    });
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).subarray(0, 8).toString("latin1")).toBe("ORBITARC");

    await getDb().execute(sql`update portable_archive_exports set created_at = now() - interval '25 hours', updated_at = now() - interval '25 hours' where id = ${id}`);
    const old = await stateOf(owner, fixture);
    expect(old.export, "older than 24 hours reads as none").toBeNull();
    expect(old.latest, "the archive itself is not the job").not.toBeNull();
    await runDocumentMaintenanceCycle();
    expect(await jobExists(id), "the sweep deleted the final row").toBe(false);
  }, SETTLE_MS);
});

describe("test 11: audit", () => {
  it("writes portable_archive_export_started from the route and portable_archive_requested from the completion, both by the requester", async () => {
    const fixture = await createIntegrationFixture("export-job-audit");
    const owner = await fixture.session("owner");
    const id = await started(owner, fixture);
    const lines = async (action: string) => (await getDb().select().from(auditLog).where(eq(auditLog.householdId, fixture.household.id)))
      .filter((line) => line.action === action);

    expect(await lines("portable_archive_export_started"), "from the route, before the worker runs").toHaveLength(1);
    expect(await lines("portable_archive_requested")).toHaveLength(0);
    await runExportWorkerOnce();

    const startedLines = await lines("portable_archive_export_started");
    const requested = await lines("portable_archive_requested");
    expect(startedLines).toHaveLength(1);
    expect(requested).toHaveLength(1);
    expect(startedLines[0].actorUserId).toBe(fixture.users.owner.id);
    expect(requested[0].actorUserId).toBe(fixture.users.owner.id);
    expect(requested[0].entityId, "the completion's line names the archive").toBe((await job(id)).archive_id);
  }, SETTLE_MS);
});

describe("test 12: migration 0024 and the one-live index", () => {
  it("refuses a second live row for one household in plain SQL, and allows a final one beside a live one", async () => {
    const fixture = await createIntegrationFixture("export-job-index");
    const insert = (status: string) => getDb().execute(sql`
      insert into portable_archive_exports (id, household_id, requested_by_user_id, include_documents, status)
      values (gen_random_uuid(), ${fixture.household.id}, ${fixture.users.owner.id}, false, ${status}::document_job_status)`);

    await insert("pending");
    for (const status of ["pending", "processing", "retry"]) {
      const refusal = await insert(status).then(() => null, (error: { message?: string; cause?: { message?: string; constraint_name?: string } }) => error);
      expect(refusal, `a second ${status} row is refused`).not.toBeNull();
      expect(`${refusal!.message} ${refusal!.cause?.message} ${refusal!.cause?.constraint_name}`).toContain("portable_archive_exports_one_live");
    }
    await insert("failed");
    await insert("completed");
    const other = await createIntegrationFixture("export-job-index-other");
    await getDb().execute(sql`
      insert into portable_archive_exports (id, household_id, requested_by_user_id, include_documents, status)
      values (gen_random_uuid(), ${other.household.id}, ${other.users.owner.id}, false, 'pending')`);
  });
});
