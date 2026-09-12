// Describer-word runs over the words a page prints about itself: the owner's
// method of 2026-09-11 (22:39), written that night and never measured until
// now. It is the mirror image of the provider bins
// (`extraction-provider-runs.ts`), run over the other half of the same split.
//
// The provider bins keep a run of words only where one of its words
// distinguishes one organisation from another -- a name word. Everything
// left over is a describer word: what kind of thing this is. Those are
// exactly the words subtype is asking about, so this method counts runs made
// of nothing else.
//
//   source      the stage 1 headings, and the stage 2 organisations at least
//               one sieve read as the provider -- `subtypeSources`, the same
//               reading the taxonomy bins get. What a document calls itself
//               and who it is from is what says what it is.
//   drop        the joining words and the company-form words, both lists
//               already the owner's (`JOINING_WORDS`, `COMPANY_FORM_WORDS`).
//               They are dropped from the sequence rather than breaking it,
//               so "Certificate of Motor Insurance" is one run of three
//               words and not two runs of one.
//   keep        a run of consecutive surviving words, every one of them a
//               word from `subtype-taxonomy.json`. A run carrying anything
//               else is a name, not a description.
//   count       how often each run is printed across the sources, case
//               folded. A run printed exactly as often as a longer run
//               containing it folds into that longer run, as the provider
//               bins fold theirs.
//
// What the owner's version stops at is a list: the top two runs, printed for
// a human to read. To score it, a run has to become an answer, so the run is
// put back through the taxonomy -- which qualifier group and which kind group
// its own words land in -- and composed by the taxonomy's own rules
// (`composeSubtype`). The answer is the first of the ranked runs that
// composes one.
//
// Nothing here reads where a heading sits, how it is capitalised, or how any
// document we have seen behaves. The word lists are the taxonomy's and the
// owner's.

import { COMPANY_FORM_WORDS } from "./extraction-provider-runs";
import type { TaggedCandidate } from "./extraction-stages";
import {
  composeSubtype,
  JOINING_WORDS,
  subtypeGroupBins,
  subtypeSources,
  type SubtypeSource,
} from "./extraction-subtype-bins";
import subtypeTaxonomyJson from "./subtype-taxonomy.json";

interface TaxonomyGroup {
  name: string;
  synonyms: string[];
}

interface SubtypeTaxonomy {
  kinds: TaxonomyGroup[];
  qualifiers: TaxonomyGroup[];
}

/**
 * Words dropped from a line before its runs are read: the words that join a
 * phrase together, and the words that say a name belongs to a company. Both
 * lists are reused rather than restated -- a word that means nothing to the
 * provider bins means nothing here either.
 */
export const DROPPED_WORDS: ReadonlySet<string> = new Set<string>([
  ...JOINING_WORDS,
  ...COMPANY_FORM_WORDS,
]);

function taxonomyWords(): Set<string> {
  const taxonomy = subtypeTaxonomyJson as SubtypeTaxonomy;
  const words = new Set<string>();
  for (const group of [...taxonomy.kinds, ...taxonomy.qualifiers]) {
    for (const synonym of [group.name, ...group.synonyms]) {
      for (const word of synonym.toLowerCase().split(/[^a-z0-9&]+/u)) {
        if (word.length > 0 && !DROPPED_WORDS.has(word)) words.add(word);
      }
    }
  }
  return words;
}

/** Every word the taxonomy uses to describe what a document is about, once
 * the joining and company-form words are taken out of it. */
export const TAXONOMY_WORDS: ReadonlySet<string> = taxonomyWords();

/** Whether a word says what kind of thing a document is. */
export function isDescriberWord(word: string): boolean {
  return TAXONOMY_WORDS.has(word.toLowerCase());
}

