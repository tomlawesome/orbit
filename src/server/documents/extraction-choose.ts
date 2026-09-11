// Stage 3 of the three-stage extraction shape (ADR-0026): one answer per
// field, or none, from the tagged shortlist stage 2 hands over.
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
  chooseDateToActOnWithModel,
  chooseMeaningFieldsWithModel,
  chooseProviderByRules,
  type MeaningTransport,
} from "./extraction-choose-meaning";
import { DATE_RANGE, WORDS_BEFORE } from "./extraction-date-sieves";
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

function chooseCost(candidates: readonly TaggedCandidate[]): {
  costMinor?: number;
  currency?: string;
} {
  // ADR-0025 section 3 refuses a cost whose evidence carries no currency,
  // and the scorer gives no half credit for one, so an amount without a
  // symbol or code is not half an answer -- it is none. Such amounts are
  // dropped before the ranking rather than after it: a figure in a
  // transaction table that cannot be the answer should not be allowed to
  // outrank, or tie with, one that can.
  const priced = candidates.filter((candidate) => candidate.kind !== "amount" || candidate.currency);
  const best = bestTagged(priced, "amount", AMOUNT_PREFERENCE);
  if (best.length === 0) return {};
  if (new Set(best.map((candidate) => candidate.value)).size > 1) return {};
  const winner = best[0];
  const minor = Number(winner.value);
  return Number.isFinite(minor) ? { costMinor: minor, currency: winner.currency } : {};
}

/**
 * Stage 3 of ADR-0026. The rule-shaped fields are chosen here. Of the two
 * meaning-shaped ones, `provider` takes the value where the page states it
 * in so many words (`extraction-choose-meaning.ts`) and `subtype` is left
 * blank: both are the model's to choose over the shortlist, which is the
 * same module's second half and is wired up by the caller.
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
function scheduleFrom(
  dateRoles: ReadonlyArray<{ date: string; role: string }>,
  candidates: readonly TaggedCandidate[],
): { scheduleKind?: "renewal" | "service"; recurrenceMonths?: number } {
  const scheduleKind = dateRoles.some((entry) => entry.role === "renewal")
    ? "renewal"
    : dateRoles.some((entry) => entry.role === "service")
      ? "service"
      : undefined;
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

  return {
    dates,
    ...(dateRoles.length > 0 ? { dateRoles } : {}),
    ...(scheduleKind === undefined ? {} : { scheduleKind }),
    ...(recurrenceMonths === undefined ? {} : { recurrenceMonths }),
    ...(reference === undefined ? {} : { reference }),
    ...(provider === undefined ? {} : { provider }),
    ...chooseCost(candidates),
  };
};

/**
 * The whole of stage 3 with the model available: the rules first, then the
 * three questions they left open -- who the household deals with, what type
 * of thing this is, and which of the dates nothing could label is the one to
 * act on.
 *
 * The model is never handed the page, only the shortlist and its blocks
 * (ADR-0026 stage 3), and every answer is refused unless the shortlist
 * carries it. Used by `stages-score-cli.ts` and `holdout-score-cli.ts` under
 * `--model`, so both measure the same pipeline.
 */
export async function chooseFieldsWithModel(
  candidates: readonly TaggedCandidate[],
  transport: MeaningTransport,
): Promise<ExtractedFields> {
  const chosen = chooseFields(candidates);
  const meaning = await chooseMeaningFieldsWithModel(candidates, chosen, transport);

  const decided = chosen.dateRoles ?? [];
  const offered = datesWithoutARole(candidates, decided);
  const picked = await chooseDateToActOnWithModel(candidates, offered, decided, transport);
  const dateRoles = picked === undefined ? decided : [...decided, picked];

  return {
    ...chosen,
    ...meaning,
    ...(dateRoles.length > 0 ? { dateRoles } : {}),
    ...scheduleFrom(dateRoles, candidates),
  };
}
