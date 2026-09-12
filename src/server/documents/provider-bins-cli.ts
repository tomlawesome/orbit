#!/usr/bin/env node
// How well the provider word-run bins rank, and whether the gate in front of
// them is what limits them (#989, #994). The shipped shortlist bins only the
// organisations a stage 2 sieve read as "provider"; this runs the same
// binning over every organisation stage 1 found as well, and prints counts
// only -- no page text, no names -- so the hold-out stays unread.
//
//   npm run eval:provider-bins
//   npm run eval:provider-bins -- --holdout3     # the 12 unseen pages (#998; the first two hold-outs are retired)
//   npm run eval:provider-bins -- --limit 6
//   npm run eval:provider-bins -- --answers      # owner only; see below
//
// `--answers` prints what the bins actually replied on each page beside the
// right answer, and where the right answer sat in the ranking. On the
// hold-out that is reading the pages, which is how a hold-out quietly becomes
// a second tuning set -- it is for the owner deciding whether the scorer is
// too strict, not for whoever is tuning (the rule at the top of
// `holdout-score-cli.ts`).
//
// Two rulers, because the two disagree: the scorer's `classifyProvider`, and
// a looser one that counts a short form of the name a hit, which is what a
// reader marking by hand does.
import { EXTRACTION_CORPUS } from "./extraction-corpus";
import { EXTRACTION_HOLDOUT3_FULLPAGE } from "./extraction-holdout3-fullpage";
import { DESCRIBER_WORDS, providerTaggedOrganisations, providerWordRuns } from "./extraction-provider-runs";
import { classifyProvider } from "./extraction-scoring";
import { sieve } from "./extraction-sieve";
import { tagCandidates } from "./extraction-tags";

/** How many of the commonest words seed the strings. The owner's six. */
const TOP_WORDS = Number(process.argv[process.argv.indexOf("--top-words") + 1]) || 6;

const onHoldout3 = process.argv.includes("--holdout3");
const limitAt = process.argv.indexOf("--limit");
const limit = limitAt >= 0 ? Number(process.argv[limitAt + 1]) : Number.MAX_SAFE_INTEGER;
const corpus = (onHoldout3 ? EXTRACTION_HOLDOUT3_FULLPAGE : EXTRACTION_CORPUS).slice(0, limit);

/** The scorer's answer, and a looser one: a reader marking this by eye
 * counts a short form of the name as a hit. Same runs, two rulers. */
const strict = (wanted: string, got: string): boolean => classifyProvider(wanted, got) === "correct";
const fold = (value: string): string => value.toLowerCase().replaceAll(/[^a-z0-9]+/gu, " ").trim();
const loose = (wanted: string, got: string): boolean => {
  const a = fold(wanted);
  const b = fold(got);
  return a === b || (b.length >= 4 && a.includes(b)) || (a.length >= 4 && b.includes(a));
};

/**
 * The owner's original method, 2026-09-11, as they describe it: bin every
 * word across the names the sieve kept, take the top few, then look for
 * places where those words sit next to each other, and rank those strings
 * by how often they are printed.
 *
 * Different from `providerWordRuns`, which counts every run of consecutive
 * words whatever the words are worth on their own. Here a string is only
 * ever built out of words that are frequent by themselves, so a name
 * printed once cannot reach the list at all.
 */
function seededRuns(
  names: readonly string[],
  { words: topWords, dropDescribers }: { words: number; dropDescribers: boolean },
): Array<{ display: string; count: number }> {
  const split = (name: string): string[] => name.toLowerCase().split(/[^a-z0-9&]+/u).filter(Boolean);

  const wordCounts = new Map<string, number>();
  for (const name of names) {
    for (const word of split(name)) {
      if (dropDescribers && DESCRIBER_WORDS.has(word)) continue;
      wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
    }
  }
  const seeds = new Set([...wordCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, topWords)
    .map(([word]) => word));

  // The longest stretches made only of seed words, counted across the names.
  const strings = new Map<string, { count: number; printed: string }>();
  for (const name of names) {
    const printed = name.split(/[^A-Za-z0-9&]+/u).filter(Boolean);
    const folded = printed.map((word) => word.toLowerCase());
    let from = 0;
    while (from < folded.length) {
      if (!seeds.has(folded[from] as string)) { from += 1; continue; }
      let to = from;
      while (to < folded.length && seeds.has(folded[to] as string)) to += 1;
      const key = folded.slice(from, to).join(" ");
      const held = strings.get(key);
      if (held) held.count += 1;
      else strings.set(key, { count: 1, printed: printed.slice(from, to).join(" ") });
      from = to;
    }
  }
  return [...strings.entries()]
    .sort((left, right) => right[1].count - left[1].count || right[0].length - left[0].length)
    .map(([, value]) => ({ display: value.printed, count: value.count }));
}

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

