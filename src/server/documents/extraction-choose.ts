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
function claimStrength(trigger: string): number {
  if (trigger.trim() === "") return 0;
  return RANGE_CONNECTOR_TRIGGER.test(trigger) ? 1 : 2;
}

function roleClaims(candidates: readonly TaggedCandidate[]): RoleClaim[] {
  const claims: RoleClaim[] = [];
  for (const candidate of candidates) {
    if (candidate.kind !== "date") continue;
    for (const tag of candidate.tags) {
      // `other` means stage 2 found a date but nothing saying what it was
      // for. It is not a role, and a date that only has one is not a date
      // this document is about.
      if (tag.value === "other" || !isDateRole(tag.value)) continue;
      claims.push({ date: candidate.value, role: tag.value, strength: claimStrength(tag.trigger) });
    }
  }
  return claims;
}

/** The date this document is about, and what each is for. Stage 2 preserves
 * page order, so first-seen order is page order. */
function chooseDates(candidates: readonly TaggedCandidate[]): {
  dates: string[];
  dateRoles: Array<{ date: string; role: DocumentDateRole }>;
} {
  const claims = roleClaims(candidates);

  const dates: string[] = [];
  for (const claim of claims) if (!dates.includes(claim.date)) dates.push(claim.date);

  const dateRoles: Array<{ date: string; role: DocumentDateRole }> = [];
  for (const date of dates) {
    const forDate = claims.filter((claim) => claim.date === date);
    // Only the best-evidenced claims are heard: a quoted label beats a range
    // connector, and both beat a tag with no trigger. Two claims of equal
    // strength disagreeing is the page itself being ambiguous -- keep the
    // date, say nothing about what it is for.
    const best = Math.max(...forDate.map((claim) => claim.strength));
    const considered = forDate.filter((claim) => claim.strength === best);
    const roles = new Set(considered.map((claim) => claim.role));
    // Every document carries a date of issue, so `issued` is the role a date
    // has when the page says nothing more specific about it. Where one claim
    // says `issued` and another names a job that date does -- the inspection,
    // the renewal -- the specific one is what the household needs.
    if (roles.size > 1 && roles.has("issued")) roles.delete("issued");
    if (roles.size === 1) dateRoles.push({ date, role: [...roles][0] });
  }

  return { dates, dateRoles };
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
const CYCLE_ANNUAL = /\bannual(?:ly)?\b/iu;

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
  const best = bestTagged(candidates, "amount", AMOUNT_PREFERENCE);
  if (best.length === 0) return {};
  if (new Set(best.map((candidate) => candidate.value)).size > 1) return {};
  const winner = best[0];
  // ADR-0025 section 3 refuses a cost whose evidence carries no currency,
  // and the scorer gives no half credit for one, so an amount without a
  // symbol or code is not half an answer -- it is none.
  if (!winner.currency) return {};
  const minor = Number(winner.value);
  return Number.isFinite(minor) ? { costMinor: minor, currency: winner.currency } : {};
}

/**
 * Stage 3 of ADR-0026. `provider` and `subtype` are a later slice and stay
 * blank here rather than being guessed from the organisation and heading
 * candidates that stage 2 has already tagged.
 */
export const chooseFields: ChooseStage = (candidates): ExtractedFields => {
  const { dates, dateRoles } = chooseDates(candidates);

  // The same derivation `scripts/corpus/verify.mjs` applies to ground
  // truth, so an extractor cannot disagree with the corpus about what its
  // own roles mean: renewal wins because it is the one the household must
  // act on.
  const scheduleKind = dateRoles.some((entry) => entry.role === "renewal")
    ? "renewal"
    : dateRoles.some((entry) => entry.role === "service")
      ? "service"
      : undefined;

  // A cycle length is only ever a fact about a schedule. Without one there
  // is nothing for it to be the cycle of.
  const recurrenceMonths = scheduleKind === undefined ? undefined : chooseRecurrenceMonths(candidates);
  const reference = chooseReference(candidates);

  return {
    dates,
    ...(dateRoles.length > 0 ? { dateRoles } : {}),
    ...(scheduleKind === undefined ? {} : { scheduleKind }),
    ...(recurrenceMonths === undefined ? {} : { recurrenceMonths }),
    ...(reference === undefined ? {} : { reference }),
    ...chooseCost(candidates),
  };
};
