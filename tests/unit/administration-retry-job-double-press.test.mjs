import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1605 b1 W-Q3: retryJob had no in-flight guard and sent the row's status as
 * it stood when the page was read. Pressing retry twice (a double tap, or both
 * layouts' buttons) sent two requests for one failed job, the second claiming
 * a status the first had already moved. One press is one request, and a row
 * already shown queued (retried) is not retried again from the stale row.
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

const failedRow = () => ({
  id: "j1", kind: "scan", status: "failed", attempts: 5,
  lastErrorCode: "scanner_unavailable", createdAt: "2026-10-30T09:00:00.000Z", updatedAt: "2026-10-30T09:10:00.000Z",
});

beforeEach(() => { server.retryDocumentJob.mockReset(); });

describe("retryJob presses (#1605 W-Q3)", () => {
  it("a second press while the first is still in flight sends nothing", async () => {
    /** @type {Array<() => void>} */
    const releases = [];
    server.retryDocumentJob.mockImplementation(() => new Promise((resolve) => { releases.push(() => resolve({})); }));
    const card = { problem: /** @type {string | null} */ (null), busy: null };
    /** @type {Record<string, any>} */
    const retried = {};
    const on = { card: /** @type {any} */ (card), retried, wake: vi.fn() };

    const first = retryJob(/** @type {any} */ (failedRow()), on);
    const second = retryJob(/** @type {any} */ (failedRow()), on);
    await Promise.resolve();
    for (const release of releases) release();
    await Promise.all([first, second]);

    expect(server.retryDocumentJob).toHaveBeenCalledTimes(1);
    expect(on.wake).toHaveBeenCalledTimes(1);
  });

  it("a press on a row already shown queued does not send the row's old failed status again", async () => {
    server.retryDocumentJob.mockResolvedValue({});
    const card = { problem: /** @type {string | null} */ (null), busy: null };
    /** @type {Record<string, any>} */
    const retried = {};
    const on = { card: /** @type {any} */ (card), retried, wake: vi.fn() };

    await retryJob(/** @type {any} */ (failedRow()), on);
    await retryJob(/** @type {any} */ (failedRow()), on);

    expect(server.retryDocumentJob).toHaveBeenCalledTimes(1);
  });
});
