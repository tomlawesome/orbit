import { describe, expect, it } from "vitest";

import { EXTRACTION_HOLDOUT_CORPUS } from "./extraction-holdout-corpus";
import { SCORING_RUNS, formatRepeatedScore, scoreCorpusRepeated } from "./extraction-scoring";
import { proposalFromText } from "./suggestions";

// The hold-out measurement (ADR-0025 section 6, issue #934). This file
// REPORTS a number; it does not gate one. There is deliberately no floor
// assertion here:
//
//  - the tuning corpus already carries the ratchet (`ACCURACY_FLOOR` in
//    `extraction-accuracy.test.ts`), and a second floor over documents no
//    extractor was fitted to would fail for the honest reason that the
//    hold-out exists — an extractor meeting unseen paper;
//  - a floor invites the one move this corpus exists to prevent, which is
//    editing the documents until the number clears the bar;
//  - what the hold-out number gates in ADR-0025 is the MODEL path, by a
//    margin over this baseline, not the baseline itself.
//
// A floor for the hold-out is the owner's to set, once the number has been
// seen and has held still across a few changes.
//
// ADR-0025 minimum of five runs: the heuristic is deterministic, so its
// five runs are identical and minimum equals maximum. The repetition is
// the shape a non-deterministic extractor will be measured in.

const ADR_0025_MINIMUM_HOLDOUT_DOCUMENTS = 10;

describe("hold-out extraction accuracy (ADR-0025 section 6)", () => {
  it(`holds at least the ${ADR_0025_MINIMUM_HOLDOUT_DOCUMENTS} documents the ADR requires`, () => {
    expect(EXTRACTION_HOLDOUT_CORPUS.length).toBeGreaterThanOrEqual(ADR_0025_MINIMUM_HOLDOUT_DOCUMENTS);
    // Every document must be worth at least one point, or it is decoration.
    for (const document of EXTRACTION_HOLDOUT_CORPUS) {
      const { dates, provider, reference } = document.expected;
      expect(
        dates.length + (dates.length === 0 ? 1 : 0) + (provider === undefined ? 0 : 1) + (reference === undefined ? 0 : 1),
        `${document.name} scores no points`,
      ).toBeGreaterThan(0);
    }
  });

  it("reports the heuristic baseline against the hold-out", async () => {
    const repeated = await scoreCorpusRepeated(
      EXTRACTION_HOLDOUT_CORPUS,
      (text, filename) => proposalFromText(text, filename),
      SCORING_RUNS,
    );
    // Printing the measurement is the whole point of this test.
    console.info(formatRepeatedScore("hold-out extraction accuracy (heuristics)", repeated));
    expect(repeated.worst.possible).toBeGreaterThan(0);
    // Determinism check, not an accuracy gate: today's extractor must not
    // wobble between runs. When a model extractor is scored here, this
    // expectation moves to the deterministic baseline alone.
    expect(repeated.minimum).toBe(repeated.maximum);
  });
});
