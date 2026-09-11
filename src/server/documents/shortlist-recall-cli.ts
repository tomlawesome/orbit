#!/usr/bin/env node
// Stage 2's measurement since the owner's correction of 2026-09-11: the
// model chooses every field from a shortlist, so what stage 2 is judged on
// is whether the answer is ON that shortlist.
//
//   npm run eval:shortlist
//   npm run eval:shortlist -- --misses
//
// Per field, over the 24 tuning documents: how often the expected answer is
// among the entries handed to the model, and how many entries there were.
// Recall here is a ceiling on everything stage 3 can score -- an answer the
// shortlist does not carry is one no model can pick -- and the mean size is
// what it costs: a list of eight is a choice, a list of forty is extraction
// again.
//
// No model is called. This reads the shortlists themselves.

import {
  costShortlistEntries,
  dateShortlistEntries,
  recurrenceShortlistEntries,
  referenceShortlistEntries,
} from "./extraction-choose";
import { providerShortlistEntries, subtypeShortlistEntries } from "./extraction-choose-meaning";
import { EXTRACTION_CORPUS } from "./extraction-corpus";
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

function emptyTallies(): Record<Field, FieldTally> {
  const tallies = {} as Record<Field, FieldTally>;
  for (const field of FIELDS) tallies[field] = { found: 0, wanted: 0, entries: 0, lists: 0, misses: [] };
  return tallies;
}

const percent = (part: number, whole: number): string =>
  whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;

function main(): void {
  const showMisses = process.argv.includes("--misses");
  const tallies = emptyTallies();

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

  for (const document of EXTRACTION_CORPUS) {
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
    count("provider", providers, expected.provider === undefined ? [] : [{
      wanted: expected.provider,
      on: providers.some((entry) =>
        classifyProvider(expected.provider as string, entry.value) === "correct"),
    }], name);

    const subtypes = subtypeShortlistEntries(tagged);
    count("subtype", subtypes, expected.subtype === undefined ? [] : [{
      wanted: formatSubtypeExpected(expected.subtype),
      on: subtypes.some((entry) =>
        classifySubtype(expected.subtype as NonNullable<ExtractedFields["subtype"]>, entry.value) === "correct"),
    }], name);

    const recurrences = recurrenceShortlistEntries(tagged);
    count("recurrence", recurrences, expected.recurrenceMonths === undefined ? [] : [{
      wanted: `${expected.recurrenceMonths} months`,
      on: recurrences.some((entry) => Number(entry.value) === expected.recurrenceMonths),
    }], name);
  }

  console.log("field        answer on the shortlist   mean entries");
  for (const field of FIELDS) {
    const { found, wanted, entries, lists } = tallies[field];
    const rate = `${found}/${wanted} (${percent(found, wanted)})`;
    console.log(`${field.padEnd(12)} ${rate.padEnd(24)} ${(entries / lists).toFixed(1)}`);
  }
  const misses = FIELDS.flatMap((field) => tallies[field].misses);
  if (showMisses && misses.length > 0) console.log(`\nmisses:\n- ${misses.join("\n- ")}`);
  else if (misses.length > 0) console.log(`\n${misses.length} misses; --misses names them`);
}

main();
