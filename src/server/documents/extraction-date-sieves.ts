// Stage 2's date sieves (ADR-0026, owner 2026-09-11). Several independent
// ways of looking at one date, each one a small named function, none of them
// allowed to discard anything.
//
// The pipeline finds every date on the page and then loses most of them,
// because until now exactly one sieve looked at a date: the words printed in
// front of it. A page that says "14 November 2026, when your cover ends",
// or heads a column "Renewal date" three blocks above the value, or prints
// the term ("12 months") instead of naming the second date, says what its
// dates are for in a way no trigger table sitting in front of the date can
// hear.
//
// So a date is read several ways at once:
//
//   words-before        the label in front of it (ConText, as before), plus
//                       the range and term-end corrections that read the
//                       block around the label rather than the label alone
//   words-after         the clause printed after it in the same block
//   heading-above       the nearest short heading-shaped block above it,
//                       which is where a flattened table keeps its column
//                       headings
//   term-arithmetic     a date that is another date plus a term the page
//                       printed anywhere ("12 months", "24-month",
//                       "annual") ends that term, and the other one starts it
//   printed-throughout  a date repeated across the whole document is the
//                       running header or footer, which is when the document
//                       was produced -- not a date anyone acts on
//   issue-relative      the document's own date, found by its label or by
//                       being the most-repeated early date; a date printed
//                       before it is not something the household still has
//                       to do
//
// Each sieve returns a vote, never a decision: a role, the words that
// justified it, and how good a reason that is. Votes are merged into tags by
// role, so a date several sieves agree about carries one tag naming all of
// them (`Tag.sieves`) and stage 3 can tell a date three sieves kept from one
// a single weak sieve kept. Nothing here drops a date, and a sieve that says
// nothing about a date costs that date nothing.
//
// None of these sieves may key on where a date sits on the page or on how
// the 24 tuning documents behave (owner, 2026-09-11): "above in the block
// order" is the structure of a flattened table, which every table has, and
// is as far as position goes.

import { CONTEXT_TERMINATION_TERMS, type ContextRoleAssignment } from "./context-roles";
import {
  STRENGTH_GUESS,
  STRENGTH_STATED,
  STRENGTH_WEAK,
  type Tag,
} from "./extraction-stages";
import type { DocumentDateRole } from "./suggestions";

/** A date the sieve found, with everything a stage 2 sieve may read: its
 * normalised value, where it is, how long it was printed, and the Tika block
 * it sits in. */
export interface DateCandidate {
  /** ISO `YYYY-MM-DD`. */
  value: string;
  /** Offset of the date's first character in the page text. */
  index: number;
  /** Length of the date as the page printed it. */
  length: number;
  /** The Tika block the date sits in, whitespace collapsed. */
  line: string;
}

/**
 * One sieve's reading of one date. `weight` is the same scale stage 3 scores
 * a claim on: 2 the page says so in words, 1 a weaker reading that could
 * still be right, 0 a default with nothing behind it.
 */
export interface DateVote {
  sieve: string;
  role: DocumentDateRole;
  /** The words on the page that justified it, verbatim, or "" for a default. */
  trigger: string;
  weight: number;
}

export interface DateSieve {
  name: string;
  /** Every vote this sieve casts for one date. Most sieves cast none. */
  read: (text: string, candidate: DateCandidate, all: readonly DateCandidate[]) => DateVote[];
}

export { STRENGTH_GUESS, STRENGTH_STATED, STRENGTH_WEAK };

// ------------------------------------------------------------ date arithmetic

function parseIso(value: string): { year: number; month: number; day: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return undefined;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** `value` plus `months` calendar months, the day clamped to the end of the
 * month it lands in -- 31 January plus one month is 28 February, which is
 * how a term printed in months is read. */
export function addMonths(value: string, months: number): string | undefined {
  const parsed = parseIso(value);
  if (!parsed) return undefined;
  const total = parsed.year * 12 + (parsed.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return iso(year, month, Math.min(parsed.day, lastDay));
}

/** The day before `value`, because half of UK paper ends a term on the
 * anniversary and the other half on the day before it. */
export function dayBefore(value: string): string | undefined {
  const parsed = parseIso(value);
  if (!parsed) return undefined;
  const at = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day - 1));
  return iso(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate());
}

