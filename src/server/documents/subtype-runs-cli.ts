#!/usr/bin/env node
// Scores the describer-run method for subtype, against the taxonomy bins it
// is meant to beat. One field, no model (the owner's testing rule of
// 2026-09-12).
//
//   npm run eval:subtype-runs               # the 24 the extractor was tuned on
//   npm run eval:subtype-runs -- --holdout  # the 12 unseen pages
//   npm run eval:subtype-runs -- --holdout --misses   # owner only
//
// Three lines come out. The first two are the two methods' answers, scored
// the way every other run is scored: a right answer is a point, a wrong one
// and a blank are both nothing (owner, 2026-09-12). The third is the
// diagnostic the method was written for -- whether either of the top two
// runs is a right answer -- because the owner's version of it offers two
// suggestions and a human picks.
//
// `--misses` names documents, so it is for the owner, not for whoever is
// tuning: see the note at the top of `holdout-score-cli.ts`.
import { chooseSubtypeByRules } from "./extraction-choose-meaning";
import { EXTRACTION_CORPUS } from "./extraction-corpus";
import { EXTRACTION_HOLDOUT_FULLPAGE } from "./extraction-holdout-fullpage";
import { classifySubtype, formatSubtypeExpected } from "./extraction-scoring";
import { sieve } from "./extraction-sieve";
import { tagCandidates } from "./extraction-tags";
import {
  chooseSubtypeByDescriberRuns,
  describerRuns,
  subtypeOfRun,
  subtypeSources,
} from "./subtype-describer-runs";

const holdout = process.argv.includes("--holdout");
const showMisses = process.argv.includes("--misses");
const documents = holdout ? EXTRACTION_HOLDOUT_FULLPAGE : EXTRACTION_CORPUS;
/** The experiment register reads a score line as "<route>: <percent> (n/m)
 * [<field> ...]", and strips exactly one leading "hold-out: " to learn which
 * corpus it was. So the corpus is that prefix and nothing else. */
const corpus = holdout ? "hold-out: " : "";

/** How many of the top runs the diagnostic line looks at, which is how many
 * the owner's version offers. */
const RUNS_OFFERED = 2;

interface Scored {
  right: number;
  of: number;
  misses: string[];
}

function percent(right: number, of: number): string {
  return of === 0 ? "0.0%" : `${((right / of) * 100).toFixed(1)}%`;
}

function line(label: string, scored: Scored): string {
  return `${label}: ${percent(scored.right, scored.of)} (${scored.right}/${scored.of})` +
    ` [subtype ${percent(scored.right, scored.of)} (${scored.right}/${scored.of})]` +
    (showMisses && scored.misses.length ? `\n  misses:\n  - ${scored.misses.join("\n  - ")}` : "");
}

function main(): void {
  const answered: Scored = { right: 0, of: 0, misses: [] };
  const binned: Scored = { right: 0, of: 0, misses: [] };
  const offered: Scored = { right: 0, of: 0, misses: [] };

  for (const document of documents) {
    const expected = document.expected.subtype;
    if (expected === undefined) continue;
    const tagged = tagCandidates(document.text, sieve(document.text));

    const runs = describerRuns(subtypeSources(tagged));
    const byRuns = chooseSubtypeByDescriberRuns(tagged);
    const byBins = chooseSubtypeByRules(tagged);
    const suggestions = runs
      .map((run) => subtypeOfRun(run.run))
      .filter((subtype): subtype is string => subtype !== undefined)
      .slice(0, RUNS_OFFERED);

    const record = (scored: Scored, actual: string | undefined, note?: string): void => {
      scored.of += 1;
      const verdict = classifySubtype(expected, actual);
      if (verdict === "correct") {
        scored.right += 1;
        return;
      }
      const name = document.name.split(",")[0] as string;
      scored.misses.push(
        `${name}: subtype expected ${formatSubtypeExpected(expected)}, got ` +
        `${note ?? (actual === undefined ? "nothing" : `"${actual}"`)} (${verdict})`);
    };

    record(answered, byRuns);
    record(binned, byBins);

    offered.of += 1;
    if (suggestions.some((subtype) => classifySubtype(expected, subtype) === "correct")) {
      offered.right += 1;
    } else {
      const name = document.name.split(",")[0] as string;
      offered.misses.push(
        `${name}: subtype expected ${formatSubtypeExpected(expected)}, offered ` +
        `${suggestions.length ? suggestions.map((subtype) => `"${subtype}"`).join(", ") : "nothing"}`);
    }
  }

  console.log(line(`${corpus}subtype by describer runs`, answered));
  console.log(line(`${corpus}subtype by taxonomy bins`, binned));
  console.log(line(`${corpus}subtype in either of the top two runs`, offered));
}

main();
