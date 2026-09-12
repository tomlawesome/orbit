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
// Nothing here reads the page. Each candidate already carries `line`, the
// Tika block it was found in, and its tags already carry the words that
// justified them, so this stage only compares what stage 2 decided.

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
import { AMOUNT_LABEL } from "./extraction-amount-sieves";
import { DATE_RANGE, WORDS_BEFORE } from "./extraction-date-sieves";
import { bestSupported, type ShortlistEntry } from "./extraction-shortlist";
import type { CandidateKind } from "./extraction-sieve";
import type { ExtractedFields } from "./extraction-scoring";
import type { ChooseStage, TaggedCandidate } from "./extraction-stages";
import { documentDateRoles, type DocumentDateRole } from "./suggestions";
import { trimFieldValue } from "./value-trim";

/**
 * Identifier tags that can carry the household's own reference, best first.
 *
 * `company` and `other` are absent deliberately and not as an oversight:
 * `company` is the organisation's number (VAT, company registration, FCA
 * firm reference), which is never the household's reference however alone
 * it stands on the page, and `other` is a candidate nothing on the page
 * explained.
 */
const REFERENCE_PREFERENCE = ["reference", "certificate", "policy", "account", "customer", "invoice"];

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

/** The rank of a candidate's best tag in `preference`, or nothing when none
 * of its tags appear there. A candidate tagged both `total` and `rival` is
 * a `total`: the preference list says which tags may win, so the best one
 * present decides. */
function bestRank(candidate: TaggedCandidate, preference: readonly string[]): number | undefined {
  let best: number | undefined;
  for (const tag of candidate.tags) {
    const rank = preference.indexOf(tag.value);
    if (rank === -1) continue;
    if (best === undefined || rank < best) best = rank;
  }
  return best;
}

/** Every candidate of `kind` that ties for the best tag in `preference`, in
 * page order. More than one means the page made the same claim twice --
 * agreeing or not is the caller's question. */
