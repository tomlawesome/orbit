// The shortlist stage 3 hands the model, for every field (ADR-0026, amended
// 2026-09-11: "everything is supposed to go to the model for final choice").
//
// Stage 2's sieves no longer answer anything. They shrink and rank: for each
// field they hand over the few candidates they spoke best for, each with the
// block it was printed in and the names of the sieves and tags that kept it.
// The model picks one of those, or none, and a rule only answers where there
// is no model to ask (`chooseFields`).
//
// So this file holds the shape of that hand-over and nothing that decides
// anything. The number it is judged on is `eval:shortlist`: how often the
// expected answer is among the entries, and how many entries there were.

/** One candidate as the model is shown it. */
export interface ShortlistEntry {
  /** The answer as the scorer compares it: ISO date, minor units, the
   * printed reference, the organisation's name, a taxonomy phrase. */
  value: string;
  /** How the entry is printed in the excerpt, and how the model's reply is
   * read back: the figure as the page wrote it, the date as ISO. */
  display: string;
  /** For an amount, the currency the symbol or code implied. */
  currency?: string;
  /** The Tika block the candidate was printed in: the evidence, and the
   * only page text the model ever sees. */
  line: string;
  /** The sieve names and tags that kept it, as words the model can read. */
  why: string[];
  /** How well the sieves spoke for it. The rank order, and nothing else:
   * the model, not this number, chooses. */
  support: number;
}

/**
 * How many candidates a field's shortlist may carry. Eight is the owner's
 * ceiling (2026-09-11): enough that the answer is nearly always among them,
 * few enough that the model is choosing rather than extracting.
 */
export const SHORTLIST_LIMIT = 8;

/** At most this much excerpt: the shortlist and its blocks, never the page
 * (ADR-0026 stage 3). */
export const EXCERPT_LIMIT = 1_500;

/** Enough of a block to show what kept a candidate, no more. */
export const BLOCK_LIMIT = 140;

/**
 * How much of the page one entry carries.
 *
 * Every window is centred on the candidate's own printing, and every window
 * begins and ends on a whole word (owner, 2026-09-14). What shipped before
 * was the first `BLOCK_LIMIT` characters of the Tika block, counted from the
 * block's own start, so on a real page a name printed three hundred
 * characters in was not in the text the model read at all -- which made it
 * an unfair control as well as a poor window. `block` keeps its size and is
 * centred like the rest; the others change the size: the sentence the
 * candidate sits in, or that many words either side.
 */
export const CONTEXT_WINDOWS = ["block", "sentence", "w15", "w10", "w5"] as const;

/** One of the windows above, by name. */
export type ContextWindow = (typeof CONTEXT_WINDOWS)[number];

/** What an entry carries where nothing says otherwise: the shipped block. */
export const DEFAULT_WINDOW: ContextWindow = "block";

/**
 * At most this much sentence. A Tika block can be a whole paragraph with no
 * full stop anywhere in it, and one runaway sentence must not eat the
 * excerpt the other seven entries need.
 */
export const SENTENCE_LIMIT = 300;

/** A sentence ends at one of these wherever it stands: a line break, a table
 * cell, a bullet. */
const BOUNDARY_MARKS = new Set(["\n", "\r", "|", "\t", "•", "·"]);

/** And at one of these only where a space or the end of the block follows,
 * so a decimal point, a web address and a file name do not each end one. */
const SENTENCE_MARKS = new Set([".", "?", "!"]);

/** What is shown where a window had to drop the text on that side, so the
 * model can tell a sentence that ended from one that was cut. */
const CUT_MARK = "…";

/** Where the candidate's own words start and stop inside its block. */
interface Printing { from: number; to: number }

/** A stretch of a block, and whether text was dropped at either end of it. */
interface Window extends Printing { cutBefore: boolean; cutAfter: boolean }

function boundaryAt(line: string, at: number): boolean {
  const mark = line[at];
  if (BOUNDARY_MARKS.has(mark)) return true;
  if (!SENTENCE_MARKS.has(mark)) return false;
  const next = line[at + 1];
  return next === undefined || /\s/u.test(next) || BOUNDARY_MARKS.has(next);
}

/**
 * Where the candidate is printed in its block.
 *
 * Case and runs of whitespace are forgiven: a provider run is stored case
 * folded and joined by single spaces, and the page it came from may print
 * the same name in capitals or broken across a line.
 */
