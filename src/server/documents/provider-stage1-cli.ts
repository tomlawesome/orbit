#!/usr/bin/env node
// What provider's own stage 1 (#996) is worth, against the shared sieve it
// replaces. One field, no model.
//
//   npm run eval:provider-stage1                # the tuning pages the extractor was tuned on
//   npm run eval:provider-stage1 -- --holdout3   # the 12 unseen pages (#998; the first two hold-outs are retired)
//
// Two things are measured, because stage 1 is only judged on the first.
//
//   recall     is the right name among the candidates at all? Nothing
//              downstream can recover a name that was never cut out, so this
//              is the number stage 1 lives or dies by.
//   answer     what the whole provider route then replies, with the same
//              stage 2 and the same word-run bins as today. Here only to
//              show what the extra candidates cost the stages behind it.
//
// Both are marked two ways: by `classifyProvider`, which wants the whole
// name and forgives only case and one trailing company form, and by eye,
// which counts a short form of the right name. The owner's verdict on the
// first, 2026-09-12: "classifyProvider is far too strict." Until that is
// settled, read both.
import { EXTRACTION_CORPUS } from "./extraction-corpus";
import { EXTRACTION_HOLDOUT3_FULLPAGE } from "./extraction-holdout3-fullpage";
import { providerTaggedOrganisations, providerWordRuns } from "./extraction-provider-runs";
import { classifyProvider } from "./extraction-scoring";
import { sieve } from "./extraction-sieve";
import { tagCandidates } from "./extraction-tags";
import { providerCandidates } from "./provider-stage1-sieve";

const holdout3 = process.argv.includes("--holdout3");
const documents = holdout3 ? EXTRACTION_HOLDOUT3_FULLPAGE : EXTRACTION_CORPUS;
const prefix = holdout3 ? "hold-out 3: " : "";

/** The scorer's ruler. */
const strict = (wanted: string, got: string): boolean =>
  classifyProvider(wanted, got) === "correct";

/** A reader's ruler: a short form of the right name is the right name. */
const fold = (value: string): string => value.toLowerCase().replaceAll(/[^a-z0-9]+/gu, " ").trim();
const byEye = (wanted: string, got: string): boolean => {
  const a = fold(wanted);
  const b = fold(got);
  return a === b || (b.length >= 4 && a.includes(b)) || (a.length >= 4 && b.includes(a));
};

interface Tally { hits: number; of: number; candidates: number }
const empty = (): Tally => ({ hits: 0, of: 0, candidates: 0 });

const percent = (tally: Tally): string =>
  `${tally.of === 0 ? "0.0" : ((tally.hits / tally.of) * 100).toFixed(1)}%`;

const scoreLine = (label: string, tally: Tally): string =>
  `${prefix}${label}: ${percent(tally)} (${tally.hits}/${tally.of})` +
  ` [provider ${percent(tally)} (${tally.hits}/${tally.of})]`;

function main(): void {
  const sharedRecall = empty();
  const ownRecall = empty();
  const sharedRecallEye = empty();
  const ownRecallEye = empty();
  const sharedAnswer = empty();
  const ownAnswer = empty();
  const ownAnswerEye = empty();

  for (const document of documents) {
    const wanted = document.expected.provider;
    if (wanted === undefined) continue;

    const shared = sieve(document.text).filter((candidate) => candidate.kind === "organisation");
    const own = providerCandidates(document.text);

    const record = (tally: Tally, hit: boolean, candidates = 0): void => {
      tally.of += 1;
      tally.hits += hit ? 1 : 0;
      tally.candidates += candidates;
    };

    record(sharedRecall, shared.some((c) => strict(wanted, c.value)), shared.length);
    record(ownRecall, own.some((c) => strict(wanted, c.value)), own.length);
    record(sharedRecallEye, shared.some((c) => byEye(wanted, c.value)));
    record(ownRecallEye, own.some((c) => byEye(wanted, c.value)));

    // Stage 2 still reads the whole page, so both routes are handed the same
    // dates, amounts and headings and differ only in the names. Provider's
    // own stage 2 is the next thing to separate; until it exists, this is
    // the fair comparison.
    const everythingElse = sieve(document.text).filter((candidate) => candidate.kind !== "organisation");
    const answerOf = (candidates: typeof shared): string | undefined =>
      providerWordRuns(providerTaggedOrganisations(
        tagCandidates(document.text, [...candidates, ...everythingElse].sort((a, b) => a.index - b.index)),
      ))[0]?.display;
    const sharedReply = answerOf(shared);
    const ownReply = answerOf(own);
    record(sharedAnswer, sharedReply !== undefined && strict(wanted, sharedReply));
    record(ownAnswer, ownReply !== undefined && strict(wanted, ownReply));
    record(ownAnswerEye, ownReply !== undefined && byEye(wanted, ownReply));
  }

  const perPage = (tally: Tally): string => (tally.candidates / tally.of).toFixed(0);
  console.log(`${prefix || "tuning: "}stage 1 recall, the number stage 1 is judged on`);
  console.log(`  shared sieve          ${percent(sharedRecall)} (${sharedRecall.hits}/${sharedRecall.of})` +
    `   by eye ${percent(sharedRecallEye)}   ${perPage(sharedRecall)} candidates a page`);
  console.log(`  provider's own sieve  ${percent(ownRecall)} (${ownRecall.hits}/${ownRecall.of})` +
    `   by eye ${percent(ownRecallEye)}   ${perPage(ownRecall)} candidates a page`);
  console.log("");
  console.log(scoreLine("provider by its own stage 1", ownAnswer));
  console.log(scoreLine("provider by the shared stage 1", sharedAnswer));
  console.log(`${prefix}provider by its own stage 1, marked by eye: ` +
    `${percent(ownAnswerEye)} (${ownAnswerEye.hits}/${ownAnswerEye.of})` +
    ` [provider ${percent(ownAnswerEye)} (${ownAnswerEye.hits}/${ownAnswerEye.of})]`);
}

main();
