#!/usr/bin/env node
// How the amount sieves are judged (ADR-0026 stage 2, owner 2026-09-11),
// the same way the date and provider sieves are.
//
// Each sieve is a different way of asking what a figure is, and this says
// what each is worth on its own over the 24 tuning documents:
//
//   answer kept     of the expected costs, how many this sieve spoke for at
//                   all -- a sieve that never keeps the answer is a sieve
//                   doing nothing
//   tag right       of those, how many it read as a cost rather than as
//                   last year's figure or the rival beside it
//   only this one   of those, how many no other sieve kept
//   candidates      how many of every figure on every page it spoke for; a
//                   sieve that keeps nearly all of them is not sieving
//   ms              what it costs over the whole corpus
//
//   npm run eval:amount-sieves
//   npm run eval:amount-sieves -- --verbose    # the answers no sieve kept

import {
  AMOUNT_LABEL,
  AMOUNT_SIEVES,
  AMOUNT_SIEVE_NAMES,
  amountPageFacts,
  runAmountSieves,
  type AmountVote,
} from "./extraction-amount-sieves";
import { EXTRACTION_CORPUS } from "./extraction-corpus";
import { sieve } from "./extraction-sieve";
import { amountCandidatesOf, amountLabels } from "./extraction-tags";

const verbose = process.argv.includes("--verbose");

interface Tally {
  answersKept: number;
  tagRight: number;
  onlyOne: number;
  candidatesKept: number;
  ms: number;
}

/** The tags that say a figure is a cost of some kind. `previous` and
 * `rival` are the sieve speaking against, and keep nothing. */
const A_COST = ["total", "due", "instalment"];

function keeps(vote: AmountVote): boolean {
  return A_COST.includes(vote.tag);
}

function main(): void {
  const tallies = new Map<string, Tally>(
    AMOUNT_SIEVE_NAMES.map((name) =>
      [name, { answersKept: 0, tagRight: 0, onlyOne: 0, candidatesKept: 0, ms: 0 }]),
  );
  let answers = 0;
  let candidates = 0;
  const orphans: string[] = [];

  for (const document of EXTRACTION_CORPUS) {
    const { text } = document;
    const found = sieve(text);
    const amounts = amountCandidatesOf(text, found);
    candidates += amounts.length;

    // Timed one sieve at a time, over the same input stage 2 gives them.
    const beforeLabels = performance.now();
    const labels = amountLabels(text, found);
    (tallies.get(AMOUNT_LABEL) as Tally).ms += performance.now() - beforeLabels;
    const page = amountPageFacts(text, amounts, labels);
    for (const entry of AMOUNT_SIEVES) {
      const started = performance.now();
      for (const amount of amounts) entry.read(amount, amounts, page);
      (tallies.get(entry.name) as Tally).ms += performance.now() - started;
    }

    const votes = runAmountSieves(text, amounts, labels);
    for (const cast of votes) {
      for (const vote of cast) {
        if (keeps(vote)) (tallies.get(vote.sieve) as Tally).candidatesKept += 1;
      }
    }

    const expected = document.expected.costMinor;
    if (expected === undefined) continue;
    answers += 1;
    const forAnswer = votes.filter((_, at) => amounts[at].value === String(expected)).flat();
    if (!forAnswer.some(keeps)) orphans.push(`${document.filename}: ${expected}`);
    for (const name of AMOUNT_SIEVE_NAMES) {
      const cast = forAnswer.filter((vote) => vote.sieve === name);
      if (cast.length === 0) continue;
      (tallies.get(name) as Tally).answersKept += 1;
      if (cast.some(keeps)) (tallies.get(name) as Tally).tagRight += 1;
      if (forAnswer.every((vote) => vote.sieve === name)) (tallies.get(name) as Tally).onlyOne += 1;
    }
  }

  console.log(
    `amount sieves over ${EXTRACTION_CORPUS.length} documents: ${answers} expected costs, ` +
      `${candidates} amount candidates\n`,
  );
  console.log(
    `${"sieve".padEnd(20)}${"answer kept".padEnd(15)}${"tag right".padEnd(13)}${"only this one".padEnd(15)}` +
      `${"candidates kept".padEnd(22)}ms`,
  );
  for (const name of AMOUNT_SIEVE_NAMES) {
    const tally = tallies.get(name) as Tally;
    const share = candidates === 0 ? 0 : Math.round((tally.candidatesKept / candidates) * 100);
    console.log(
      name.padEnd(20) +
        `${tally.answersKept}/${answers}`.padEnd(15) +
        `${tally.tagRight}/${answers}`.padEnd(13) +
        `${tally.onlyOne}`.padEnd(15) +
        `${tally.candidatesKept}/${candidates} (${share}%)`.padEnd(22) +
        tally.ms.toFixed(0),
    );
  }
  console.log(`\nanswers no sieve kept: ${orphans.length}/${answers}`);
  if (verbose) for (const orphan of orphans) console.log(`  ${orphan}`);
}

main();
