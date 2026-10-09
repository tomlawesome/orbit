import { eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { documentJobs } from "@/db/schema";
import { log } from "@/lib/logger";
import { completeJob, failJob, holdsJobLease, jobFailureCode } from "./claims";

/*
 * The job-finishing writes were copied twelve times (#1349, engine-17). These
 * pin the one copy against a recording stand-in for the database; the worker
 * characterization suite and the document integration suites pin each caller.
 */
const JOB = { id: "40000000-0000-4000-8000-000000000004", leaseToken: "50000000-0000-4000-8000-000000000005" };

function recordingDb(options: { attempts?: number; matched?: number } = {}) {
  const writes: { values: Record<string, unknown>; where: unknown }[] = [];
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (options.attempts === undefined ? [] : [{ attempts: options.attempts }]) }) }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (where: unknown) => {
          writes.push({ values, where });
          const matched = Array.from({ length: options.matched ?? 1 }, () => ({ id: JOB.id }));
          return Object.assign(Promise.resolve(undefined), { returning: async () => matched });
        },
      }),
    }),
  };
  return { db: db as never, writes };
}

const sqlOf = (where: unknown) => new PgDialect().sqlToQuery(where as never);

afterEach(() => vi.restoreAllMocks());

describe("holdsJobLease", () => {
  it("names the row, the processing status and the lease token, and nothing else", () => {
    const { sql, params } = sqlOf(holdsJobLease(JOB));
    expect(sql).toContain('"document_jobs"."id" = $1');
    expect(sql).toContain('"document_jobs"."status" = $2');
    expect(sql).toContain('"document_jobs"."lease_token" = $3');
    expect(params).toEqual([JOB.id, "processing", JOB.leaseToken]);
  });
});

describe("completeJob", () => {
  const now = new Date("2030-01-02T03:04:05.000Z");

  it("completes under the caller's predicate and drops the lease", async () => {
    const { db, writes } = recordingDb();
    const owns = eq(documentJobs.id, JOB.id);
    expect(await completeJob(db, owns, { now })).toBe(true);
    expect(writes[0].where).toBe(owns);
    expect(writes[0].values).toEqual({
      status: "completed", completedAt: now, lockedAt: null, leaseExpiresAt: null, leaseToken: null, lastError: null, updatedAt: now,
    });
  });

  it("records a cancelled job with its reason and a completion time", async () => {
    const { db, writes } = recordingDb();
    await completeJob(db, holdsJobLease(JOB), { status: "cancelled", lastError: "scan_recovery_expired", now });
    expect(writes[0].values).toMatchObject({ status: "cancelled", completedAt: now, lastError: "scan_recovery_expired" });
  });

  it("records a failed job with no completion time", async () => {
    const { db, writes } = recordingDb();
    await completeJob(db, holdsJobLease(JOB), { status: "failed", lastError: "stage_purge_failed", now });
    expect(writes[0].values).toMatchObject({ status: "failed", completedAt: null, lastError: "stage_purge_failed", leaseToken: null });
  });

  it("says so when the caller no longer holds the job", async () => {
    const { db } = recordingDb({ matched: 0 });
    expect(await completeJob(db, holdsJobLease(JOB))).toBe(false);
  });
});

describe("failJob", () => {
  it("sends a job with attempts left back to retry and drops its lease", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const { db, writes } = recordingDb({ attempts: 2 });
    await failJob({ db, owns: holdsJobLease(JOB), code: "purge_failed", maxAttempts: 5 });
    expect(writes[0].values).toMatchObject({ status: "retry", lastError: "purge_failed", lockedAt: null, leaseExpiresAt: null, leaseToken: null });
    expect(writes[0].values).not.toHaveProperty("nextAttemptAt");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ state: "retrying", reason: "purge_failed", action: "retry_job" }));
  });

  it("fails a job for good once it has used its last attempt", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const { db, writes } = recordingDb({ attempts: 5 });
    await failJob({ db, owns: holdsJobLease(JOB), code: "rewrap_failed", maxAttempts: 5 });
    expect(writes[0].values).toMatchObject({ status: "failed", lastError: "rewrap_failed" });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ state: "exhausted", action: "inspect_admin_diagnostics" }));
  });

  it("schedules the next attempt only when the caller gives a delay, by the attempt it will be", async () => {
    vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const { db, writes } = recordingDb({ attempts: 3 });
    const before = Date.now();
    const seen: number[] = [];
    await failJob({ db, owns: holdsJobLease(JOB), code: "scanner_protocol", maxAttempts: 5, retryDelayMs: (next) => { seen.push(next); return next * 1_000; } });
    expect(seen).toEqual([4]);
    const nextAttemptAt = (writes[0].values.nextAttemptAt as Date).getTime();
    expect(nextAttemptAt).toBeGreaterThanOrEqual(before + 4_000);
    expect(nextAttemptAt).toBeLessThan(before + 4_000 + 5_000);
  });

  it("writes nothing for a job the caller no longer holds", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const { db, writes } = recordingDb();
    await failJob({ db, owns: holdsJobLease(JOB), code: "purge_failed", maxAttempts: 5 });
    expect(writes).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs a code the log schema does not list as unexpected_failure, never as itself", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const { db } = recordingDb({ attempts: 1 });
    await failJob({ db, owns: holdsJobLease(JOB), code: "something_unlisted", maxAttempts: 5 });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "unexpected_failure" }));
  });
});

describe("jobFailureCode", () => {
  it("blames the key when an error mentions a key or a secret, and uses the fallback otherwise", () => {
    expect(jobFailureCode(new Error("wrapped under a key this instance does not hold"), "purge_failed")).toBe("key_unavailable");
    expect(jobFailureCode(new Error("bad Secret"), "rewrap_failed")).toBe("key_unavailable");
    expect(jobFailureCode(new Error("disk full"), "purge_failed")).toBe("purge_failed");
    expect(jobFailureCode("not an error", "purge_failed")).toBe("purge_failed");
  });
});
