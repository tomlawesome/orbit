// Stage 3 of the three-stage extraction shape (ADR-0026): one answer per
// field, or none, from the tagged shortlist stage 2 hands over.
//
// Since the owner's correction of 2026-09-11 the rules in this file do two
// jobs, and neither is having the last word. They RANK: every field's
// shortlist is ordered by how well the sieves spoke for each candidate, and
// the model picks from the top of it (`chooseFieldsWithModel`). They FALL
// BACK: where there is no model to ask -- an attended run, no Ollama --
// `chooseFields` answers by rule as it always did, which is what every
// `eval:stages` number without `--model` measures. A rule never answers
// alongside the model.
//
// The sieve is judged on recall and keeps everything; the choice is judged
// on being right, and the scorer (`extraction-scoring.ts`) prices a
// confident wrong value at twice a blank -- a blank prompts the reviewer to
// fill the field in, a plausible wrong value gets approved unread. So every
// rule here resolves a genuine tie by returning nothing. Page position is
// never the tie-breaker: the first amount on a page is no likelier to be
// the total than the second, and a rule that says otherwise would be a
// guess wearing a rule's clothes.
//
// Almost nothing here reads the page. Each candidate already carries `line`,
// the Tika block it was found in, and its tags already carry the words that
// justified them, so this stage mostly compares what stage 2 decided. The
// exceptions are named where they take the text: provider's cues
// (`provider-route.ts`), the contract term a lone instalment multiplies out
// by, the heading printed over a figure, which the figure's own block does
// not carry, and the sheet marks the reference is counted across, which are
// a fact about the document rather than about any one block.

import {
  chooseCostWithModel,
  chooseDatesWithModel,
  chooseProviderByRules,
  chooseProviderWithModel,
  chooseRecurrenceWithModel,
  chooseReferenceWithModel,
  chooseSubtypeByRules,
  chooseSubtypeWithModel,
  providerShortlistEntries,
  subtypeShortlist,
  type MeaningTransport,
} from "./extraction-choose-meaning";
import { ADDS_UP, AMOUNT_LABEL, INSTALMENT_TOTAL } from "./extraction-amount-sieves";
import { DATE_RANGE, WORDS_BEFORE } from "./extraction-date-sieves";
import { referencePreference } from "./extraction-reference-kind";
import { neverTheReference } from "./extraction-reference-never";
import { bestSupported, type ShortlistEntry } from "./extraction-shortlist";
import { pageBlocks } from "./extraction-sieve";
import type { ExtractedFields } from "./extraction-scoring";
import { STRENGTH_STATED, type ChooseStage, type Tag, type TaggedCandidate } from "./extraction-stages";
import { subtypeGroupBins, subtypeSources } from "./extraction-subtype-bins";
import { termEndRole } from "./extraction-term-end";
import { chooseProviderFromPage } from "./provider-route";
import { documentDateRoles, type DocumentDateRole } from "./suggestions";
import { trimFieldValue } from "./value-trim";

/**
 * Amount tags that can carry this document's cost, best first.
 *
 * `previous` (last year's figure) and `rival` (the upgrade tier, the exit
 * fee) are printed beside the real number to be read instead of it, so they
 * are excluded outright rather than ranked last -- ranking them would let
 * one win a page that prints no total.
 */
const AMOUNT_PREFERENCE = ["total", "due", "instalment"];

/** How many sieves have to agree before the rules name a cost that no
 * label stated. One sieve is one way of looking, and a page prints thirty
 * figures. */
const AGREEING_AMOUNT_SIEVES = 2;

function isDateRole(value: string): value is DocumentDateRole {
  return (documentDateRoles as readonly string[]).includes(value);
}

/** One candidate's claim that a date plays a role. A candidate can make
 * more than one (stage 2 may tag it twice), and two candidates can make
 * conflicting ones about the same date. */
interface RoleClaim {
  date: string;
  role: DocumentDateRole;
  /** How good the page's reason for this role is -- see `claimStrength`. */
  strength: number;
  /** The stage 2 sieves that agreed on it. Several sieves reading a date
   * different ways and reaching the same answer is a better reason than one
   * of them alone (ADR-0026 stage 2, owner 2026-09-11). */
  sieves: readonly string[];
}

/** A connector is what a range rule quotes when it reads "A to B": it says
 * the two dates bound a period, not what either date IS. */
const RANGE_CONNECTOR_TRIGGER = /^[\s(]*(?:to|until|till|through|up to|–|—|-)[\s)]*$/iu;

/**
 * How strong a reason the page gave for a role:
 *
 * 2. a printed label beside the date ("Renewal date", "Date of issue");
 * 1. a range connector -- the date bounds a period, which is weaker: the
 *    same date can end one period and start the next;
 * 0. nothing quoted at all, which is a guess and says so.
 *
 * A stronger claim settles a disagreement a weaker one would otherwise tie,
 * so "Cover runs from A to B ... expiring on B" keeps B's printed label
 * instead of blanking the field over an argument with the connector.
 */
const CONNECTOR_STRENGTH = 1;

function claimStrength(trigger: string): number {
  if (trigger.trim() === "") return 0;
  return RANGE_CONNECTOR_TRIGGER.test(trigger) ? CONNECTOR_STRENGTH : 2;
}

function roleClaims(candidates: readonly TaggedCandidate[]): RoleClaim[] {
  const claims: RoleClaim[] = [];
  for (const candidate of candidates) {
    if (candidate.kind !== "date") continue;
    for (const tag of candidate.tags) {
      // `other` means stage 2 found a date but nothing saying what it was
      // for. It is not a role -- though, since ADR-0026's date sieves, it is
      // no longer a reason to drop the date either (see `chooseDates`).
      if (tag.value === "other" || !isDateRole(tag.value)) continue;
      claims.push({
        date: candidate.value,
        role: tag.value,
        strength: tag.strength ?? claimStrength(tag.trigger),
        // A tag with no sieve names came from the words beside the date --
        // which is the range connector when that is what it quoted.
        sieves: tag.sieves ??
          [claimStrength(tag.trigger) === CONNECTOR_STRENGTH ? DATE_RANGE : WORDS_BEFORE],
      });
    }
  }
  return claims;
}

/**
 * Whether a date nothing could label is still offered as a date.
 *
 * Rules never discard what the model could still choose (owner,
 * 2026-09-11), so an unlabelled date is always offered to the model where
 * there is one. Without the model it is offered as a date with no role,
 * which is measurably better on the 24 than dropping it: a date the page
 * prints and the extractor withholds is scored as a wrong answer, while a
 * date offered with no role costs nothing it was not already costing.
 */
const OFFER_UNLABELLED_DATES = true;

/** Every distinct date the sieve found, in page order. */
function everyDate(candidates: readonly TaggedCandidate[]): string[] {
  const dates: string[] = [];
  for (const candidate of candidates) {
    if (candidate.kind === "date" && !dates.includes(candidate.value)) dates.push(candidate.value);
  }
  return dates;
}

/**
 * The dates stage 3's rules could not put a job to: what the model is asked
 * about (`extraction-choose-meaning.ts`), and what is offered role-less
 * without it. Ordered by how many sieves spoke for the date at all, so a
 * date several sieves noticed is asked about before one nothing noticed.
 */
export function datesWithoutARole(
  candidates: readonly TaggedCandidate[],
  decided: ReadonlyArray<{ date: string }>,
): string[] {
  const spokenFor = (date: string) => {
    let sieves = 0;
    for (const candidate of candidates) {
      if (candidate.kind !== "date" || candidate.value !== date) continue;
      for (const tag of candidate.tags) {
        if (tag.trigger.trim() === "") continue;
        // An `other` tag is a sieve saying this date is NOT one to act on,
        // which is a reason to ask about it last rather than first.
        sieves += (tag.value === "other" ? -1 : 1) * (tag.sieves?.length ?? 1);
      }
    }
    return sieves;
  };
  return everyDate(candidates)
    .filter((date) => !decided.some((entry) => entry.date === date))
    .map((date, order) => ({ date, order, sieves: spokenFor(date) }))
    .sort((left, right) => right.sieves - left.sieves || left.order - right.order)
    .map((entry) => entry.date);
}

