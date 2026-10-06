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
// Measured 2026-09-10: minimum of 5 runs 92.6% (50/54) -- provider 80.0%
// (12/15), reference 92.3% (12/13), dates 100.0% (26/26). The first honest
// reading since 2c66021, and it says what the first fresh hold-out said
// before it was spent: provider is the hard field, dates are close to
// solved.
//
// It first read 85.2% (46/54). The difference was not extraction: two
// provider answers were returned with a legal suffix ("Northfield Gas &
// Energy Ltd" against an expected "Northfield Gas & Energy", likewise
// "Fenwick Motors Ltd"), and #939's wrong-value penalty charged each of
// them double for it. The owner ruled on 2026-09-10 that the suffix is
// technically the more correct form but a name without it is equally
// acceptable, so `classifyProvider` now treats the two as one answer and
// the four points came back. The corpus was NOT edited to reach that
// number -- the meaning of the field was settled instead, which is the only
// move available once a hold-out has been scored.
//
// The four remaining misses are all genuine blanks: a sender in an email
// header rather than a letterhead, a plan name, a brand carrying a "+", and
// one reference.
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
