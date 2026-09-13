// Extraction evaluation corpus (issue #319): synthetic but representative
// household documents, as the text layer a parser would emit, with the
// fields a correct extraction should find. Accuracy against this corpus is
// the measured number behind every extraction change — heuristic, parser,
// or model. Add documents freely; never tune a fixture to make a parser
// look better.

import type { DocumentDateRole } from "./suggestions";
import type { ScheduleKind } from "@/lib/domain";
import { FULL_PAGE_CORPUS } from "./extraction-corpus-fullpage";

/** Ground truth for `subtype` naming taxonomy groups by NAME rather than
 * literal phrases (owner decision 2026-09-11, #989). `qualifiers` is
 * optional: a kind can be declared on its own. */
export interface SubtypeSpec {
  kinds: string[];
  qualifiers?: string[];
}

export interface CorpusExpectation {
  // ISO dates that a correct extraction should surface (order-free).
  dates: string[];
  provider?: string;
  reference?: string;
  // --- The rest is the contract ADR-0025 section 7 gives the model path
  // (issue #960). The heuristics never attempt any of it, by the owner's
  // decision on #319, so every one of these is a blank for `proposalFromText`
  // — that is the measurement, not a defect.
  //
  // Ground truth here is what a careful human reading the page would say,
  // and it is declared only where the page actually says it. Two rules keep
  // it from asking for something the design forbids producing:
  //
  //  - a `costMinor` is declared only where the amount is plainly THE cost of
  //    the thing (a premium, a total due, the monthly price) AND its line
  //    carries a currency symbol or code. A sum insured, an excess, an exit
  //    fee or a balance is not the cost, and a page with several rival
  //    amounts is left undeclared rather than guessed at.
  //  - a `recurrenceMonths` is declared only where the page prints the month
  //    count in DIGITS (the grounding rule needs them in the evidence span)
  //    and the item has a scheduled date to repeat. "Annual", "twelve-month"
  //    and "each month" therefore declare nothing.
  //
  // Every date carries a role naming what kind of date it is, regardless of
  // whether it has already happened: a service date is a service date
  // whether the engineer came last year or comes next year. Choosing which
  // of them becomes the item's scheduled event is the application's job, not
  // the label's.
  //
  // Known thin spot: exactly one of the 36 documents states a recurrence in
  // a form the contract can produce (the gas safety record's "within 12
  // months"), so `recurrence` is measured on a single point. Household
  // paperwork mostly writes "annual" or "twelve-month" in words, which the
  // digits-in-the-span rule refuses on purpose. The fix is more documents,
  // not a looser rule — a document that prints its interval in digits is
  // welcome here.
  /** One role per expected date, in the order the document prints them. */
  dateRoles?: Array<{ date: string; role: DocumentDateRole }>;
  /** What kind of thing the page is. The accepted answers come from the
   * generic taxonomy in `subtype-taxonomy.json`, not a per-page list (owner
   * decision 2026-09-11, #989): ground truth names taxonomy KIND and
   * QUALIFIER groups, and `subtypeAnswers` in `extraction-scoring.ts`
   * expands them into every phrase the taxonomy's combination rules accept.
   * The older plain string or array of literal phrases is still accepted
   * (#989/#992), matched exactly rather than expanded. */
  subtype?: string | string[] | SubtypeSpec;
  /** Minor units. Always declared together with `currency`, never alone. */
  costMinor?: number;
  currency?: string;
  /** Declared only when `costMinor` is never printed: a fixed-term contract's
   * cost is everything paid over its term (owner, 2026-09-13), and some pages
   * print the monthly price and the term but never the product. Each
   * `[minor, months]` pair's price must be printed, its months (or the whole
   * term) must be printed, and the products must sum to `costMinor`;
   * `scripts/corpus/verify.mjs` and `four-field-contract.test.ts` both check. */
  costArithmetic?: ReadonlyArray<readonly [minor: number, months: number]>;
  recurrenceMonths?: number;
  /** Derived from the roles above; the model never emits it. */
  scheduleKind?: ScheduleKind;
}

export interface CorpusDocument {
  name: string;
  filename: string;
  text: string;
  expected: CorpusExpectation;
}

// The 48 full-page documents live in their own generated module, because
// their text is Tika's real output and is regenerated from the source HTML
// rather than written here. They are part of this corpus, not a separate
// one: every measurement reads `EXTRACTION_CORPUS`. The 48 is 24 original
// full-page documents (#981, #986) plus hold-outs 1 and 2 (#986 step 8,
// #997), twelve documents each, both spent and rolled into the tuning set
// on 2026-09-12 (#996, #998) rather than replaced. Their generated modules
// (`extraction-holdout-fullpage.ts`, `extraction-holdout2-fullpage.ts`) are
// gone; hold-out 3 (#998) is the only unseen set now, scored separately from
// `src/server/documents/extraction-holdout3-fullpage.ts` and never imported
// here.
// The thirty-six short documents that used to live here are gone (owner,
// 2026-09-11): *"The short documents are a pointless accuracy floor. There is
// no accuracy floor. The short documents are a spoon fed result and we should
// just disregard them from now."*
//
// They averaged 294 characters, and 76 of their 77 date-like strings were
// answers, so "find the dates" and "find the right dates" were the same task
// (#981). The heuristics were tuned against them twice (#929), which made
// every number they produced a measure of "handles these thirty-six", not of
// accuracy. Deleting them is the point: a spoon-fed number left in the
// repository gets quoted again.
//
// They remain in git history if a comparison ever needs them.
export const EXTRACTION_CORPUS: CorpusDocument[] = [...FULL_PAGE_CORPUS];
