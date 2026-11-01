import { describe, expect, it } from "vitest";
import { JOB_REASONS, jobMetaOf } from "../../web/src/routes/administration/words.js";

/*
 * #1584 (A-Q1, D-S1): the server reports structure_check_unavailable when a
 * document's structure check could not run (scan recovery retries it). The
 * administration job row names it in plain words instead of "reason not named".
 * JOB_REASONS words are at most 26 characters (the row's whole meta at 360).
 */
const CLOCK = "2026-10-31T12:00:00.000Z";
const job = (status, lastErrorCode) => ({
  id: "job-1", kind: "scan", status, lastErrorCode, attempts: 2,
  createdAt: "2026-10-31T11:00:00.000Z", updatedAt: "2026-10-31T11:54:00.000Z",
});

describe("the administration job row for a structure check that did not run (#1584)", () => {
  it("says the document check didn’t run, on a failed row and on a retrying row", () => {
    expect(JOB_REASONS.structure_check_unavailable).toBe("document check didn’t run");
    expect(jobMetaOf(job("failed", "structure_check_unavailable"), CLOCK, {})).toBe("document check didn’t run");
    expect(jobMetaOf(job("retry", "structure_check_unavailable"), CLOCK, {})).toBe("document check didn’t run");
    expect(jobMetaOf(job("failed", "structure_check_unavailable"), CLOCK, {}, { tries: true })).toMatch(/^document check didn’t run · 2 tries · last tried /);
  });

  it("keeps every reason within the 26-character cap", () => {
    for (const [code, words] of Object.entries(JOB_REASONS)) {
      expect(words.length, code).toBeLessThanOrEqual(26);
    }
  });
});
