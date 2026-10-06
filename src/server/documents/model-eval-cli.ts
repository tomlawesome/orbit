#!/usr/bin/env node
// ADR-0025 section 6's model evaluation, as the separate script the ADR
// names (#959). Run it where the `ai` Compose profile exists -- a developer
// machine, or an opt-in CI job -- never as a required pipeline gate, since
// CI runners do not carry the profile:
//
//   node node_modules/tsx/dist/cli.mjs src/server/documents/model-eval-cli.ts
//
// It reports the three numbers section 6 requires, each as minimum, mean and
// maximum over SCORING_RUNS repeats: the heuristics alone, the model's blind
// pass, and the model's adjudicated answer. Beside them it reports
// per-disagreement resolution accuracy, the diagnostic that catches
// adjudication parroting the heuristic instead of judging it.
//
// This scores the TUNING corpus only. The hold-out corpus is deliberately
// not imported here: sessions doing extraction improvement never read it,
// and scoring the model against it with the +0.05 margin is #962's job, not
// this script's.
//
// With no model configured the model numbers are skipped, not failed, and
// the heuristic number is exactly what the fast lane already measures.

import { adjudicateProposal } from "./adjudication";
import { EXTRACTION_CORPUS } from "./extraction-corpus";
import { formatThreeWayScore, scoreCorpusThreeWay, type ThreeWayExtractor } from "./extraction-scoring";
import { MODEL_MAILBOX_DEADLINE_MS } from "./model-extraction";
import { proposalFromText } from "./suggestions";

/**
 * Adapts the production flow to the harness. The evaluation measures what a
 * reviewer would actually see, so it calls the same `adjudicateProposal` the
 * upload paths call rather than a scoring-only reimplementation of it. The
 * mailbox deadline is the generous one of the two, which is the right budget
 * for an offline evaluation: a deadline loss here would show up as a lower
 * score and read as a worse model rather than a slower host.
 */
export function adjudicationThreeWayExtractor(deadlineMs = MODEL_MAILBOX_DEADLINE_MS): ThreeWayExtractor {
  return async (text, filename, heuristic) => {
    const result = await adjudicateProposal({ text, filename, heuristic, deadlineMs });
    return { blind: result.blind, adjudicated: result.proposal, comparisons: result.comparisons };
  };
}

async function main(): Promise<void> {
  // Optional first argument: how many repeats. ADR-0025 section 6's gate uses
  // five and takes the minimum, which is the default. One repeat is for
  // looking at a candidate's accuracy quickly while iterating -- it produces
  // a number to read, never a number to gate on, because a single run cannot
  // show the run-to-run variance the minimum exists to catch.
  const requested = Number.parseInt(process.argv[2] ?? "", 10);
  const runs = Number.isInteger(requested) && requested > 0 ? requested : undefined;
  const score = await scoreCorpusThreeWay(EXTRACTION_CORPUS, {
    heuristic: proposalFromText,
    threeWay: adjudicationThreeWayExtractor(),
    runs,
  });
  if (runs !== undefined && runs < 5) {
    console.log(`(${runs} repeat${runs === 1 ? "" : "s"}, not the five the section 6 gate needs -- indicative only)\n`);
  }
  console.log(formatThreeWayScore("tuning corpus", score));
  if (!score.model) {
    console.log(
      "\nNo model configured, so only the heuristic number was measured. Bring up the `ai`\n" +
      "Compose profile and set OLLAMA_MODEL to measure the model path.",
    );
  }
}

main();
