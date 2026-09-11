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

function entryLine(at: number, entry: ShortlistEntry): string {
  const why = entry.why.length > 0 ? ` (${entry.why.join("; ")})` : "";
  const block = entry.line ? ` "${entry.line.slice(0, BLOCK_LIMIT)}"` : "";
  return `${at}. ${entry.display}${why}:${block}`;
}

/**
 * The shortlist as any model reads it: a heading, then one numbered line per
 * entry carrying the candidate, why the sieves kept it, and the block it
 * came from.
 *
 * Numbered because the answer is a number (owner, 2026-09-11: the chooser is
 * not tied to one model, so the reply has to be something any model can give
 * and any parser can read). Cut at `EXCERPT_LIMIT`, because a shortlist is a
 * few hundred characters and a call needing more has stopped being a choice.
 */
export function shortlistExcerpt(
  heading: string,
  entries: readonly ShortlistEntry[],
  limit: number = EXCERPT_LIMIT,
): string {
  let excerpt = heading;
  for (const [at, entry] of entries.entries()) {
    const line = entryLine(at + 1, entry);
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
