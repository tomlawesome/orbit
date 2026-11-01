import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * A retried document job reads "queued" only until the server has moved the
 * row. Pressing retry shows the row queued at once (the same optimistic view
 * on both layouts); the server's own next answer then settles it, failed
 * again or not. The optimistic row is fenced on the server's own stamp: it is
 * shown while the row still carries the `updatedAt` it had when retry was
 * pressed (`was`), and dropped once that stamp has moved. No browser clock is
 * compared with the server's.
 *
 * `words.js` is imported as it is; `acts.svelte.js` with the workspace seam
 * stood in, as administration-landed-then-reread.test.mjs does.
 */

const server = vi.hoisted(() => ({ retryDocumentJob: vi.fn() }));
vi.mock("$lib/data/workspace.js", () => ({
  retryDocumentJob: (/** @type {unknown[]} */ ...a) => server.retryDocumentJob(...a),
  sendSetupLink: vi.fn(),
  addMember: vi.fn(), commandContact: vi.fn(), createLocalUser: vi.fn(), createSystem: vi.fn(),
  restoreHousehold: vi.fn(), testMail: vi.fn(), commandMailbox: vi.fn(), commandUploadLimit: vi.fn(),
  wordsOf: (/** @type {unknown} */ error) => (error instanceof Error ? error.message : String(error)),
}));

const { JOB_REASONS, jobCountsOf, jobMetaOf, jobsOf, tellsOf } = await import("../../web/src/routes/administration/words.js");
const { retryJob } = await import("../../web/src/routes/administration/acts.svelte.js");

const T0 = "2026-10-30T09:00:00.000Z"; // the job was created
const T1 = "2026-10-30T09:10:00.000Z"; // the server's stamp on the failed row
const T2 = "2026-10-30T11:00:00.000Z"; // the browser's time when retry was pressed
const T3 = "2026-10-30T11:05:00.000Z"; // a later server stamp
const CLOCK = "2026-10-30T12:00:00.000Z";

const failedRow = () => ({
  id: "j1", kind: "scan", status: "failed", attempts: 5,
  lastErrorCode: "scanner_unavailable", createdAt: T0, updatedAt: T1,
});
const entry = () => ({ status: "pending", at: T2, was: T1 });

describe("a job just retried reads queued", () => {
  it("shows the row queued, attempt 1, counted queued, with the optimistic words", () => {
    const retried = { j1: entry() };
    const jobs = jobsOf([failedRow()], retried);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: "pending", attempts: 0, updatedAt: T2 });
    expect(jobCountsOf(jobs)).toBe("1 queued");
    expect(jobMetaOf(jobs[0], CLOCK, retried)).toBe("attempt 1 · queued just now");
  });
});

describe("a re-read that finds the server has moved on settles the row", () => {
  it("failed again: the row reads failed with its attempts, counted failed, with its reason and tries", () => {
    const retried = { j1: entry() };
    const failedAgain = { ...failedRow(), updatedAt: T3 };
    const jobs = jobsOf([failedAgain], retried);
    expect(jobs[0]).toMatchObject({ status: "failed", attempts: 5, updatedAt: T3 });
    expect(jobCountsOf(jobs)).toBe("1 failed");
    const meta = jobMetaOf(jobs[0], CLOCK, retried, { tries: true });
    expect(meta.startsWith(JOB_REASONS.scanner_unavailable)).toBe(true);
    expect(meta).toContain("5 tries");
  });

  it("genuinely queued by the server: its own words, not the optimistic ones", () => {
    const retried = { j1: entry() };
    const queued = { ...failedRow(), status: "pending", attempts: 0, updatedAt: T3 };
    const jobs = jobsOf([queued], retried);
    expect(jobs[0].status).toBe("pending");
    expect(jobMetaOf(jobs[0], CLOCK, retried)).toBe("queued 3h ago");
  });

  it("the tells follow: a job that failed again is named, a job just retried is not", () => {
    const retried = { j1: entry() };
    const justRetried = tellsOf(/** @type {any} */ ({}), jobsOf([failedRow()], retried));
    expect(justRetried.filter((tell) => tell.card === "jobs")).toEqual([]);
    const failedAgain = tellsOf(/** @type {any} */ ({}), jobsOf([{ ...failedRow(), updatedAt: T3 }], retried));
    expect(failedAgain.filter((tell) => tell.card === "jobs")).toEqual([{ card: "jobs", text: "1 job failed" }]);
  });
});

describe("retryJob records the fence", () => {
  beforeEach(() => { server.retryDocumentJob.mockReset(); });

  it("keeps the row's updatedAt as the server reported it, and wakes once", async () => {
    server.retryDocumentJob.mockResolvedValue({});
    const card = { problem: /** @type {string | null} */ ("old"), busy: null };
    /** @type {Record<string, any>} */
    const retried = {};
    const wake = vi.fn();
    await retryJob(/** @type {any} */ (failedRow()), { card: /** @type {any} */ (card), retried, wake });
    expect(server.retryDocumentJob).toHaveBeenCalledWith("j1", "failed");
    expect(retried.j1).toEqual({ status: "pending", at: expect.any(String), was: T1 });
    expect(Number.isNaN(Date.parse(retried.j1.at))).toBe(false);
    expect(card.problem).toBeNull();
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("a refused retry records nothing and says why on the card", async () => {
    server.retryDocumentJob.mockRejectedValue(new Error("not retryable"));
    const card = { problem: /** @type {string | null} */ (null), busy: null };
    /** @type {Record<string, any>} */
    const retried = {};
    const wake = vi.fn();
    await retryJob(/** @type {any} */ (failedRow()), { card: /** @type {any} */ (card), retried, wake });
    expect(retried).toEqual({});
    expect(card.problem).toBe("not retryable");
    expect(wake).not.toHaveBeenCalled();
  });
});

describe("the list's order", () => {
  it("a failed row first, then the retried pair, newest first", () => {
    const older = { ...failedRow(), id: "j2", updatedAt: "2026-10-30T08:00:00.000Z" };
    const newer = { ...failedRow(), id: "j3", updatedAt: "2026-10-30T08:30:00.000Z" };
    const other = { ...failedRow(), id: "j4", updatedAt: "2026-10-30T07:00:00.000Z" };
    const retried = {
      j2: { status: "pending", at: "2026-10-30T11:00:00.000Z", was: older.updatedAt },
      j3: { status: "pending", at: "2026-10-30T11:30:00.000Z", was: newer.updatedAt },
    };
    const jobs = jobsOf([older, other, newer], retried);
    expect(jobs.map((job) => job.id)).toEqual(["j4", "j3", "j2"]);
  });
});