/**
 * The dates this document is about, and what each is for. Stage 2 preserves
 * page order, so first-seen order is page order.
 *
 * A date whose role the rules settle is chosen as it always was. A date they
 * cannot -- because no sieve spoke for it, or only a guess did -- is no
 * longer dropped: the sieve found it on the page, and a rule that throws it
 * away takes the choice off the model that could still have made it.
 */
function chooseDates(candidates: readonly TaggedCandidate[], text: string | undefined): {
  dates: string[];
  dateRoles: Array<{ date: string; role: DocumentDateRole }>;
} {
  // `renewal` and `expiry` both say "the term ends here"; which it is
  // depends on what kind of thing the page is about, not on the words
  // around the date (`extraction-term-end.ts`). The two are voted on as
  // one claim, and the winner is named afterwards from the page's kind.
  const endsATerm = (role: DocumentDateRole) => role === "renewal" || role === "expiry";
  const family = (role: DocumentDateRole): DocumentDateRole => (endsATerm(role) ? "expiry" : role);
  const claims = roleClaims(candidates).map((claim) => ({ ...claim, role: family(claim.role) }));
  const endRole = termEndRole(subtypeGroupBins(subtypeSources(candidates)), text);

  const claimed: string[] = [];
  for (const claim of claims) if (!claimed.includes(claim.date)) claimed.push(claim.date);

  const dateRoles: Array<{ date: string; role: DocumentDateRole }> = [];
  for (const date of claimed) {
    const forDate = claims.filter((claim) => claim.date === date);
    // One date can close one printed period and open the next: a renewal
    // notice prints the cover ending and the cover proposed from the same
    // day. The two claims do not conflict, and the one the household acts
    // on is the period beginning -- so a date a period starts at is a
    // `start`, whatever the period it also ends is called.
    // A printed connector, specifically: the page drew the period. A sieve
    // that worked the period out by arithmetic has not seen the page say so,
    // and must not turn a stated "your price ends on this date" into a start.
    const opensAPeriod = forDate.some(
      (claim) => claim.role === "start" && claim.sieves.includes(DATE_RANGE),
    );
    const closesAPeriod = forDate.some((claim) => endsATerm(claim.role));
    if (opensAPeriod && closesAPeriod) {
      dateRoles.push({ date, role: "start" });
      continue;
    }
    // Only the best-evidenced claims are heard: a quoted label beats a range
    // connector, and both beat a tag with no trigger. Two claims of equal
    // strength disagreeing is the page itself being ambiguous -- keep the
    // date, say nothing about what it is for.
    const best = Math.max(...forDate.map((claim) => claim.strength));
    // A guess is not an answer. A sieve that reached a role with nothing
    // behind it -- a date repeated in a footer, say -- counts towards
    // agreement with a sieve that did have a reason, and towards keeping the
    // date, but on its own it names nothing.
    if (best < CONNECTOR_STRENGTH) continue;
    const considered = forDate.filter((claim) => claim.strength === best);
    const roles = new Set(considered.map((claim) => claim.role));
    // Every document carries a date of issue, so `issued` is the role a date
    // has when the page says nothing more specific about it. Where one claim
    // says `issued` and another names a job that date does -- the inspection,
    // the renewal -- the specific one is what the household needs.
    if (roles.size > 1 && roles.has("issued")) roles.delete("issued");
    // Still arguing: the role the most sieves agree on wins -- several ways
    // of looking at one date reaching one answer is the whole point of
    // having several (ADR-0026 stage 2). Where they are level, the role the
    // page states most often wins, the same way a reference printed in every
    // footer wins. Level on both is an ambiguous page: blank.
    const winner = [...roles]
      .map((role) => {
        const mine = considered.filter((claim) => claim.role === role);
        const sieves = new Set(mine.flatMap((claim) => claim.sieves));
        return { role, sieves: sieves.size, claims: mine.length };
      })
      .sort((a, b) => b.sieves - a.sieves || b.claims - a.claims);
    const clear = winner.length === 1 ||
      winner[0].sieves > winner[1].sieves ||
      (winner[0].sieves === winner[1].sieves && winner[0].claims > winner[1].claims);
    if (clear) dateRoles.push({ date, role: endsATerm(winner[0].role) ? endRole : winner[0].role });
  }

  const leftovers = OFFER_UNLABELLED_DATES ? datesWithoutARole(candidates, dateRoles) : [];
  // Page order, whichever way a date got here.
  const kept = new Set([...claimed, ...leftovers]);
  return { dates: everyDate(candidates).filter((date) => kept.has(date)), dateRoles };
}

// "12 months", "every 6 months", "24-month". `months?\b` cannot match
// "monthly", which is how often the household pays rather than how long the
// thing lasts.
const CYCLE_MONTHS = /(\d{1,3})\s*-?\s*months?\b/iu;
// "2 years", "3-year", "1 year".
const CYCLE_YEARS = /(\d{1,2})\s*-?\s*years?\b/iu;
// The one word allowed to stand in for a figure, because pages print it far
// more often than "12 months". "two years" gets no such treatment: spelled
// numbers are where a misread becomes a wrong value.
const CYCLE_ANNUAL = /\bannual(?:ly)?\b|\byearly\b|\b(?:per|a|each|every) (?:year|annum)\b|\bfor the year\b/iu;

/**
 * How long the cycle is, in months, from the block a candidate was found
 * in. It is the cycle of the thing -- a 24-month contract is 24 -- not how
 * often it is paid for, so monthly instalments on an annual policy are
 * still 12.
 */
function cycleMonths(line: string): number | undefined {
  const months = line.match(CYCLE_MONTHS);
  if (months) return Number(months[1]);
  const years = line.match(CYCLE_YEARS);
  if (years) return Number(years[1]) * 12;
  if (CYCLE_ANNUAL.test(line)) return 12;
  return undefined;
}

function chooseRecurrenceMonths(candidates: readonly TaggedCandidate[]): number | undefined {
  for (const candidate of candidates) {
    const months = cycleMonths(candidate.line);
    if (months !== undefined && months > 0) return months;
  }
  return undefined;
}

/**
 * The household's own reference: the top of the same ranking the model is
 * shown (`referenceShortlistEntries`), or nothing.
 *
 * One ranking, not two. The shortlist already scores each number by how many
 * of the document's sheets it was printed on, by the word the page labelled
 * it with -- in the order this page's kind of thing puts those words -- and
 * by how often the page printed it, which is the page agreeing with itself: a
 * reference is the number a household is told to quote, so it appears in the
 * header, in every sheet's footer and in the payment instructions, while the
 * engineer's licence beside it is printed once.
 *
 * Two entries level at the top is the page printing two equally good claims,
 * and the answer to that is nothing. A top entry no label spoke for is the
 * page never saying which number is theirs, which is also nothing: the most
 * repeated unlabelled number is a guess, and a guess costs twice a blank.
 */
function chooseReference(
  candidates: readonly TaggedCandidate[],
  text: string | undefined,
): string | undefined {
  const ranked = referenceEntries(candidates, text);
  const best = ranked[0];
  if (best === undefined || !best.labelled) return undefined;
  if (ranked[1] !== undefined && ranked[1].support === best.support) return undefined;
  return trimFieldValue("reference", best.value, best.line);
}

/**
 * The amounts the page gave a reason to read as this document's cost, one
 * entry per figure, with every sieve that spoke for or against it.
 *
 * `previous` (last year's figure) and `rival` (the upgrade tier, the exit
 * fee, the employer's half) are reasons AGAINST rather than low-ranked
 * reasons for: a page prints them to be read instead of the real number, so
 * one of them cancels a reason for.
 */
