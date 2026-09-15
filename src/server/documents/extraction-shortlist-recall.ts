// The shortlist-recall counting itself, shared by the corpus CLI
// (`shortlist-recall-cli.ts`) and the real-document bundle
// (`scripts/extract-bundle/cli.ts`), so a run over the owner's own documents
// reports the same numbers the corpora report, measured the same way. What
// the numbers mean, and why subtype has no rank, is in the CLI's header.
//
// The page text is the caller's: the corpus hands over its stored Tika text,
// the bundle hands over the page after letter-spacing repair, which is what
// its own chooser read.

import {
  costShortlistEntries,
  dateShortlistEntries,
  recurrenceShortlistEntries,
  referenceShortlistEntries,
} from "./extraction-choose";
import { providerShortlistEntries, subtypeShortlist } from "./extraction-choose-meaning";
import type { CorpusExpectation } from "./extraction-corpus";
import {
  classifyProvider,
  classifySubtype,
  formatSubtypeExpected,
  type ExtractedFields,
} from "./extraction-scoring";
import { sieve } from "./extraction-sieve";
import type { ShortlistEntry } from "./extraction-shortlist";
import { composeSubtype } from "./extraction-subtype-bins";
import { tagCandidates } from "./extraction-tags";

export interface FieldTally {
  /** Expected answers that were first on the shortlist. */
  top1: number;
  /** Expected answers in the top two. */
  top2: number;
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

export const RECALL_FIELDS = ["dates", "reference", "cost", "provider", "subtype", "recurrence"] as const;
export type RecallField = (typeof RECALL_FIELDS)[number];
export type RecallTallies = Record<RecallField, FieldTally>;

/** Whether a field's shortlist carries a real best-first order to rank the
 * answer against. Only subtype does not (see the CLI's header comment). */
const RANKED: Record<RecallField, boolean> = {
  dates: true, reference: true, cost: true, provider: true, subtype: false, recurrence: true,
};

export function emptyRecallTallies(): RecallTallies {
  const tallies = {} as RecallTallies;
  for (const field of RECALL_FIELDS) {
    tallies[field] = { top1: 0, top2: 0, top3: 0, found: 0, wanted: 0, entries: 0, lists: 0, misses: [] };
  }
  return tallies;
}

const percent = (part: number, whole: number): string =>
  whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`;

/** One document's page text and what a careful reader says is on it. */
export interface RecallDocument {
  name: string;
  text: string;
  expected: CorpusExpectation;
}

/** Add one document's shortlists to the tallies. */
export function countShortlistRecall(tallies: RecallTallies, document: RecallDocument): void {
  const tagged = tagCandidates(document.text, sieve(document.text));
  const { expected, name } = document;

  /** `rank` is the 0-based position the answer sits at in the shortlist's
   * own order, or -1 where it is not on the list. Where the field is not
   * ranked (subtype), pass 0 for on the list and -1 for not: `RANKED`
   * keeps this from turning that into a top-1 or top-3 claim. */
  const count = (
    field: RecallField,
    entries: readonly ShortlistEntry[],
    wantedAnswers: ReadonlyArray<{ wanted: string; rank: number }>,
  ): void => {
    const tally = tallies[field];
    tally.entries += entries.length;
    tally.lists += 1;
    for (const { wanted, rank } of wantedAnswers) {
      tally.wanted += 1;
      if (rank >= 0) {
        tally.found += 1;
        if (RANKED[field]) {
          if (rank === 0) tally.top1 += 1;
          if (rank <= 1) tally.top2 += 1;
          if (rank <= 2) tally.top3 += 1;
        }
      } else {
        tally.misses.push(`${name}: ${field} ${wanted} is not on the shortlist of ${entries.length}`);
      }
    }
  };

  const dates = dateShortlistEntries(tagged);
  count("dates", dates, expected.dates.map((date) => ({
    wanted: date,
    rank: dates.findIndex((entry) => entry.value === date),
  })));

  const references = referenceShortlistEntries(tagged, document.text);
  count("reference", references, expected.reference === undefined ? [] : [{
    wanted: expected.reference,
    rank: references.findIndex((entry) => entry.value === expected.reference),
  }]);

  const costs = costShortlistEntries(tagged, document.text);
  count("cost", costs, expected.costMinor === undefined ? [] : [{
    wanted: `${expected.costMinor} ${expected.currency ?? "no currency"}`,
    rank: costs.findIndex((entry) =>
      Number(entry.value) === expected.costMinor && entry.currency === expected.currency),
  }]);

  const providers = providerShortlistEntries(tagged);
  const providerAt = expected.provider === undefined
    ? -1
    : providers.findIndex((entry) =>
      classifyProvider(expected.provider as string, entry.value) === "correct");
  count("provider", providers, expected.provider === undefined ? [] : [{
    wanted: expected.provider,
    rank: providerAt,
  }]);

  // The subtype shortlist is two lists the chooser pairs up, so the truth
  // is on it when some qualifier and kind it offers compose to it -- but
  // that cross-product is built only to answer "is it on the list
  // anywhere", never to rank the composed answer (see the CLI's header
  // comment). `rank` here is only ever 0 (on the list) or -1 (not).
  const subtypes = subtypeShortlist(tagged);
  const composable = [undefined, ...subtypes.qualifiers.map((entry) => entry.value)].flatMap((qualifier) =>
    [undefined, ...subtypes.kinds.map((entry) => entry.value)].map((kind) => composeSubtype(qualifier, kind)));
  const subtypeOn = expected.subtype !== undefined && composable.some((composed) => composed !== undefined
    && classifySubtype(expected.subtype as NonNullable<ExtractedFields["subtype"]>, composed) === "correct");
  count("subtype", subtypes.entries, expected.subtype === undefined ? [] : [{
    wanted: formatSubtypeExpected(expected.subtype),
    rank: subtypeOn ? 0 : -1,
  }]);

  const recurrences = recurrenceShortlistEntries(tagged);
  count("recurrence", recurrences, expected.recurrenceMonths === undefined ? [] : [{
    wanted: `${expected.recurrenceMonths} months`,
    rank: recurrences.findIndex((entry) => Number(entry.value) === expected.recurrenceMonths),
  }]);
}

/** The table: a header line, then one line per field. */
export function formatRecallTable(label: string, tallies: RecallTallies): string {
  const lines = [
    `${label}field        top-1               top-2               top-3               on list             mean entries`,
  ];
  for (const field of RECALL_FIELDS) {
    const { top1, top2, top3, found, wanted, entries, lists } = tallies[field];
    const top1Cell = RANKED[field] ? `${top1}/${wanted} (${percent(top1, wanted)})` : "n/a";
    const top2Cell = RANKED[field] ? `${top2}/${wanted} (${percent(top2, wanted)})` : "n/a";
    const top3Cell = RANKED[field] ? `${top3}/${wanted} (${percent(top3, wanted)})` : "n/a";
    const onCell = `${found}/${wanted} (${percent(found, wanted)})`;
    const mean = lists === 0 ? "n/a" : (entries / lists).toFixed(1);
    lines.push(
      `${field.padEnd(12)} ${top1Cell.padEnd(19)} ${top2Cell.padEnd(19)} ${top3Cell.padEnd(19)} ${onCell.padEnd(19)} ${mean}`,
    );
  }
  return lines.join("\n");
}

/** Every expected answer that was not on its shortlist at all. */
export function recallMisses(tallies: RecallTallies): string[] {
  return RECALL_FIELDS.flatMap((field) => tallies[field].misses);
}
