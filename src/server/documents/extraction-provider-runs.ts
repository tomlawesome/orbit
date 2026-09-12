// Word-run bins over the organisations stage 2 spoke for: the owner's
// method of 2026-09-11, moved out of `tmp/provider-word-bins.ts` and made
// the provider shortlist's ranking.
//
// The sieves cut one printed name a dozen ways -- "Kestrel Travel", "Travel
// Insurance Services Ltd", "Kestrel Travel Insurance Services Ltd" -- and
// every cut used to arrive at stage 3 as a rival to the others, to be
// merged back by rules about legal suffixes and how often each cut was
// printed. The bins do not need those rules. Count every run of consecutive
// words across every mention the sieves kept, and the words the page really
// repeats -- the ones belonging to the organisation it is from -- rise on
// their own, because every cut of that name contributes to them and a name
// printed once contributes to nothing else.
//
// What stops the bins filling with "insurance ltd" is which words are
// allowed to carry a run:
//
//   describer words   what kind of thing this is, and what kind of company:
//                     every word of every name and synonym in
//                     `subtype-taxonomy.json` (kinds and qualifiers), plus
//                     the generic company-form words below. These appear on
//                     every page of their type, so a run made of nothing
//                     but them says nothing about which organisation.
//   name words        everything else: the words that distinguish this
//                     organisation from the next one.
//
// A run is counted only where it carries at least one name word. The
// describer list is the taxonomy and the company-form words and nothing
// else -- never a word taken from a document we have seen, which would be
// tuning the bins to the 24 (owner, 2026-09-11).
//
// Measured by the owner over six unseen hold-out pages
// (`--stage2 --phrases`, #989 note 16839): the correct provider was in the
// top two bins on all six.

import type { TaggedCandidate } from "./extraction-stages";
import subtypeTaxonomyJson from "./subtype-taxonomy.json";

/**
 * Words that say a name belongs to a company rather than which company it
 * is. Generic enough to print on any page: legal forms, the words that join
 * a name together, and the country.
 */
export const COMPANY_FORM_WORDS: readonly string[] = [
  "ltd",
  "limited",
  "plc",
  "llp",
  "co",
  "company",
  "group",
  "the",
  "of",
  "and",
  "&",
  "uk",
  "for",
  "a",
];

interface TaxonomyGroup {
  name: string;
  synonyms: string[];
}

interface SubtypeTaxonomy {
  kinds: TaxonomyGroup[];
  qualifiers: TaxonomyGroup[];
}

/** The words of a name, as both the bins and the printed form split it.
 * `&` is a word of its own, because real names are built from it. */
function wordsOf(value: string): string[] {
  return value.split(/[^A-Za-z0-9&]+/u).filter((word) => word.length > 0);
}

function describerWords(): Set<string> {
  const words = new Set<string>(COMPANY_FORM_WORDS);
  const taxonomy = subtypeTaxonomyJson as SubtypeTaxonomy;
  for (const group of [...taxonomy.kinds, ...taxonomy.qualifiers]) {
    for (const synonym of [group.name, ...group.synonyms]) {
      for (const word of wordsOf(synonym)) words.add(word.toLowerCase());
    }
  }
  return words;
}

/** Every word that describes what kind of thing or what kind of company a
 * name is, rather than which one. */
export const DESCRIBER_WORDS: ReadonlySet<string> = describerWords();

/** Whether a word distinguishes one organisation from another. */
export function isNameWord(word: string): boolean {
  return !DESCRIBER_WORDS.has(word.toLowerCase());
}

/**
 * Words that join a name together and carry nothing on their own. A real
 * name is built from them -- "Colworth & Drake", "Bank of Scotland" -- but
 * never begins or ends on one.
 */
const JOINING_WORDS = new Set(["of", "and", "the", "a", "an", "for", "to", "in", "on", "at", "by", "with", "or", "&"]);

/** Words that never go in a bin on their own (owner, 2026-09-12: "words
 * like 'of' and 'and' should be excluded from the binning process"): the
 * joining words, and the words a sentence around a name is made of. A
 * name may still contain one -- "Bank of Scotland" is counted as a run --
 * but none of them is ever a word worth counting by itself. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  ...JOINING_WORDS,
  "your", "this", "that", "these", "our", "we", "you", "it", "is", "are", "as", "from", "per", "what", "who",
]);

/** Whether a run is a name rather than a piece of a sentence. A run is
 * allowed to contain a joining word and not to start or end on one: without
 * this the bins answer with "of the Bramblewood Childcare Group", which is
 * the sentence around the name and not the name. */
function isWholeName(run: readonly string[]): boolean {
  const first = run[0];
  const last = run[run.length - 1];
  if (first === undefined || last === undefined) return false;
  return !JOINING_WORDS.has(first) && !JOINING_WORDS.has(last);
}

