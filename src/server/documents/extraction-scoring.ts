// One scorer for both extraction corpora (ADR-0025 section 6, issue #934).
//
// The scoring rule is the one `extraction-accuracy.test.ts` has always
// used, lifted out unchanged so the tuning corpus and the hold-out corpus
// are measured the same way: each expected date is one point, a document
// with no expected dates is worth one point for emitting none, and an
// expected provider or reference is one point for an exact match.
//
// The one addition is repetition. ADR-0025 scores a non-deterministic
// extractor by running the whole corpus five times and gating on the
// MINIMUM, so run-to-run variance counts against the extractor and never
// for it. Nothing non-deterministic exists yet: today the only extractor
// is the deterministic heuristic, whose five runs are identical. The shape
// is here so that when a model extractor arrives it is scored honestly
// from its first run, rather than the harness being reshaped around
// whatever the model turns out to do.
//
// Issue #939 added two more things, both measurement-only — no extractor
// and no corpus document changed to produce them:
//
// 1. A wrong value now costs more than a blank. Orbit's flow is
//    review-first: a blank field prompts the reviewer to fill it in, while
//    a plausible wrong value can be approved without a second look and
//    reach the household's data. So a field that is blank when a value was
//    expected loses its point, same as before (0 earned out of the 1
//    possible). A field that holds a value not matching what was expected
//    loses that same point AND `WRONG_VALUE_PENALTY` more (earning
//    `-WRONG_VALUE_PENALTY`, currently -1): losing the point a correct
//    answer would have earned, then losing an equal amount again. A wrong
//    date is judged the same way: an expected date missing from an
//    extractor that returned no dates at all is a blank (nothing was
//    offered); an expected date missing from an extractor that DID return
//    some dates is wrong (something was offered, standing in for the
//    reviewer's confidence, and it was not this). A document expecting no
//    dates that gets some anyway has nothing to be blank about, so any
//    date returned there is wrong, never blank. Because a wrong value can
//    score below zero for its field, the overall and per-field accuracy
//    figures this scorer reports can go negative — that is intentional: a
//    corpus dominated by wrong values should read as worse than a blank
//    one, not floor at 0%.
// 2. Per-field scores are reported alongside the overall figure: provider,
//    reference, and dates (`FIELD_NAMES` below), summed across the whole
//    corpus. A single aggregate hides which field is the hard one; this
//    does not. Two more field categories exist in the design but have no
//    ground truth yet and so are not reported here: role-labelled dates
//    (`documentDateRoles`, `model-extraction.ts`) and the four fields the
//    model path owns (`cost`, `subtype`, `scheduleKind`,
//    `recurrenceMonths`, ADR-0025 section 7). ADR-0025 section 6 already
//    sequences this: corpus ground truth grows to cover those fields
//    first, which is corpus work and explicitly out of this issue's scope.
//    When that ground truth exists, it plugs into the same `FieldName` /
//    `FieldScore` shape this file establishes.

import type { CorpusDocument } from "./extraction-corpus";

/** ADR-0025 section 6: five runs, and the minimum is the score. */
export const SCORING_RUNS = 5;

/**
 * How much more a wrong value costs than a blank (issue #939). A blank
 * field earns 0 out of its 1 possible point. A wrong value earns
 * `-WRONG_VALUE_PENALTY`: it forfeits the same point a blank forfeits, and
 * then loses that much again, because a plausible wrong value is the one
 * that gets approved without a second look while a blank is the one that
 * gets noticed and checked.
 */
export const WRONG_VALUE_PENALTY = 1;

/** The fields a scored extractor returns. `DocumentProposal` satisfies it. */
export interface ExtractedFields {
  dates: string[];
  provider?: string;
  reference?: string;
}

/**
 * Anything that turns document text into candidate fields. Async because a
 * model extractor will be; the heuristic simply returns.
 */
export type CorpusExtractor = (
  text: string,
  filename: string,
) => ExtractedFields | Promise<ExtractedFields>;

/** The per-field categories this scorer can report against today's ground
 * truth. See the file header for the two categories not yet measurable. */
export type FieldName = "provider" | "reference" | "dates";
export const FIELD_NAMES: readonly FieldName[] = ["provider", "reference", "dates"];

export interface FieldScore {
  earned: number;
  possible: number;
  accuracy: number;
}

export interface RunScore {
  earned: number;
  possible: number;
  accuracy: number;
  misses: string[];
  fields: Record<FieldName, FieldScore>;
}

export interface RepeatedScore {
  runs: RunScore[];
  /** The gating number. */
  minimum: number;
  mean: number;
  maximum: number;
  /** The run that produced the minimum, for reporting its misses. */
  worst: RunScore;
}

interface FieldTotal {
  earned: number;
  possible: number;
}

function emptyFieldTotals(): Record<FieldName, FieldTotal> {
  return {
    provider: { earned: 0, possible: 0 },
    reference: { earned: 0, possible: 0 },
    dates: { earned: 0, possible: 0 },
  };
}

function buildFieldScores(totals: Record<FieldName, FieldTotal>): Record<FieldName, FieldScore> {
  const scores = {} as Record<FieldName, FieldScore>;
  for (const field of FIELD_NAMES) {
    const { earned, possible } = totals[field];
    scores[field] = { earned, possible, accuracy: possible === 0 ? 1 : earned / possible };
  }
  return scores;
}

type Classification = "correct" | "blank" | "wrong";

/** A correct value earns its point; a blank earns nothing; a wrong value
 * earns `-WRONG_VALUE_PENALTY` (issue #939, see the file header). */
function pointsFor(classification: Classification): number {
  if (classification === "correct") return 1;
  if (classification === "blank") return 0;
  return -WRONG_VALUE_PENALTY;
}