// -------------------------------------------------------- shared page reading

/** Where a scope ends: terminal punctuation, a line break (so nothing leaves
 * its Tika block), a semicolon, or a termination term shared with
 * `context-roles.ts` so the two cannot drift apart. */
const CUT = new RegExp(
  `[.!?]+(?=\\s|$)|[\\r\\n]+|;|\\b(?:${CONTEXT_TERMINATION_TERMS.join("|")})\\b`,
  "iu",
);

/** How much of the clause after a date is still about that date. Beyond a
 * clause the page has moved on, whatever it goes on to say. */
const TAIL_LIMIT = 90;

/**
 * The words printed after a date, up to the end of its clause OR the next
 * date -- whichever comes first.
 *
 * Stopping at the next date is the whole rule: "cover runs from 14 June 2026
 * to 13 June 2031, expiring at midnight" says the expiry is the SECOND date,
 * and a tail that ran past it would hand the word to the first.
 */
function tailAfter(
  text: string,
  candidate: DateCandidate,
  all: readonly DateCandidate[],
): { tail: string; stoppedAtDate: boolean } {
  const from = candidate.index + candidate.length;
  const nextDate = all
    .filter((entry) => entry.index >= from)
    .reduce((nearest, entry) => Math.min(nearest, entry.index), Number.POSITIVE_INFINITY);
  const window = text.slice(from, Math.min(nextDate, from + TAIL_LIMIT));
  const cut = CUT.exec(window);
  return {
    tail: cut ? window.slice(0, cut.index) : window,
    stoppedAtDate: !cut && nextDate <= from + TAIL_LIMIT,
  };
}

/** A term the page printed, in months: "12 months", "24-month", "5 years",
 * "annual". Spelled-out numbers are refused, as they are in
 * `extraction-choose.ts`: a misread number is a wrong value. */
const TERM_MONTHS = /(\d{1,3})\s*-?\s*months?\b/iu;
const TERM_YEARS = /(\d{1,2})\s*-?\s*years?\b/iu;
const TERM_ANNUAL = /\bannual(?:ly)?\b|\byearly\b|\b(?:per|each|every) (?:year|annum)\b/iu;

export function printedTerms(text: string): Array<{ months: number; trigger: string }> {
  const found: Array<{ months: number; trigger: string }> = [];
  for (const match of text.matchAll(new RegExp(TERM_MONTHS, "giu"))) {
    found.push({ months: Number(match[1]), trigger: match[0].trim() });
  }
  for (const match of text.matchAll(new RegExp(TERM_YEARS, "giu"))) {
    found.push({ months: Number(match[1]) * 12, trigger: match[0].trim() });
  }
  const annual = TERM_ANNUAL.exec(text);
  if (annual) found.push({ months: 12, trigger: annual[0].trim() });
  return found.filter((term) => term.months > 0 && term.months <= 600);
}

/** The same reading `extraction-tags.ts` makes of a term's end: a guarantee,
 * a warranty or a certificate runs out; everything else the household holds
 * for a term has to be taken again. */
const RUNS_OUT = /\b(?:guarantee|warranty|certificate|quot(?:e|ation)|ticket|forfeit(?:ed)?|returned|used within)\b|expir/iu;

/** A term that ends in somebody coming round rather than in a bill: the
 * annual booster, the next inspection. Not "service charge", which is a bill
 * the household renews -- hence the words for a visit and not the word
 * "service" on its own. */
const ENDS_IN_A_VISIT = /\bbooster\b|\bvaccinat|\binspect|\bcheck-?up\b|\bre-?test\b|next (?:service|visit|appointment)\b/iu;

/**
 * Words that say a period is one the page is REPORTING on -- a statement
 * year, a billing quarter, a scheme year -- rather than a term the household
 * holds. The same list `extraction-tags.ts` refuses a date range on, applied
 * to the arithmetic for the same reason: a statement covering "12 months" to
 * 5 April is not a policy renewing on 5 April.
 */
const REPORTING_PERIOD =
  /statement|billing|transaction|quarter|reading|scheme year|year ended|summary|history|benefit statement/iu;

