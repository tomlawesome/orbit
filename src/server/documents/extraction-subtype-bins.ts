// Taxonomy bins over the words a page prints about itself: the owner's
// second method of 2026-09-11, moved out of `tmp/provider-word-bins.ts`
// (`--match`) and made the subtype shortlist.
//
// Subtype asks what type of thing a document is about, and the taxonomy
// (`subtype-taxonomy.json`) is the project's answer to that question: 51
// kinds and 63 qualifiers, each with its synonyms. Showing a model the
// taxonomy is showing it three thousand phrases and asking it to write one.
// Counting instead which taxonomy groups the page's own words land in
// leaves four names to choose between.
//
//   source      the stage 1 headings, and every organisation stage 1 found.
//               What a document calls itself and who it is from is what says
//               what it is; the figures and the dates do not.
//   phrase      every synonym of every kind and every qualifier, case
//               folded, with the generic words dropped (of, and, the, a,
//               an, for, to, in, on, at, by, with, or, &), so "Certificate
//               of Insurance" is matched by "insurance certificate".
//   count       each time a phrase appears as a run of consecutive words in
//               a source value, its group scores one. A group with several
//               synonyms in one phrase scores once per synonym: a heading
//               saying "insurance policy" is two reasons to think insurance
//               and not one.
//   place       where each hit was printed: a document names what it is at
//               the top of its first sheet, heads the sections it is made
//               of, and mentions everything else in its text. A count alone
//               lets an advert or a footer repeated on every sheet outvote
//               the title, which is what real paper does (#1015).
//
// Measured by the owner over the 24 (#989 note 16840): the true qualifier
// and the true kind are both in the top two groups on 24 of 24, and the top
// pair alone is fully right on 22 of 24. On six unseen pages his verdict
// was four highly accurate, one acceptable, one poor.
//
// Nothing here reads where a heading sits, how it is capitalised, or how
// the 24 tuning documents behave. The phrases are the taxonomy's own, and
// the generic word list is the owner's.

import type { TaggedCandidate } from "./extraction-stages";
import subtypeTaxonomyJson from "./subtype-taxonomy.json";

/** Words that join a phrase together rather than saying what it is. Dropped
 * from both the taxonomy's phrases and the page's words, so the two are
 * compared on the words that carry meaning. */
export const JOINING_WORDS: readonly string[] = [
  "of", "and", "the", "a", "an", "for", "to", "in", "on", "at", "by", "with", "or", "&",
];

const JOINING = new Set(JOINING_WORDS);

interface TaxonomyGroup {
  name: string;
  synonyms: string[];
}

interface SubtypeTaxonomy {
  kinds: TaxonomyGroup[];
  qualifiers: TaxonomyGroup[];
  combinations: { patterns: string[]; standalone: string[] };
}

const TAXONOMY = subtypeTaxonomyJson as SubtypeTaxonomy;

/** The words of a phrase or a printed line, case folded, the joining words
 * dropped. */
function meaningWords(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9&]+/u)
    .filter((word) => word.length > 0 && !JOINING.has(word));
}

/** One synonym, ready to be looked for: the group it speaks for and the
 * words it is made of. */
interface Phrase {
  group: string;
  words: string[];
}

function phrasesOf(groups: readonly TaxonomyGroup[]): Phrase[] {
  return groups.flatMap((group) =>
    [group.name, ...group.synonyms]
      .map((synonym) => ({ group: group.name, words: meaningWords(synonym) }))
      .filter((phrase) => phrase.words.length > 0));
}

const KIND_PHRASES = phrasesOf(TAXONOMY.kinds);
const QUALIFIER_PHRASES = phrasesOf(TAXONOMY.qualifiers);

/**
 * Where on the paper a word was printed, loudest first.
 *
 * A general fact about household paper: a document names what it is at the
 * top of its first sheet; its text mentions everything else it has to do
 * with; and under some of its headings it is talking about something else
 * entirely -- an add-on it would like to sell, the firm's regulator, how to
 * complain. So the same word is a different amount of evidence depending on
 * where it was printed.
 */
