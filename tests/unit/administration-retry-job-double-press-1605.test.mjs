import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1605 W-Q3: double-pressing Retry on a failed document job sent the same
 * stale `failed` status twice; the server refused the second and the card
 * showed a problem under a retry that had worked. One retry per job may be in
 * flight: a press while one is out is ignored, and the guard is released when
 * it settles either way (a refused retry can be pressed again).
 */
const server = vi.hoisted(() => ({ retryDocumentJob: vi.fn() }));
vi.mock("$lib/data/workspace.js", () => ({
  retryDocumentJob: (/** @type {unknown[]} */ ...a) => server.retryDocumentJob(...a),
  sendSetupLink: vi.fn(),
  addMember: vi.fn(), commandContact: vi.fn(), createLocalUser: vi.fn(), createSystem: vi.fn(),
  restoreHousehold: vi.fn(), testMail: vi.fn(), commandMailbox: vi.fn(), commandUploadLimit: vi.fn(),
  wordsOf: (/** @type {unknown} */ error) => (error instanceof Error ? error.message : String(error)),
}));

const { retryJob } = await import("../../web/src/routes/administration/acts.svelte.js");

const failedJob = () => ({
  id: "j1", kind: "scan", status: "failed", attempts: 5, lastErrorCode: "scanner_unavailable",
  createdAt: "2026-10-30T09:00:00.000Z", updatedAt: "2026-10-30T09:10:00.000Z",
});
const on = () => ({ card: { problem: /** @type {string | null} */ (null) }, retried: /** @type {Record<string, unknown>} */ ({}), wake: vi.fn() });

describe("retryJob has an in-flight guard", () => {
  beforeEach(() => { server.retryDocumentJob.mockReset(); });

  it("a second press while the first is out sends nothing and says nothing", async () => {
    let settle = () => {};
    server.retryDocumentJob.mockImplementationOnce(() => new Promise((resolve) => { settle = () => resolve(undefined); }));
    const args = on();
    const job = failedJob();
    const first = retryJob(job, args);
    const second = retryJob(job, args);
    settle();
    await Promise.all([first, second]);
    expect(server.retryDocumentJob).toHaveBeenCalledTimes(1);
    expect(args.card.problem).toBeNull();
    expect(args.retried.j1).toMatchObject({ status: "pending", was: job.updatedAt });
    expect(args.wake).toHaveBeenCalledTimes(1);
  });

  it("the guard is per job: another job's retry still goes", async () => {
    server.retryDocumentJob.mockResolvedValue(undefined);
    const args = on();
    await Promise.all([retryJob(failedJob(), args), retryJob({ ...failedJob(), id: "j2" }, args)]);
    expect(server.retryDocumentJob).toHaveBeenCalledTimes(2);
  });

  it("a refused retry releases the guard, so the next press is sent", async () => {
    server.retryDocumentJob.mockRejectedValueOnce(new Error("refused")).mockResolvedValueOnce(undefined);
    const args = on();
    const job = failedJob();
    await retryJob(job, args);
    expect(args.card.problem).toBe("refused");
    await retryJob(job, args);
    expect(server.retryDocumentJob).toHaveBeenCalledTimes(2);
    expect(args.card.problem).toBeNull();
  });
});