interface AmountClaim {
  value: string;
  currency?: string;
  /** Every sieve that read the figure as a cost of some kind. */
  sieves: Set<string>;
  against: Set<string>;
  /** The strengths of those sieves added up, one reading per sieve: three
   * sieves with the page's own words behind them is a better reason than
   * three weak readings. Counted per sieve and not per printing, so a
   * figure printed six times is not six reasons. */
  weight: number;
  /** Whether the trigger table named it in so many words -- the one sieve
   * that can answer alone. */
  labelStated: boolean;
  /** Whether a sieve read it in so many words as last year's figure, or as
   * the rival printed beside the real one. Such a figure is out of the
   * running however much else agrees about it: the page printed it to be
   * read instead of the answer. */
  ruledOut: boolean;
  /**
   * What the best-evidenced reading says it is, as a rank in
   * `AMOUNT_PREFERENCE`. Read off the tag the most sieves agreed on, not
   * off the best tag any single sieve reached: one stray reading of a
   * monthly figure as a total must not promote it to one.
   */
  rank: number;
  /** Whether every printing of the figure is the page talking about what
   * was paid before (`LAST_TIME`). */
  lastTime: boolean;
  /** Whether every printing of the figure is the page pricing the other way
   * of paying (`THE_OTHER_WAY_OF_PAYING`). */
  theOtherWay: boolean;
  /** Whether the page frames the figure as the whole commitment: the year,
   * the term, the price paid in one go (`THE_WHOLE_COMMITMENT`). */
  wholeCommitment: boolean;
  /** Whether every printing of the figure sits under a heading announcing
   * something else on offer (`ANOTHER_THING_ON_OFFER`). */
  anotherThingOnOffer: boolean;
}

/**
 * The page talking about what was paid before: "your last payment of
 * £140.00", "may still be paying £39.00 under the previous price list",
 * "last year's premium", a withdrawn tariff.
 *
 * A real, labelled total, and still not the commitment -- so it is demoted
 * below every figure the page does not frame as history, rather than ruled
 * out. Read off the figure's own block, because that is where a page puts
 * the words that date it; a figure the page also prints plainly somewhere
 * else is not history at all, which is why every printing has to say so.
 */