export const SUBTYPE_PLACES = ["title", "body", "aside"] as const;
export type SubtypePlace = (typeof SUBTYPE_PLACES)[number];

/** One line of the page the bins may read: what it says, the Tika block it
 * was printed in, and where on the paper that block sits. A source with no
 * place stated is read as body text, the middle of the three. */
export interface SubtypeSource {
  value: string;
  line: string;
  place?: SubtypePlace;
}

/** One taxonomy group, how often the page's words landed in it, and where. */
export interface GroupBin<S extends SubtypeSource = SubtypeSource> {
  group: string;
  count: number;
  /** How many of those hits were printed in each place. */
  places: Record<SubtypePlace, number>;
  /** The sources a phrase for this group was found in, first seen first. */
  sources: S[];
}

function noPlaces(): Record<SubtypePlace, number> {
  return { title: 0, body: 0, aside: 0 };
}

function bin<S extends SubtypeSource>(
  sources: readonly S[],
  phrases: readonly Phrase[],
): Array<GroupBin<S>> {
  const bins = new Map<string, GroupBin<S> & { seen: Set<S>; order: number }>();
  for (const source of sources) {
    const words = meaningWords(source.value);
    for (const phrase of phrases) {
      let found = 0;
      for (let at = 0; at + phrase.words.length <= words.length; at += 1) {
        if (phrase.words.every((word, i) => words[at + i] === word)) found += 1;
      }
      if (found === 0) continue;
      let held = bins.get(phrase.group);
      if (!held) {
        held = {
          group: phrase.group,
          count: 0,
          places: noPlaces(),
          sources: [],
          seen: new Set(),
          order: bins.size,
        };
        bins.set(phrase.group, held);
      }
      held.count += found;
      held.places[source.place ?? "body"] += found;
      if (!held.seen.has(source)) {
        held.seen.add(source);
        held.sources.push(source);
      }
    }
  }
  return [...bins.values()]
    .sort((left, right) => right.count - left.count || left.order - right.order)
    .map(({ group, count, places, sources: found }) => ({ group, count, places, sources: found }));
}

/**
 * The taxonomy groups the page's own words support, most-supported first.
 *
 * Pure: the same sources always give the same bins, and nothing here reads
 * the page, the document or where anything sits on it.
 */
export function subtypeGroupBins<S extends SubtypeSource>(sources: readonly S[]): {
  qualifiers: Array<GroupBin<S>>;
  kinds: Array<GroupBin<S>>;
} {
  return {
    qualifiers: bin(sources, QUALIFIER_PHRASES),
    kinds: bin(sources, KIND_PHRASES),
  };
}

/** Whether the document named this group where it names itself -- its title
 * -- rather than only mentioning it further down. */
function named(bin: Pick<GroupBin, "places">): number {
  return bin.places.title > 0 ? 1 : 0;
}

/** How often the page says a word other than as an aside: an advert for an
 * add-on and the small print about the firm are the page talking about
 * something else, whatever they are selling under them. */
function spoken(bin: Pick<GroupBin, "count" | "places">): number {
  return bin.count - bin.places.aside;
}

/**
 * Which of two groups the page says louder: negative when `left` is louder,
 * the comparator's own sign convention.
 *
 * Two facts about paper, in the order they are read.
 *
 * A document says what it is in its title, and its text mentions everything
 * else it has to do with -- other products, the regulator, how it may be
 * paid. So a word printed only in the text never outvotes a word the title
 * carries, however often the text repeats it.
 *
 * Then, among words the title is silent about, an aside does not count: what
 * a page offers as an extra, and the small print about the firm, are the
 * page talking about something else. A word printed nowhere but there is a
 * rival, ranked under every word the page says in its own voice, and still
 * ranked above nothing at all -- it stays in its bin and on the shortlist.
 *
 * Everything after those two is the count, as it always was.
 */
