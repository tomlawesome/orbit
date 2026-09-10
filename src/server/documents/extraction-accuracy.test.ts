import { describe, expect, it } from "vitest";

import { EXTRACTION_CORPUS } from "./extraction-corpus";
import { formatRunScore, scoreCorpus } from "./extraction-scoring";
import { proposalFromText } from "./suggestions";

// The measured number behind #319: extraction accuracy against the corpus.
// Scoring is deliberately simple and stable — each expected field is one
// point (every expected date individually; provider; reference), plus one
// point per document for emitting no false dates on date-free documents.
// It lives in `extraction-scoring.ts` so this corpus and the hold-out
// corpus of ADR-0025 are scored by the same code (#934).
// The floor is a ratchet: raise it when extraction durably improves; never
// lower it to make a change pass.
//
// Issue #939 (2026-09-10) changed how a point is lost, not what a point is:
// a blank field still earns 0, but a wrong value now earns
// `-WRONG_VALUE_PENALTY` (see `extraction-scoring.ts`), so a plausible wrong
// value costs more than an honest blank. It also added the per-field
// breakdown printed alongside the overall figure. Measurement only — this
// corpus and the extractor were not touched for #939.

// Measured 1.00 (78/78) on 2026-09-09, after the extractor learned the
// harder corpus: hyphenated, year-first and two-digit-year numeric dates,
// "the 1st of October", references carrying spaces and slashes, providers
// named in prose or on the letterhead, and firmware versions refused as
// dates. The floor sits below the measurement so that ADDING harder corpus
// documents is always welcome: a hard new document may land red-margin
// against perfection but must never take the whole measure below this
// floor without an accompanying, recorded floor decision. Raised 0.9 -> 0.95
// with that measurement; 0.95 still leaves about four points of the current
// 78 free for the next batch of hard documents.
//
// Re-measured 1.00 (78/78) on 2026-09-10 under #939's wrong-costs-more
// scoring: provider 100.0% (14/14), reference 100.0% (17/17), dates 100.0%
// (47/47). The figure is unchanged because this corpus currently holds zero
// wrong values for the heuristic to be penalised on — the penalty and the
// floor are both restated here for the record, not because the number
// moved. ACCURACY_FLOOR stays at 0.95: it was already a ratchet below a
// measurement that has not fallen, and the new penalty makes a future
// regression that turns a blank into a wrong guess cost the floor faster
// than before, which is the point of raising it, not a reason to move it
// now.
//
// This corpus is the TUNING set: improvement work reads it freely. The
// hold-out set it is paired with (`extraction-holdout-corpus.ts`) is the
// one improvement work must not read, and it is reported without a floor.
const ACCURACY_FLOOR = 0.95;

describe("extraction accuracy against the corpus (#319)", () => {
  it(`heuristic extraction stays at or above the ${ACCURACY_FLOOR} floor`, async () => {
    const score = await scoreCorpus(EXTRACTION_CORPUS, (text, filename) => proposalFromText(text, filename));
    // Always print the measurement — the number is the point.
    console.info(formatRunScore("extraction accuracy", score));
    expect(score.accuracy).toBeGreaterThanOrEqual(ACCURACY_FLOOR);
  });
});
