#!/usr/bin/env node
// How the date sieves are judged (ADR-0026 stage 2, owner 2026-09-11).
//
// Each sieve is a different way of looking at a date, and this says what
// each one is worth on its own over the 24 tuning documents:
//
//   answers kept    of the dated answers the corpus expects, how many this
//                   sieve spoke for at all -- a sieve that never keeps an
//                   answer is a sieve doing nothing
//   role right      of those, how many it named correctly
//   only this one   of those, how many no other sieve kept. This is the
//                   number that says whether a sieve earns its place: a
//                   sieve that only ever agrees with the words before the
//                   date adds nothing the words before the date did not
//   candidates      how many of every date on every page it spoke for; a
//                   sieve that keeps nearly all of them is not sieving
//   ms              what it costs over the whole corpus
//
// A sieve is worth keeping when it keeps answers other sieves miss, even if
// it is often wrong on its own: stage 3 hears the agreement, not one vote.
// Nothing here is a gate.
//
//   npm run eval:date-sieves
//   npm run eval:date-sieves -- --verbose    # the answers no sieve kept

import { EXTRACTION_CORPUS } from "./extraction-corpus";
import {
  DATE_SIEVES,
  DATE_RANGE,
  runDateSieves,
  WORDS_BEFORE,
  type DateCandidate,
  type DateVote,
} from "./extraction-date-sieves";
import { sieve } from "./extraction-sieve";
import { dateCandidatesOf, wordsBeforeAssignments } from "./extraction-tags";

const verbose = process.argv.includes("--verbose");

interface Tally {
  answersKept: number;
  roleRight: number;
  onlyOne: number;
  candidatesKept: number;
  ms: number;
}

const NAMES = [WORDS_BEFORE, DATE_RANGE, ...DATE_SIEVES.map((entry) => entry.name)];

/** A vote that claims a role is a vote to keep the date. `other` asserts
 * nothing, so it keeps nothing. */
function keeps(vote: DateVote): boolean {
  return vote.role !== "other";
}

function main(): void {
  const tallies = new Map<string, Tally>(
    NAMES.map((name) => [name, { answersKept: 0, roleRight: 0, onlyOne: 0, candidatesKept: 0, ms: 0 }]),
  );
  let answers = 0;
  let candidates = 0;
  const orphans: string[] = [];

  for (const document of EXTRACTION_CORPUS) {
    const { text } = document;
    const dates: DateCandidate[] = dateCandidatesOf(text, sieve(text));
    candidates += dates.length;

    // Timed one sieve at a time, over the same input stage 2 gives them.
    const beforeWords = performance.now();
    const assignments = wordsBeforeAssignments(text, dates);
    const wordsBeforeMs = performance.now() - beforeWords;
    for (const name of [WORDS_BEFORE, DATE_RANGE]) {
      (tallies.get(name) as Tally).ms += wordsBeforeMs / 2;
    }
    for (const entry of DATE_SIEVES) {
      const started = performance.now();
      for (const date of dates) entry.read(text, date, dates);
      (tallies.get(entry.name) as Tally).ms += performance.now() - started;
    }

    const votes = runDateSieves(text, dates, assignments);
    for (const cast of votes) {
      for (const vote of cast) {
        if (keeps(vote)) (tallies.get(vote.sieve) as Tally).candidatesKept += 1;
      }
    }

    for (const expected of document.expected.dateRoles ?? []) {
      answers += 1;
      const forAnswer = votes
        .filter((_, at) => dates[at].value === expected.date)
        .flat()
        .filter(keeps);
      if (forAnswer.length === 0) orphans.push(`${document.filename}: ${expected.date} ${expected.role}`);
      for (const name of NAMES) {
        const cast = forAnswer.filter((vote) => vote.sieve === name);
        if (cast.length === 0) continue;
        (tallies.get(name) as Tally).answersKept += 1;
        if (cast.some((vote) => vote.role === expected.role)) (tallies.get(name) as Tally).roleRight += 1;
        if (forAnswer.every((vote) => vote.sieve === name)) (tallies.get(name) as Tally).onlyOne += 1;
      }
    }
  }

  console.log(
    `date sieves over ${EXTRACTION_CORPUS.length} documents: ${answers} dated answers, ${candidates} date candidates\n`,
  );
  console.log(
    `${"sieve".padEnd(20)}${"answers kept".padEnd(15)}${"role right".padEnd(14)}` +
      `${"only this one".padEnd(15)}${"candidates kept".padEnd(20)}ms`,
  );
  for (const name of NAMES) {
    const tally = tallies.get(name) as Tally;
    const share = candidates === 0 ? 0 : Math.round((tally.candidatesKept / candidates) * 100);
    console.log(
      name.padEnd(20) +
        `${tally.answersKept}/${answers}`.padEnd(15) +
        `${tally.roleRight}/${answers}`.padEnd(14) +
        `${tally.onlyOne}`.padEnd(15) +
        `${tally.candidatesKept}/${candidates} (${share}%)`.padEnd(20) +
        tally.ms.toFixed(0),
    );
  }
  console.log(`\nanswers no sieve kept: ${orphans.length}/${answers}`);
  if (verbose) for (const orphan of orphans) console.log(`  ${orphan}`);
}

main();