const LAST_TIME =
  /\b(?:previous(?:ly)?|last year(?:'s|’s)?|last (?:payment|bill|invoice|premium|charge|price)\b|you (?:last )?paid\b|(?:payment|amount|sum) received\b|received on \d|paid on \d|old (?:price|rate)|former(?:ly)?|withdrawn|no longer available)\b/iu;

function everyPrintingIsHistory(lines: readonly string[]): boolean {
  return lines.length > 0 && lines.every((line) => LAST_TIME.test(line));
}

/**
 * The other way of paying. A page that prices one thing twice -- the annual
 * premium and what the same cover comes to spread over twelve instalments,
 * the paid-in-full price and the pay-monthly one -- is offering an option
 * and not naming a second commitment, and the commitment is the figure the
 * option is set beside (ADR-0026, 2026-09-13: "an offered option is not the
 * commitment").
 *
 * So a figure every printing of which prices paying monthly sorts under one
 * no printing of which does. Where the page frames every figure that way it
 * changes nothing, which is the rolling contract paid by the month: there
 * is no other way of paying on offer for it to lose to.
 */
const THE_OTHER_WAY_OF_PAYING =
  /\b(?:paid|pay|paying|payable|spread|split)\s+(?:it\s+|this\s+|the\s+cost\s+|for\s+)?(?:monthly\b|by\s+(?:\d{1,2}\s+)?(?:monthly\s+|quarterly\s+|weekly\s+)?instalments?|(?:over|across|in)\s+(?:\d{1,2}|twelve|ten)\s+(?:monthly\s+)?(?:instalments?|payments?))/iu;

/**
 * The page naming the whole commitment: the year, the term, the price paid
 * in one go. A figure framed this way is the commitment however the page
 * also words it -- "Annual total if paid monthly" is the year's price on a
 * plan the household pays by the month (ADR-0026, 2026-09-13), not the
 * other way of paying.
 */
const THE_WHOLE_COMMITMENT =
  /\b(?:annual(?:ly)?|yearly|in full|in one (?:go|payment)|single (?:\d{1,2}[- ]month )?payment|up ?front|for the year|over the (?:full |whole |entire )?term|for the \d{1,3}[- ]month (?:period|term))\b/iu;

/**
 * The block above a figure, where the page is using it as the figure's
 * heading: the block before it with no figure of its own. "PAID MONTHLY, 12
 * INSTALMENTS" printed over "£61.83 total £741.96 a year" is the page saying
 * what the figures under it price, and the figures alone do not say it.
 */
function framesOf(candidates: readonly TaggedCandidate[], text: string | undefined): Map<number, string> {
  const frames = new Map<number, string>();
  if (text === undefined) return frames;
  const blocks = pageBlocks(text);
  for (const candidate of candidates) {
    let above = "";
    for (let at = blocks.length - 1; at >= 0; at -= 1) {
      if (blocks[at].index > candidate.index) continue;
      const heading = blocks[at - 1];
      if (heading !== undefined && !PRINTED_FIGURE.test(heading.line)) above = heading.line;
      break;
    }
    frames.set(candidate.index, `${above} ${candidate.line}`);
  }
  return frames;
}

/** A money amount as a page prints it: what tells a heading from a row of
 * figures. */
const PRINTED_FIGURE = /[£€$]\s?\d/u;

function everyPrintingPricesTheOtherWay(frames: readonly string[]): boolean {
  return frames.length > 0 &&
    frames.every((frame) => THE_OTHER_WAY_OF_PAYING.test(frame) && !THE_WHOLE_COMMITMENT.test(frame));
}

/**
 * A panel heading announcing something other than the page's own charge:
 * "RAILCARD OFFERS", "ALSO AVAILABLE", "ADD-ONS", "OPTIONAL EXTRAS", "YOUR
 * OTHER SERVICES". A figure under one is a real, labelled price for
 * something the household has not committed to.
 *
 * One printing under such a heading is enough, where history and the other
 * way of paying both need every printing. Those two are readings of a
 * block, and a figure the page also prints plainly is not history; this is
 * the page putting a price in its "things you could buy" box, which is a
 * reason against the figure however many other printings agree about it --
 * the same stance the module takes on every other reason against.
 */
const ANOTHER_THING_ON_OFFER =
  /\b(?:also available|available (?:separately|to add|as an extra)|other (?:services|products|policies|plans|accounts|cover)|add[- ]?ons?|optional extras?|offers?|upgrades?|our (?:other|full) range|more from us|partner offers)\b/iu;

function everyPrintingIsOnOffer(headings: readonly string[]): boolean {
  return headings.length > 0 && headings.some((heading) => ANOTHER_THING_ON_OFFER.test(heading));
}

/** A block that heads a group rather than being one of them: a few short
 * words, no figure of its own, not a sentence. */
function aHeading(line: string): boolean {
  return line.length > 1 && line.length <= 60 &&
    line.split(" ").length <= HEADING_WORDS &&
    !PRINTED_FIGURE.test(line) && !/[.!?;]$/u.test(line);
}

/** A heading is a name, not a sentence: a few words at most. */
const HEADING_WORDS = 6;

/** How far above a figure the page's heading for it may sit. */
const HEADING_REACH_BLOCKS = 6;

/**
 * The nearest heading above each figure -- the panel it was printed in,
 * which is what says whether the page is pricing its own charge or the
 * things it also sells.
 */
function headingsOf(candidates: readonly TaggedCandidate[], text: string | undefined): Map<number, string> {
  const headings = new Map<number, string>();
  if (text === undefined) return headings;
  const blocks = pageBlocks(text);
  for (const candidate of candidates) {
    let own = blocks.length;
    for (let at = 0; at < blocks.length; at += 1) {
      if (blocks[at].index > candidate.index) { own = at; break; }
    }
    for (let at = own - 1; at >= Math.max(0, own - 1 - HEADING_REACH_BLOCKS); at -= 1) {
      if (!aHeading(blocks[at].line)) continue;
      headings.set(candidate.index, blocks[at].line);
      break;
    }
  }
  return headings;
}

/** Tags that are a reason against a figure being the cost. `other` is one
 * too where a sieve said so in words (a cover limit, an excess, a penalty)
 * and not where it is the blank tag a figure nobody read carries. */
const NOT_THE_COST = ["previous", "rival"];

function speaksAgainst(tag: { value: string; trigger: string }): boolean {
  return NOT_THE_COST.includes(tag.value) || (tag.value === "other" && tag.trigger.trim() !== "");
}

/** The period a figure is quoted by, and nothing else: "a year", "per
 * annum", "each year", "annually". */
const A_PERIOD_AND_NOTHING_ELSE = /^[\s·,.-]*(?:(?:per|a|each|every)\s+(?:year|annum)|annually|yearly)[\s·,.]*$/iu;

/**
 * Whether the block is a sentence rather than a row of a table or a form
 * field: it closes with a full stop, or carries one mid-block with a space
 * after it. "still on it pay £98.40 a year." is a sentence; "European
 * breakdown, annual EU-AN £96.00" is a row.
 */
const A_SENTENCE = /[.!?](?:\s|$)/u;

/**
 * A rival price quoted in prose (#1006 class 1). "Members who are still on
 * it pay £98.40 a year" tells the household what somebody else pays, and
 * "a year" says how often that price falls due -- it does not say the
 * figure is the total for this document.
 *
 * So where the only reason to read a figure as the whole price is the
 * period beside it, and the page printed it in a sentence, the period is
 * not a label and the reading is dropped. A table row headed "per year", a
 * figure the page called a premium, and anything else a sieve read in words
 * are all untouched: the tag's own trigger is what is tested, and stage 2
 * puts the strongest reason it found there.
 */
function aPeriodMistakenForALabel(tag: { value: string; trigger: string }, line: string): boolean {
  return tag.value === "total" && A_PERIOD_AND_NOTHING_ELSE.test(tag.trigger) && A_SENTENCE.test(line);
}

/** What one sieve said, kept at its best: a sieve that read the same
 * figure twice has one opinion about it. */
type SieveReadings = Map<string, number>;

function record(readings: SieveReadings, sieve: string, strength: number): void {
  readings.set(sieve, Math.max(readings.get(sieve) ?? 0, strength));
}

function totalStrength(readings: SieveReadings): number {
  return [...readings.values()].reduce((sum, strength) => sum + strength, 0);
}

/**
 * The page text is optional and is read for one thing only: the heading a
 * figure sits under, which the figure's own block does not carry. Without
 * it every reading falls back to the block, as it always did.
 */
export function amountClaims(candidates: readonly TaggedCandidate[], text?: string): AmountClaim[] {
  interface Working {
    value: string;
    currency?: string;
    /** One set of readings per tag, so the best-evidenced tag can be read
     * off at the end. */
    byTag: Map<string, SieveReadings>;
    against: SieveReadings;
    labelStated: boolean;
    /** Whether a printing of the figure carries the page naming it in so
     * many words and nothing reading it as something else: the cell the
     * tier table borrowed the figure into is not that printing. */
    namedInItsOwnCell: boolean;
    /** Whether `previous` or `rival` spoke against it -- the readings that
     * put a figure out of the running whatever else agrees. */
    printedInsteadOfTheAnswer: boolean;
  }
  const byValue = new Map<string, Working>();
  // Every block each figure was printed in, with the heading over it, so a
  // reading of the printings as a whole -- history, or the other way of
  // paying -- can be taken once.
  const frames = framesOf(candidates, text);
  const headings = headingsOf(candidates, text);
  const linesOf = new Map<string, string[]>();
  const framesOfValue = new Map<string, string[]>();
  const headingsOfValue = new Map<string, string[]>();
  for (const candidate of candidates) {
    if (candidate.kind !== "amount" || !candidate.currency) continue;
    const key = `${candidate.value} ${candidate.currency}`;
    linesOf.set(key, [...(linesOf.get(key) ?? []), candidate.line]);
    framesOfValue.set(key, [
      ...(framesOfValue.get(key) ?? []),
      frames.get(candidate.index) ?? candidate.line,
    ]);
    headingsOfValue.set(key, [...(headingsOfValue.get(key) ?? []), headings.get(candidate.index) ?? ""]);
  }

  for (const candidate of candidates) {
    // ADR-0025 section 3 refuses a cost whose evidence carries no currency,
    // and the scorer gives no half credit for one, so an amount without a
    // symbol or code is not half an answer -- it is none.
    if (candidate.kind !== "amount" || !candidate.currency) continue;
    const key = `${candidate.value} ${candidate.currency}`;
    // What this one printing says, kept apart until the tags of the cell
    // have all been read: a cell that names the figure and a cell that
    // reads it as something else are two different printings, and which of
    // them is which is what tells a tier table from a cover limit.
    let statedHere = false;
    let againstHere = false;
    let insteadOfTheAnswer = false;
    let held: Working | undefined;
    for (const tag of candidate.tags) {
      const rank = AMOUNT_PREFERENCE.indexOf(tag.value);
      const against = speaksAgainst(tag);
      if (rank === -1 && !against) continue;
      if (aPeriodMistakenForALabel(tag, candidate.line)) continue;
      held = held ?? byValue.get(key) ?? {
        value: candidate.value,
        currency: candidate.currency,
        byTag: new Map<string, SieveReadings>(),
        against: new Map() as SieveReadings,
        labelStated: false,
        namedInItsOwnCell: false,
        printedInsteadOfTheAnswer: false,
      };
      const strength = tag.strength ?? claimStrength(tag.trigger);
      const sieves = tag.sieves ?? [AMOUNT_LABEL];
      if (against) {
        for (const sieve of sieves) record(held.against, sieve, strength);
        if (strength >= STRENGTH_STATED) {
          againstHere = true;
          if (NOT_THE_COST.includes(tag.value)) insteadOfTheAnswer = true;
        }
      } else {
        const readings = held.byTag.get(tag.value) ?? new Map() as SieveReadings;
        for (const sieve of sieves) record(readings, sieve, strength);
        held.byTag.set(tag.value, readings);
        // The words in front of the figure, or the form's own heading
        // printed straight over its cell (`heading-above` at full
        // strength): either is the page naming the figure in so many words.
        if ((sieves.includes(AMOUNT_LABEL) || sieves.includes("heading-above")) && strength >= STRENGTH_STATED) {
          statedHere = true;
        }
      }
    }
    if (held === undefined) continue;
    held.labelStated ||= statedHere;
    held.namedInItsOwnCell ||= statedHere && !againstHere;
    held.printedInsteadOfTheAnswer ||= insteadOfTheAnswer;
    byValue.set(key, held);
  }

  const claims: AmountClaim[] = [];
  for (const working of byValue.values()) {
    const readings: SieveReadings = new Map();
    for (const perTag of working.byTag.values()) {
      for (const [sieve, strength] of perTag) record(readings, sieve, strength);
    }
    // The reading the most sieves agreed on is what the figure is; where
    // they are level, the stronger reading, and then the one the page's
    // preference puts first.
    const headline = [...working.byTag.entries()]
      .map(([tag, perTag]) => ({ tag, sieves: perTag.size, weight: totalStrength(perTag) }))
      .sort((left, right) =>
        right.sieves - left.sieves ||
        right.weight - left.weight ||
        AMOUNT_PREFERENCE.indexOf(left.tag) - AMOUNT_PREFERENCE.indexOf(right.tag))[0];
    claims.push({
      value: working.value,
      ...(working.currency === undefined ? {} : { currency: working.currency }),
      sieves: new Set(readings.keys()),
      against: new Set(working.against.keys()),
      // A figure the page printed to be read instead of the answer is out of
      // the running whatever else agrees. An `other` reading -- a cover
      // limit, an excess, a penalty -- does the same, unless another
      // printing of the same figure is the page naming it in so many words
      // with nothing reading that cell as anything else: a tier table
      // comparing this plan with the two beside it borrows the premium into
      // a "per condition" row, and the premium is still the premium.
      ruledOut: working.printedInsteadOfTheAnswer ||
        ([...working.against.values()].some((strength) => strength >= STRENGTH_STATED) &&
          !working.namedInItsOwnCell),
      weight: totalStrength(readings),
      labelStated: working.labelStated,
      rank: headline === undefined ? AMOUNT_PREFERENCE.length : AMOUNT_PREFERENCE.indexOf(headline.tag),
      lastTime: everyPrintingIsHistory(linesOf.get(`${working.value} ${working.currency}`) ?? []),
      theOtherWay: everyPrintingPricesTheOtherWay(
        framesOfValue.get(`${working.value} ${working.currency}`) ?? [],
      ),
      wholeCommitment: (framesOfValue.get(`${working.value} ${working.currency}`) ?? [])
        .some((frame) => THE_WHOLE_COMMITMENT.test(frame)),
      anotherThingOnOffer: everyPrintingIsOnOffer(
        headingsOfValue.get(`${working.value} ${working.currency}`) ?? [],
      ),
    });
  }
  return claims;
}

/** How many independent reasons there are to call a figure the cost: the
 * sieves for it, less the ones that read it as last year's or as the rival
 * printed beside it. */
function amountAgreement(claim: AmountClaim): number {
  return claim.sieves.size - claim.against.size;
}

/** Whether the page gave reason enough to name this figure at all: two
 * sieves agreeing, or the trigger table naming it in so many words. */
function enoughReason(claim: AmountClaim): boolean {
  return amountAgreement(claim) >= AGREEING_AMOUNT_SIEVES || claim.labelStated;
}

/**
 * Whether the page's own line items come to this figure: the row that adds
 * up the rows above it, or the figure the printed instalments multiply out
 * to. Either is the page doing the arithmetic itself, which is a better
 * reason than however many sieves read words beside a rival.
 */
function lineItemsAddUp(claim: AmountClaim): boolean {
  return claim.sieves.has(ADDS_UP) || claim.sieves.has(INSTALMENT_TOTAL);
}

/**
 * Claims worth offering: something spoke for the figure and nothing has
 * cancelled it out. Ordered best first.
 *
 * What the thing costs is heard before what one payment of it costs: a
 * page that prints a total and the twelve instalments it is paid in has
 * answered the question with the total, and the instalments are how, not
 * how much. So an instalment is only in the running where the page named
 * no total and no amount due at all -- and within either group, the figure
 * the most sieves agree about wins.
 */
export function rankedAmounts(candidates: readonly TaggedCandidate[], text?: string): AmountClaim[] {
  const kept = amountClaims(candidates, text)
    .filter((claim) => !claim.ruledOut && amountAgreement(claim) > 0);
  // Only a total or an amount due the page really gave a reason for keeps
  // the instalments out of the running: where the whole-price figures are
  // all one weak reading, the monthly fee the page did name is the better
  // answer -- it is what a gym membership costs.
  const whole = kept.filter((claim) =>
    claim.rank < AMOUNT_PREFERENCE.indexOf("instalment") && enoughReason(claim));
  // The row that adds up the rows above it is the bill for this page's
  // transaction, and outranks a price the page printed for something else
  // however many ways that price was read: "Business Hosting Plan £89.99
  // per year" is not what the domain renewal costs.
  const addsUp = (claim: AmountClaim): number => claim.sieves.has(ADDS_UP) ? 1 : 0;
  // Last time's figure is a real, labelled total and still not the
  // commitment, so it sorts below every figure the page does not date --
  // ahead of any other reason, because no amount of agreement about what a
  // figure was makes it what the household pays now.
  const now = (claim: AmountClaim): number => claim.lastTime ? 0 : 1;
  // What the thing costs, ahead of what the option to spread it costs. Only
  // a rival TOTAL is demoted: an instalment already ranks under every
  // whole-price figure, and the monthly fee on a rolling agreement is the
  // answer rather than a rival to it.
  // A figure printed under "RAILCARD OFFERS" or "ALSO AVAILABLE" is a real
  // price for something the household has not committed to, and joins it.
  const commitment = (claim: AmountClaim): number =>
    claim.anotherThingOnOffer ||
      (claim.theOtherWay && claim.rank < AMOUNT_PREFERENCE.indexOf("instalment"))
      ? 0
      : 1;
  // Last, because being framed as the year or the term is a way of telling
  // two figures the page spoke for equally well apart, not a reason that
  // outranks how well it spoke for them.
  const whole0 = (claim: AmountClaim): number => claim.wholeCommitment ? 1 : 0;
  return (whole.length > 0 ? whole : kept).sort((left, right) =>
    now(right) - now(left) ||
    commitment(right) - commitment(left) ||
    addsUp(right) - addsUp(left) ||
    amountAgreement(right) - amountAgreement(left) ||
    right.weight - left.weight ||
    left.rank - right.rank ||
    whole0(right) - whole0(left));
}

/**
 * What this document costs, where the page gives two reasons to believe it
 * or one stated label, and nothing where it does not.
 *
 * Blank is the answer to a page that prints two equally well-spoken-for
 * figures: a wrong cost costs a point where a blank costs nothing, and the
 * blank is what the model is then asked about.
 */
/**
 * The term a contract binds the household for, in months, where the page
 * states it as a term -- "initial minimum term of 12 months", "Minimum
 * term 24 months", "runs for 36 months", "24-month contract" -- and not
 * where it merely mentions a span of months. One figure only: a page that
 * names two different terms has not said which one the price runs over.
 */
const CONTRACT_TERM = [
  /(?:minimum|fixed|initial|contract|agreement)[^\S\n]+term(?:[^\S\n]+(?:of|is))?:?[^\S\n]+(\d{1,3})[^\S\n]*-?[^\S\n]*months?\b/giu,
  /(\d{1,3})[^\S\n]*-?[^\S\n]*months?[^\S\n]+(?:minimum[^\S\n]+|fixed[^\S\n]+|initial[^\S\n]+)?(?:term|contract|agreement)\b/giu,
  /(?:runs|running|lasts)[^\S\n]+for[^\S\n]+(\d{1,3})[^\S\n]+months?\b/giu,
  /contract[^\S\n]+length:?[^\S\n]+(\d{1,3})[^\S\n]+months?\b/giu,
];

export function contractTermMonths(text: string): number | undefined {
  const found = new Set<number>();
  for (const pattern of CONTRACT_TERM) {
    for (const match of text.matchAll(pattern)) found.add(Number(match[1]));
  }
  const terms = [...found].filter((months) => months >= 2 && months <= 600);
  return terms.length === 1 ? terms[0] : undefined;
}

/**
 * A reading of the page that can also come out ambiguous.
 *
 * Two readings of one page disagreeing is the page being unclear about its
 * own arithmetic, not an invitation to pick the larger. The caller answers
 * blank, which is what this stage does with every other tie.
 */
interface Derived<T> {
  value?: T;
  ambiguous: boolean;
}

const MONEY = String.raw`[£€$]\s?(?<pounds>\d{1,3}(?:,\d{3})*|\d+)(?:\.(?<pence>\d{2}))?`;
/** The figure is a rate and not a lump sum for the leg: "£300 for the first
 * 12 months" is what that leg costs in total, and reading it as a monthly
 * price would multiply money that was never charged. */
const A_MONTH = String.raw`(?:\s*\/\s*(?:mo|month|pm)\b|\s*p\/m\b|\s*pcm\b|\s*(?:per|a|each)\s+month\b|\s*monthly\b)`;
const FIRST_MONTHS = String.raw`\bfirst\s+(?<months>\d{1,2})\s+months?\b`;

/**
 * An introductory rate and how long it runs: "£14.00/mo for your first 6
 * months", "first 3 months at £9.99 a month".
 *
 * A page that prices a term in two legs has said its own arithmetic is a
 * sum, not one multiplication -- the standing rate times the whole term is
 * money the household never pays. Only the leg the page calls "first" is
 * read here; what the rest of the term costs is the figure stage 2 already
 * chose, so nothing about the second leg is guessed.
 *
 * The two forms need the price and the span written next to each other,
 * with no other figure between them. Without that, "first 6 months" followed
 * by the standing rate on the next line reads as the introductory one.
 */
const INTRODUCTORY_LEG = [
  new RegExp(`${MONEY}${A_MONTH}[^£€$\\d]{0,30}?${FIRST_MONTHS}`, "giu"),
  new RegExp(`${FIRST_MONTHS}\\s+(?:at|for|of|costs?|is)\\s+${MONEY}${A_MONTH}`, "giu"),
];

function introductoryLeg(text: string): Derived<{ minor: number; months: number }> {
  // One line, so a price and the words after it read together however the
  // page's blocks fell.
  const flat = text.replace(/\s+/gu, " ");
  const legs = new Map<string, { minor: number; months: number }>();
  for (const pattern of INTRODUCTORY_LEG) {
    for (const match of flat.matchAll(pattern)) {
      const groups = match.groups;
      if (groups === undefined) continue;
      const minor = Number(groups.pounds.replace(/,/gu, "")) * 100 +
        (groups.pence === undefined ? 0 : Number(groups.pence));
      const months = Number(groups.months);
      if (minor <= 0 || months < 1) continue;
      legs.set(`${minor}/${months}`, { minor, months });
    }
  }
  const found = [...legs.values()];
  return found.length === 1 ? { value: found[0], ambiguous: false } : { ambiguous: found.length > 1 };
}

function chooseCost(
  candidates: readonly TaggedCandidate[],
  text?: string,
): {
  costMinor?: number;
  currency?: string;
} {
  const ranked = rankedAmounts(candidates, text);
  const best = ranked[0];
  if (best === undefined) return {};
  if (!enoughReason(best)) return {};
  const rival = ranked[1];
  // A tie on how well the page spoke for two figures is a genuine tie and
  // blank is the answer -- unless the page's own arithmetic breaks it
  // (#1006 class 3). Where one of the two is what the line items add up to
  // and the other is not, the page has already said which is the bill, and
  // answering blank would be throwing that away.
  if (rival &&
    amountAgreement(rival) === amountAgreement(best) &&
    rival.weight === best.weight &&
    rival.rank === best.rank &&
    rival.lastTime === best.lastTime &&
    rival.theOtherWay === best.theOtherWay &&
    rival.wholeCommitment === best.wholeCommitment &&
    rival.anotherThingOnOffer === best.anotherThingOnOffer &&
    lineItemsAddUp(rival) === lineItemsAddUp(best)) {
    return {};
  }
  const minor = Number(best.value);
  if (!Number.isFinite(minor)) return {};
  // A page that prices a fixed-term contract only by the month has left
  // the arithmetic to the reader: what the contract costs is the payment
  // times the term (owner, 2026-09-13: Orbit tracks the whole commitment,
  // and where the pay-monthly price is what the household pays, the term's
  // cost is duration times the monthly cost). Only where the page names
  // no total at all -- the best figure is an instalment -- and says how
  // long the term is; a page that printed the product has been read already
  // by the `term-multiple` sieve.
  const priced = { costMinor: minor, currency: best.currency };
  if (text === undefined || best.rank !== AMOUNT_PREFERENCE.indexOf("instalment")) return priced;
  // The multiplier has to be a term the page printed in so many words
  // (#1006 class 5): "minimum term 24 months", "runs for 36 months". A span
  // counted off two dates is not one -- a pension statement, an annual
  // summary and a rolling agreement all cover a period, and none of them is
  // a contract priced over it, so multiplying by the gap between their dates
  // invents a commitment the page never stated.
  const term = contractTermMonths(text);
  if (term === undefined) return priced;
  const intro = introductoryLeg(text);
  if (intro.ambiguous) return {};
  if (intro.value === undefined || intro.value.months >= term) {
    return { costMinor: minor * term, currency: best.currency };
  }
  // The sum only means anything if the chosen figure is the standing rate:
  // where it is the introductory one, the page has not said through this
  // reading what the rest of the term costs, and blank beats a guess.
  if (intro.value.minor === minor) return {};
  return {
    costMinor: intro.value.months * intro.value.minor + (term - intro.value.months) * minor,
    currency: best.currency,
  };
}

/**
 * Stage 3 of ADR-0026. The rule-shaped fields are chosen here. Of the two
 * meaning-shaped ones, `provider` and `subtype` take the value the bins are
 * plain about (`extraction-choose-meaning.ts`) and answer blank otherwise:
 * both are the model's to choose over the shortlist, which is the same
 * module's second half and is wired up by the caller.
 */
/**
 * What the roles say about the schedule: the same derivation
 * `scripts/corpus/verify.mjs` applies to ground truth, so an extractor
 * cannot disagree with the corpus about what its own roles mean. Renewal
 * wins because it is the one the household must act on.
 *
 * Shared with the model path, where a role the model supplied has to change
 * the schedule the same way one a rule supplied does.
 */
function scheduleKindFrom(
  dateRoles: ReadonlyArray<{ date: string; role: string }>,
): "renewal" | "service" | undefined {
  return dateRoles.some((entry) => entry.role === "renewal")
    ? "renewal"
    : dateRoles.some((entry) => entry.role === "service")
      ? "service"
      : undefined;
}

function scheduleFrom(
  dateRoles: ReadonlyArray<{ date: string; role: string }>,
  candidates: readonly TaggedCandidate[],
): { scheduleKind?: "renewal" | "service"; recurrenceMonths?: number } {
  const scheduleKind = scheduleKindFrom(dateRoles);
  // A cycle length is only ever a fact about a schedule. Without one there
  // is nothing for it to be the cycle of.
  const recurrenceMonths = scheduleKind === undefined ? undefined : chooseRecurrenceMonths(candidates);
  return {
    ...(scheduleKind === undefined ? {} : { scheduleKind }),
    ...(recurrenceMonths === undefined ? {} : { recurrenceMonths }),
  };
}

export const chooseFields: ChooseStage = (candidates, text): ExtractedFields => {
  const { dates, dateRoles } = chooseDates(candidates, text);
  const { scheduleKind, recurrenceMonths } = scheduleFrom(dateRoles, candidates);
  const reference = chooseReference(candidates, text);
  const provider = text === undefined ? chooseProviderByRules(candidates) : chooseProviderFromPage(text);
  const subtype = chooseSubtypeByRules(candidates);

  return {
    dates,
    ...(dateRoles.length > 0 ? { dateRoles } : {}),
    ...(scheduleKind === undefined ? {} : { scheduleKind }),
    ...(recurrenceMonths === undefined ? {} : { recurrenceMonths }),
    ...(reference === undefined ? {} : { reference }),
    ...(provider === undefined ? {} : { provider }),
    ...(subtype === undefined ? {} : { subtype }),
    ...chooseCost(candidates, text),
  };
};

// ------------------------------------------------- the shortlists, ranked
//
// One per field: the few candidates the sieves spoke best for, each with the
// block it was printed in and the names of the sieves and tags that kept it.
// The rules' own ordering is the rank, and the rank is all it is -- the
// model picks (ADR-0026, amended 2026-09-11). What these are judged on is
// `eval:shortlist`: how often the expected answer is among the entries.

/** Three reasons is enough to say why a candidate is on the list; a fourth
 * spends the excerpt without telling the model anything new. */
const REASONS_SHOWN = 3;

/** What a date's block and the sieves that read it say about it. */
function dateEntry(candidates: readonly TaggedCandidate[], date: string): ShortlistEntry {
  let support = 0;
  let line = "";
  const why: string[] = [];
  for (const candidate of candidates) {
    if (candidate.kind !== "date" || candidate.value !== date) continue;
    if (!line || (!why.length && candidate.line.length > line.length)) line = candidate.line;
    for (const tag of candidate.tags) {
      const sieves = tag.sieves ?? [WORDS_BEFORE];
      const stated = tag.trigger.trim() !== "";
      if (tag.value === "other" || !isDateRole(tag.value)) {
        // A sieve reading a date as nothing in particular is a reason to ask
        // about it after the ones something spoke for.
        if (stated) support -= sieves.length;
        continue;
      }
      support += sieves.length * (stated ? (tag.strength ?? claimStrength(tag.trigger)) + 1 : 0);
      const reason = `${tag.value}${stated ? ` from "${tag.trigger}"` : ""} by ${sieves.join(", ")}`;
      if (stated && !why.includes(reason)) why.push(reason);
    }
  }
  return { value: date, display: date, line, why: why.slice(0, REASONS_SHOWN), support };
}

/** Every date the sieve found, best-spoken-for first: the list the model is
 * asked which of them the household must keep, and what each is for. */
export function dateShortlistEntries(candidates: readonly TaggedCandidate[]): ShortlistEntry[] {
  return bestSupported(everyDate(candidates).map((date) => dateEntry(candidates, date)));
}

// What the reference ranking is made of, in the order it decides. Several
// reasons agreeing beat one stronger reason (ADR-0026 stage 2), and for a
// reference the page repeating itself is one of those reasons: the number a
// household is told to quote is printed in the header, in the footer of
// every sheet and in the payment instructions, while the calibration
// certificate beside it is printed once.

/** A number some label spoke for always outranks one nothing did, however
 * often the page printed it and however far through the document it ran. A
 * page laying out its sheets is not the page saying which number is the
 * household's. Far enough above the band below that no count reaches it. */
const A_LABEL_AT_ALL = 1_000_000;

/** One more sheet the number was printed on, ranked above the word the page
 * labelled it with. Real paper prints the item's own reference in the header
 * or footer of every sheet -- "Policy number ... | page 2 of 4" -- while the
 * invoice number, the VAT number and another organisation's number are
 * printed once and left there. Far enough above the order and the repeats
 * that neither lifts a number out of the sheets it reached. */
const A_SHEET_PRINTED_ON = 1_000;

/** One step of the preference order: an account number where the kind of
 * thing wanted a policy number, or a bare noun where the page could have
 * spelled the label out. */
const A_STEP_OF_THE_ORDER = 4;

/** One more printing that carried a label of its own, worth the same as a
 * step: the page saying the same thing twice is as good a reason as saying
 * a slightly better thing once. A printing with no label behind it is worth
 * 1, and only settles what is otherwise level. */
const A_LABEL_PRINTED_AGAIN = 4;

/**
 * How a page says where one sheet ended and the next began: "Policy number
 * ... | page 2 of 4", "Sheet 3 of 12". Tika's text runs the sheets together
 * with nothing between them, so the number the page printed to find its own
 * way around is the only break left in it, and the fixtures carry it
 * verbatim (`extraction-corpus-fullpage.ts`).
 *
 * It is the same string stage 2 tags `page` and `extraction-reference-never.ts`
 * drops, which is why counting sheets costs the shortlist nothing: the marks
 * are read off the page here, and the numbers inside them were never
 * candidates.
 */
const SHEET_MARK = /\b(?:page|sheet|p\.)\s*(\d{1,3})\s*(?:of|\/)\s*\d{1,3}\b/giu;

/**
 * Where each sheet ends, in character offsets.
 *
 * A sheet that numbers itself twice -- a header and a footer both saying
 * "Page 2 of 4" -- is one sheet, so a run of marks carrying the same number
 * is one mark. Whether a document numbers itself at the head or the foot of
 * each sheet is not known and does not need to be: every candidate is placed
 * on the first mark at or after it, which on a head-numbered document names
 * every sheet one too high and moves no candidate relative to another. What
 * is asked of this is how MANY sheets a number was printed on, so a naming
 * that is consistently one out answers it exactly.
 */
function sheetMarks(text: string | undefined): number[] {
  if (text === undefined) return [];
  const marks: number[] = [];
  let numbered: string | undefined;
  for (const match of text.matchAll(SHEET_MARK)) {
    const ends = (match.index ?? 0) + match[0].length;
    if (match[1] === numbered && marks.length > 0) marks[marks.length - 1] = ends;
    else marks.push(ends);
    numbered = match[1];
  }
  return marks;
}

/** The sheet a printing sits on: the first mark at or after it, or the sheet
 * past the last mark. A document with no marks is one sheet, and every
 * candidate on it gets the same answer -- which is the rule staying silent,
 * as it must where there is nothing to count. */
function sheetAt(marks: readonly number[], index: number): number {
  const at = marks.findIndex((mark) => mark >= index);
  return at === -1 ? marks.length : at;
}

/** A shortlist entry with the two things the rules need and the model does
 * not: whether any label spoke for this number at all, and how many of the
 * document's sheets it was printed on. */
interface ReferenceEntry extends ShortlistEntry {
  labelled: boolean;
  sheets: number;
}

/**
 * Every identifier that could be the household's own, best-labelled first.
 *
 * Three things decide the order, and none of them is where the number sits
 * on the page:
 *
 * 1. which word the page labelled it with, ranked by what kind of thing the
 *    page is about (`extraction-reference-kind.ts`) -- a policy number on an
 *    insurance schedule, an account number on a water bill, a certificate
 *    number on a safety record;
 * 2. whether the page spelled that label out ("Certificate number") or
 *    merely printed the noun beside the number ("Certificate CSS-0417");
 * 3. how often the page printed it with a label, because a reference is the
 *    number the household is told to quote and a page repeats it.
 *
 * Above all three sits how many of the document's SHEETS the number was
 * printed on, under only the plain fact of a label, which nothing outranks.
 * Real paper puts the item's own reference in the header or footer of every
 * sheet -- "Policy number ... | page 2 of 4" -- while the invoice number, the
 * VAT number and another organisation's number are printed once and left
 * there. Sheets, not repeats: a number set three times in one table is not on
 * every sheet, and this counts the sheets it reached rather than the times it
 * was set.
 *
 * Where a customer number repeats in the same footer as the answer both are
 * on every sheet, the counts are level, and the page's own word for the
 * number decides as before -- which is the label still deciding, and the
 * reason the sheets are a band rather than a bigger version of (3).
 *
 * Numbers that can never be the household's reference -- the organisation's
 * VAT or company registration, a telephone number, bank details, a product
 * or promotion code, a sheet number, a number inside an address -- are not
 * ranked last, they are not here at all (`extraction-reference-never.ts`).
 * They are still in the tagged candidates, carrying the tag that says why.
 */
function referenceEntries(
  candidates: readonly TaggedCandidate[],
  text: string | undefined,
): ReferenceEntry[] {
  const marks = sheetMarks(text);
  const preference: readonly string[] = referencePreference(subtypeGroupBins(subtypeSources(candidates)));
  const dropped = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.kind === "identifier" && neverTheReference(candidate.tags as Tag<"identifier">[])) {
      dropped.add(candidate.value);
    }
  }

  interface Working extends Omit<ReferenceEntry, "sheets"> {
    /** The best place in the order any printing of this number earned --
     * two steps per tag, so that a bare noun sits between its own tag and
     * the next one down -- or the end of the order where none did. */
    step: number;
    printings: number;
    /** How many of those printings the page put a label beside. */
    labelledPrintings: number;
    /** The sheets it was printed on, so that a number set three times in one
     * table counts as the one sheet it reached. */
    sheets: Set<number>;
  }
  const entries = new Map<string, Working>();
  for (const candidate of candidates) {
    if (candidate.kind !== "identifier" || dropped.has(candidate.value)) continue;
    const held = entries.get(candidate.value) ?? {
      value: candidate.value,
      display: candidate.value,
      line: candidate.line,
      why: [] as string[],
      support: 0,
      labelled: false,
      step: preference.length * 2,
      printings: 0,
      labelledPrintings: 0,
      sheets: new Set<number>(),
    };
    // Printed again is one more reason, whatever the label beside it says.
    held.printings += 1;
    held.sheets.add(sheetAt(marks, candidate.index));
    let labelledHere = false;
    for (const tag of candidate.tags) {
      const rank = preference.indexOf(tag.value);
      if (rank === -1) continue;
      // A bare noun beside the number ("Certificate CSS-0417") is heard one
      // step behind the same word spelled out as a label ("Certificate
      // number"), so a page that names the number in so many words beats a
      // page that merely printed the word near it.
      const step = rank * 2 + ((tag.strength ?? STRENGTH_STATED) < STRENGTH_STATED ? 1 : 0);
      if (step < held.step) {
        held.step = step;
        // The block that carried the best label is the evidence for it.
        held.line = candidate.line;
      }
      held.labelled = true;
      labelledHere = true;
      const reason = `${tag.value}${tag.trigger.trim() ? ` from "${tag.trigger}"` : ""}`;
      if (!held.why.includes(reason)) held.why.push(reason);
    }
    if (labelledHere) held.labelledPrintings += 1;
    entries.set(candidate.value, held);
  }
  const ranked = [...entries.values()].map(({ step, printings, labelledPrintings, sheets, ...entry }) => ({
    ...entry,
    sheets: sheets.size,
    support: (entry.labelled ? A_LABEL_AT_ALL : 0) + sheets.size * A_SHEET_PRINTED_ON +
      (preference.length * 2 - step) * A_STEP_OF_THE_ORDER +
      labelledPrintings * A_LABEL_PRINTED_AGAIN + printings,
    why: entry.why.length > 0 ? entry.why.slice(0, REASONS_SHOWN) : ["no label beside it"],
  }));
  // On a single sheet, and on a document that never numbered its sheets,
  // every entry reaches the same one sheet: the term is the same for all of
  // them and settles nothing, which is the rule staying silent where there is
  // nothing to count.
  return bestSupported(ranked) as ReferenceEntry[];
}