function termEndRole(context: string): DocumentDateRole {
  if (ENDS_IN_A_VISIT.test(context)) return "service";
  return RUNS_OUT.test(context) ? "expiry" : "renewal";
}

// --------------------------------------------------------------- words-after

interface TailTrigger {
  role: DocumentDateRole;
  weight: number;
  pattern: string;
}

/**
 * The clause a page prints AFTER a date, which is how running prose says
 * what a date is for: "14 November 2026, when your cover ends", "31 March
 * 2027, by which time payment must reach us". A trigger table sitting in
 * front of the date cannot hear any of it.
 *
 * Every row is a statement about the date, never a bare role word. A page
 * prints "renewal" and "expires" all over itself, and a clause that merely
 * contains one is usually talking about a different date -- which is what a
 * sieve reading forwards gets wrong when it is allowed to be vague.
 */
/** A clause that denies itself. ConText's own first job (Harkema et al.
 * 2009) is negation, and a trailing clause is where a page puts it. */
const NEGATED = /\b(?:not|no longer|never|cannot|can't|isn't|aren't|won't|neither|nor)\b/iu;

const TAIL_TRIGGERS: readonly TailTrigger[] = [
  { role: "renewal", weight: STRENGTH_STATED, pattern: "when[\\w' ]{0,24}\\brenew" },
  { role: "renewal", weight: STRENGTH_STATED, pattern: "(?:is|are)[\\w' ]{0,16}\\brenewal\\b" },
  { role: "renewal", weight: STRENGTH_STATED,
    pattern: "unless you (?:tell us|let us know|cancel|switch|contact us)" },

  { role: "expiry", weight: STRENGTH_STATED,
    pattern: "when[\\w' ]{0,24}(?:ends?|expires?|runs out|finishes|lapses|stops)\\b" },
  { role: "expiry", weight: STRENGTH_STATED, pattern: "(?:is|are)[\\w' ]{0,16}(?:expiry|end date)\\b" },
  { role: "expiry", weight: STRENGTH_STATED, pattern: "after which[\\w' ]{0,24}(?:no longer|not) " },

  { role: "start", weight: STRENGTH_STATED,
    pattern: "when[\\w' ]{0,24}(?:begins?|starts?|commences?|takes effect)\\b" },

  { role: "due", weight: STRENGTH_STATED, pattern: "(?:is|are) (?:the |your )?(?:date )?(?:payment is )?due\\b" },
  { role: "due", weight: STRENGTH_STATED, pattern: "\\bto (?:pay|avoid|settle)\\b" },
  { role: "due", weight: STRENGTH_STATED, pattern: "by which(?: time)?[\\w' ]{0,16}(?:pay|reach|settle)" },

  { role: "service", weight: STRENGTH_STATED,
    pattern: "for (?:your |the |a )?next (?:service|inspection|test|check-?up|appointment|visit)\\b" },
  { role: "service", weight: STRENGTH_STATED,
    pattern: "(?:was|were|is|are) (?:last )?(?:serviced|inspected|tested|examined)\\b" },

  { role: "issued", weight: STRENGTH_STATED, pattern: "(?:was|were) (?:issued|printed|produced|prepared)\\b" },
];

/** What is left of a tail after its trigger when the trigger was about the
 * date the tail stopped at: nothing, or a preposition leading into it. */
const LEADS_INTO_NEXT_DATE = /^\s*(?:on|by|at|from|until|before|of)?\s*$/iu;

const wordsAfter: DateSieve = {
  name: "words-after",
  read: (text, candidate, all) => {
    const { tail, stoppedAtDate } = tailAfter(text, candidate, all);
    if (!tail.trim()) return [];
    const votes: DateVote[] = [];
    for (const trigger of TAIL_TRIGGERS) {
      const match = new RegExp(trigger.pattern, "iu").exec(tail);
      if (!match) continue;
      // "...and your next payment is due on" with the next date right after
      // the tail: the clause was leading into that date, not looking back at
      // this one.
      if (stoppedAtDate && LEADS_INTO_NEXT_DATE.test(tail.slice(match.index + match[0].length))) continue;
      // "...the registration certificate issued 20 March 2019, which are not
      // renewal documents". A clause that denies what it is saying says the
      // opposite of what the row reads, so the row reads nothing: ConText's
      // own negation rule, which is the algorithm's first job.
      if (NEGATED.test(tail.slice(0, match.index + match[0].length))) continue;
      const role = trigger.role === "expiry" ? termEndRole(`${candidate.line} ${tail}`) : trigger.role;
      votes.push({ sieve: "words-after", role, trigger: match[0].trim(), weight: trigger.weight });
    }
    return best(votes);
  },
};