function printedAt(line: string, entry: ShortlistEntry): Printing | undefined {
  for (const wanted of [entry.display, entry.value]) {
    const words = wanted.trim().split(/\s+/u).filter((word) => word.length > 0);
    if (words.length === 0) continue;
    const pattern = words.map((word) => word.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&")).join("\\s+");
    const found = new RegExp(pattern, "iu").exec(line);
    if (found) return { from: found.index, to: found.index + found[0].length };
  }
  return undefined;
}

/**
 * A window longer than its cap keeps the candidate and spends what the cap
 * leaves on both sides of it, half each way; where one side has less text
 * than that, the other takes what it did not use (owner, 2026-09-14: the
 * candidate gets context before it as well as after).
 */
function capped(printed: Printing, window: Window, limit: number): Window {
  if (window.to - window.from <= limit) return window;
  const spare = Math.max(0, limit - (printed.to - printed.from));
  const before = printed.from - window.from;
  const after = window.to - printed.to;
  let takeBefore = Math.min(before, Math.floor(spare / 2));
  const takeAfter = Math.min(after, spare - takeBefore);
  takeBefore = Math.min(before, spare - takeAfter);
  return {
    from: printed.from - takeBefore,
    to: printed.to + takeAfter,
    cutBefore: window.cutBefore || takeBefore < before,
    cutAfter: window.cutAfter || takeAfter < after,
  };
}

/** The whole block, which every size is then cut out of. */
function wholeBlock(line: string): Window {
  return { from: 0, to: line.length, cutBefore: false, cutAfter: false };
}

/** The sentence the candidate sits in. A sentence that ran out of block, or
 * that ends at a full stop, was not cut; one the cap shortened was. */
function sentenceAround(line: string, printed: Printing): Window {
  const found = wholeBlock(line);
  for (let at = printed.from - 1; at >= 0; at -= 1) {
    if (boundaryAt(line, at)) {
      found.from = at + 1;
      break;
    }
  }
  for (let at = printed.to; at < line.length; at += 1) {
    if (boundaryAt(line, at)) {
      // A full stop belongs to the sentence it closes; a cell or bullet
      // boundary belongs to neither side of it.
      found.to = SENTENCE_MARKS.has(line[at]) ? at + 1 : at;
      break;
    }
  }
  return capped(printed, found, SENTENCE_LIMIT);
}

/** That many words either side of the candidate, or as many as the block has. */
function wordsAround(line: string, printed: Printing, words: number): Window {
  const ahead = [...line.slice(0, printed.from).matchAll(/\S+/gu)];
  const behind = [...line.slice(printed.to).matchAll(/\S+/gu)];
  const before = ahead.slice(-words);
  const after = behind.slice(0, words);
  const last = after[after.length - 1];
  return {
    from: before[0]?.index ?? printed.from,
    to: last === undefined ? printed.to : printed.to + last.index + last[0].length,
    cutBefore: ahead.length > before.length,
    cutAfter: behind.length > after.length,
  };
}

/**
 * The window moved out to whole words at both ends (owner, 2026-09-14: never
 * cut a word in half). A bound that fell inside a word steps away from the
 * word, never into the candidate: a name printed hard against a bracket or a
 * slash keeps that character rather than losing its first letter.
 */
function wholeWords(line: string, printed: Printing, window: Window): Window {
  const word = (at: number): boolean => at >= 0 && at < line.length && /\S/u.test(line[at]);
  let { from, to } = window;
  let { cutBefore, cutAfter } = window;
  if (word(from - 1) && word(from)) {
    while (from < printed.from && word(from)) from += 1;
    cutBefore = true;
  }
  if (word(to) && word(to - 1)) {
    while (to > printed.to && word(to - 1)) to -= 1;
    cutAfter = true;
  }
  return { from, to, cutBefore, cutAfter };
}

/**
 * The page text one entry carries, with the candidate's own words marked so
 * the model can see which part of the sentence it is being asked about, and
 * an ellipsis wherever the window dropped the rest of the block.
 *
 * A candidate whose block does not carry its words -- an amount stored in
 * minor units, a run the page never printed whole -- has nothing to centre
 * on, so it gets the head of its block at the same size. That is the old
 * behaviour, and it is the honest thing to show rather than a window
 * centred on a guess.
 */
export function contextWindow(entry: ShortlistEntry, window: ContextWindow = DEFAULT_WINDOW): string {
  const line = entry.line;
  if (!line) return "";
  const printed = printedAt(line, entry) ?? { from: 0, to: 0 };
  const sized = window === "sentence"
    ? sentenceAround(line, printed)
    : window === "block"
      ? capped(printed, wholeBlock(line), BLOCK_LIMIT)
      : wordsAround(line, printed, Number(window.slice(1)));
  const { from, to, cutBefore, cutAfter } = wholeWords(line, printed, sized);
  const marked = printed.to > printed.from
    ? line.slice(from, printed.from) +
      `«${line.slice(printed.from, printed.to)}»` +
      line.slice(printed.to, to)
    : line.slice(from, to);
  const shown = marked.replace(/\s+/gu, " ").trim();
  return `${cutBefore ? `${CUT_MARK} ` : ""}${shown}${cutAfter ? ` ${CUT_MARK}` : ""}`;
}

/**
 * The best-spoken-for entries, best first, capped.
 *
 * Ties keep the order they arrived in, which is page order: where the
 * sieves have nothing to separate two candidates, the shortlist must not
 * invent a reason, and stage 3 has never used position as one.
 */
export function bestSupported(
  entries: readonly ShortlistEntry[],
  limit: number = SHORTLIST_LIMIT,
): ShortlistEntry[] {
  return entries
    .map((entry, order) => ({ entry, order }))
    .sort((left, right) => right.entry.support - left.entry.support || left.order - right.order)
    .slice(0, limit)
    .map(({ entry }) => entry);
}

/** Case and whitespace runs ignored -- the comparison the scorer makes. */
export function comparable(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

function entryLine(at: number, entry: ShortlistEntry, window: ContextWindow): string {
  const why = entry.why.length > 0 ? ` (${entry.why.join("; ")})` : "";
  const shown = contextWindow(entry, window);
  const block = shown ? ` "${shown}"` : "";
  return `${at}. ${entry.display}${why}:${block}`;
}

/** What an excerpt shows and how much of it. */
export interface ExcerptShape {
  /** Which window each entry carries. The control is the shipped block. */
  window?: ContextWindow;
  /** The ceiling on the whole excerpt, heading included. */
  limit?: number;
}

/**
 * The shortlist as any model reads it: a heading, then one numbered line per
 * entry carrying the candidate, why the sieves kept it, and the block it
 * came from.
 *
 * Numbered because the answer is a number (owner, 2026-09-11: the chooser is
 * not tied to one model, so the reply has to be something any model can give
 * and any parser can read). Cut at `EXCERPT_LIMIT`, because a shortlist is a
 * few hundred characters and a call needing more has stopped being a choice
 * -- a wider window therefore buys its context by dropping entries off the
 * bottom of the list, which is what makes the window a trade and not a free
 * gain.
 */
export function shortlistExcerpt(
  heading: string,
  entries: readonly ShortlistEntry[],
  shape: ExcerptShape = {},
): string {
  const limit = shape.limit ?? EXCERPT_LIMIT;
  const window = shape.window ?? DEFAULT_WINDOW;
  let excerpt = heading;
  for (const [at, entry] of entries.entries()) {
    const line = entryLine(at + 1, entry, window);
    if (excerpt.length + line.length + 1 > limit) break;
    excerpt += `\n${line}`;
  }
  return excerpt;
}

/** The entry the model named, by the value or the display it was shown, or
 * nothing. Whitespace and case are forgiven; anything else is not on the
 * list. */
export function entryNamed(
  answer: string,
  entries: readonly ShortlistEntry[],
): ShortlistEntry | undefined {
  const wanted = comparable(answer);
  if (!wanted || wanted === "none") return undefined;
  return entries.find((entry) =>
    comparable(entry.display) === wanted || comparable(entry.value) === wanted);
}

/** A field's own way of recognising its answer written some other way: an
 * amount with the symbol left off, a date in the page's words, a name
 * without its legal suffix. */
export interface EntryMatch {
  matches?: (answer: string, entry: ShortlistEntry) => boolean;
  /** Whether to try `matches` before reading the answer as a line number.
   * Dates need it: "1 April 2026" begins with a number that is not one. */
  matchesFirst?: boolean;
}

/**
 * The entry the model chose, read leniently: the line number it was asked
 * for, the value written out, or whatever the field's own matcher
 * recognises. Nothing on the list, or `none`, is nothing -- which is an
 * allowed answer everywhere.
 */
export function entryChosen(
  answer: string,
  entries: readonly ShortlistEntry[],
  match: EntryMatch = {},
): ShortlistEntry | undefined {
  const text = answer.trim();
  if (!text) return undefined;
  const named = entryNamed(text, entries);
  if (named) return named;
  const byMatch = () => match.matches === undefined
    ? undefined
    : entries.find((entry) => match.matches?.(text, entry) ?? false);
  if (match.matchesFirst) {
    const found = byMatch();
    if (found) return found;
  }
  const number = /\d+/u.exec(text);
  if (number) {
    const at = Number(number[0]);
    if (at >= 1 && at <= entries.length) return entries[at - 1];
  }
  return byMatch();
}

/**
 * The model's reply as lines to read one at a time.
 *
 * Any model, any shape: a bare number, a sentence, one line per date, or the
 * JSON a structured-mode model returns. JSON is flattened to the same lines
 * -- `[{"date": "3", "what_it_is_for": "renewal"}]` becomes `3 renewal` --
 * so one lenient parser reads every transport's reply.
 */
export function replyLines(raw: string): string[] {
  const text = raw.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text.split(/[\n;]+/u).map((line) => line.trim()).filter((line) => line.length > 0);
  }
  const lines: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (value !== null && typeof value === "object") {
      const held = Object.values(value as Record<string, unknown>);
      const scalars = held.filter((entry) => typeof entry === "string" || typeof entry === "number");
      if (scalars.length > 0) lines.push(scalars.join(" "));
      for (const entry of held) {
        if (entry !== null && typeof entry === "object") walk(entry);
      }
      return;
    }
    if (value !== null && value !== undefined) lines.push(String(value));
  };
  walk(parsed);
  return lines.map((line) => line.trim()).filter((line) => line.length > 0);
}
