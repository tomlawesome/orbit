// Stage 2's amount sieves (ADR-0026's amendment, owner 2026-09-11), the
// same shape as the date and provider sieves: several independent ways of
// looking at one figure, each a small named function, none of them allowed
// to discard anything.
//
// Until now exactly one sieve looked at an amount: the words printed in
// front of it. A page that heads a column "Total" three blocks above the
// figure, or prints last year's charge beside this year's under a two-year
// heading, or says what a figure is only after it, or prints the same
// figure in the summary, in the detail and in the payment instruction, says
// which figure matters in a way a trigger table in front of the number
// cannot hear.
//
//   label               the words in front of it (the trigger table stage 2
//                       has always run), which says what the page called it
//   words-after         the clause printed after it in the same block
//   heading-above       the nearest heading-shaped block above it, which is
//                       where a flattened table keeps its column headings
//   column-period       a row of figures under a heading of periods: the
//                       figure in the current period's column is this
//                       year's charge and the ones before it are last
//                       year's
//   period-adjacent     a period word beside it -- "a month", "annual
//                       premium" -- which says whether the figure is the
//                       whole thing or one payment of it
//   printed-throughout  the same figure printed in several places: the
//                       summary, the detail and the payment instruction all
//                       carry the figure the household must pay
//   instalment-total    a figure that is what the printed instalments add up
//                       to ("ten monthly instalments of £215.91") is the
//                       total, whatever is printed beside it
//
// Each returns a vote, never a decision. Votes merge into tags by tag
// value, so a figure several sieves agree about carries one tag naming all
// of them, and stage 3 can tell a figure three sieves kept from one a
// single weak sieve kept.
//
// "The largest amount on the page" is not a sieve and never will be: it is
// a guess about typography, not a reading of the page. Nor may any sieve
// key on where a figure sits on the page -- "the block above in a flattened
// table" is the structure of a table, which every table has, and is as far
// as position goes.

import {
  STRENGTH_STATED,
  STRENGTH_WEAK,
  type AmountTag,
  type Tag,
} from "./extraction-stages";

/** An amount the sieve found, with everything a stage 2 sieve may read. */
export interface AmountCandidate {
  /** Minor units, as the sieve normalises them. */
  value: string;
  currency?: string;
  index: number;
  /** How long the amount was on the page, so a sieve can read what follows
   * it. */
  length: number;
  /** The Tika block it sits in, whitespace collapsed. */
  line: string;
}

/** One sieve's reading of one amount. */
export interface AmountVote {
  sieve: string;
  tag: AmountTag;
  trigger: string;
  weight: number;
}

export interface AmountSieve {
  name: string;
  read: (
    candidate: AmountCandidate,
    all: readonly AmountCandidate[],
    page: AmountPageFacts,
  ) => AmountVote[];
}

/** The name the trigger-table pass records, so a tag can say the words
 * beside the figure were one of the sieves that agreed. */
export const AMOUNT_LABEL = "label";

// ------------------------------------------------------------ page facts

/** What the sieves read about the page as a whole, worked out once per
 * document because every one of thirty figures would otherwise re-read it. */
export interface AmountPageFacts {
  text: string;
  /** The blocks of the page in order, with where each starts. */
  blocks: Array<{ index: number; line: string }>;
  /** What the trigger table called each value, where it called it
   * anything: how the repetition sieve knows what a repeated figure is. */
  labelled: Map<string, AmountTag>;
  /** Totals the page's own instalment arithmetic implies. */
  instalmentTotals: Array<{ value: number; trigger: string }>;
}

/** A printed money amount, for reading a block rather than sieving a page:
 * the sieve proper has already found the candidates. */