// -------------------------------------------------------------- heading-above

/** Anything that could be a date, in any of the forms the sieve reads. A
 * block carrying one is a row of the table, not a heading of it. */
const DATE_SHAPED =
  /\d{4}[/.-]\d{1,2}[/.-]\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?[A-Za-z]{3,}\.?\s+\d{2,4}|[A-Za-z]{3,}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{2,4}/u;

/**
 * A block that could be a cell of the same table: short, and not a sentence.
 * The search upwards passes through these and stops at anything else,
 * because a paragraph between a heading and a value means they were never
 * in one table.
 */
function tableShaped(line: string): boolean {
  if (line.length < 2 || line.length > 48) return false;
  if (line.split(" ").length > 6) return false;
  return !/[.!?;]$/u.test(line);
}

/**
 * A cell that could be the heading of a column rather than a value in it.
 *
 * A block with a date in it is never one. "Policy start date 18 October
 * 2026" is a labelled value, and reading it as the heading of the date three
 * blocks below hands one date's label to another -- the single commonest way
 * this sieve was wrong before the rule.
 */
function headingShaped(line: string): boolean {
  return tableShaped(line) && !DATE_SHAPED.test(line);
}

/** The role words a column heading is written with. A heading naming two
 * roles is ambiguous and asserts nothing. */
const HEADING_ROLES: ReadonlyArray<{ role: DocumentDateRole; pattern: RegExp }> = [
  { role: "renewal", pattern: /\brenew/iu },
  { role: "expiry", pattern: /\bexpir|\bend(?:s|ing)?\b|\bvalid (?:to|until)\b/iu },
  { role: "due", pattern: /\bdue\b|\bpayable\b/iu },
  { role: "service", pattern: /\bservice\b|\binspect|\btest(?:ed|ing)?\b|\bcheck-?up\b|\bappointment\b/iu },
  { role: "start", pattern: /\bstart|\bfrom\b|\bcommenc|\beffective\b/iu },
  { role: "issued", pattern: /\bissued?\b|\bdated\b|\bprinted\b/iu },
];

/** How far above a value its column heading can be. A flattened table puts
 * every heading of the row above every value of it, so the reach has to
 * cross a few blocks -- and stop, because a heading eight blocks up is
 * heading something else. */
const HEADING_REACH_BLOCKS = 6;
const HEADING_REACH_CHARACTERS = 400;

/** The blocks above the one `index` sits in, nearest first, out to the
 * reach. The date's own block is not among them: the words before a date in
 * its own block are the words-before sieve's, not this one's. */
function blocksAbove(text: string, index: number): string[] {
  const ownBlock = text.lastIndexOf("\n", index) + 1;
  const before = text.slice(Math.max(0, ownBlock - HEADING_REACH_CHARACTERS), ownBlock);
  return before
    .split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .reverse()
    .slice(0, HEADING_REACH_BLOCKS);
}

const headingAbove: DateSieve = {
  name: "heading-above",
  read: (text, candidate) => {
    for (const line of blocksAbove(text, candidate.index)) {
      // Out of the table: whatever is above this is heading something else.
      if (!tableShaped(line)) break;
      if (!headingShaped(line)) continue;
      const matched = HEADING_ROLES.filter((entry) => entry.pattern.test(line));
      if (matched.length !== 1) continue;
      const role = matched[0].role === "expiry" ? termEndRole(`${line} ${candidate.line}`) : matched[0].role;
      return [{ sieve: "heading-above", role, trigger: line, weight: STRENGTH_WEAK }];
    }
    return [];
  },
};

// ------------------------------------------------------------ term-arithmetic

