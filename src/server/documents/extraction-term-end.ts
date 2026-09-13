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
// bins the subtype field uses (`extraction-subtype-bins.ts`).

import type { GroupBin } from "./extraction-subtype-bins";
import type { DocumentDateRole } from "./suggestions";

/** Kinds the household takes out again when they end. */
const RENEWS = new Set([
  "Insurance", "Plan", "Contract", "Subscription", "Membership", "Tariff", "Utility",
  "Tax", "Licence", "Permit", "Mortgage", "Maintenance contract", "Tenancy", "Rental",
  "Registration", "Service charge", "Season ticket", "Parking permit", "Domain",
  "Software subscription",
]);

/** Kinds that are over when their term is. */
const ENDS = new Set(["Warranty", "Guarantee", "Loan", "Lease", "Course", "Quote"]);

/** Words for the piece of paper rather than the thing it is about: every
 * tenancy is an agreement, every quote is for something. These decide only
 * when nothing more specific is on the page. */
const PAPER = new Set(["Contract", "Bill", "Statement", "Certificate", "Record", "Quote"]);

/** A page that talks about renewing is about a thing that renews. */
const TALKS_OF_RENEWING = /\brenew(?:al|ed|s|ing)?\b/iu;

/**
 * The role of a date that ends the page's term. The best-supported kind
 * with a known answer decides, the paper words waiting their turn behind
 * the thing words. A page whose kind says nothing (a certificate, an
 * inspection, a statement) renews if it speaks of renewing anywhere, and
 * otherwise merely expires.
 */
export function termEndRole(kinds: ReadonlyArray<GroupBin>, text: string | undefined): DocumentDateRole {
  const things = kinds.filter(({ group }) => !PAPER.has(group));
  const paper = kinds.filter(({ group }) => PAPER.has(group));
  for (const { group } of [...things, ...paper]) {
    if (RENEWS.has(group)) return "renewal";
    if (ENDS.has(group)) return "expiry";
  }
  return text !== undefined && TALKS_OF_RENEWING.test(text) ? "renewal" : "expiry";
}