export function louderWherePrinted(
  left: Pick<GroupBin, "count" | "places">,
  right: Pick<GroupBin, "count" | "places">,
): number {
  if (named(left) !== named(right)) return named(right) - named(left);
  if (spoken(left) !== spoken(right)) return spoken(right) - spoken(left);
  if (left.count !== right.count) return right.count - left.count;
  for (const place of SUBTYPE_PLACES) {
    const difference = right.places[place] - left.places[place];
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The same bins, reordered by where the page printed the words. Groups the
 * page prints equally loudly keep the order they came in, which is the count
 * order, so nothing is dropped and nothing is invented -- only the ranking
 * changes.
 */
export function rankedWherePrinted<S extends SubtypeSource>(
  bins: ReadonlyArray<GroupBin<S>>,
): Array<GroupBin<S>> {
  return bins
    .map((bin, order) => ({ bin, order }))
    .sort((left, right) => louderWherePrinted(left.bin, right.bin) || left.order - right.order)
    .map(({ bin }) => bin);
}

/** A subtype source with the place on the paper it was printed in. */
export type PlacedCandidate = TaggedCandidate & { place: SubtypePlace };

/**
 * The block stage 2 read as the document's own title: the page's first short
 * block (`extraction-tags.ts`). A name printed inside that block is in the
 * title too, which is why the block and not the heading candidate is what
 * the places are measured against.
 */
function titleBlock(candidates: readonly TaggedCandidate[]): TaggedCandidate | undefined {
  return candidates.find((candidate) =>
    candidate.kind === "heading" && candidate.tags.some((tag) => tag.value === "title"));
}

/**
 * A block the page set apart as the name of what follows it.
 *
 * The general fact: a heading is a name, not a sentence and not a row of a
 * table. It is short, it does not punctuate like prose, it carries none of
 * the figures the text under it carries, and it is printed in capitals or
 * with its words capitalised -- which, once Tika has thrown the type away,
 * is all that is left of being set apart. Subtype keeps its own copy of this
 * judgement (AGENTS.md: every field owns its own stages), and stage 1's
 * looser reading of a heading -- any short block -- stays exactly as it is.
 */
function isSetApartHeading(line: string): boolean {
  if (line.length < 3 || line.length > HEADING_MAX_CHARS) return false;
  if (!/[A-Za-z]/u.test(line)) return false;
  // A figure belongs to the text; the name over it does not carry one.
  if (/\d/u.test(line)) return false;
  if (/[.,;:!?]$/u.test(line)) return false;
  const words = line.split(" ").filter((word) => word.length > 0);
  if (words.length === 0 || words.length > HEADING_MAX_WORDS) return false;
  if (line === line.toUpperCase()) return true;
  return words.every((word) => CAPITALISED_WORD.test(word) || JOINING.has(word.toLowerCase()));
}

/** As long a block as a heading can be, in characters and in words. A name
 * for what follows is short; past this the block is a sentence. */
const HEADING_MAX_CHARS = 80;
const HEADING_MAX_WORDS = 10;

/** A word printed as part of a name rather than as part of a sentence. */
const CAPITALISED_WORD = /^[A-Z][A-Za-z'’&.-]*$/u;

/**
 * Headings that say the block under them is an aside rather than part of
 * what the document is.
 *
 * Two kinds of block, named as block kinds and not as products (#1015). A
 * household document offers things it is not: an add-on, an optional cover,
 * something else the household may also like. And it carries small print it
 * is not about: who regulates the firm, how to complain, which scheme would
 * pay out. Both are headed in so many words, and the words are the same
 * whatever is being sold under them -- which is what makes this a fact about
 * paper rather than a list of products.
 */
const OFFERS_SOMETHING_ELSE = [
  "add on", "add ons", "optional", "optional extra", "optional extras", "extras",
  "extra cover", "additional cover", "additional products", "other products",
  "other services", "also available", "you may also like", "cover options",
  "further products", "upgrade", "upgrades",
];

const SMALL_PRINT_ABOUT_THE_FIRM = [
  "complain", "complaint", "complaints", "ombudsman",
  "regulator", "regulated", "regulatory", "compensation scheme",
];

const ASIDE_HEADINGS = [...OFFERS_SOMETHING_ELSE, ...SMALL_PRINT_ABOUT_THE_FIRM]
  .map((phrase) => ` ${phrase} `);

/** A line reduced to its words, spaced at both ends, so a phrase is looked
 * for whole rather than inside a longer word. */
function spacedWords(line: string): string {
  return ` ${line.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim()} `;
}

function saysAside(line: string): boolean {
  const words = spacedWords(line);
  return ASIDE_HEADINGS.some((phrase) => words.includes(phrase));
}

/**
 * The stretches of the page an aside heading owns: from that heading to the
 * next heading that is not one, or to the end of the page.
 *
 * A heading owns what is printed under it until the page puts up another
 * heading, which is what a heading is for.
 */
function asideBlocks(candidates: readonly TaggedCandidate[]): Array<{ from: number; to: number }> {
  const blocks: Array<{ from: number; to: number }> = [];
  let opened: number | undefined;
  for (const candidate of candidates) {
    if (candidate.kind !== "heading" || !isSetApartHeading(candidate.line)) continue;
    if (saysAside(candidate.line)) {
      opened ??= candidate.index;
    } else if (opened !== undefined) {
      blocks.push({ from: opened, to: candidate.index });
      opened = undefined;
    }
  }
  if (opened !== undefined) blocks.push({ from: opened, to: Number.POSITIVE_INFINITY });
  return blocks;
}

/** Whether a source was printed inside a given block: the same block text, at
 * an offset the block covers. Both halves are needed -- a page that repeats
 * its title in a footer prints the same words somewhere else entirely. */
function inside(block: TaggedCandidate, candidate: TaggedCandidate): boolean {
  return candidate.line === block.line &&
    candidate.index >= block.index &&
    candidate.index < block.index + block.line.length;
}

/**
 * What the bins read: what the document calls itself, and who it is from.
 *
 * Every organisation, not only the ones provider's stage 2 spoke for. Subtype
 * used to read provider's shortlist, so tuning provider moved subtype's
 * answers with no measurement saying it should; every field owns its own
 * stages now (owner, 2026-09-12). Measured on the day of the change: the two
 * readings score the same, 22/24 on the tuning corpus and 10/12 on the
 * hold-out, so nothing was traded for the separation.
 *
 * Each source carries where it was printed, which is what the bins weigh it
 * by. Nothing is left out for sitting in the wrong place: a word the small
 * print carries is still a rival, ranked under the words the title carries.
 */
export function subtypeSources(candidates: readonly TaggedCandidate[]): PlacedCandidate[] {
  const title = titleBlock(candidates);
  const asides = asideBlocks(candidates);
  const placeOf = (candidate: TaggedCandidate): SubtypePlace => {
    if (title !== undefined && inside(title, candidate)) return "title";
    // A word the page prints only under "optional extras" or "how to
    // complain" is a rival, not the answer: it stays in its bin and on the
    // shortlist, ranked under every word the document named itself with.
    if (asides.some((block) => candidate.index >= block.from && candidate.index < block.to)) return "aside";
    return "body";
  };
  const placed = (candidate: TaggedCandidate): PlacedCandidate =>
    ({ ...candidate, place: placeOf(candidate) });
  return [
    ...candidates.filter((candidate) => candidate.kind === "heading").map(placed),
    ...candidates.filter((candidate) => candidate.kind === "organisation").map(placed),
  ];
}

/**
 * The answer a qualifier and a kind make together, in the taxonomy's own
 * combination rules: a kind on its own, a qualifier in front of a kind, or
 * a qualifier alone where the taxonomy allows it to stand alone ("MOT",
 * "Council tax"). A qualifier with no kind and no licence to stand alone is
 * not an answer. A word the taxonomy lists on both sides ("Mortgage") is
 * said once: a mortgage statement lands its words in both bins, and
 * "Mortgage Mortgage" is not a thing (owner's real documents, 2026-09-13).
 */
export function composeSubtype(qualifier?: string, kind?: string): string | undefined {
  if (kind !== undefined && qualifier !== undefined) return qualifier === kind ? kind : `${qualifier} ${kind}`;
  if (kind !== undefined) return kind;
  if (qualifier !== undefined && TAXONOMY.combinations.standalone.includes(qualifier)) return qualifier;
  return undefined;
}