const PRINTED_AMOUNT = /(?:[£€$]\s?|(?:GBP|EUR|USD)\s?)(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?/gu;

function minorUnitsIn(line: string): number[] {
  const found: number[] = [];
  for (const match of line.matchAll(PRINTED_AMOUNT)) {
    const whole = Number(match[1].replace(/,/gu, ""));
    found.push(whole * 100 + (match[2] === undefined ? 0 : Number(match[2])));
  }
  return found;
}

/** The numbers a page writes out rather than printing in digits. Only up to
 * twelve, because that is as far as instalments go, and only where the
 * arithmetic then checks out exactly -- which is the guard that lets a
 * spelled number be read at all. */
const SPELLED: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

/** "ten monthly instalments of £215.91", "12 payments of £31.00". */
const INSTALMENTS = new RegExp(
  `\\b(\\d{1,2}|${Object.keys(SPELLED).join("|")})\\s+(?:equal\\s+)?(?:monthly|quarterly|weekly|annual)?\\s*` +
    "(?:instalments?|payments?|repayments?)\\s+of\\s+[£€$]?\\s?(\\d{1,3}(?:,\\d{3})*|\\d+)(?:\\.(\\d{2}))?",
  "giu",
);

/** "(final instalment £215.88)" -- the last payment a schedule rounds on. */
const FINAL_INSTALMENT = /final (?:instalment|payment)(?:\s+of)?\s*[£€$]?\s?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?/iu;

/**
 * What the page's own instalment arithmetic says the total is: the number
 * of payments times the payment, and -- where a schedule rounds its last
 * payment -- the rest plus that one. Both have to come out exactly, which
 * is what makes this a reading of the page rather than a guess at it.
 */
function instalmentTotals(text: string): Array<{ value: number; trigger: string }> {
  const totals: Array<{ value: number; trigger: string }> = [];
  for (const match of text.matchAll(INSTALMENTS)) {
    const count = SPELLED[match[1].toLowerCase()] ?? Number(match[1]);
    if (!Number.isFinite(count) || count < 2 || count > 60) continue;
    const each = Number(match[2].replace(/,/gu, "")) * 100 + (match[3] === undefined ? 0 : Number(match[3]));
    if (each <= 0) continue;
    const trigger = match[0].replace(/\s+/gu, " ").trim();
    totals.push({ value: count * each, trigger });
    // The schedule's own rounding: "(final instalment £215.88)" printed in
    // the same sentence as the instalments it belongs to.
    const around = text.slice(match.index ?? 0, (match.index ?? 0) + match[0].length + 80);
    const final = FINAL_INSTALMENT.exec(around);
    if (final) {
      const last = Number(final[1].replace(/,/gu, "")) * 100 + (final[2] === undefined ? 0 : Number(final[2]));
      totals.push({ value: (count - 1) * each + last, trigger: `${trigger}, ${final[0].trim()}` });
    }
  }
  return totals;
}

export function amountPageFacts(
  text: string,
  candidates: readonly AmountCandidate[] = [],
  labels: ReadonlyArray<Tag<"amount"> | undefined> = [],
): AmountPageFacts {
  const blocks: Array<{ index: number; line: string }> = [];
  for (const match of text.matchAll(/[^\n]+/gu)) {
    const line = match[0].replace(/\s+/gu, " ").trim();
    if (line) blocks.push({ index: match.index ?? 0, line });
  }
  const labelled = new Map<string, AmountTag>();
  candidates.forEach((candidate, at) => {
    const label = labels[at];
    if (label && label.trigger.trim() !== "" && !labelled.has(candidate.value)) {
      labelled.set(candidate.value, label.value);
    }
  });
  return { text, blocks, labelled, instalmentTotals: instalmentTotals(text) };
}

/** The trigger table's reading as a vote, on the same scale as the rest. */
export function amountLabelVote(tag: Tag<"amount">): AmountVote {
  return {
    sieve: AMOUNT_LABEL,
    tag: tag.value,
    trigger: tag.trigger,
    weight: tag.trigger.trim() === "" ? STRENGTH_WEAK : STRENGTH_STATED,
  };
}

// ------------------------------------------------------------ words-after

/** How much of the clause after a figure is still about that figure. */
const TAIL_LIMIT = 60;

/** The words printed after an amount, up to the end of its clause or the
 * next amount -- whichever comes first, because "£159.31 £163.37 to pay"
 * says the SECOND figure is the one to pay. */
function tailAfter(
  candidate: AmountCandidate,
  all: readonly AmountCandidate[],
  page: AmountPageFacts,
): string {
  const from = candidate.index + candidate.length;
  const next = all
    .filter((entry) => entry.index >= from)
    .reduce((nearest, entry) => Math.min(nearest, entry.index), from + TAIL_LIMIT);
  const window = page.text.slice(from, next);
  const cut = /[.;!?]+(?=\s|$)|[\r\n]+/u.exec(window);
  return cut ? window.slice(0, cut.index) : window;
}

const TAIL_TRIGGERS: ReadonlyArray<{ tag: AmountTag; pattern: string }> = [
  { tag: "total", pattern: "^\\s*(?:is|are)[\\w' ]{0,12}\\b(?:the )?(?:total|premium|full amount|price)\\b" },
  { tag: "total", pattern: "^\\s*(?:in total|in full)\\b" },
  { tag: "total", pattern: "^\\s*(?:for|covering) the (?:whole )?year\\b" },
  { tag: "total", pattern: "^\\s*(?:a|per|each|every) (?:year|annum)\\b" },

  { tag: "due", pattern: "^\\s*(?:is|are) (?:now )?due\\b" },
  { tag: "due", pattern: "^\\s*to pay\\b" },
  { tag: "due", pattern: "^\\s*(?:on or before|by)\\s+\\d{1,2}[/ ]" },
  { tag: "due", pattern: "^\\s*(?:must|should) (?:reach|be paid)" },

  { tag: "instalment", pattern: "^\\s*(?:a|per|each|every) month\\b" },
  { tag: "instalment", pattern: "^\\s*(?:x|×)\\s*\\d{1,2}\\b" },
  { tag: "instalment", pattern: "^\\s*(?:monthly|each month|a month)\\b" },

  { tag: "previous", pattern: "^\\s*(?:last year|in \\d{4}/\\d{2}|previously)\\b" },
];

const wordsAfter: AmountSieve = {
  name: "words-after",
  read: (candidate, all, page) => {
    const tail = tailAfter(candidate, all, page);
    if (!tail.trim()) return [];
    const votes: AmountVote[] = [];
    for (const trigger of TAIL_TRIGGERS) {
      const match = new RegExp(trigger.pattern, "iu").exec(tail);
      if (match) {
        votes.push({
          sieve: "words-after",
          tag: trigger.tag,
          trigger: match[0].trim(),
          weight: STRENGTH_STATED,
        });
      }
    }
    return best(votes, "words-after");
  },
};

// ----------------------------------------------------------- heading-above

/** A block that could be a cell of the same table: short, and not a
 * sentence. The search upwards passes through these and stops at anything
 * else, because a paragraph between a heading and a figure means they were
 * never in one table. */
function tableShaped(line: string): boolean {
  if (line.length < 2 || line.length > 60) return false;
  if (line.split(" ").length > 8) return false;
  return !/[.!?;]$/u.test(line);
}

/** A cell that could be the heading of a column rather than a figure in it:
 * a block carrying money is a row of the table, not a heading of it. */
function headingShaped(line: string): boolean {
  return tableShaped(line) && minorUnitsIn(line).length === 0;
}

/**
 * What a column heading says its column is. The patterns are anchored at
 * the start of the block, because a heading IS the words it is made of:
 * "Total payable" heads a column of totals, while "the total shown above
 * includes VAT" is a sentence that happens to carry the word.
 */
const HEADING_TAGS: ReadonlyArray<{ tag: AmountTag; pattern: RegExp }> = [
  { tag: "instalment", pattern: /^(?:monthly|instalments?|each month)\b/iu },
  { tag: "previous", pattern: /^(?:previous|last year)/iu },
  { tag: "due", pattern: /^(?:amount |balance )?(?:now )?(?:due|outstanding|to pay|payable)\b/iu },
  { tag: "total", pattern: /^(?:grand )?(?:total|premium|annual premium|charge for the year)\b/iu },
];

/** A heading is a name, not a sentence: a few words at most. */
const HEADING_WORDS = 4;

const HEADING_REACH_BLOCKS = 6;

/** Which block an offset sits in. */
function blockOf(page: AmountPageFacts, index: number): number {
  return page.blocks.findIndex(
    (block) => index >= block.index && index < block.index + block.line.length + 1,
  );
}

/** The blocks above the one an offset sits in, nearest first, out to the
 * reach. The figure's own block is not among them: the words in front of it
 * there are the label sieve's, not this one's. */
function blocksAbove(page: AmountPageFacts, index: number): string[] {
  const own = blockOf(page, index);
  if (own <= 0) return [];
  return page.blocks
    .slice(Math.max(0, own - HEADING_REACH_BLOCKS), own)
    .map((block) => block.line)
    .reverse();
}

const headingAbove: AmountSieve = {
  name: "heading-above",
  read: (candidate, _all, page) => {
    for (const line of blocksAbove(page, candidate.index)) {
      if (!tableShaped(line)) break;
      if (!headingShaped(line) || line.split(" ").length > HEADING_WORDS) continue;
      const matched = HEADING_TAGS.filter((entry) => entry.pattern.test(line));
      if (matched.length !== 1) continue;
      return [{ sieve: "heading-above", tag: matched[0].tag, trigger: line, weight: STRENGTH_WEAK }];
    }
    return [];
  },
};

// ----------------------------------------------------------- column-period

/** A period a column of a bill is headed with: "2026/27", "2026-27",
 * "2026", "Apr 2026". */
const PERIOD_TOKEN = /\b(?:\d{4}\s?[/-]\s?\d{2,4}|20\d{2})\b/gu;

/** The rows of one table print the same number of figures; the heading of
 * it prints none. How far up the sieve will look for that heading. */
const COLUMN_REACH_BLOCKS = 12;

/**
 * A row of figures under a heading of periods. Where a bill prints last
 * year's charge beside this year's -- which is how every council tax demand
 * and most service charges are set out -- the words in front of the row
 * name the row, not the column, so the label alone cannot say which figure
 * is this year's. The heading can: the columns are in the order the periods
 * are, and the last period is the one the page is billing.
 */
const columnPeriod: AmountSieve = {
  name: "column-period",
  read: (candidate, _all, page) => {
    const ownBlock = blockOf(page, candidate.index);
    if (ownBlock === -1) return [];
    const row = page.blocks[ownBlock].line;
    const figures = minorUnitsIn(row);
    if (figures.length < 2) return [];

    // Up past the sibling rows -- the ones printing as many figures -- to
    // the first block that prints none, which is the heading of the table.
    let heading: string | undefined;
    for (let at = ownBlock - 1; at >= 0 && at >= ownBlock - COLUMN_REACH_BLOCKS; at -= 1) {
      const line = page.blocks[at].line;
      const printed = minorUnitsIn(line).length;
      if (printed === figures.length) continue;
      if (printed === 0 && tableShaped(line)) heading = line;
      break;
    }
    if (heading === undefined) return [];
    const periods: string[] = heading.match(PERIOD_TOKEN) ?? [];
    if (periods.length !== figures.length) return [];

    // Which figure of the row this candidate is: the sieve normalises to
    // minor units, so the comparison is on the value, and a row printing
    // one figure twice says the same thing about both.
    const mine = Number(candidate.value);
    const at = figures.indexOf(mine);
    if (at === -1) return [];
    const latest = periods.indexOf([...periods].sort()[periods.length - 1]);
    return [{
      sieve: "column-period",
      tag: at === latest ? "total" : "previous",
      trigger: `${periods[at]} (${heading})`,
      weight: STRENGTH_STATED,
    }];
  },
};

// --------------------------------------------------------- period-adjacent

/** How long the thing costs for, printed beside what it costs. */
const A_MONTH = /\b(?:a|per|each|every) month\b|\bmonthly\b|\bper calendar month\b|\bpcm\b/iu;
const A_YEAR = /\b(?:a|per|each|every) (?:year|annum)\b|\bannual(?:ly)?\b|\byearly\b|\bfor the year\b/iu;

/**
 * A period word beside the figure. "£31.00 a month" is one payment of the
 * thing; "£412.99 annual premium" is the whole of it. A block saying both
 * -- "£31.00 a month, £372.00 a year" -- says nothing about either figure
 * on its own, so it votes nothing.
 */
const periodAdjacent: AmountSieve = {
  name: "period-adjacent",
  read: (candidate) => {
    const month = A_MONTH.exec(candidate.line);
    const year = A_YEAR.exec(candidate.line);
    if ((month === null) === (year === null)) return [];
    const matched = month ?? (year as RegExpExecArray);
    return [{
      sieve: "period-adjacent",
      tag: month ? "instalment" : "total",
      trigger: matched[0].trim(),
      weight: STRENGTH_WEAK,
    }];
  },
};

// ------------------------------------------------------ printed-throughout

/** Two printings of one figure inside this much page are one printing the
 * sieve found twice. */
const ONE_PRINTING = 40;
const RUNNING_PRINTINGS = 3;
const RUNNING_SPREAD = 0.4;

/**
 * The figure a page keeps coming back to -- in the summary box, in the
 * detail, in the direct-debit notice -- is the figure the household has to
 * do something about.
 *
 * What it IS is whatever the page called it where it did, and where the
 * page called it nothing anywhere this sieve says nothing: a rate repeated
 * down a table of rates is repetition without a claim, and a sieve that
 * read it as a total would be inventing the label the page withheld.
 */
const printedThroughout: AmountSieve = {
  name: "printed-throughout",
  read: (candidate, all, page) => {
    const at = all
      .filter((entry) => entry.value === candidate.value && entry.currency === candidate.currency)
      .map((entry) => entry.index)
      .sort((left, right) => left - right);
    const printings: number[] = [];
    for (const index of at) {
      if (printings.length === 0 || index - printings[printings.length - 1] > ONE_PRINTING) printings.push(index);
    }
    if (printings.length < 2) return [];
    const reach = all.length === 0
      ? 0
      : Math.max(...all.map((entry) => entry.index)) - Math.min(...all.map((entry) => entry.index));
    const spread = reach === 0 ? 0 : (printings[printings.length - 1] - printings[0]) / reach;
    const running = printings.length >= RUNNING_PRINTINGS && spread >= RUNNING_SPREAD;
    const tag = page.labelled.get(candidate.value);
    if (tag === undefined) return [];
    return [{
      sieve: "printed-throughout",
      tag,
      trigger: running
        ? `printed ${printings.length} times across the document`
        : `printed ${printings.length} times`,
      weight: running ? STRENGTH_STATED : STRENGTH_WEAK,
    }];
  },
};

// -------------------------------------------------------- instalment-total

/**
 * The figure the page's own instalments add up to. A demand that says "ten
 * monthly instalments of £215.91 (final instalment £215.88)" has stated its
 * total in arithmetic, whichever of the figures beside it the label
 * happened to land on.
 */
const instalmentTotal: AmountSieve = {
  name: "instalment-total",
  read: (candidate, _all, page) => {
    const mine = Number(candidate.value);
    const found = page.instalmentTotals.find((total) => total.value === mine);
    if (!found) return [];
    return [{ sieve: "instalment-total", tag: "total", trigger: found.trigger, weight: STRENGTH_STATED }];
  },
};

// ------------------------------------------------------------------ the set

/** Only the strongest vote a single sieve casts: a sieve has one opinion
 * per figure, and rows that both match are the same opinion reached twice.
 * A sieve disagreeing with itself at the same strength has read nothing. */
function best(votes: readonly AmountVote[], sieve: string): AmountVote[] {
  if (votes.length === 0) return [];
  const strongest = Math.max(...votes.map((vote) => vote.weight));
  const kept = votes.filter((vote) => vote.weight === strongest);
  const tags = new Set(kept.map((vote) => vote.tag));
  return tags.size === 1 ? [{ ...kept[0], sieve }] : [];
}

export const AMOUNT_SIEVES: readonly AmountSieve[] = [
  wordsAfter,
  headingAbove,
  columnPeriod,
  periodAdjacent,
  printedThroughout,
  instalmentTotal,
];

/** Every sieve's name, the label first, for reports and for ordering the
 * names on a tag. */
export const AMOUNT_SIEVE_NAMES: readonly string[] = [
  AMOUNT_LABEL,
  ...AMOUNT_SIEVES.map((sieve) => sieve.name),
];

/** Every sieve's votes for every amount, the label's first. */
export function runAmountSieves(
  text: string,
  candidates: readonly AmountCandidate[],
  labels: ReadonlyArray<Tag<"amount"> | undefined>,
): AmountVote[][] {
  const page = amountPageFacts(text, candidates, labels);
  return candidates.map((candidate, at) => {
    const votes: AmountVote[] = [];
    const label = labels[at];
    if (label) votes.push(amountLabelVote(label));
    for (const sieve of AMOUNT_SIEVES) votes.push(...sieve.read(candidate, candidates, page));
    return votes;
  });
}

/**
 * The votes for one amount merged into tags, one per tag value, each naming
 * the sieves that agreed on it and how strong the best of them was. The
 * label comes first, so every caller that reads `tags[0]` still finds what
 * the page called the figure.
 */
export function amountTagsFromVotes(votes: readonly AmountVote[]): Tag<"amount">[] {
  const byTag = new Map<AmountTag, AmountVote[]>();
  for (const vote of votes) {
    const held = byTag.get(vote.tag);
    if (held) held.push(vote);
    else byTag.set(vote.tag, [vote]);
  }

  const tags: Array<{ tag: Tag<"amount">; strength: number }> = [];
  for (const [value, cast] of byTag) {
    const strength = Math.max(...cast.map((vote) => vote.weight));
    const strongest = cast.find((vote) => vote.weight === strength) as AmountVote;
    const names = AMOUNT_SIEVE_NAMES.filter((name) => cast.some((vote) => vote.sieve === name));
    // Where the words beside the figure were the only sieve that spoke, the
    // tag is left exactly as stage 2 has always produced it: `sieves` and
    // `strength` absent means "the label, as before".
    const alone = names.length === 1 && names[0] === AMOUNT_LABEL;
    tags.push({
      strength,
      tag: {
        value,
        trigger: strongest.trigger,
        source: "label",
        ...(alone ? {} : { sieves: names, strength }),
      },
    });
  }

  const labelTag = votes.find((vote) => vote.sieve === AMOUNT_LABEL)?.tag;
  return tags
    .sort((left, right) => {
      if (left.tag.value !== right.tag.value) {
        if (left.tag.value === labelTag) return -1;
        if (right.tag.value === labelTag) return 1;
      }
      return right.strength - left.strength;
    })
    .map((entry) => entry.tag);
}
