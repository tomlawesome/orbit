#!/usr/bin/env node
// Stage 2's measurement since the owner's correction of 2026-09-11: the
// model chooses every field from a shortlist, so what stage 2 is judged on
// is whether the answer is ON that shortlist.
//
//   npm run eval:shortlist
//   npm run eval:shortlist -- --misses
//   npm run eval:shortlist -- --holdout   # the twelve unseen pages
//
// Per field, over the 24 tuning documents: how often the expected answer is
// among the entries handed to the model, and how many entries there were.
// Recall here is a ceiling on everything stage 3 can score -- an answer the
// shortlist does not carry is one no model can pick -- and the mean size is
// what it costs: a list of eight is a choice, a list of forty is extraction
// again.
//
// Provider also reports where on the list the answer is. Its entries are
// word-run bins (`extraction-provider-runs.ts`), ranked by how often the
// run was printed across the names stage 2 kept, so the rank is what the
// ranking is judged on: the owner's six-for-six hold-out result was the
// answer in the top two bins, and this says how the same method does on
// the 24.

// No model is called. This reads the shortlists themselves.

import {
  costShortlistEntries,
  dateShortlistEntries,
  recurrenceShortlistEntries,
  referenceShortlistEntries,
} from "./extraction-choose";
import { providerShortlistEntries, subtypeShortlist } from "./extraction-choose-meaning";
import { composeSubtype } from "./extraction-subtype-bins";
import { EXTRACTION_CORPUS } from "./extraction-corpus";
import { EXTRACTION_HOLDOUT_FULLPAGE } from "./extraction-holdout-fullpage";
import {
  classifyProvider,
  classifySubtype,
  formatSubtypeExpected,
  type ExtractedFields,
} from "./extraction-scoring";
import { sieve } from "./extraction-sieve";
import type { ShortlistEntry } from "./extraction-shortlist";
import { tagCandidates } from "./extraction-tags";

interface FieldTally {
  /** Expected answers that were on the shortlist. */
  found: number;
  /** Expected answers in total. */
  wanted: number;
  /** Entries handed over, summed over the documents a list was built for. */
  entries: number;
  lists: number;
  misses: string[];
}

const FIELDS = ["dates", "reference", "cost", "provider", "subtype", "recurrence"] as const;
type Field = (typeof FIELDS)[number];

/** Where the provider answer sat among the runs, over the documents that
 * have one. */
interface RankTally {
  first: number;
  firstTwo: number;
  onList: number;
  wanted: number;
}

function emptyTallies(): Record<Field, FieldTally> {
  const tallies = {} as Record<Field, FieldTally>;
  for (const field of FIELDS) tallies[field] = { found: 0, wanted: 0, entries: 0, lists: 0, misses: [] };
  return tallies;
}

const percent = (part: number, whole: number): string =>
  whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;