function classifyScalar(expected: string, actual: string | undefined): Classification {
  if (actual === expected) return "correct";
  return actual === undefined ? "blank" : "wrong";
}

/** An expected date missing from an extractor that returned nothing at all
 * is a blank. Missing from an extractor that returned other dates instead
 * is wrong: something was offered, and it was not this. */
function classifyExpectedDate(expectedDate: string, extractedDates: string[]): Classification {
  if (extractedDates.includes(expectedDate)) return "correct";
  return extractedDates.length === 0 ? "blank" : "wrong";
}

/** A document with no expected dates has nothing to be blank about: any
 * date returned is a wrong (hallucinated) value, never a blank. */
function classifyNoDatesExpected(extractedDates: string[]): Classification {
  return extractedDates.length === 0 ? "correct" : "wrong";
}

interface DocumentScore {
  earned: number;
  possible: number;
  misses: string[];
  fieldTotals: Record<FieldName, FieldTotal>;
}

function addPoint(totals: Record<FieldName, FieldTotal>, field: FieldName, classification: Classification): number {
  const delta = pointsFor(classification);
  totals[field].possible += 1;
  totals[field].earned += delta;
  return delta;
}

function scoreDocument(document: CorpusDocument, extracted: ExtractedFields): DocumentScore {
  const { name, expected } = document;
  const misses: string[] = [];
  const fieldTotals = emptyFieldTotals();
  let earned = 0;
  let possible = 0;

  for (const date of expected.dates) {
    possible += 1;
    const classification = classifyExpectedDate(date, extracted.dates);
    earned += addPoint(fieldTotals, "dates", classification);
    if (classification !== "correct") {
      misses.push(
        `${name}: date ${date} not extracted (${classification}; got ${extracted.dates.join(", ") || "none"})`,
      );
    }
  }
  if (expected.dates.length === 0) {
    possible += 1;
    const classification = classifyNoDatesExpected(extracted.dates);
    earned += addPoint(fieldTotals, "dates", classification);
    if (classification !== "correct") {
      misses.push(`${name}: false dates ${extracted.dates.join(", ")} (wrong; none expected)`);
    }
  }
  if (expected.provider !== undefined) {
    possible += 1;
    const classification = classifyScalar(expected.provider, extracted.provider);
    earned += addPoint(fieldTotals, "provider", classification);
    if (classification !== "correct") {
      misses.push(
        `${name}: provider expected "${expected.provider}", got "${extracted.provider ?? "none"}" (${classification})`,
      );
    }
  }
  if (expected.reference !== undefined) {
    possible += 1;
    const classification = classifyScalar(expected.reference, extracted.reference);
    earned += addPoint(fieldTotals, "reference", classification);
    if (classification !== "correct") {
      misses.push(
        `${name}: reference expected "${expected.reference}", got "${extracted.reference ?? "none"}" (${classification})`,
      );
    }
  }

  return { earned, possible, misses, fieldTotals };
}

/** Score one pass of a corpus. */
export async function scoreCorpus(
  corpus: readonly CorpusDocument[],
  extractor: CorpusExtractor,
): Promise<RunScore> {
  let earned = 0;
  let possible = 0;
  const misses: string[] = [];
  const fieldTotals = emptyFieldTotals();
  for (const document of corpus) {
    const extracted = await extractor(document.text, document.filename);
    const score = scoreDocument(document, extracted);
    earned += score.earned;
    possible += score.possible;
    misses.push(...score.misses);
    for (const field of FIELD_NAMES) {
      fieldTotals[field].earned += score.fieldTotals[field].earned;
      fieldTotals[field].possible += score.fieldTotals[field].possible;
    }
  }
  return {
    earned,
    possible,
    accuracy: possible === 0 ? 1 : earned / possible,
    misses,
    fields: buildFieldScores(fieldTotals),
  };
}

/**
 * Score a corpus `runs` times and report minimum, mean and maximum. The
 * minimum is the number ADR-0025's gate uses.
 */
export async function scoreCorpusRepeated(
  corpus: readonly CorpusDocument[],
  extractor: CorpusExtractor,
  runs: number = SCORING_RUNS,
): Promise<RepeatedScore> {
  const scored: RunScore[] = [];
  for (let run = 0; run < runs; run += 1) {
    scored.push(await scoreCorpus(corpus, extractor));
  }
  const accuracies = scored.map((score) => score.accuracy);
  const minimum = Math.min(...accuracies);
  const worst = scored.find((score) => score.accuracy === minimum) ?? scored[0];
  return {
    runs: scored,
    minimum,
    mean: accuracies.reduce((total, value) => total + value, 0) / accuracies.length,
    maximum: Math.max(...accuracies),
    worst,
  };
}

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

function formatFieldScores(fields: Record<FieldName, FieldScore>): string {
  return FIELD_NAMES.map(
    (field) => `${field} ${percent(fields[field].accuracy)} (${fields[field].earned}/${fields[field].possible})`,
  ).join(", ");
}

export function formatRunScore(label: string, score: RunScore): string {
  return `${label}: ${percent(score.accuracy)} (${score.earned}/${score.possible})` +
    ` [${formatFieldScores(score.fields)}]` +
    (score.misses.length ? `\n  misses:\n  - ${score.misses.join("\n  - ")}` : "");
}

export function formatRepeatedScore(label: string, repeated: RepeatedScore): string {
  const { worst, runs, minimum, mean, maximum } = repeated;
  return `${label}: minimum of ${runs.length} runs ${percent(minimum)} ` +
    `(${worst.earned}/${worst.possible}); mean ${percent(mean)}, maximum ${percent(maximum)}` +
    ` [${formatFieldScores(worst.fields)}]` +
    (worst.misses.length ? `\n  misses in the worst run:\n  - ${worst.misses.join("\n  - ")}` : "");
}