/** One run of describer words, how often the sources printed it, and where. */
export interface DescriberRun<S extends SubtypeSource = SubtypeSource> {
  /** The run case folded, single spaced: the bin's identity. */
  run: string;
  /** The run as the sources printed it most often. */
  display: string;
  /** How many runs across all the sources were this one. */
  count: number;
  /** The sources it was found in, first seen first, each once. */
  sources: S[];
}

interface Bin<S extends SubtypeSource> {
  run: string;
  count: number;
  order: number;
  spellings: Map<string, number>;
  sources: S[];
  seen: Set<S>;
}

/** The most frequent printing of a run; the first seen where two are equally
 * frequent. */
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

/** A line's words in reading order, the dropped words taken out, keeping the
 * printed spelling beside the folded one. */
function keptWords(value: string): Array<{ printed: string; folded: string }> {
  return value
    .split(/[^A-Za-z0-9&]+/u)
    .filter((word) => word.length > 0)
    .map((printed) => ({ printed, folded: printed.toLowerCase() }))
    .filter((word) => !DROPPED_WORDS.has(word.folded));
}

/**
 * The describer-word runs the sources support, best first.
 *
 * Ranked by count, then by the longer run, then by the order they were first
 * seen -- the provider bins' ordering, which puts the fullest form of a
 * repeated phrase above its fragments.
 *
 * Pure: the same sources always give the same runs, and nothing here reads
 * the page, the document or where anything sits on it.
 */
export function describerRuns<S extends SubtypeSource>(
  sources: readonly S[],
): Array<DescriberRun<S>> {
  const bins = new Map<string, Bin<S>>();
  for (const source of sources) {
    const words = keptWords(source.value);
    for (let from = 0; from < words.length; from += 1) {
      if (!isDescriberWord(words[from]?.folded ?? "")) continue;
      for (let to = from + 1; to <= words.length && isDescriberWord(words[to - 1]?.folded ?? ""); to += 1) {
        const key = words.slice(from, to).map((word) => word.folded).join(" ");
        let bin = bins.get(key);
        if (!bin) {
          bin = { run: key, count: 0, order: bins.size, spellings: new Map(), sources: [], seen: new Set() };
          bins.set(key, bin);
        }
        bin.count += 1;
        const spelling = words.slice(from, to).map((word) => word.printed).join(" ");
        bin.spellings.set(spelling, (bin.spellings.get(spelling) ?? 0) + 1);
        if (!bin.seen.has(source)) {
          bin.seen.add(source);
          bin.sources.push(source);
        }
      }
    }
  }

  const ranked = [...bins.values()].sort((left, right) =>
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
      sources: bin.sources,
    }));
}

/**
 * The subtype one run says, in the taxonomy's own words: the qualifier group
 * and the kind group the run's own words land in most, composed by
 * `composeSubtype`.
 *
 * A run that lands in no kind and in no qualifier the taxonomy lets stand
 * alone says nothing a subtype can be written from, and answers nothing.
 */
export function subtypeOfRun(run: string): string | undefined {
  const bins = subtypeGroupBins([{ value: run, line: "" }]);
  return composeSubtype(bins.qualifiers[0]?.group, bins.kinds[0]?.group);
}

/** What the describer runs read: the same sources as the taxonomy bins. */
export { subtypeSources };

/**
 * The subtype the describer runs answer with: the first of the ranked runs
 * that composes an answer.
 *
 * Later runs are consulted only because an earlier one can rank first and
 * still say nothing on its own -- "car" with no kind beside it, where the
 * taxonomy does not let Car stand alone. Nothing is merged across runs: the
 * answer is one run's own words, which is what makes it different from the
 * taxonomy bins, where the qualifier and the kind are counted apart and can
 * come from lines that never mentioned each other.
 */
export function chooseSubtypeByDescriberRuns(
  candidates: readonly TaggedCandidate[],
): string | undefined {
  for (const run of describerRuns(subtypeSources(candidates))) {
    const subtype = subtypeOfRun(run.run);
    if (subtype !== undefined) return subtype;
  }
  return undefined;
}
