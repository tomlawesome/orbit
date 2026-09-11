#!/usr/bin/env node
// How the provider sieves are judged (ADR-0026 stage 2, owner 2026-09-11),
// the same way the date sieves are (`date-sieve-report-cli.ts`).
//
// Each sieve is a different way of asking whether an organisation is the
// one the household would contact, and this says what each is worth on its
// own over the 24 tuning documents:
//
//   answer kept     of the 24 expected providers, how many this sieve voted
//                   for at all -- a sieve that never keeps the answer is a
//                   sieve doing nothing
//   only this one   of those, how many no other sieve kept. This is the
//                   number that says whether a sieve earns its place
//   candidates      how many of every organisation on every page it voted
//                   for; a sieve that keeps nearly all of them is not
//                   sieving
//   ms              what it costs over the whole corpus
//
// A sieve is worth keeping when it keeps answers others miss, even where it
// is often wrong alone: stage 3 hears the agreement, not one vote. Nothing
// here is a gate.
//
//   npm run eval:provider-sieves
//   npm run eval:provider-sieves -- --verbose    # the answers no sieve kept

import { EXTRACTION_CORPUS } from "./extraction-corpus";
import {
  LANGUAGE_FACT,
  PROVIDER_SIEVES,
  PROVIDER_SIEVE_NAMES,
  providerPageFacts,
  runProviderSieves,
  sameOrganisation,
  statesTheProvider,
  type ProviderVote,
} from "./extraction-provider-sieves";
import { sieve } from "./extraction-sieve";
import { organisationCandidatesOf, organisationLabels } from "./extraction-tags";

const verbose = process.argv.includes("--verbose");

interface Tally {
  answersKept: number;
  onlyOne: number;
  candidatesKept: number;
  ms: number;
}

/** A vote stage 3 reads as a reason to call this the provider -- which is
 * what the language fact votes when it quotes "administered by" as much as
 * when it quotes "your supplier is". Every other tag -- the underwriter,
 * the regulator, the legal entity -- is the sieve speaking against, and
 * keeps nothing. */
function keeps(vote: ProviderVote): boolean {
  return vote.tag === "provider" || statesTheProvider(vote.tag, vote.trigger);
}

function main(): void {
  const tallies = new Map<string, Tally>(
    PROVIDER_SIEVE_NAMES.map((name) => [name, { answersKept: 0, onlyOne: 0, candidatesKept: 0, ms: 0 }]),
  );
  let answers = 0;
  let candidates = 0;
  const orphans: string[] = [];

  for (const document of EXTRACTION_CORPUS) {
    const { text } = document;
    const found = sieve(text);
    const organisations = organisationCandidatesOf(found);
    candidates += organisations.length;

    // Timed one sieve at a time, over the same input stage 2 gives them.
    const beforeLabels = performance.now();
    const labels = organisationLabels(text, found);
    (tallies.get(LANGUAGE_FACT) as Tally).ms += performance.now() - beforeLabels;
    const page = providerPageFacts(text, organisations, labels);
    for (const entry of PROVIDER_SIEVES) {
      const started = performance.now();
      for (const organisation of organisations) entry.read(organisation, organisations, page);
      (tallies.get(entry.name) as Tally).ms += performance.now() - started;
    }

    const votes = runProviderSieves(text, organisations, labels);
    for (const cast of votes) {
      for (const vote of cast) {
        if (keeps(vote)) (tallies.get(vote.sieve) as Tally).candidatesKept += 1;
      }
    }

    const expected = document.expected.provider;
    if (expected === undefined) continue;
    answers += 1;
    const forAnswer = votes
      .filter((_, at) => sameOrganisation(organisations[at].value, expected))
      .flat()
      .filter(keeps);
    if (forAnswer.length === 0) orphans.push(`${document.filename}: ${expected}`);
    for (const name of PROVIDER_SIEVE_NAMES) {
      const cast = forAnswer.filter((vote) => vote.sieve === name);
      if (cast.length === 0) continue;
      (tallies.get(name) as Tally).answersKept += 1;
      if (forAnswer.every((vote) => vote.sieve === name)) (tallies.get(name) as Tally).onlyOne += 1;
    }
  }

  console.log(
    `provider sieves over ${EXTRACTION_CORPUS.length} documents: ${answers} expected providers, ` +
      `${candidates} organisation candidates\n`,
  );
  console.log(
    `${"sieve".padEnd(20)}${"answer kept".padEnd(15)}${"only this one".padEnd(15)}` +
      `${"candidates kept".padEnd(22)}ms`,
  );
  for (const name of PROVIDER_SIEVE_NAMES) {
    const tally = tallies.get(name) as Tally;
    const share = candidates === 0 ? 0 : Math.round((tally.candidatesKept / candidates) * 100);
    console.log(
      name.padEnd(20) +
        `${tally.answersKept}/${answers}`.padEnd(15) +
        `${tally.onlyOne}`.padEnd(15) +
        `${tally.candidatesKept}/${candidates} (${share}%)`.padEnd(22) +
        tally.ms.toFixed(0),
    );
  }
  console.log(`\nanswers no sieve kept: ${orphans.length}/${answers}`);
  if (verbose) for (const orphan of orphans) console.log(`  ${orphan}`);
}

main();