/** One place an organisation was printed, as the bins read it: the name the
 * sieve cut, and the Tika block it came from. */
export interface ProviderMention {
  value: string;
  line: string;
}

/** One bin: a run of words, how often it was printed across the mentions,
 * and where it came from. */
export interface WordRun<M extends ProviderMention = ProviderMention> {
  /** The run case folded, single spaced: the bin's identity. */
  run: string;
  /** The run as the page printed it most often -- the form to show a model
   * and to answer with. */
  display: string;
  /** How many runs across all the mentions were this one. A name printed
   * three ways contributes to every run it contains, so the count is how
   * much of the kept text this run accounts for, not how many mentions
   * carried it. */
  count: number;
  /** The mentions it was found in, first seen first, each once. */
  mentions: M[];
}

interface Bin<M extends ProviderMention> {
  run: string;
  count: number;
  order: number;
  /** Every original-case printing of the run, and how often each was seen. */
  spellings: Map<string, number>;
  mentions: M[];
  seen: Set<M>;
}

/** The most frequent printing of a run; the first seen where two are
 * equally frequent. */
function bestPrinting(spellings: ReadonlyMap<string, number>): string {
  let best = "";
  let most = 0;
  for (const [spelling, times] of spellings) {
    if (times > most) {
      best = spelling;
      most = times;
    }
  }
  return best;
}

/** Whether `part` is printed inside `whole` as a run of whole words. */
function isRunOf(part: readonly string[], whole: readonly string[]): boolean {
  if (part.length >= whole.length) return false;
  for (let at = 0; at + part.length <= whole.length; at += 1) {
    if (part.every((word, i) => word === whole[at + i])) return true;
  }
  return false;
}

/**
 * The word-run bins over the mentions the caller kept, best first.
 *
 * Every run of consecutive words in every mention is counted, case folded,
 * as long as one of its words is a name word and it neither begins nor ends
 * on a joining word. Ranked by count, then by the
 * longer run, then by the order they were first seen -- the owner's
 * ordering, which puts the fullest form of a repeated name at the top and
 * its fragments under it.
 *
 * A run printed exactly as often as a longer run containing it is that
 * longer run and nothing else, so it is dropped (owner, 2026-09-11):
 * "colworth &", "& drake" and "colworth" at ten fold into "colworth &
 * drake" at ten. Without that, eight places on a shortlist go to eight
 * cuts of one name, and the answer is pushed off the end by a rival the
 * page printed once more.
 *
 * Pure: the same mentions always give the same bins, and nothing here reads
 * the page, the document or where anything sits on it.
 */
export function providerWordRuns<M extends ProviderMention>(
  mentions: readonly M[],
): Array<WordRun<M>> {
  const bins = new Map<string, Bin<M>>();
  for (const mention of mentions) {
    const printed = wordsOf(mention.value);
    const folded = printed.map((word) => word.toLowerCase());
    for (let from = 0; from < folded.length; from += 1) {
      for (let to = from + 1; to <= folded.length; to += 1) {
        const run = folded.slice(from, to);
        if (!run.some(isNameWord) || !isWholeName(run)) continue;
        const key = run.join(" ");
        let bin = bins.get(key);
        if (!bin) {
          bin = { run: key, count: 0, order: bins.size, spellings: new Map(), mentions: [], seen: new Set() };
          bins.set(key, bin);
        }
        bin.count += 1;
        const spelling = printed.slice(from, to).join(" ");
        bin.spellings.set(spelling, (bin.spellings.get(spelling) ?? 0) + 1);
        if (!bin.seen.has(mention)) {
          bin.seen.add(mention);
          bin.mentions.push(mention);
        }
      }
    }
  }

  const ranked = [...bins.values()]
    .sort((left, right) =>
      right.count - left.count ||
      right.run.length - left.run.length ||
      left.order - right.order);

  const words = new Map(ranked.map((bin) => [bin.run, bin.run.split(" ")]));
  return ranked
    .filter((bin) => !ranked.some((other) =>
      other !== bin &&
      other.count === bin.count &&
      isRunOf(words.get(bin.run) as string[], words.get(other.run) as string[])))
    .map((bin) => ({
      run: bin.run,
      display: bestPrinting(bin.spellings),
      count: bin.count,
      mentions: bin.mentions,
    }));
}

/**
 * The organisations the bins are built from: every stage 1 organisation at
 * least one stage 2 sieve read as the provider.
 *
 * Any sieve is enough, which is the owner's step 2 exactly: this is a
 * ranking, not a decision, and a name one weak sieve spoke for still has
 * its words counted against the names several sieves spoke for.
 */
export function providerTaggedOrganisations(
  candidates: readonly TaggedCandidate[],
): TaggedCandidate[] {
  return candidates.filter((candidate) =>
    candidate.kind === "organisation" &&
    candidate.tags.some((tag) => tag.value === "provider"));
}
