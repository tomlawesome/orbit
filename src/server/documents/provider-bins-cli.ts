#!/usr/bin/env node
// How well the provider word-run bins rank, and whether the gate in front of
// them is what limits them (#989, #994). The shipped shortlist bins only the
// organisations a stage 2 sieve read as "provider"; this runs the same
// binning over every organisation stage 1 found as well, and prints counts
// only -- no page text, no names -- so the hold-out stays unread.
//
//   npm run eval:provider-bins
//   npm run eval:provider-bins -- --holdout      # the 12 unseen pages
//   npm run eval:provider-bins -- --limit 6
//
// Two rulers, because the two disagree: the scorer's `classifyProvider`, and
// a looser one that counts a short form of the name a hit, which is what a
// reader marking by hand does.
import { EXTRACTION_CORPUS } from "./extraction-corpus";
import { EXTRACTION_HOLDOUT_FULLPAGE } from "./extraction-holdout-fullpage";
import { providerTaggedOrganisations, providerWordRuns } from "./extraction-provider-runs";
import { classifyProvider } from "./extraction-scoring";
import { sieve } from "./extraction-sieve";
import { tagCandidates } from "./extraction-tags";

const onHoldout = process.argv.includes("--holdout");
const limitAt = process.argv.indexOf("--limit");
const limit = limitAt >= 0 ? Number(process.argv[limitAt + 1]) : Number.MAX_SAFE_INTEGER;
const corpus = (onHoldout ? EXTRACTION_HOLDOUT_FULLPAGE : EXTRACTION_CORPUS).slice(0, limit);

/** The scorer's answer, and a looser one: a reader marking this by eye
 * counts a short form of the name as a hit. Same runs, two rulers. */
const strict = (wanted: string, got: string): boolean => classifyProvider(wanted, got) === "correct";
const fold = (value: string): string => value.toLowerCase().replaceAll(/[^a-z0-9]+/gu, " ").trim();
const loose = (wanted: string, got: string): boolean => {
  const a = fold(wanted);
  const b = fold(got);
  return a === b || (b.length >= 4 && a.includes(b)) || (a.length >= 4 && b.includes(a));
};

interface Tally { top1: number; top2: number; onList: number; entries: number; pages: number }
const empty = (): Tally => ({ top1: 0, top2: 0, onList: 0, entries: 0, pages: 0 });

/** Same counting either side; only the set of names it counts over differs. */
function count(
  tally: Tally,
  runs: ReadonlyArray<{ display: string }>,
  wanted: string,
  matches: (wanted: string, got: string) => boolean,
): void {
  const at = runs.findIndex((run) => matches(wanted, run.display));
  tally.pages += 1;
  tally.entries += runs.length;
  if (at === 0) tally.top1 += 1;
  if (at >= 0 && at <= 1) tally.top2 += 1;
  if (at >= 0) tally.onList += 1;
}

const gated = empty();
const ungated = empty();
const gatedLoose = empty();
let organisationsFound = 0;
let organisationsKept = 0;

for (const document of corpus) {
  if (document.expected.provider === undefined) continue;
  const wanted = document.expected.provider;
  const tagged = tagCandidates(document.text, sieve(document.text));
  const organisations = tagged.filter((candidate) => candidate.kind === "organisation");
  const kept = providerTaggedOrganisations(tagged);
  organisationsFound += organisations.length;
  organisationsKept += kept.length;
  count(gated, providerWordRuns(kept).slice(0, 8), wanted, strict);
  count(gatedLoose, providerWordRuns(kept).slice(0, 8), wanted, loose);
  count(ungated, providerWordRuns(organisations).slice(0, 8), wanted, strict);
}

const percent = (part: number, whole: number): string =>
  `${part}/${whole} (${whole === 0 ? "n/a" : ((part / whole) * 100).toFixed(1)}%)`;

const report = (name: string, tally: Tally): void => {
  console.log(`${name.padEnd(34)} top-1 ${percent(tally.top1, tally.pages).padEnd(16)} ` +
    `top-2 ${percent(tally.top2, tally.pages).padEnd(16)} on list ${percent(tally.onList, tally.pages).padEnd(16)} ` +
    `mean entries ${(tally.entries / tally.pages).toFixed(1)}`);
};

console.log(`${onHoldout ? "the 12 unseen pages" : "the 24 tuning pages"}, provider by word-run bins\n`);
report("bins over the sieve-2 providers", gated);
report("  the same, marked by eye", gatedLoose);
report("bins over every organisation", ungated);
console.log(`\norganisations stage 1 found: ${organisationsFound}; a provider sieve kept: ${organisationsKept}`);
