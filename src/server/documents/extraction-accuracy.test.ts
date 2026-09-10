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
// Re-measured 1.00 (135/135) on 2026-09-10 after #937's second half retired
// the 13 spent hold-out documents into this corpus: provider 100.0%
// (27/27), reference 100.0% (29/29), dates 100.0% (79/79). The corpus grew
// 23 -> 36 documents and 78 -> 135 points; the retired documents each earn
// exactly what they earned in the hold-out (78 + 57 = 135, and each field
// bucket adds up the same way), so nothing regressed and nothing was tuned
// to make this number.
//
// ACCURACY_FLOOR raised 0.95 -> 0.97 with that measurement, and this is a
// re-record rather than a ratchet on improved extraction: the extractor did
// not get better, the corpus got bigger. 0.95 was chosen to leave "about
// four points of the current 78" free for the next batch of hard documents;
// against 135 points that same 0.95 leaves about seven, which is a looser
// gate than the one that was agreed, arrived at by arithmetic rather than
// by decision. 0.97 of 135 is 131, restoring the intended four points of
// slack. The measurement itself has not moved from 1.00.
//
// Re-measured 0.502 (135/269) on 2026-09-10 after #960 extended the corpus
// ground truth to the whole proposal contract: provider 100.0% (27/27),
// reference 100.0% (29/29), dates 100.0% (79/79), dateRoles 0.0% (0/76),
// subtype 0.0% (0/29), cost 0.0% (0/14), scheduleKind 0.0% (0/14),
// recurrence 0.0% (0/1).
//
// Nothing regressed and no corpus document's existing expectations changed.
// The extractor earns exactly the 135 points it earned before, out of a
// corpus that now asks for 269, because ADR-0025 section 6 requires the
// ground truth to cover the four model-owned fields and role-labelled dates
// "so the gate judges the whole contract, not the easy quarter of it". The
// heuristics attempt none of those five categories — that is the owner's
// decision on #319, not a defect — so they are a blank on all 134 new
// points. The headline number therefore stopped meaning "how much of what
// it tries does the heuristic get right" (still 100%, in the per-field
// breakdown above) and started meaning "how much of the contract does the
// heuristic cover" (just over half).
//
// ACCURACY_FLOOR re-recorded 0.97 -> 0.48 against that new point total.
// This is arithmetic on a bigger denominator, not a concession on a worse
// extractor, and it is deliberately NOT a lowered ratchet: 0.97 of 269 is
// 261 points, a bar no extractor that omits the four fields could ever
// clear, so leaving it would have gated on the corpus growing rather than
// on extraction. The slack convention is unchanged — every earlier record
// here kept about four points free for the next batch of hard documents.
// (135 - 4) / 269 is 0.487, and 0.48 is the nearest two-decimal value at or
// below it, leaving 5.9 points. It rounds DOWN rather than up because 0.49
// would leave 3.2 points and quietly tighten a gate nobody agreed to
// tighten.
//
// What this floor now protects is that the heuristics keep covering their
// half of the contract; what it cannot protect is a regression inside one
// field, which the per-field breakdown printed above is for. When the model
// path scores this same corpus (ADR-0025 section 6's second gate), it is
// measured against the whole 269 and this same floor.
//
// This corpus is the TUNING set: improvement work reads it freely. The
// hold-out set it is paired with (`extraction-holdout-corpus-2.ts`) is the
// one improvement work must not read, and it is reported without a floor.
const ACCURACY_FLOOR = 0.48;

describe("extraction accuracy against the corpus (#319)", () => {
  it(`heuristic extraction stays at or above the ${ACCURACY_FLOOR} floor`, async () => {
    const score = await scoreCorpus(EXTRACTION_CORPUS, (text, filename) => proposalFromText(text, filename));
    // Always print the measurement — the number is the point.
    console.info(formatRunScore("extraction accuracy", score));
    expect(score.accuracy).toBeGreaterThanOrEqual(ACCURACY_FLOOR);
  });
});