/** The reference shortlist as the model is shown it: `referenceEntries`
 * without the rules' own note of which entries a label spoke for and how far
 * through the document each ran. The page text is read for the sheet marks
 * alone; without it the ranking is what it was before they were counted. */
export function referenceShortlistEntries(
  candidates: readonly TaggedCandidate[],
  text?: string,
): ShortlistEntry[] {
  return referenceEntries(candidates, text);
}

/**
 * The bands the cost shortlist falls into, best first and far enough apart
 * that no amount of agreement lifts a figure out of its own: the figures
 * the page speaks for as this commitment, then the ones it prints to price
 * the other way of paying, then the ones no sieve spoke for at all, then
 * the ones it dates to last time, then the ones its own words rule out.
 *
 * Nothing is dropped. A rule that drops a candidate takes the choice off
 * the model, and the reasons still order each band within itself.
 */
const THE_OTHER_WAY_BAND = -1_000;
const NOTHING_SPOKE_BAND = -2_000;
const LAST_TIME_BAND = -3_000;
const RULED_OUT_BAND = -4_000;

/** The figure as the page would print it, which is how the model is asked
 * about it and how its answer is read back. */
function printedAmount(value: string, currency: string | undefined): string {
  const symbol = currency === "GBP" ? "£" : currency === "EUR" ? "€" : currency === "USD" ? "$" : "";
  return `${symbol}${(Number(value) / 100).toFixed(2)}`;
}

