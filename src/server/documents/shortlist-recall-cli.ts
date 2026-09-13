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
import { EXTRACTION_HOLDOUT3_FULLPAGE } from "./extraction-holdout3-fullpage";
import { EXTRACTION_HOLDOUT4_FULLPAGE } from "./extraction-holdout4-fullpage";
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
  /** Expected answers that were first on the shortlist. */
  top1: number;
  /** Expected answers in the top three. */
  top3: number;
  /** Expected answers that were on the shortlist anywhere. */
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

/** Whether a field's shortlist carries a real best-first order to rank the
 * answer against. Only subtype does not (see the header comment). */
const RANKED: Record<Field, boolean> = {
  dates: true, reference: true, cost: true, provider: true, subtype: false, recurrence: true,
};

function emptyTallies(): Record<Field, FieldTally> {
  const tallies = {} as Record<Field, FieldTally>;
  for (const field of FIELDS) {
    tallies[field] = { top1: 0, top3: 0, found: 0, wanted: 0, entries: 0, lists: 0, misses: [] };
  }
  return tallies;
}

const percent = (part: number, whole: number): string =>
  whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;

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
  const tallies = emptyTallies();

  /** `rank` is the 0-based position the answer sits at in the shortlist's
   * own order, or -1 where it is not on the list. Where the field is not
   * ranked (subtype), pass 0 for on the list and -1 for not: `RANKED`
   * keeps this file from turning that into a top-1 or top-3 claim. */
  const count = (
    field: Field,
    entries: readonly ShortlistEntry[],
    expected: ReadonlyArray<{ wanted: string; rank: number }>,
    name: string,
  ): void => {
    const tally = tallies[field];
    tally.entries += entries.length;
    tally.lists += 1;
    for (const { wanted, rank } of expected) {
      tally.wanted += 1;
      if (rank >= 0) {
        tally.found += 1;
        if (RANKED[field]) {
          if (rank === 0) tally.top1 += 1;
          if (rank <= 2) tally.top3 += 1;
        }
      } else {
        tally.misses.push(`${name}: ${field} ${wanted} is not on the shortlist of ${entries.length}`);
      }
    }
  };

  for (const document of corpus) {
    const tagged = tagCandidates(document.text, sieve(document.text));
    const { expected, name } = document;

    const dates = dateShortlistEntries(tagged);
    count("dates", dates, expected.dates.map((date) => ({
      wanted: date,
      rank: dates.findIndex((entry) => entry.value === date),
    })), name);

    const references = referenceShortlistEntries(tagged);
    count("reference", references, expected.reference === undefined ? [] : [{
      wanted: expected.reference,
      rank: references.findIndex((entry) => entry.value === expected.reference),
    }], name);

    const costs = costShortlistEntries(tagged);
    count("cost", costs, expected.costMinor === undefined ? [] : [{
      wanted: `${expected.costMinor} ${expected.currency ?? "no currency"}`,
      rank: costs.findIndex((entry) =>
        Number(entry.value) === expected.costMinor && entry.currency === expected.currency),
    }], name);

    const providers = providerShortlistEntries(tagged);
    const providerAt = expected.provider === undefined
      ? -1
      : providers.findIndex((entry) =>
        classifyProvider(expected.provider as string, entry.value) === "correct");
    count("provider", providers, expected.provider === undefined ? [] : [{
      wanted: expected.provider,
      rank: providerAt,
    }], name);

    // The subtype shortlist is two lists the chooser pairs up, so the truth
    // is on it when some qualifier and kind it offers compose to it -- but
    // that cross-product is built only to answer "is it on the list
    // anywhere", never to rank the composed answer (see the header
    // comment). `rank` here is only ever 0 (on the list) or -1 (not).
    const subtypes = subtypeShortlist(tagged);
    const composable = [undefined, ...subtypes.qualifiers.map((entry) => entry.value)].flatMap((qualifier) =>
      [undefined, ...subtypes.kinds.map((entry) => entry.value)].map((kind) => composeSubtype(qualifier, kind)));
    const subtypeOn = expected.subtype !== undefined && composable.some((composed) => composed !== undefined
      && classifySubtype(expected.subtype as NonNullable<ExtractedFields["subtype"]>, composed) === "correct");
    count("subtype", subtypes.entries, expected.subtype === undefined ? [] : [{
      wanted: formatSubtypeExpected(expected.subtype),
      rank: subtypeOn ? 0 : -1,
    }], name);

    const recurrences = recurrenceShortlistEntries(tagged);
    count("recurrence", recurrences, expected.recurrenceMonths === undefined ? [] : [{
      wanted: `${expected.recurrenceMonths} months`,
      rank: recurrences.findIndex((entry) => Number(entry.value) === expected.recurrenceMonths),
    }], name);
  }

  console.log(`${label}field        top-1               top-3               on list             mean entries`);
  for (const field of FIELDS) {
    const { top1, top3, found, wanted, entries, lists } = tallies[field];
    const top1Cell = RANKED[field] ? `${top1}/${wanted} (${percent(top1, wanted)})` : "n/a";
    const top3Cell = RANKED[field] ? `${top3}/${wanted} (${percent(top3, wanted)})` : "n/a";
    const onCell = `${found}/${wanted} (${percent(found, wanted)})`;
    console.log(`${field.padEnd(12)} ${top1Cell.padEnd(19)} ${top3Cell.padEnd(19)} ${onCell.padEnd(19)} ${(entries / lists).toFixed(1)}`);
  }

  const misses = FIELDS.flatMap((field) => tallies[field].misses);
  if (showMisses && misses.length > 0) console.log(`\nmisses:\n- ${misses.join("\n- ")}`);
  else if (misses.length > 0 && !onHoldout3 && !onHoldout4) console.log(`\n${misses.length} misses; --misses names them`);
  else if (misses.length > 0) console.log(`\n${misses.length} misses, not named: these pages stay unread.`);
}

main();
