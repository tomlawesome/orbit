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
// 2. Per-field scores are reported alongside the overall figure, summed
//    across the whole corpus (`FIELD_NAMES` below). A single aggregate
//    hides which field is the hard one; this does not.
//
// Issue #960 filled in the categories #939 could only sketch. The corpus
// now carries ground truth for role-labelled dates and for the four fields
// ADR-0025 section 7 gives the model path, so all eight categories are
// scored: provider, reference, dates, dateRoles, subtype, cost,
// scheduleKind and recurrence. The scoring rule itself did not change —
// each declared expectation is one point, won, blank or wrong exactly as
// before. Three details are worth stating, because they decide what the
// number means:
//
//  - A field is scored only on documents whose ground truth DECLARES it,
//    which is how provider and reference have always worked. Dates keep
//    their extra rule: a document expecting none is worth a point for
//    emitting none.
//  - `cost` is one point for the amount AND its currency together. ADR-0025
//    section 3 refuses a cost whose evidence carries no currency, so half a
//    cost is not a partial credit, it is a value the contract would drop.
//  - `subtype` is compared with case and whitespace runs ignored, because
//    documents shout their headings ("HOME INSURANCE") and the measurement
//    is whether the extractor found the right thing, not whether it copied
//    the typography. Every other text field keeps its exact comparison.
//    Ground truth may also declare a SET of acceptable phrases rather than
//    one, because a page can genuinely support more than one right answer
//    (owner decision 2026-09-11, #989/#992); a match against any member of
//    the set is correct. The current form of that ruling (#989) names
//    taxonomy KIND and QUALIFIER groups from `subtype-taxonomy.json` rather
//    than literal phrases; `subtypeAnswers` expands a document's declared
//    groups into every phrase the taxonomy's combination rules accept, and
//    that expansion is what gets matched against.
//
// The heuristics attempt none of the five new categories, by the owner's
// decision on #319, so they score a blank on every one of those points.
// That is the measurement working: the corpus now judges the whole
// contract rather than the quarter of it the heuristics ever tried, and the
// floor in `extraction-accuracy.test.ts` is re-recorded against the larger
// point total rather than the extractor being let off the new fields.

import type { CorpusDocument, SubtypeSpec } from "./extraction-corpus";
import { selectedExtractionModel } from "./model-extraction";
import subtypeTaxonomyJson from "./subtype-taxonomy.json";
import type { DocumentProposal } from "./suggestions";

interface TaxonomyGroup {
  name: string;
  synonyms: string[];
}

interface SubtypeTaxonomy {
  description: string;
  kinds: TaxonomyGroup[];
  qualifiers: TaxonomyGroup[];
  combinations: {
    patterns: string[];
    standalone: string[];
    notes: string[];
  };
}

const SUBTYPE_TAXONOMY = subtypeTaxonomyJson as SubtypeTaxonomy;

/** ADR-0025 section 6: five runs, and the minimum is the score. */
export const SCORING_RUNS = 5;

/**
 * How much more a wrong value costs than a blank. Zero since the owner's
 * ruling of 2026-09-12: a wrong answer and a blank both simply earn no
 * point, so a score reads as "how many did it get right" and nothing else.
 *
 * The earlier value of 1 (issue #939) was there because a plausible wrong
 * value is the one that gets approved without a second look. That is still
 * true and still worth handling -- but as its own piece of work, not by
 * bending every measurement around it. Every score recorded before this
 * date was computed with the penalty and is not comparable with one after.
 */
export const WRONG_VALUE_PENALTY = 0;

/** The fields a scored extractor returns. `DocumentProposal` satisfies it. */
export interface ExtractedFields {
  dates: string[];
  provider?: string;
  reference?: string;
  dateRoles?: Array<{ date: string; role: string }>;
  subtype?: string;
  costMinor?: number;
  currency?: string;
  recurrenceMonths?: number;
  scheduleKind?: string;
}