/** How far apart two dates can be printed and still share the words between
 * them: the blocks they sit in, and the page between them if that is short.
 * Further apart, what is printed between them is about something else. */
const ARITHMETIC_GAP = 400;

/** How far back the pair's words start ahead of it. UK paper heads the box
 * before it fills it: "Statement period" sits above the two dates it
 * governs as often as between them. */
const ARITHMETIC_LEAD = 200;

/** The text a pair of dates share, which says what kind of pair they are --
 * a statement period, a guarantee, a term ending in a visit: their two
 * blocks, the page between them, and the short run-up to the first. The
 * term itself may be printed anywhere on the page. */
function betweenText(text: string, left: DateCandidate, right: DateCandidate): string {
  const from = Math.min(left.index, right.index);
  const to = Math.max(left.index + left.length, right.index + right.length);
  const lead = text.slice(Math.max(0, from - ARITHMETIC_LEAD), from);
  if (to - from > ARITHMETIC_GAP) return `${lead} ${left.line} ${right.line}`;
  return `${lead} ${left.line} ${text.slice(from, to)} ${right.line}`;
}

const termArithmetic: DateSieve = {
  name: "term-arithmetic",
  read: (text, candidate, all) => {
    const votes: DateVote[] = [];
    for (const other of all) {
      if (other === candidate || other.value === candidate.value) continue;
      const earlier = other.value < candidate.value ? other : candidate;
      const later = earlier === other ? candidate : other;
      const context = betweenText(text, earlier, later);
      // A statement year is not a term: every statement prints twelve months
      // of dates and says "12 months" somewhere, and none of them is a
      // renewal.
      if (REPORTING_PERIOD.test(context)) continue;
      // The term can be printed anywhere on the page: a gym agreement
      // states its minimum term in clause prose a long way from the dates
      // it governs. Two dates exactly a printed term apart are still one
      // weak reading, because a page can print "12 months" about something
      // else -- reading the term from anywhere is what makes it weak.
      for (const term of printedTerms(text)) {
        const anniversary = addMonths(earlier.value, term.months);
        if (anniversary === undefined) continue;
        if (later.value !== anniversary && later.value !== dayBefore(anniversary)) continue;
        const role = candidate === earlier ? "start" : termEndRole(context);
        votes.push({ sieve: "term-arithmetic", role, trigger: term.trigger, weight: STRENGTH_WEAK });
      }
    }
    return best(votes);
  },
};

// -------------------------------------------------------- printed-throughout

/**
 * A date printed all the way through a document -- a running header, a
 * footer on every sheet, the date in the box at the top of each page -- is a
 * date the document is carrying rather than mentioning, which is usually the
 * day it was produced.
 *
 * "Usually" is why this votes at `STRENGTH_GUESS`: on the tuning corpus a
 * date printed throughout is nearly always one of the answers, but which
 * answer it is varies -- the gas record repeats the inspection date, the
 * contract repeats the end of the term. So the vote can never win a role on
 * its own. What it is worth is agreement: where another sieve has already
 * read the date as the document's own, repetition is a second reason to
 * believe it, and where none has, the date is still kept and still offered.
 */
const RUNNING_REPEATS = 3;
/** And how much of the document those repeats have to span before they are a
 * running header or footer rather than one dense table. */
const RUNNING_SPREAD = 0.5;

const printedThroughout: DateSieve = {
  name: "printed-throughout",
  read: (text, candidate, all) => {
    const sightings = all.filter((entry) => entry.value === candidate.value);
    if (sightings.length < RUNNING_REPEATS) return [];
    const first = Math.min(...sightings.map((entry) => entry.index));
    const last = Math.max(...sightings.map((entry) => entry.index));
    const reach = all.length === 0 ? 0 : Math.max(...all.map((entry) => entry.index)) -
      Math.min(...all.map((entry) => entry.index));
    if (reach === 0 || (last - first) / reach < RUNNING_SPREAD) return [];
    return [{
      sieve: "printed-throughout",
      role: "issued",
      trigger: `printed ${sightings.length} times across the document`,
      weight: STRENGTH_GUESS,
    }];
  },
};

// ------------------------------------------------------------- issue-relative