function main(): void {
  // `--holdout` reads the twelve pages nobody tuned on. It answers the
  // question the owner asked by hand -- is the provider in the top bins on
  // pages we have not seen -- and, like the hold-out score, it prints only
  // the summary: naming a miss on an unseen page is how a hold-out becomes
  // a second tuning set.
  const onHoldout = process.argv.includes("--holdout");
  const corpus = onHoldout ? EXTRACTION_HOLDOUT_FULLPAGE : EXTRACTION_CORPUS;
  const showMisses = process.argv.includes("--misses") && !onHoldout;
  const tallies = emptyTallies();
  const providerRank: RankTally = { first: 0, firstTwo: 0, onList: 0, wanted: 0 };

  const count = (
    field: Field,
    entries: readonly ShortlistEntry[],
    expected: ReadonlyArray<{ wanted: string; on: boolean }>,
    name: string,
  ): void => {
    const tally = tallies[field];
    tally.entries += entries.length;
    tally.lists += 1;
    for (const { wanted, on } of expected) {
      tally.wanted += 1;
      if (on) tally.found += 1;
      else tally.misses.push(`${name}: ${field} ${wanted} is not on the shortlist of ${entries.length}`);
    }
  };

  for (const document of corpus) {
    const tagged = tagCandidates(document.text, sieve(document.text));
    const { expected, name } = document;

    const dates = dateShortlistEntries(tagged);
    count("dates", dates, expected.dates.map((date) => ({
      wanted: date,
      on: dates.some((entry) => entry.value === date),
    })), name);

    const references = referenceShortlistEntries(tagged);
    count("reference", references, expected.reference === undefined ? [] : [{
      wanted: expected.reference,
      on: references.some((entry) => entry.value === expected.reference),
    }], name);

    const costs = costShortlistEntries(tagged);
    count("cost", costs, expected.costMinor === undefined ? [] : [{
      wanted: `${expected.costMinor} ${expected.currency ?? "no currency"}`,
      on: costs.some((entry) =>
        Number(entry.value) === expected.costMinor && entry.currency === expected.currency),
    }], name);

    const providers = providerShortlistEntries(tagged);
    const providerAt = expected.provider === undefined
      ? -1
      : providers.findIndex((entry) =>
        classifyProvider(expected.provider as string, entry.value) === "correct");
    if (expected.provider !== undefined) {
      providerRank.wanted += 1;
      if (providerAt === 0) providerRank.first += 1;
      if (providerAt >= 0 && providerAt <= 1) providerRank.firstTwo += 1;
      if (providerAt >= 0) providerRank.onList += 1;
    }
    count("provider", providers, expected.provider === undefined ? [] : [{
      wanted: expected.provider,
      on: providerAt >= 0,
    }], name);

    // The subtype shortlist is two lists the chooser pairs up, so the truth
    // is on it when some qualifier and kind it offers compose to it.
    const subtypes = subtypeShortlist(tagged);
    const composable = [undefined, ...subtypes.qualifiers.map((entry) => entry.value)].flatMap((qualifier) =>
      [undefined, ...subtypes.kinds.map((entry) => entry.value)].map((kind) => composeSubtype(qualifier, kind)));
    count("subtype", subtypes.entries, expected.subtype === undefined ? [] : [{
      wanted: formatSubtypeExpected(expected.subtype),
      on: composable.some((composed) => composed !== undefined
        && classifySubtype(expected.subtype as NonNullable<ExtractedFields["subtype"]>, composed) === "correct"),
    }], name);

    const recurrences = recurrenceShortlistEntries(tagged);
    count("recurrence", recurrences, expected.recurrenceMonths === undefined ? [] : [{
      wanted: `${expected.recurrenceMonths} months`,
      on: recurrences.some((entry) => Number(entry.value) === expected.recurrenceMonths),
    }], name);
  }

  console.log(`${onHoldout ? "hold-out: " : ""}field        answer on the shortlist   mean entries`);
  for (const field of FIELDS) {
    const { found, wanted, entries, lists } = tallies[field];
    const rate = `${found}/${wanted} (${percent(found, wanted)})`;
    console.log(`${field.padEnd(12)} ${rate.padEnd(24)} ${(entries / lists).toFixed(1)}`);
  }
  const { first, firstTwo, onList, wanted } = providerRank;
  console.log("\nprovider, where the answer sits among the runs");
  console.log(`  top-1    ${first}/${wanted} (${percent(first, wanted)})`);
  console.log(`  top-2    ${firstTwo}/${wanted} (${percent(firstTwo, wanted)})`);
  console.log(`  on list  ${onList}/${wanted} (${percent(onList, wanted)})`);

  const misses = FIELDS.flatMap((field) => tallies[field].misses);
  if (showMisses && misses.length > 0) console.log(`\nmisses:\n- ${misses.join("\n- ")}`);
  else if (misses.length > 0 && !onHoldout) console.log(`\n${misses.length} misses; --misses names them`);
  else if (misses.length > 0) console.log(`\n${misses.length} misses, not named: these pages stay unread.`);
}

main();