function bestTagged(
  candidates: readonly TaggedCandidate[],
  kind: CandidateKind,
  preference: readonly string[],
): TaggedCandidate[] {
  let bestSoFar: number | undefined;
  const winners: TaggedCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.kind !== kind) continue;
    const rank = bestRank(candidate, preference);
    if (rank === undefined) continue;
    if (bestSoFar === undefined || rank < bestSoFar) {
      bestSoFar = rank;
      winners.length = 0;
    }
    if (rank === bestSoFar) winners.push(candidate);
  }
  return winners;
}

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
function chooseDates(candidates: readonly TaggedCandidate[]): {
  dates: string[];
  dateRoles: Array<{ date: string; role: DocumentDateRole }>;
} {
  const claims = roleClaims(candidates);

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
    const closesAPeriod = forDate.some((claim) => claim.role === "renewal" || claim.role === "expiry");
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
    if (clear) dateRoles.push({ date, role: winner[0].role });
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
 * Two identifiers labelled equally well, saying different things: the one
 * the page prints most often wins.
 *
 * A reference is the number a household is told to quote, so the page puts
 * it in the header, in the footer of every sheet and in the payment
 * instructions; a number that appears beside it once -- the engineer's
 * licence, a meter read, a line in a URL -- does not get repeated. This
 * counts how often each value appears anywhere in the shortlist, which is
 * the page agreeing with itself, and not where on the page it sits. No
 * clear winner is still nothing.
 */
function mostRepeated(
  tied: readonly TaggedCandidate[],
  candidates: readonly TaggedCandidate[],
): TaggedCandidate | undefined {
  const appearances = (value: string) =>
    candidates.filter((candidate) => candidate.kind === "identifier" && candidate.value === value).length;
  let winner = tied[0];
  let clear = true;
  for (const candidate of tied.slice(1)) {
    if (candidate.value === winner.value) continue;
    const difference = appearances(candidate.value) - appearances(winner.value);
    if (difference > 0) {
      winner = candidate;
      clear = true;
    } else if (difference === 0) {
      clear = false;
    }
  }
  return clear ? winner : undefined;
}

function chooseReference(candidates: readonly TaggedCandidate[]): string | undefined {
  const best = bestTagged(candidates, "identifier", REFERENCE_PREFERENCE);
  if (best.length === 0) return undefined;
  const winner = new Set(best.map((candidate) => candidate.value)).size === 1
    ? best[0]
    : mostRepeated(best, candidates);
  if (!winner) return undefined;
  return trimFieldValue("reference", winner.value, winner.line);
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
}

/** Tags that are a reason against a figure being the cost. */
const NOT_THE_COST = ["previous", "rival"];

/** What one sieve said, kept at its best: a sieve that read the same
 * figure twice has one opinion about it. */
type SieveReadings = Map<string, number>;

function record(readings: SieveReadings, sieve: string, strength: number): void {
  readings.set(sieve, Math.max(readings.get(sieve) ?? 0, strength));
}

function totalStrength(readings: SieveReadings): number {
  return [...readings.values()].reduce((sum, strength) => sum + strength, 0);
}

export function amountClaims(candidates: readonly TaggedCandidate[]): AmountClaim[] {
  interface Working {
    value: string;
    currency?: string;
    /** One set of readings per tag, so the best-evidenced tag can be read
     * off at the end. */
    byTag: Map<string, SieveReadings>;
    against: SieveReadings;
    labelStated: boolean;
  }
  const byValue = new Map<string, Working>();

  for (const candidate of candidates) {
    // ADR-0025 section 3 refuses a cost whose evidence carries no currency,
    // and the scorer gives no half credit for one, so an amount without a
    // symbol or code is not half an answer -- it is none.
    if (candidate.kind !== "amount" || !candidate.currency) continue;
    for (const tag of candidate.tags) {
      const rank = AMOUNT_PREFERENCE.indexOf(tag.value);
      const against = NOT_THE_COST.includes(tag.value);
      if (rank === -1 && !against) continue;
      const key = `${candidate.value} ${candidate.currency}`;
      const held = byValue.get(key) ?? {
        value: candidate.value,
        currency: candidate.currency,
        byTag: new Map<string, SieveReadings>(),
        against: new Map() as SieveReadings,
        labelStated: false,
      };
      const strength = tag.strength ?? claimStrength(tag.trigger);
      const sieves = tag.sieves ?? [AMOUNT_LABEL];
      if (against) {
        for (const sieve of sieves) record(held.against, sieve, strength);
      } else {
        const readings = held.byTag.get(tag.value) ?? new Map() as SieveReadings;
        for (const sieve of sieves) record(readings, sieve, strength);
        held.byTag.set(tag.value, readings);
        if (sieves.includes(AMOUNT_LABEL) && strength >= 2) held.labelStated = true;
      }
      byValue.set(key, held);
    }
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
      ruledOut: [...working.against.values()].some((strength) => strength >= 2),
      weight: totalStrength(readings),
      labelStated: working.labelStated,
      rank: headline === undefined ? AMOUNT_PREFERENCE.length : AMOUNT_PREFERENCE.indexOf(headline.tag),
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
export function rankedAmounts(candidates: readonly TaggedCandidate[]): AmountClaim[] {
  const kept = amountClaims(candidates)
    .filter((claim) => !claim.ruledOut && amountAgreement(claim) > 0);
  // Only a total or an amount due the page really gave a reason for keeps
  // the instalments out of the running: where the whole-price figures are
  // all one weak reading, the monthly fee the page did name is the better
  // answer -- it is what a gym membership costs.
  const whole = kept.filter((claim) =>
    claim.rank < AMOUNT_PREFERENCE.indexOf("instalment") && enoughReason(claim));
  return (whole.length > 0 ? whole : kept).sort((left, right) =>
    amountAgreement(right) - amountAgreement(left) ||
    right.weight - left.weight ||
    left.rank - right.rank);
}

/**
 * What this document costs, where the page gives two reasons to believe it
 * or one stated label, and nothing where it does not.
 *
 * Blank is the answer to a page that prints two equally well-spoken-for
 * figures: a wrong cost costs a point where a blank costs nothing, and the
 * blank is what the model is then asked about.
 */
function chooseCost(candidates: readonly TaggedCandidate[]): {
  costMinor?: number;
  currency?: string;
} {
  const ranked = rankedAmounts(candidates);
  const best = ranked[0];
  if (best === undefined) return {};
  if (!enoughReason(best)) return {};
  const rival = ranked[1];
  if (rival &&
    amountAgreement(rival) === amountAgreement(best) &&
    rival.weight === best.weight &&
    rival.rank === best.rank) {
    return {};
  }
  const minor = Number(best.value);
  return Number.isFinite(minor) ? { costMinor: minor, currency: best.currency } : {};
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

export const chooseFields: ChooseStage = (candidates): ExtractedFields => {
  const { dates, dateRoles } = chooseDates(candidates);
  const { scheduleKind, recurrenceMonths } = scheduleFrom(dateRoles, candidates);
  const reference = chooseReference(candidates);
  const provider = chooseProviderByRules(candidates);
  const subtype = chooseSubtypeByRules(candidates);

  return {
    dates,
    ...(dateRoles.length > 0 ? { dateRoles } : {}),
    ...(scheduleKind === undefined ? {} : { scheduleKind }),
    ...(recurrenceMonths === undefined ? {} : { recurrenceMonths }),
    ...(reference === undefined ? {} : { reference }),
    ...(provider === undefined ? {} : { provider }),
    ...(subtype === undefined ? {} : { subtype }),
    ...chooseCost(candidates),
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

/** Every identifier the sieve found, the best-labelled first: the page's own
 * label decides the order, and how often the page repeated it breaks ties.
 * A number a checksum read as the company's own goes last. */
export function referenceShortlistEntries(candidates: readonly TaggedCandidate[]): ShortlistEntry[] {
  const entries = new Map<string, ShortlistEntry>();
  for (const candidate of candidates) {
    if (candidate.kind !== "identifier") continue;
    const held = entries.get(candidate.value) ?? {
      value: candidate.value,
      display: candidate.value,
      line: candidate.line,
      why: [] as string[],
      support: 0,
    };
    // Printed again is one more reason, whatever the label beside it says.
    held.support += 1;
    for (const tag of candidate.tags) {
      const rank = REFERENCE_PREFERENCE.indexOf(tag.value);
      const reason = `${tag.value}${tag.trigger.trim() ? ` from "${tag.trigger}"` : ""}`;
      if (rank !== -1) {
        held.support += (REFERENCE_PREFERENCE.length - rank) * 2;
        if (!held.line) held.line = candidate.line;
      } else if (tag.value === "company") {
        // The organisation's own number -- a VAT or UTR the checksum
        // recognised -- is never the household's reference.
        held.support -= REFERENCE_PREFERENCE.length * 2;
      } else {
        continue;
      }
      if (!held.why.includes(reason)) held.why.push(reason);
    }
    entries.set(candidate.value, held);
  }
  return bestSupported([...entries.values()].map((entry) => ({
    ...entry,
    why: entry.why.length > 0 ? entry.why.slice(0, REASONS_SHOWN) : ["no label beside it"],
  })));
}

/** The figure as the page would print it, which is how the model is asked
 * about it and how its answer is read back. */
function printedAmount(value: string, currency: string | undefined): string {
  const symbol = currency === "GBP" ? "£" : currency === "EUR" ? "€" : currency === "USD" ? "$" : "";
  return `${symbol}${(Number(value) / 100).toFixed(2)}`;
}

/**
 * Every figure the page prints with a currency, the best-spoken-for first.
 *
 * The rules' ranking, with nothing dropped: a figure a sieve read as last
 * year's or as the rival beside the real one goes last rather than out, and
 * a figure no sieve spoke for at all sits between the two. The cap is what
 * shortens the list, not a rule.
 */
export function costShortlistEntries(candidates: readonly TaggedCandidate[]): ShortlistEntry[] {
  const entries: ShortlistEntry[] = [];
  const seen = new Set<string>();
  const blockFor = (value: string, currency: string | undefined) =>
    candidates.find((candidate) =>
      candidate.kind === "amount" && candidate.value === value && candidate.currency === currency);

  for (const claim of amountClaims(candidates)) {
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
      ],
      // Ruled out by the page's own words, so last -- but still on the list,
      // because a rule that drops a candidate takes the choice off the model.
      support: claim.ruledOut ? -1 : amountAgreement(claim) * 2 + claim.weight + (claim.labelStated ? 2 : 0),
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
      support: 0,
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