/** What a document calls its own date. "Date" on its own is not here: every
 * label on the page ends in it. "Date:" opening a line is, because that is
 * how a letter or an email heads itself. */
const ISSUE_LABEL =
  /\b(?:date of issue|issue date|issued(?: on)?|dated|date printed|printed on|(?:statement|invoice|bill|notice|certificate|document|report|letter|account|agreement) date)\b|^date:/gimu;

/** A label names the date beside it, not one in the next paragraph. */
const ISSUE_LABEL_REACH = 40;

interface IssueDate {
  value: string;
  trigger: string;
  weight: number;
}

/** The date the document was written: the one its own label names, or -- with
 * no label -- the early date it repeats most, which is what a running header
 * carries. Nothing where the page gives neither. */
export function issueDate(text: string, all: readonly DateCandidate[]): IssueDate | undefined {
  let labelled: { candidate: DateCandidate; trigger: string; distance: number } | undefined;
  for (const match of text.matchAll(ISSUE_LABEL)) {
    const end = (match.index ?? 0) + match[0].length;
    for (const candidate of all) {
      const distance = candidate.index - end;
      if (distance < 0 || distance > ISSUE_LABEL_REACH) continue;
      if (text.slice(end, candidate.index).includes("\n")) continue;
      if (labelled === undefined || distance < labelled.distance) {
        labelled = { candidate, trigger: match[0].trim(), distance };
      }
    }
  }
  if (labelled) {
    return { value: labelled.candidate.value, trigger: labelled.trigger, weight: STRENGTH_STATED };
  }

  const counts = new Map<string, number>();
  for (const candidate of all) counts.set(candidate.value, (counts.get(candidate.value) ?? 0) + 1);
  const repeated = [...counts.entries()].filter(([, count]) => count > 1);
  if (repeated.length === 0) return undefined;
  const most = Math.max(...repeated.map(([, count]) => count));
  // The earliest of the most-repeated: a document carries the day it was
  // produced, and the dates it is about come after it.
  const value = repeated.filter(([, count]) => count === most).map(([date]) => date).sort()[0];
  return { value, trigger: `printed ${most} times`, weight: STRENGTH_WEAK };
}

const issueRelative: DateSieve = {
  name: "issue-relative",
  read: (text, candidate, all) => {
    const issued = issueDateFor(text, all);
    if (!issued) return [];
    if (candidate.value === issued.value) {
      return [{ sieve: "issue-relative", role: "issued", trigger: issued.trigger, weight: issued.weight }];
    }
    // Before the document was written, so it is not something the household
    // still has to do. Said as `other`, which asserts no role and only sinks
    // a date no other sieve spoke for.
    if (candidate.value < issued.value) {
      return [{
        sieve: "issue-relative",
        role: "other",
        trigger: `before ${issued.value}`,
        weight: STRENGTH_WEAK,
      }];
    }
    return [];
  },
};

// One issue date per document, not one per date: the search reads the whole
// page, and a page has forty dates on it.
const issueDates = new WeakMap<readonly DateCandidate[], IssueDate | undefined>();

function issueDateFor(text: string, all: readonly DateCandidate[]): IssueDate | undefined {
  if (!issueDates.has(all)) issueDates.set(all, issueDate(text, all));
  return issueDates.get(all);
}

// ------------------------------------------------------------------ the set

/** Only the strongest vote a single sieve casts: a sieve has one opinion per
 * date, and rows that both match are the same opinion reached twice. */
function best(votes: readonly DateVote[]): DateVote[] {
  if (votes.length === 0) return [];
  const strongest = Math.max(...votes.map((vote) => vote.weight));
  const kept = votes.filter((vote) => vote.weight === strongest);
  const roles = new Set(kept.map((vote) => vote.role));
  // One sieve disagreeing with itself at the same strength has not read
  // anything: it says nothing rather than picking the first row.
  return roles.size === 1 ? [kept[0]] : [];
}

/**
 * Every sieve that reads one date at a time, in the order their votes are
 * recorded. `words-before` is not here: it reads all the dates at once (a
 * scope has to know where the next trigger is), so it is run by `dateTags`.
 */