/**
 * Every figure the page prints with a currency, the best-spoken-for first.
 *
 * The rules' ranking, with nothing dropped: a rival total the page prints to
 * be read instead of the charge goes down a band rather than off the list.
 * The cap is what shortens the list, not a rule.
 */
export function costShortlistEntries(candidates: readonly TaggedCandidate[], text?: string): ShortlistEntry[] {
  const entries: ShortlistEntry[] = [];
  const seen = new Set<string>();
  const blockFor = (value: string, currency: string | undefined) =>
    candidates.find((candidate) =>
      candidate.kind === "amount" && candidate.value === value && candidate.currency === currency);

  for (const claim of amountClaims(candidates, text)) {
    const key = `${claim.value} ${claim.currency}`;
    seen.add(key);
    const reading = claim.rank < AMOUNT_PREFERENCE.length ? AMOUNT_PREFERENCE[claim.rank] : "other";
    entries.push({
      value: claim.value,
      display: printedAmount(claim.value, claim.currency),
      ...(claim.currency === undefined ? {} : { currency: claim.currency }),
      line: blockFor(claim.value, claim.currency)?.line ?? "",
      why: [
        `read as the ${reading} by: ${[...claim.sieves].join(", ")}`,
        ...(claim.against.size > 0
          ? [`read as last year's or the rival beside it by: ${[...claim.against].join(", ")}`]
          : []),
        ...(claim.lastTime ? ["printed only where the page is saying what was paid before"] : []),
        ...(claim.theOtherWay ? ["printed only where the page is pricing the other way of paying"] : []),
        ...(claim.anotherThingOnOffer ? ["printed only under a heading offering something else"] : []),
      ],
      support: amountAgreement(claim) * 2 + claim.weight + (claim.labelStated ? 2 : 0) +
        (claim.ruledOut
          ? RULED_OUT_BAND
          : claim.lastTime
            ? LAST_TIME_BAND
            : claim.theOtherWay || claim.anotherThingOnOffer ? THE_OTHER_WAY_BAND : 0),
    });
  }

  for (const candidate of candidates) {
    if (candidate.kind !== "amount" || !candidate.currency) continue;
    const key = `${candidate.value} ${candidate.currency}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      value: candidate.value,
      display: printedAmount(candidate.value, candidate.currency),
      currency: candidate.currency,
      line: candidate.line,
      why: ["no sieve spoke for it"],
      support: NOTHING_SPOKE_BAND,
    });
  }

  return bestSupported(entries);
}

/** Every period the page prints in a block a candidate sits in, the most
 * often printed first: what the model is asked how long the thing runs for. */
export function recurrenceShortlistEntries(candidates: readonly TaggedCandidate[]): ShortlistEntry[] {
  const entries = new Map<number, ShortlistEntry>();
  for (const candidate of candidates) {
    const months = cycleMonths(candidate.line);
    if (months === undefined || months <= 0) continue;
    const held = entries.get(months) ?? {
      value: String(months),
      display: `${months} months`,
      line: candidate.line,
      why: ["printed on this line"],
      support: 0,
    };
    held.support += 1;
    entries.set(months, held);
  }
  return bestSupported([...entries.values()]);
}

/**
 * The whole of stage 3 with a model available: every field is the model's
 * pick from its own shortlist (owner, 2026-09-11 -- "everything is supposed
 * to go to the model for final choice").
 *
 * Five or six questions per document: the dates and their jobs in one call,
 * then the reference, the cost, the provider, what type of thing this is,
 * and -- only where the roles say there is a schedule to repeat -- how long
 * it runs for. Each is a few hundred characters, the shortlist and its
 * blocks, never the page (ADR-0026 stage 3). `none` is an allowed answer to
 * every one of them, and an answer the shortlist does not carry leaves the
 * field blank. No rule answers alongside: `chooseFields` above is the
 * ranking behind these lists and the answer only where there is no model.
 *
 * Used by `stages-score-cli.ts` and `holdout-score-cli.ts` under `--model`,
 * so both measure the same pipeline.
 */
export async function chooseFieldsWithModel(
  candidates: readonly TaggedCandidate[],
  transport: MeaningTransport,
): Promise<ExtractedFields> {
  const dateRoles = await chooseDatesWithModel(dateShortlistEntries(candidates), transport);
  // Page order, as every other route reports dates.
  const order = everyDate(candidates);
  const dates = order.filter((date) => dateRoles.some((entry) => entry.date === date));

  const reference = await chooseReferenceWithModel(referenceShortlistEntries(candidates), transport);
  const cost = await chooseCostWithModel(costShortlistEntries(candidates), transport);
  const provider = await chooseProviderWithModel(providerShortlistEntries(candidates), transport);
  const subtype = await chooseSubtypeWithModel(subtypeShortlist(candidates), transport);

  // Derived from the roles, exactly as the rules path derives them: a
  // schedule is what the roles mean, not a separate question. The cycle
  // length is a question, but only where there is a schedule for it to be
  // the cycle of.
  const scheduleKind = scheduleKindFrom(dateRoles);
  const recurrenceMonths = scheduleKind === undefined
    ? undefined
    : await chooseRecurrenceWithModel(recurrenceShortlistEntries(candidates), transport);

  return {
    dates,
    ...(dateRoles.length > 0 ? { dateRoles } : {}),
    ...(scheduleKind === undefined ? {} : { scheduleKind }),
    ...(recurrenceMonths === undefined ? {} : { recurrenceMonths }),
    ...(reference === undefined ? {} : { reference }),
    ...(provider === undefined ? {} : { provider }),
    ...(subtype === undefined ? {} : { subtype }),
    ...(cost ?? {}),
  };
}