const showAnswers = process.argv.includes("--answers");
interface Answer {
  name: string;
  wanted: string;
  got: string;
  rank: number;
  strict: boolean;
  loose: boolean;
}
const answers: Answer[] = [];

const gated = empty();
const ungated = empty();
const gatedLoose = empty();
const seededAll = empty();
const seededAllLoose = empty();
const seededNames = empty();
const seededNamesLoose = empty();
const seededStage2 = empty();
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
  const shortlist = providerWordRuns(kept).slice(0, 8);
  if (showAnswers) {
    const at = shortlist.findIndex((run) => strict(wanted, run.display));
    const byEye = shortlist.findIndex((run) => loose(wanted, run.display));
    answers.push({
      name: document.name.split(",")[0] as string,
      wanted,
      got: shortlist[0]?.display ?? "(nothing)",
      rank: at >= 0 ? at + 1 : byEye >= 0 ? -(byEye + 1) : 0,
      strict: at === 0,
      loose: byEye === 0,
    });
  }
  count(gated, shortlist, wanted, strict);
  count(gatedLoose, providerWordRuns(kept).slice(0, 8), wanted, loose);
  count(ungated, providerWordRuns(organisations).slice(0, 8), wanted, strict);

  const stage1Names = organisations.map((candidate) => candidate.value);
  const keptNames = kept.map((candidate) => candidate.value);
  const plain = seededRuns(stage1Names, { words: TOP_WORDS, dropDescribers: false }).slice(0, 8);
  count(seededAll, plain, wanted, strict);
  count(seededAllLoose, plain, wanted, loose);
  const named = seededRuns(stage1Names, { words: TOP_WORDS, dropDescribers: true }).slice(0, 8);
  count(seededNames, named, wanted, strict);
  count(seededNamesLoose, named, wanted, loose);
  count(seededStage2, seededRuns(keptNames, { words: TOP_WORDS, dropDescribers: true }).slice(0, 8), wanted, strict);
}

const percent = (part: number, whole: number): string =>
  `${part}/${whole} (${whole === 0 ? "n/a" : ((part / whole) * 100).toFixed(1)}%)`;

const report = (name: string, tally: Tally): void => {
  console.log(`${name.padEnd(34)} top-1 ${percent(tally.top1, tally.pages).padEnd(16)} ` +
    `top-2 ${percent(tally.top2, tally.pages).padEnd(16)} on list ${percent(tally.onList, tally.pages).padEnd(16)} ` +
    `mean entries ${(tally.entries / tally.pages).toFixed(1)}`);
};

console.log(`${onHoldout3 ? "the 12 unseen pages" : `the ${EXTRACTION_CORPUS.length} tuning pages`}, provider by word-run bins\n`);
console.log("every run of words, however rare (shipped)");
report("  over the sieve-2 providers", gated);
report("  the same, marked by eye", gatedLoose);
report("  over every organisation", ungated);
console.log(`\nstrings built from the top ${TOP_WORDS} words only (owner's original)`);
report("  over every organisation", seededAll);
report("  the same, marked by eye", seededAllLoose);
report("  describer words dropped first", seededNames);
report("  the same, marked by eye", seededNamesLoose);
report("  and only the sieve-2 providers", seededStage2);
console.log(`\norganisations stage 1 found: ${organisationsFound}; a provider sieve kept: ${organisationsKept}`);

// One line in the register's own form, so the provider method can take a row
// on the experiment log beside the other fields' methods (owner, 2026-09-12:
// one row each, a result only in its own column). It is the shipped bins'
// strict top-1 -- what the rules would answer with, not what a reader
// marking by eye would accept.
const scored = percent(gated.top1, gated.pages).replace(/^(\d+)\/(\d+) \((.*)\)$/u, "$3 ($1/$2)");
const prefix = onHoldout3 ? "hold-out 3: " : "";
console.log(`\n${prefix}provider by top word run: ${scored} [provider ${scored}]`);

if (showAnswers) {
  // "where" reads: the rank the scorer found the right answer at, a negative
  // rank where only a reader marking by eye would have found it there, and
  // "not on list" where eight bins never contained it either way.
  const where = (answer: Answer): string =>
    answer.rank > 0 ? `#${answer.rank}` : answer.rank < 0 ? `#${-answer.rank} by eye` : "not on list";
  console.log("\nwhat the bins replied, page by page\n");
  for (const answer of answers) {
    const mark = answer.strict ? "right" : answer.loose ? "right by eye" : "wrong";
    console.log(`${answer.name}`);
    console.log(`  wanted:  ${answer.wanted}`);
    console.log(`  replied: ${answer.got}   -> ${mark}, right answer ${where(answer)}`);
  }
}