export const DATE_SIEVES: readonly DateSieve[] = [
  wordsAfter,
  headingAbove,
  termArithmetic,
  printedThroughout,
  issueRelative,
];

/** The name the words-before pass records, and the name its range-connector
 * correction records, so the report can tell them apart. */
export const WORDS_BEFORE = "words-before";
export const DATE_RANGE = "date-range";

/** Every sieve's name, words-before first, for reports and for ordering the
 * names on a tag. */
export const DATE_SIEVE_NAMES: readonly string[] = [
  WORDS_BEFORE,
  DATE_RANGE,
  ...DATE_SIEVES.map((sieve) => sieve.name),
];

/** A connector says two dates bound a period; it does not say what either
 * date is, which is why it is weaker than a label. */
const RANGE_CONNECTOR = /^[\s(]*(?:to|until|till|through|up to|–|—|-)[\s)]*$/iu;

/** The words-before pass as a vote, so it sits on the same scale as the
 * rest. Strength is read off the trigger exactly as stage 3 has always read
 * it: a quoted label is 2, a range connector 1, nothing at all 0. */
function wordsBeforeVote(assignment: ContextRoleAssignment): DateVote {
  const trigger = assignment.trigger.trim();
  const connector = trigger !== "" && RANGE_CONNECTOR.test(trigger);
  return {
    sieve: connector ? DATE_RANGE : WORDS_BEFORE,
    role: assignment.role,
    trigger: assignment.trigger,
    weight: trigger === "" ? STRENGTH_GUESS : connector ? STRENGTH_WEAK : STRENGTH_STATED,
  };
}

/** Every sieve's votes for every date, in `DATE_SIEVES` order. The
 * words-before assignments are passed in because the pass that produces them
 * also applies the range and term-end corrections (`extraction-tags.ts`). */
export function runDateSieves(
  text: string,
  all: readonly DateCandidate[],
  assignments: readonly ContextRoleAssignment[],
): DateVote[][] {
  return all.map((candidate, at) => {
    const votes: DateVote[] = [];
    const assignment = assignments[at];
    if (assignment) votes.push(wordsBeforeVote(assignment));
    for (const sieve of DATE_SIEVES) votes.push(...sieve.read(text, candidate, all));
    return votes;
  });
}

/**
 * The votes for one date merged into tags, one per role claimed.
 *
 * A tag names every sieve that agreed on it and how strong the best of them
 * was, which is what lets stage 3 float a date several sieves kept above one
 * a single weak sieve kept. The words-before tag comes first and, where it
 * is the only sieve that spoke for its role, is left exactly as stage 2 has
 * always produced it -- `sieves` and `strength` absent means "the words
 * beside the date, as before".
 */
export function tagsFromVotes(votes: readonly DateVote[]): Tag<"date">[] {
  const byRole = new Map<DocumentDateRole, DateVote[]>();
  for (const vote of votes) {
    const held = byRole.get(vote.role);
    if (held) held.push(vote);
    else byRole.set(vote.role, [vote]);
  }

  const tags: Array<{ tag: Tag<"date">; strength: number }> = [];
  for (const [role, cast] of byRole) {
    const strength = Math.max(...cast.map((vote) => vote.weight));
    const strongest = cast.find((vote) => vote.weight === strength) as DateVote;
    const names = DATE_SIEVE_NAMES.filter((name) => cast.some((vote) => vote.sieve === name));
    const alone = names.length === 1 && (names[0] === WORDS_BEFORE || names[0] === DATE_RANGE);
    tags.push({
      strength,
      tag: {
        value: role,
        trigger: strongest.trigger,
        source: "label",
        ...(alone ? {} : { sieves: names, strength }),
      },
    });
  }

  // The words-before reading first, whatever it said: stage 3 and every
  // caller that reads `tags[0]` has always found the label there. The rest
  // follow best-evidenced first.
  const wordsBeforeRole = votes[0]?.role;
  return tags
    .sort((left, right) => {
      if (left.tag.value !== right.tag.value) {
        if (left.tag.value === wordsBeforeRole) return -1;
        if (right.tag.value === wordsBeforeRole) return 1;
      }
      return right.strength - left.strength;
    })
    .map((entry) => entry.tag);
}