/**
 * Anything that turns document text into candidate fields. Async because a
 * model extractor will be; the heuristic simply returns.
 */
export type CorpusExtractor = (
  text: string,
  filename: string,
) => ExtractedFields | Promise<ExtractedFields>;

/** Every category the corpus can declare ground truth for. */
export type FieldName =
  | "provider"
  | "reference"
  | "dates"
  | "dateRoles"
  | "subtype"
  | "cost"
  | "scheduleKind"
  | "recurrence";
export const FIELD_NAMES: readonly FieldName[] = [
  "provider",
  "reference",
  "dates",
  "dateRoles",
  "subtype",
  "cost",
  "scheduleKind",
  "recurrence",
];

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
  const totals = {} as Record<FieldName, FieldTotal>;
  for (const field of FIELD_NAMES) totals[field] = { earned: 0, possible: 0 };
  return totals;
}

function buildFieldScores(totals: Record<FieldName, FieldTotal>): Record<FieldName, FieldScore> {
  const scores = {} as Record<FieldName, FieldScore>;
  for (const field of FIELD_NAMES) {
    const { earned, possible } = totals[field];
    scores[field] = { earned, possible, accuracy: possible === 0 ? 1 : earned / possible };
  }
  return scores;
}

export type Classification = "correct" | "blank" | "wrong";

/** A correct value earns its point; a blank and a wrong value both earn
 * nothing while `WRONG_VALUE_PENALTY` is 0 (see the file header). */
function pointsFor(classification: Classification): number {
  if (classification === "correct") return 1;
  if (classification === "blank") return 0;
  return -WRONG_VALUE_PENALTY;
}

function classifyScalar(expected: string, actual: string | undefined): Classification {
  if (actual === expected) return "correct";
  return actual === undefined ? "blank" : "wrong";
}

/** Trailing company-form words, which a provider name may carry or omit.
 * Owner ruling 2026-09-10: the suffix is technically the more correct
 * answer, but a name without it is equally acceptable, so neither may be
 * scored as a miss. */
const LEGAL_SUFFIXES = [
  "ltd",
  "ltd.",
  "limited",
  "plc",
  "plc.",
  "llp",
  "llc",
  "cic",
  "co",
  "co.",
  "company",
  "group",
  "holdings",
];

/** A provider name stripped of one trailing company-form word, for
 * comparison only — never for display, and never written back to a corpus. */
function withoutLegalSuffix(name: string): string {
  const words = name.trim().split(/\s+/u);
  if (words.length < 2) return name.trim();
  const last = words[words.length - 1].toLowerCase().replace(/^&/u, "");
  if (!LEGAL_SUFFIXES.includes(last)) return name.trim();
  return words.slice(0, -1).join(" ").replace(/\s*&$/u, "").trim();
}

/** Provider is compared with its legal suffix optional on BOTH sides, per
 * the owner's ruling above. "Northfield Gas & Energy Ltd" and "Northfield
 * Gas & Energy" are the same answer, so scoring one of them wrong — and,
 * since #939, charging it the wrong-value penalty on top — would be
 * measuring a naming convention rather than extraction.
 *
 * Deliberately narrow: only ONE trailing company-form word is optional, and
 * only at the end. Everything else still has to match exactly, so a genuinely
 * different name ("Direct Debit" for a water company) is still wrong. */
