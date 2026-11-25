import { describe, expect, it } from "vitest";

import { nextPhase, progressWords } from "../../web/src/routes/household/[id]/archive.js";

/*
 * #1774 test 15: the card's two pure rules for the export as a job
 * (web/src/routes/household/[id]/archive.js), written before they exist.
 *
 * Contract:
 *   nextPhase({ export, latest }) -> "rest" | "form" | "queued" | "writing" | "written"
 *     the GET's body in, the card's phase out (design section 3):
 *       pending | retry -> queued      processing -> writing
 *       completed -> written           failed -> form
 *       export null and a live latest -> written; both null -> rest
 *   progressWords(bytesDone, bytesTotal, fallback) -> string
 *     the writing line's words: `fallback` (today's "encrypting N entries and
 *     their documents") while the total is not known (null or 0), else
 *     "<done> of <total> · <percent>%", the percent rounded down and held to
 *     0..100. Sizes by sizeLabel, whatever unit it picks.
 */

const job = (status, extra = {}) => ({ id: "j1", status, bytesDone: 0, bytesTotal: 100, createdAt: "2026-11-25T10:00:00Z", failureCode: null, failureMessage: null, canRetry: true, ...extra });
const latest = { id: "a1", expiresAt: "2026-11-25T16:00:00Z", includesDocuments: true, downloadUrl: "/api/portable-archives/a1/download", keepPerHousehold: 2 };

describe("nextPhase maps every job status to a card phase", () => {
  it.each([
    ["pending", "queued"],
    ["retry", "queued"],
    ["processing", "writing"],
    ["completed", "written"],
    ["failed", "form"],
  ])("%s -> %s", (status, phase) => {
    expect(nextPhase({ export: job(status), latest: null })).toBe(phase);
    expect(nextPhase({ export: job(status), latest }), "a kept archive does not change a live job's phase").toBe(phase);
  });

  it("opens in written when only a kept archive is there, and at rest when nothing is", () => {
    expect(nextPhase({ export: null, latest })).toBe("written");
    expect(nextPhase({ export: null, latest: null })).toBe("rest");
  });
});

describe("progressWords", () => {
  const fallback = "encrypting 3 entries and their documents";

  it("keeps today's words while the total is not known", () => {
    expect(progressWords(null, null, fallback)).toBe(fallback);
    expect(progressWords(0, null, fallback)).toBe(fallback);
    expect(progressWords(0, 0, fallback)).toBe(fallback);
  });

  it("says 0 %, 25 % and 100 % with both sizes", () => {
    const total = 4 * 1024 * 1024 * 1024;
    for (const [done, percent] of [[0, 0], [total / 4, 25], [total, 100]]) {
      const words = progressWords(done, total, fallback);
      expect(words).toMatch(new RegExp(` of .+ · ${percent}%$`));
      expect(words).not.toContain("NaN");
      expect(words).not.toContain(fallback);
    }
  });

  it("rounds down and never passes 100", () => {
    expect(progressWords(999, 1000, fallback)).toMatch(/ · 99%$/);
    expect(progressWords(2000, 1000, fallback)).toMatch(/ · 100%$/);
  });
});
