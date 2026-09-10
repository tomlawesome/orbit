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

import type { CorpusDocument } from "./extraction-corpus";

/** ADR-0025 section 6: five runs, and the minimum is the score. */
export const SCORING_RUNS = 5;

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

export interface RunScore {
  earned: number;
  possible: number;
  accuracy: number;
  misses: string[];
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

function scoreDocument(document: CorpusDocument, extracted: ExtractedFields): RunScore {
  const { name, expected } = document;
  const misses: string[] = [];
  let earned = 0;
  let possible = 0;

  for (const date of expected.dates) {
    possible += 1;
    if (extracted.dates.includes(date)) earned += 1;
    else misses.push(`${name}: date ${date} not extracted (got ${extracted.dates.join(", ") || "none"})`);
  }
  if (expected.dates.length === 0) {
    possible += 1;
    if (extracted.dates.length === 0) earned += 1;
    else misses.push(`${name}: false dates ${extracted.dates.join(", ")}`);
  }
  if (expected.provider !== undefined) {
    possible += 1;
    if (extracted.provider === expected.provider) earned += 1;
    else misses.push(`${name}: provider expected "${expected.provider}", got "${extracted.provider ?? "none"}"`);
  }
  if (expected.reference !== undefined) {
    possible += 1;
    if (extracted.reference === expected.reference) earned += 1;
    else misses.push(`${name}: reference expected "${expected.reference}", got "${extracted.reference ?? "none"}"`);
  }

  return { earned, possible, accuracy: possible === 0 ? 1 : earned / possible, misses };
}

/** Score one pass of a corpus. */
export async function scoreCorpus(
  corpus: readonly CorpusDocument[],
  extractor: CorpusExtractor,
): Promise<RunScore> {
  let earned = 0;
  let possible = 0;
  const misses: string[] = [];
  for (const document of corpus) {
    const extracted = await extractor(document.text, document.filename);
    const score = scoreDocument(document, extracted);
    earned += score.earned;
    possible += score.possible;
    misses.push(...score.misses);
  }
  return { earned, possible, accuracy: possible === 0 ? 1 : earned / possible, misses };
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

export function formatRunScore(label: string, score: RunScore): string {
  return `${label}: ${percent(score.accuracy)} (${score.earned}/${score.possible})` +
    (score.misses.length ? `\n  misses:\n  - ${score.misses.join("\n  - ")}` : "");
}

export function formatRepeatedScore(label: string, repeated: RepeatedScore): string {
  const { worst, runs, minimum, mean, maximum } = repeated;
  return `${label}: minimum of ${runs.length} runs ${percent(minimum)} ` +
    `(${worst.earned}/${worst.possible}); mean ${percent(mean)}, maximum ${percent(maximum)}` +
    (worst.misses.length ? `\n  misses in the worst run:\n  - ${worst.misses.join("\n  - ")}` : "");
}
