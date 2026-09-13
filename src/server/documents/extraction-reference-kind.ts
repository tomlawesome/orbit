// Which of a page's labelled numbers is the household's own reference.
//
// The label on the page cannot say on its own. A policy number, an account
// number, a certificate number, a membership number and a payment reference
// are all printed as "the number", and every one of them is the answer on
// somebody's page and the wrong answer on somebody else's. What decides is
// what kind of thing the page is about: an insurance policy is identified by
// its policy number however many other numbers surround it, a water bill by
// the account number, a gas safety record by the record's own number, a loan
// by its agreement number.
//
// So the preference order is read from the same taxonomy bins the subtype
// field uses (`extraction-subtype-bins.ts`), exactly as `termEndRole` reads
// the end of a term from them. A kind names the words its own paper uses for
// the household's file; everything the kind did not name follows behind in
// the generic order, so a page whose kind says nothing still answers the way
// it always did -- the word "reference" first.
//
// Two guards, both copied from `extraction-term-end.ts` because they are the
// same trap:
//
//   * a kind whose words appear on every other kind's page (Claim, Fees,
//     Service, Deposit, Order, Repair, Delivery, Appointment) decides
//     nothing -- an insurance schedule says "claim" more than it says
//     "insurance", and letting it decide misnames the thing the page is
//     really about;
//   * a word for the piece of paper rather than the thing it is about
//     (Contract, Bill, Statement, Certificate, Record, Quote) is heard only
//     after every thing-word on the page, because every tenancy is an
//     agreement and every renewal is a bill.

import type { GroupBin } from "./extraction-subtype-bins";
import type { IdentifierTag } from "./extraction-stages";

/**
 * The order where nothing on the page says what kind of thing it is about.
 *
 * `reference` leads it: a page that calls a number "your reference" has said
 * outright that it is the one to quote, and it stays the answer unless the
 * kind of thing names a word of its own. `company` and the other
 * never-the-answer tags are absent, and not by oversight -- see
 * `extraction-reference-never.ts`.
 */
export const GENERIC_REFERENCE_PREFERENCE: readonly IdentifierTag[] = [
  "reference",
  "certificate",
  "policy",
  "agreement",
  "account",
  "customer",
  "invoice",
];

/**
 * What each kind of thing calls the household's own number, best first.
 *
 * Read as "a page about X prints the household's file as an X-number":
 * cover is a policy, a supply or a running arrangement is an account, a
 * right to do something or a record of something done is a certificate,
 * money borrowed or a place rented is an agreement, a club is a membership
 * (which stage 2 tags `customer`, with the customer and client numbers it
 * sits beside).
 */
const BY_KIND: Readonly<Record<string, readonly IdentifierTag[]>> = {
  // Cover, and the things sold the way cover is sold.
  Insurance: ["policy"],
  Plan: ["policy"],
  Pension: ["policy", "account"],
  Warranty: ["certificate", "policy"],
  Guarantee: ["certificate"],

  // A supply, a subscription, a running arrangement: an account number.
  Utility: ["account"],
  Tariff: ["account"],
  Subscription: ["account"],
  "Software subscription": ["account"],
  Domain: ["account"],
  "Service charge": ["account"],
  Tax: ["account"],
  "Bank account": ["account"],
  "Credit card": ["account"],
  Savings: ["account"],
  Investment: ["account"],
  Membership: ["customer", "account"],
  "Season ticket": ["certificate", "customer"],

  // A right to do something, or the record of something done: the paper is
  // numbered as itself and that number IS the household's reference.
  Licence: ["certificate"],
  Permit: ["certificate"],
  "Parking permit": ["certificate"],
  "Identity document": ["certificate"],
  Registration: ["certificate"],
  Inspection: ["certificate"],
  Vaccination: ["certificate"],
  Prescription: ["certificate"],
  Course: ["certificate"],

  // Money borrowed, or somewhere rented: an agreement, and the account it
  // is serviced through.
  Mortgage: ["account", "agreement"],
  Loan: ["agreement", "account"],
  Lease: ["agreement", "account"],
  Tenancy: ["agreement", "account"],
  Rental: ["agreement", "account"],
  "Maintenance contract": ["agreement", "policy"],

  // Paper words (below), each with an answer for the pages where nothing
  // more specific is printed.
  Contract: ["agreement"],
  Bill: ["account", "invoice"],
  Statement: ["account"],
  Certificate: ["certificate"],
  Record: ["certificate"],
};

/**
 * The few qualifiers that name the thing outright where the kind is vague:
 * a water or broadband page is an account page whatever kind word its
 * heading happens to use, and council tax is billed against an account.
 * Qualifiers are heard after the kinds, because the kind is the thing.
 */
const BY_QUALIFIER: Readonly<Record<string, readonly IdentifierTag[]>> = {
  Water: ["account"],
  Waste: ["account"],
  Gas: ["account"],
  Electricity: ["account"],
  Energy: ["account"],
  "Heating oil": ["account"],
  Broadband: ["account"],
  Mobile: ["account"],
  TV: ["account"],
  Streaming: ["account"],
  Gym: ["customer", "account"],
  "Council tax": ["account"],
  Council: ["account"],
  MOT: ["certificate"],
  "Gas safety": ["certificate"],
  "Energy performance": ["certificate"],
  Safety: ["certificate"],
  Electrical: ["certificate"],
  Leasehold: ["account"],
  Tenancy: ["agreement", "account"],
};

/** Kinds whose words are printed on every other kind's page. A page of one
 * of these is decided by whatever more specific kind it also carries. */
const EVERY_PAGE = new Set([
  "Claim", "Fees", "Deposit", "Service", "Order", "Repair", "Delivery", "Appointment",
  "Benefit", "Fine", "Deed", "Will", "Quote",
]);

/** Words for the piece of paper rather than the thing it is about. These
 * decide only when nothing more specific is on the page. */
const PAPER = new Set(["Contract", "Bill", "Statement", "Certificate", "Record"]);

/**
 * The identifier tags that may carry this page's reference, best first.
 *
 * Every kind the page's own words support contributes the words its paper
 * uses, the thing-words before the paper-words, and the generic order fills
 * in behind. Nothing is dropped here: the list is a ranking, and what may
 * never be the answer at all is `extraction-reference-never.ts`.
 */
export function referencePreference(
  { kinds, qualifiers }: { kinds: ReadonlyArray<GroupBin>; qualifiers: ReadonlyArray<GroupBin> },
): IdentifierTag[] {
  const preference: IdentifierTag[] = [];
  const add = (tags: readonly IdentifierTag[] | undefined) => {
    for (const tag of tags ?? []) if (!preference.includes(tag)) preference.push(tag);
  };

  const things = kinds.filter(({ group }) => !PAPER.has(group));
  const paper = kinds.filter(({ group }) => PAPER.has(group));
  for (const { group } of [...things, ...paper]) {
    if (EVERY_PAGE.has(group)) continue;
    add(BY_KIND[group]);
  }
  for (const { group } of qualifiers) add(BY_QUALIFIER[group]);

  add(GENERIC_REFERENCE_PREFERENCE);
  return preference;
}