export function classifyProvider(expected: string, actual: string | undefined): Classification {
  if (actual === undefined) return "blank";
  // Case and whitespace runs ignored, as `comparableSubtype` already does.
  // Owner ruling 2026-09-11: "All caps is an acceptable answer... the valuable
  // part is the extraction of the correct information." A letterhead printed
  // WEXLEY WATER is read correctly by any extractor copying verbatim, and
  // scoring it wrong -- and since #939 charging it the wrong-value penalty --
  // measures typography rather than extraction. Presentation is a
  // post-processing concern, not an accuracy one.
  const comparable = (value: string) => value.replace(/\s+/gu, " ").trim().toLowerCase();
  if (comparable(actual) === comparable(expected)) return "correct";
  if (comparable(withoutLegalSuffix(actual)) === comparable(withoutLegalSuffix(expected))) {
    return "correct";
  }
  return "wrong";
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

/** Case and whitespace runs ignored, per the file header's note on
 * `subtype`. Nothing else is forgiven: a different phrase is still wrong. */
function comparableSubtype(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

/** True when `expected` names taxonomy groups (`{ kinds, qualifiers }`)
 * rather than giving literal phrases directly. */
export function isSubtypeSpec(expected: string | string[] | SubtypeSpec): expected is SubtypeSpec {
  return typeof expected === "object" && !Array.isArray(expected);
}

function taxonomyGroup(groups: TaxonomyGroup[], name: string): TaxonomyGroup {
  const group = groups.find((candidate) => candidate.name === name);
  if (!group) throw new Error(`"${name}" is not a group in subtype-taxonomy.json`);
  return group;
}

/**
 * Expands a `{ kinds, qualifiers }` ground-truth spec of taxonomy group
 * NAMES (owner decision 2026-09-11, #989: the accepted answers come from a
 * generic taxonomy, not a per-page list) into every phrase
 * `subtype-taxonomy.json`'s combination rules accept for it:
 *  - every synonym of every listed kind ("{kind}"),
 *  - every listed qualifier synonym followed by every listed kind synonym
 *    ("{qualifier} {kind}"),
 *  - every synonym of any listed qualifier the taxonomy allows to stand
 *    alone, with no kind word.
 */
export function subtypeAnswers(spec: SubtypeSpec): string[] {
  const kindGroups = spec.kinds.map((name) => taxonomyGroup(SUBTYPE_TAXONOMY.kinds, name));
  const qualifierNames = spec.qualifiers ?? [];
  const qualifierGroups = qualifierNames.map((name) => taxonomyGroup(SUBTYPE_TAXONOMY.qualifiers, name));
  const answers: string[] = [];

  for (const kind of kindGroups) answers.push(...kind.synonyms);

  for (const qualifier of qualifierGroups) {
    for (const kind of kindGroups) {
      for (const qualifierSynonym of qualifier.synonyms) {
        for (const kindSynonym of kind.synonyms) answers.push(`${qualifierSynonym} ${kindSynonym}`);
      }
    }
  }

  for (const name of qualifierNames) {
    if (!SUBTYPE_TAXONOMY.combinations.standalone.includes(name)) continue;
    answers.push(...taxonomyGroup(SUBTYPE_TAXONOMY.qualifiers, name).synonyms);
  }

  return answers;
}

/** Every literal phrase `expected` accepts, regardless of its form: one
 * phrase, a set of them, or a taxonomy spec expanded via `subtypeAnswers`.
 * For callers that need to search text for "any acceptable phrase" rather
 * than classify one candidate at a time. */
export function subtypeCandidatePhrases(expected: string | string[] | SubtypeSpec): string[] {
  if (isSubtypeSpec(expected)) return subtypeAnswers(expected);
  return Array.isArray(expected) ? expected : [expected];
}

/** `expected` may be one phrase, a set of acceptable phrases, or a
 * `{ kinds, qualifiers }` taxonomy spec (owner decision 2026-09-11, #989/
 * #992): a page can genuinely support more than one right answer, and an
 * extracted subtype is correct if it matches any of them. */
export function classifySubtype(
  expected: string | string[] | SubtypeSpec,
  actual: string | undefined,
): Classification {
  if (actual === undefined) return "blank";
  const comparableActual = comparableSubtype(actual);
  return subtypeCandidatePhrases(expected).some((candidate) => comparableSubtype(candidate) === comparableActual)
    ? "correct"
    : "wrong";
}

/** Prints the expected subtype for humans: the one phrase, every acceptable
 * phrase joined with " | ", or the taxonomy group names for the object
 * form (`kinds: A, B / qualifiers: C`) -- printing the names, not their
 * expansion, because the expansion can run into the hundreds of phrases. */
export function formatSubtypeExpected(expected: string | string[] | SubtypeSpec): string {
  if (isSubtypeSpec(expected)) {
    const kinds = `kinds: ${expected.kinds.join(", ")}`;
    const qualifiers = expected.qualifiers?.length ? ` / qualifiers: ${expected.qualifiers.join(", ")}` : "";
    return `${kinds}${qualifiers}`;
  }
  return Array.isArray(expected) ? expected.join(" | ") : expected;
}

/** A cost is its amount and its currency together (ADR-0025 section 3). */
function classifyCost(
  expected: { costMinor: number; currency?: string },
  extracted: ExtractedFields,
): Classification {
  if (extracted.costMinor === undefined) return "blank";
  return extracted.costMinor === expected.costMinor && extracted.currency === expected.currency
    ? "correct"
    : "wrong";
}

function classifyNumber(expected: number, actual: number | undefined): Classification {
  if (actual === expected) return "correct";
  return actual === undefined ? "blank" : "wrong";
}

/** A role is a label ON a date, so it is judged the way an expected date
 * is: missing from an extractor that produced no roles at all is a blank;
 * missing from one that produced some is wrong. */
function classifyExpectedDateRole(
  expected: { date: string; role: string },
  extractedRoles: Array<{ date: string; role: string }> | undefined,
): Classification {
  const roles = extractedRoles ?? [];
  if (roles.some((label) => label.date === expected.date && label.role === expected.role)) return "correct";
  return roles.length === 0 ? "blank" : "wrong";
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
    const classification = classifyProvider(expected.provider, extracted.provider);
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

  // The contract ADR-0025 section 7 gives the model path (#960).
  for (const label of expected.dateRoles ?? []) {
    possible += 1;
    const classification = classifyExpectedDateRole(label, extracted.dateRoles);
    earned += addPoint(fieldTotals, "dateRoles", classification);
    if (classification !== "correct") {
      const got = (extracted.dateRoles ?? []).find((entry) => entry.date === label.date)?.role ?? "none";
      misses.push(
        `${name}: date ${label.date} expected role "${label.role}", got "${got}" (${classification})`,
      );
    }
  }
  if (expected.subtype !== undefined) {
    possible += 1;
    const classification = classifySubtype(expected.subtype, extracted.subtype);
    earned += addPoint(fieldTotals, "subtype", classification);
    if (classification !== "correct") {
      misses.push(
        `${name}: subtype expected "${formatSubtypeExpected(expected.subtype)}", got "${extracted.subtype ?? "none"}" (${classification})`,
      );
    }
  }
  if (expected.costMinor !== undefined) {
    possible += 1;
    const classification = classifyCost(
      { costMinor: expected.costMinor, currency: expected.currency },
      extracted,
    );
    earned += addPoint(fieldTotals, "cost", classification);
    if (classification !== "correct") {
      const got = extracted.costMinor === undefined
        ? "none"
        : `${extracted.costMinor} ${extracted.currency ?? "no currency"}`;
      misses.push(
        `${name}: cost expected ${expected.costMinor} ${expected.currency ?? "no currency"}, got ${got} (${classification})`,
      );
    }
  }
  if (expected.scheduleKind !== undefined) {
    possible += 1;
    const classification = classifyScalar(expected.scheduleKind, extracted.scheduleKind);
    earned += addPoint(fieldTotals, "scheduleKind", classification);
    if (classification !== "correct") {
      misses.push(
        `${name}: schedule kind expected "${expected.scheduleKind}", got "${extracted.scheduleKind ?? "none"}" (${classification})`,
      );
    }
  }
  if (expected.recurrenceMonths !== undefined) {
    possible += 1;
    const classification = classifyNumber(expected.recurrenceMonths, extracted.recurrenceMonths);
    earned += addPoint(fieldTotals, "recurrence", classification);
    if (classification !== "correct") {
      misses.push(
        `${name}: recurrence expected ${expected.recurrenceMonths} months, ` +
        `got ${extracted.recurrenceMonths ?? "none"} (${classification})`,
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

/** Shared by `scoreCorpusRepeated` and the three-way scorer below: minimum,
 * mean and maximum over a set of runs already scored (ADR-0025 section 6).
 * The minimum is the number every gate uses, so run-to-run variance counts
 * against the extractor, never for it. */
function summariseRuns(scored: RunScore[]): RepeatedScore {
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
  return summariseRuns(scored);
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

// ADR-0025 section 6 / issue #959: the three-way measurement. "Three numbers
// are kept, never two" (section 4): the heuristics alone (above, unchanged),
// the model's blind pass, and the model's adjudicated answer -- reported
// separately, never averaged into one score. Beside them, a diagnostic:
// among the fields where the blind pass and the heuristic disagreed AND the
// blind reading was the one ground truth supports, how often adjudication
// sided with the heuristic (the wrong reading) anyway. That diagnostic is
// reporting only -- it is never a threshold, and it never fails a test.
//
// A blind score at or below the heuristic baseline is NOT a failure here or
// anywhere downstream: nothing in this file compares the blind number to the
// heuristic number or fails on the relationship between them. The model's
// value is as a judge over both readings, not as a solo extractor.
//
// The model path is a genuinely separate path, run only where the `ai`
// profile exists (`selectedExtractionModel`): CI runners do not carry it, so
// `scoreCorpusThreeWay` returns `model: null` -- a clean skip, not a failure
// -- rather than attempting a live model when none is configured. The
// heuristics-only score is computed unconditionally either way, so a caller
// that only wants today's fast-lane number is unaffected.

/** The only two adjudicated fields (`./adjudication.ts`'s `AdjudicatedField`)
 * the corpus carries ground truth for -- `title` has none, so it cannot
 * feature in the resolution-accuracy diagnostic. */
type ResolvableField = "provider" | "reference";
const RESOLVABLE_FIELDS: readonly ResolvableField[] = ["provider", "reference"];

function classifyResolvable(field: ResolvableField, expected: string, actual: string | undefined): Classification {
  return field === "provider" ? classifyProvider(expected, actual) : classifyScalar(expected, actual);
}

/** The shape of one field comparison this harness reads. Deliberately
 * narrower than `./adjudication.ts`'s `FieldComparison` -- structurally
 * compatible with it, so the real `adjudicateProposal` result can be passed
 * straight through -- so a test can hand-build one without importing the
 * model plumbing. */
export interface ThreeWayComparison {
  field: string;
  comparison: "agreed" | "disagreed" | "neither";
  outcome?: string;
}

/** The per-document result of the model's blind-then-adjudicate flow.
 * Structurally compatible with `./adjudication.ts`'s `AdjudicationResult`
 * (`blind`, `proposal` and `comparisons` line up), so `adjudicateProposal`
 * can be adapted with a one-line wrapper rather than a bespoke shape. */
export interface ThreeWayResult {
  /** `null` when the blind pass was skipped or failed for this document --
   * scored as a blank on every field, exactly as "the extractor offered
   * nothing" already is. */
  blind: ExtractedFields | null;
  /** What the reviewer would actually see. */
  adjudicated: ExtractedFields;
  comparisons: ThreeWayComparison[];
}

/** Runs the model's blind-then-adjudicate flow for one document. In
 * production this wraps `adjudicateProposal` from `./adjudication`; tests may
 * supply a hand-built fake instead. */
export type ThreeWayExtractor = (
  text: string,
  filename: string,
  heuristic: DocumentProposal,
) => Promise<ThreeWayResult>;

const EMPTY_FIELDS: ExtractedFields = { dates: [] };

/**
 * Per-disagreement resolution accuracy (ADR-0025 section 6): the sharper
 * diagnostic that detects adjudication laundering the heuristic's answer
 * instead of judging it. Reporting only -- never a threshold.
 */
export interface ResolutionAccuracy {
  /** Disagreements where the blind reading was the one ground truth supports. */
  blindCorrectDisagreements: number;
  /** Of those, how many adjudication resolved toward the heuristic anyway. */
  resolvedTowardHeuristic: number;
  /** `undefined` when there were no such disagreements to measure. */
  rate: number | undefined;
}

function resolutionAccuracyOf(blindCorrectDisagreements: number, resolvedTowardHeuristic: number): ResolutionAccuracy {
  return {
    blindCorrectDisagreements,
    resolvedTowardHeuristic,
    rate: blindCorrectDisagreements === 0 ? undefined : resolvedTowardHeuristic / blindCorrectDisagreements,
  };
}

interface ThreeWayRun {
  blind: RunScore;
  adjudicated: RunScore;
  blindCorrectDisagreements: number;
  resolvedTowardHeuristic: number;
}

async function scoreCorpusThreeWayOnce(
  corpus: readonly CorpusDocument[],
  heuristic: (text: string, filename: string) => DocumentProposal,
  threeWay: ThreeWayExtractor,
): Promise<ThreeWayRun> {
  let blindEarned = 0;
  let blindPossible = 0;
  let adjudicatedEarned = 0;
  let adjudicatedPossible = 0;
  const blindMisses: string[] = [];
  const adjudicatedMisses: string[] = [];
  const blindFieldTotals = emptyFieldTotals();
  const adjudicatedFieldTotals = emptyFieldTotals();
  let blindCorrectDisagreements = 0;
  let resolvedTowardHeuristic = 0;

  for (const document of corpus) {
    const heuristicProposal = heuristic(document.text, document.filename);
    const result = await threeWay(document.text, document.filename, heuristicProposal);

    const blindScore = scoreDocument(document, result.blind ?? EMPTY_FIELDS);
    blindEarned += blindScore.earned;
    blindPossible += blindScore.possible;
    blindMisses.push(...blindScore.misses);
    for (const field of FIELD_NAMES) {
      blindFieldTotals[field].earned += blindScore.fieldTotals[field].earned;
      blindFieldTotals[field].possible += blindScore.fieldTotals[field].possible;
    }

    const adjudicatedScore = scoreDocument(document, result.adjudicated);
    adjudicatedEarned += adjudicatedScore.earned;
    adjudicatedPossible += adjudicatedScore.possible;
    adjudicatedMisses.push(...adjudicatedScore.misses);
    for (const field of FIELD_NAMES) {
      adjudicatedFieldTotals[field].earned += adjudicatedScore.fieldTotals[field].earned;
      adjudicatedFieldTotals[field].possible += adjudicatedScore.fieldTotals[field].possible;
    }

    for (const field of RESOLVABLE_FIELDS) {
      const expected = document.expected[field];
      if (expected === undefined) continue;
      const comparison = result.comparisons.find((entry) => entry.field === field);
      if (!comparison || comparison.comparison !== "disagreed") continue;
      const blindValue = result.blind ? result.blind[field] : undefined;
      if (classifyResolvable(field, expected, blindValue) !== "correct") continue;
      blindCorrectDisagreements += 1;
      if (comparison.outcome === "endorsed_heuristic") resolvedTowardHeuristic += 1;
    }
  }

  return {
    blind: {
      earned: blindEarned,
      possible: blindPossible,
      accuracy: blindPossible === 0 ? 1 : blindEarned / blindPossible,
      misses: blindMisses,
      fields: buildFieldScores(blindFieldTotals),
    },
    adjudicated: {
      earned: adjudicatedEarned,
      possible: adjudicatedPossible,
      accuracy: adjudicatedPossible === 0 ? 1 : adjudicatedEarned / adjudicatedPossible,
      misses: adjudicatedMisses,
      fields: buildFieldScores(adjudicatedFieldTotals),
    },
    blindCorrectDisagreements,
    resolvedTowardHeuristic,
  };
}

export interface ThreeWayScore {
  /** Unconditional: the heuristics run on every upload regardless (ADR-0025
   * section 4), and this is exactly `scoreCorpusRepeated`'s result. */
  heuristic: RepeatedScore;
  /** `null` exactly when the model is not configured for this environment --
   * a clean skip, never a failure (ADR-0025 section 6). */
  model: {
    blind: RepeatedScore;
    adjudicated: RepeatedScore;
    resolution: ResolutionAccuracy;
  } | null;
}

/**
 * ADR-0025 section 6's three-way measurement. Scores the corpus
 * `SCORING_RUNS` times exactly as `scoreCorpusRepeated` always has, reporting
 * minimum, mean and maximum for the heuristics alone; where (and only where)
 * `selectedExtractionModel` reports the model as configured, it does the same
 * for the model's blind pass and its adjudicated answer, plus the
 * resolution-accuracy diagnostic summed across every run. Model evaluation
 * must never become a required pipeline gate: `model` is `null`, not a
 * failure, when the `ai` profile is absent, and the heuristic number is
 * unaffected either way.
 */
export async function scoreCorpusThreeWay(
  corpus: readonly CorpusDocument[],
  args: {
    heuristic: (text: string, filename: string) => DocumentProposal;
    threeWay: ThreeWayExtractor;
    environment?: NodeJS.ProcessEnv;
    runs?: number;
  },
): Promise<ThreeWayScore> {
  const runs = args.runs ?? SCORING_RUNS;
  const heuristicExtractor: CorpusExtractor = (text, filename) => args.heuristic(text, filename);
  const heuristicScore = await scoreCorpusRepeated(corpus, heuristicExtractor, runs);

  if (!selectedExtractionModel(args.environment ?? process.env)) {
    return { heuristic: heuristicScore, model: null };
  }

  const blindRuns: RunScore[] = [];
  const adjudicatedRuns: RunScore[] = [];
  let blindCorrectDisagreements = 0;
  let resolvedTowardHeuristic = 0;
  for (let run = 0; run < runs; run += 1) {
    const result = await scoreCorpusThreeWayOnce(corpus, args.heuristic, args.threeWay);
    blindRuns.push(result.blind);
    adjudicatedRuns.push(result.adjudicated);
    blindCorrectDisagreements += result.blindCorrectDisagreements;
    resolvedTowardHeuristic += result.resolvedTowardHeuristic;
  }

  return {
    heuristic: heuristicScore,
    model: {
      blind: summariseRuns(blindRuns),
      adjudicated: summariseRuns(adjudicatedRuns),
      resolution: resolutionAccuracyOf(blindCorrectDisagreements, resolvedTowardHeuristic),
    },
  };
}

export function formatThreeWayScore(label: string, score: ThreeWayScore): string {
  const lines = [formatRepeatedScore(`${label} (heuristic alone)`, score.heuristic)];
  if (!score.model) {
    lines.push(`${label} (model): skipped -- no model configured`);
    return lines.join("\n");
  }
  lines.push(formatRepeatedScore(`${label} (model blind)`, score.model.blind));
  lines.push(formatRepeatedScore(`${label} (model adjudicated)`, score.model.adjudicated));
  const { blindCorrectDisagreements, resolvedTowardHeuristic, rate } = score.model.resolution;
  lines.push(
    `${label} (resolution accuracy): ${resolvedTowardHeuristic}/${blindCorrectDisagreements} blind-correct ` +
    "disagreements resolved toward the heuristic anyway" +
    (rate === undefined ? " (no such disagreements)" : ` (${percent(rate)})`),
  );
  return lines.join("\n");
}
