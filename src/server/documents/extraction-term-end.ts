// Whether the date a term ends on is a `renewal` or an `expiry`.
//
// The word on the page cannot say. A tax reminder, a tenancy, an MOT and a
// guarantee all print "expires"; only the guarantee simply stops on that
// day. What decides it is what kind of thing the page is about (owner,
// 2026-09-13): a thing that continues only if the household acts again --
// insurance, tax, a licence, a subscription, a tenancy -- is renewed, so
// its end date is when Orbit must remind them. A thing that is over when
// it is over -- a guarantee, a warranty, a loan, a lease, a course -- just
// expires, and the date is kept on the item as a fact with no reminder.
//
// The sieves and tags therefore say only that a date ENDS a term; the
// chooser names the end with the page's kind, read from the same taxonomy
// bins the subtype field uses (`extraction-subtype-bins.ts`). Every kind in
// the taxonomy that can bound a term has an answer here, so a page the kind
// reader gets right is decided by its kind; a page it cannot read falls to
// the wording, which is a weaker guide (owner: be specific where we can,
// and catch the rest as well as we can).

import type { GroupBin } from "./extraction-subtype-bins";
import type { DocumentDateRole } from "./suggestions";

/** Kinds the household takes out again when they end: cover, a right to
 * do something, a supply, a place to live, a standing that lapses. */
const RENEWS = new Set([
  "Insurance", "Plan", "Contract", "Subscription", "Membership", "Tariff", "Utility",
  "Tax", "Licence", "Permit", "Mortgage", "Maintenance contract", "Tenancy", "Rental",
  "Registration", "Service charge", "Season ticket", "Parking permit", "Domain",
  "Software subscription",
  // An identity document is renewed; a benefit award is reviewed or claimed
  // again when it ends.
  "Identity document", "Benefit",
]);

/** Kinds that are over when their term is: a promise about a thing already
 * bought, money already lent, a fixed period the household simply sees out,
 * or a one-off event. */
const ENDS = new Set([
  "Warranty", "Guarantee", "Loan", "Lease", "Course", "Quote",
  // A card is replaced by the bank; savings and investments mature and the
  // money comes back; a prescription, a vaccination and a fine's discount
  // period run out.
  "Credit card", "Savings", "Investment", "Prescription", "Vaccination", "Fine",
]);

// Kinds deliberately left undecided. Bill, Statement, Bank account, Pension,
// Record, Deed and Will bound no term of their own. Certificate, Inspection,
// Service, Appointment, Repair, Delivery and Order end in a visit, which the
// date sieve names `service` on its own. Claim, Fees, Deposit and the rest
// are words every other kind's page uses too -- an insurance schedule says
// "claim" more than it says "insurance" -- so letting them decide misnames
// the thing the page is really about. A page of one of these kinds is
// decided by any more specific kind it also carries, else by the words on
// it.

/** Words for the piece of paper rather than the thing it is about: every
 * tenancy is an agreement, every quote is for something. These decide only
 * when nothing more specific is on the page. */
const PAPER = new Set(["Contract", "Bill", "Statement", "Certificate", "Record", "Quote"]);

/** Wording that speaks of a thing going round again: renewing, a yearly
 * or monthly cycle, a rolling term. */
const SPEAKS_OF_A_CYCLE = /\brenew(?:al|ed|s|ing)?\b|\bannual(?:ly)?\b|\byearly\b|\b(?:each|every|per) (?:year|month)\b|\bevery \d{1,2} months\b|\brolling\b|\bauto-?renew/iu;

/** Wording that speaks of a thing stopping: a one-off, a final payment,
 * money maturing, a promise about a thing already bought. */
const SPEAKS_OF_AN_END = /\bone-?off\b|\bsingle payment\b|\bfinal (?:payment|instalment)\b|\bmatur(?:es|ity)\b|\bnon-?renewable\b|\bwarrant(?:y|ies)\b|\bguarantee[ds]?\b/iu;

function count(pattern: RegExp, text: string): number {
  return text.match(new RegExp(pattern.source, "giu"))?.length ?? 0;
}

/**
 * The role of a date that ends the page's term. The best-supported kind
 * with a known answer decides, the paper words waiting their turn behind
 * the thing words. A page whose kind says nothing renews if its wording
 * speaks more of a cycle than of an end, and otherwise merely expires.
 */
export function termEndRole(kinds: ReadonlyArray<GroupBin>, text: string | undefined): DocumentDateRole {
  const things = kinds.filter(({ group }) => !PAPER.has(group));
  const paper = kinds.filter(({ group }) => PAPER.has(group));
  for (const { group } of [...things, ...paper]) {
    if (RENEWS.has(group)) return "renewal";
    if (ENDS.has(group)) return "expiry";
  }
  if (text === undefined) return "expiry";
  return count(SPEAKS_OF_A_CYCLE, text) > count(SPEAKS_OF_AN_END, text) ? "renewal" : "expiry";
}
