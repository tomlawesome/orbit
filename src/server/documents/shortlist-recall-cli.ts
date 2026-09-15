#!/usr/bin/env node
// Stage 2's measurement since the owner's correction of 2026-09-11: the
// model chooses every field from a shortlist, so what stage 2 is judged on
// is whether the answer is ON that shortlist -- and, per field, whether it
// sits first, in the top three, or merely somewhere on the list (#1008: the
// review screen shows three candidates with the reader's own pick
// pre-selected as #1, so "answer in the top three" is the number the
// ranking work is judged on; top-1 stays on the log too, since it is still
// the cheapest outcome for the reader).
//
//   npm run eval:shortlist
//   npm run eval:shortlist -- --misses
//   npm run eval:shortlist -- --holdout3   # the twelve unseen pages (#998; the first two hold-outs are retired)
//   npm run eval:shortlist -- --holdout4   # the twelve full-page, real-paper-noise pages (#1007)
//
// Per field, over the 60 tuning documents: how often the expected answer is
// first on the shortlist handed to the model, how often it is in the top
// three, how often it is on the list at all, and the mean size of the
// list -- what carrying it costs: a list of eight is a choice, a list of
// forty is extraction again.
//
// Rank is the position the answer sits at in the order the chooser
// receives the shortlist -- `bestSupported`'s best-first order for dates,
// reference, cost and recurrence, and the provider bins' own count order
// for provider. For dates, several expected answers can fall on one page,
// and each is ranked separately.
//
// Subtype gets no top-1 or top-3 column: the model is shown two short
// lists (what the document is about, what type of thing it is), not a
// single ranked list of composed answers, and the composition happens
// after the model picks. There is no order to report the composed answer
// against, so inventing one -- ranking the cross-product this file builds
// only to test "is it on the list anywhere" -- would be reporting a number
// the pipeline does not have. Its row reads "n/a" in both columns; only
// "on list" and mean entries are real for it.
//
// The counting is in `extraction-shortlist-recall.ts`, so the bundle that
// reads the owner's own documents (`scripts/extract-bundle/`) reports these
// same numbers rather than a second opinion of them.

// No model is called. This reads the shortlists themselves.

import { EXTRACTION_CORPUS } from "./extraction-corpus";
import { EXTRACTION_HOLDOUT3_FULLPAGE } from "./extraction-holdout3-fullpage";
import { EXTRACTION_HOLDOUT4_FULLPAGE } from "./extraction-holdout4-fullpage";
import {
  countShortlistRecall,
  emptyRecallTallies,
  formatRecallTable,
  recallMisses,
} from "./extraction-shortlist-recall";

function main(): void {
  // `--holdout3` and `--holdout4` read the twelve pages nobody tuned on.
  // Like the hold-out score, this prints only the summary: naming a miss on
  // an unseen page is how a hold-out turns into a second tuning set, so
  // `--misses` together with either flag is refused outright rather than
  // silently ignored (the same rule `holdout-score-cli.ts` states at its
  // top, applied here as a hard gate instead of a comment).
  const onHoldout3 = process.argv.includes("--holdout3");
  const onHoldout4 = process.argv.includes("--holdout4");
  const wantsMisses = process.argv.includes("--misses");
  if (wantsMisses && (onHoldout3 || onHoldout4)) {
    console.error(
      "--misses does not run on a hold-out: naming a miss on an unseen page is how a hold-out turns into a second tuning set.",
    );
    process.exitCode = 1;
    return;
  }

  const corpus = onHoldout4 ? EXTRACTION_HOLDOUT4_FULLPAGE : onHoldout3 ? EXTRACTION_HOLDOUT3_FULLPAGE : EXTRACTION_CORPUS;
  const label = onHoldout4 ? "hold-out 4: " : onHoldout3 ? "hold-out 3: " : "";
  const showMisses = wantsMisses;
  const tallies = emptyRecallTallies();

  for (const document of corpus) countShortlistRecall(tallies, document);

  console.log(formatRecallTable(label, tallies));

  const misses = recallMisses(tallies);
  if (showMisses && misses.length > 0) console.log(`\nmisses:\n- ${misses.join("\n- ")}`);
  else if (misses.length > 0 && !onHoldout3 && !onHoldout4) console.log(`\n${misses.length} misses; --misses names them`);
  else if (misses.length > 0) console.log(`\n${misses.length} misses, not named: these pages stay unread.`);
}

main();
