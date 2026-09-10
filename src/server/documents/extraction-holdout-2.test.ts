import { describe, expect, it } from "vitest";

import { EXTRACTION_HOLDOUT_CORPUS_2 } from "./extraction-holdout-corpus-2";
import { SCORING_RUNS, formatRepeatedScore, scoreCorpusRepeated } from "./extraction-scoring";
import { proposalFromText } from "./suggestions";

// The SECOND hold-out measurement (#937).
//
// The first hold-out is spent. Its three exposed weaknesses were fixed in
// 2c66021, which tuned the heuristics against those exact documents, and it
// has reported 100.0% (57/57) ever since -- against 0.702 (40/57) when it
// was fresh. That is what a tuned-against corpus always reports, so the
// number stopped meaning anything the moment the fix landed. This corpus
// replaces it as the honest measure.
//
// It was written by an agent given the extractor, both existing corpora and
// #937 itself as forbidden reading, so the documents were not shaped around
// what extraction currently handles. Whoever improves extraction next does
// not read `extraction-holdout-corpus-2.ts` either -- the same rule that
// governed the first one, and the reason the first one had to be replaced.
//
// The corpus author deliberately did not score their own documents: the
// wiring and the measurement happened here, afterwards, so no document could
// be adjusted after seeing what it scored.
//
// Measured 2026-09-10, under #939's scoring: minimum of 5 runs 85.2%
// (46/54) -- provider 53.3% (8/15), reference 92.3% (12/13), dates 100.0%
// (26/26). That is the first honest reading since 2c66021, and it says the
// same thing the first fresh hold-out said before it was spent: provider is
// the hard field and dates are close to solved.
//
// Two of the seven provider misses are scored wrong rather than blank
// because the extractor returned the name WITH its legal suffix
// ("Northfield Gas & Energy Ltd" against an expected "Northfield Gas &
// Energy", and the same for "Fenwick Motors Ltd"). Whether the suffix
// belongs in a provider name is a question about what the field means, not
// a defect, and #939's wrong-value penalty makes it cost double. Raised on
// #937 for the owner rather than settled here: editing the expectations
// after seeing the score is the exact move a hold-out exists to prevent.
//
// No floor, for the same reasons as the first hold-out: the tuning corpus
// carries the ratchet, and a floor here invites editing the paper until the
// number clears it. A floor is the owner's to set once the number has held
// still across a few changes.

const ADR_0025_MINIMUM_HOLDOUT_DOCUMENTS = 10;

describe("second hold-out extraction accuracy (#937)", () => {
  it(`holds at least the ${ADR_0025_MINIMUM_HOLDOUT_DOCUMENTS} documents the ADR requires`, () => {
    expect(EXTRACTION_HOLDOUT_CORPUS_2.length).toBeGreaterThanOrEqual(ADR_0025_MINIMUM_HOLDOUT_DOCUMENTS);
    for (const document of EXTRACTION_HOLDOUT_CORPUS_2) {
      const { dates, provider, reference } = document.expected;
      expect(
        dates.length + (dates.length === 0 ? 1 : 0) + (provider === undefined ? 0 : 1) + (reference === undefined ? 0 : 1),
        `${document.name} scores no points`,
      ).toBeGreaterThan(0);
    }
  });

  it("reports the heuristic baseline against the fresh hold-out", async () => {
    const repeated = await scoreCorpusRepeated(
      EXTRACTION_HOLDOUT_CORPUS_2,
      (text, filename) => proposalFromText(text, filename),
      SCORING_RUNS,
    );
    console.info(formatRepeatedScore("second hold-out extraction accuracy (heuristics)", repeated));
    expect(repeated.worst.possible).toBeGreaterThan(0);
    expect(repeated.minimum).toBe(repeated.maximum);
  });
});
