// Numbers that are never the household's reference, whatever else the page
// says about them.
//
// A real page carries far more numbers than the one the household is told to
// quote: the organisation's VAT and company registration, its FCA firm
// reference, the telephone number, the bank details it wants paying into, a
// product or promotion code, "page 3 of 12", and whatever sits inside a web
// address or an e-mail address. Ranking those low is not enough. A page that
// prints no other labelled number gives the lowest-ranked candidate the win,
// and a confident wrong value costs twice a blank -- so stage 3 drops them
// rather than ranking them (owner's rule, #939).
//
// Nothing is dropped from the tags. Every one of these numbers still comes
// back from stage 2 as an `identifier` carrying the tag that says why it is
// out, so the `--candidates` bundle still shows the page as it was read; it
// is `referenceShortlistEntries` and `chooseReference` that refuse to
// consider them.

import type { IdentifierTag, Tag } from "./extraction-stages";

/**
 * Tags that put a number out of the running for the household's reference.
 *
 * `company` is the organisation's own registration (VAT, company number, FCA
 * firm reference, UTR); `phone` a telephone or fax number; `bank` the
 * details a payment is sent to -- a sort code, the account behind it, a
 * direct-debit originator; `product` a model, catalogue or promotion code;
 * `page` a sheet number; `web` a number printed inside an address rather
 * than beside a label; `date` a printed date the identifier sieve matched
 * because it is digits and separators ("02/06/2026"), which the dates field
 * already has and the reference field must never take.
 */
export const NEVER_THE_REFERENCE: readonly IdentifierTag[] =
  ["company", "phone", "bank", "product", "page", "web", "date"];

/** The tags that can carry a reference, in any order: what "the page did
 * label this as the household's number" means below. */
const CAN_BE_THE_REFERENCE: readonly IdentifierTag[] =
  ["reference", "certificate", "policy", "agreement", "account", "customer", "invoice"];

/**
 * Whether stage 3 must not consider this number as the reference.
 *
 * A reason the page gave in words -- "VAT number", "Sort code", "Telephone"
 * -- settles it outright. A reason read off the number's own shape settles
 * it too, with one exception: the UTR and VAT check arithmetic passes by
 * chance often enough (roughly one ten-digit number in eleven balances as a
 * UTR) that a number the page also labelled as the household's own keeps its
 * label. Nothing else is that weak: a run of digits printed as a telephone
 * number is one however the words around it read, because "call us on
 * 0345 900 2277 quoting your reference" is how a page prints both at once.
 */
export function neverTheReference(tags: readonly Tag<"identifier">[]): boolean {
  const labelled = tags.some((tag) => CAN_BE_THE_REFERENCE.includes(tag.value));
  return tags.some((tag) =>
    NEVER_THE_REFERENCE.includes(tag.value) &&
    !(tag.value === "company" && tag.source === "shape" && labelled));
}

/** The text a shape rule reads: what the page printed either side of the
 * number, a few dozen characters, never the page. */
export interface PrintedAround {
  /** The characters immediately before the number, in page order. */
  before: string;
  /** The number as printed, and what follows it. */
  after: string;
}

/** The unbroken run of non-space characters the number sits in: a bare
 * number is its own run, and one inside an address carries the address. */
function printedToken({ before, after }: PrintedAround): string {
  return `${/\S*$/u.exec(before)?.[0] ?? ""}${/^\S*/u.exec(after)?.[0] ?? ""}`;
}

/** An address the number is printed inside rather than beside: an e-mail
 * address, a link, or a bare domain with a path. */
const INSIDE_AN_ADDRESS = /@|:\/\/|\bwww\.|[A-Za-z0-9-]\.[A-Za-z]{2,}(?:[/?#]|$)/u;

/** A telephone number as these islands print one: a leading zero or an
 * international prefix, then ten or eleven digits however the page groups
 * them. Length is what makes it a telephone number rather than an account
 * number, and the leading zero is what keeps an account number out. */
const DIALLED = /^(?:\+44\s?\(?0?\)?\s?|00\s?44\s?|0)[\d\s()-]{7,16}/u;

/** Sort code, as printed on every payment slip in the country. */
const SORT_CODE = /^\d{2}-\d{2}-\d{2}$/u;
const SORT_CODE_ANYWHERE = /\b\d{2}-\d{2}-\d{2}\b/u;

/** The account a sort code belongs to: eight digits, printed in the same
 * block as the code. Bank details are always printed as the pair. */
const BANK_ACCOUNT_DIGITS = /^\d{8}$/u;

/** A printed date, which the identifier sieve matches because a date is
 * digits with separators between them. Both orders and both separators,
 * with the month and day held to real values so that a reference shaped
 * like "2026-04417" is not mistaken for one. */
const PRINTED_DATE =
  /^(?:(?:0?[1-9]|[12]\d|3[01])[/.-](?:0?[1-9]|1[0-2])[/.-](?:\d{2}|\d{4})|\d{4}[/.-](?:0?[1-9]|1[0-2])[/.-](?:0?[1-9]|[12]\d|3[01]))$/u;

/** "Page 3 of 12", "Sheet 2 of 4". */
const NUMBERED_SHEET = /\b(?:page|sheet|p\.)\s*$/iu;
const OF_SO_MANY = /^\d{1,3}\s+of\s+\d{1,3}\b/iu;

function digitsIn(value: string): string {
  return value.replace(/\D/gu, "");
}

/**
 * What the number's own form says it is, where that is a reason it can never
 * be the reference -- or nothing, which is the usual answer.
 *
 * Read off the characters around it rather than the words, because these are
 * facts about the number: a telephone number has a shape, a sort code has a
 * shape, and a number inside an e-mail address is part of the address.
 */
export function neverTheReferenceShape(
  value: string,
  line: string,
  around: PrintedAround,
): Tag<"identifier"> | undefined {
  if (PRINTED_DATE.test(value.trim())) {
    return { value: "date", trigger: value, source: "shape" };
  }
  const token = printedToken(around);
  if (INSIDE_AN_ADDRESS.test(token)) {
    return { value: "web", trigger: token.slice(0, 60), source: "shape" };
  }
  if (NUMBERED_SHEET.test(around.before) && OF_SO_MANY.test(around.after)) {
    return { value: "page", trigger: around.after.slice(0, 20), source: "shape" };
  }
  const dialled = DIALLED.exec(around.after)?.[0] ?? "";
  const dialledDigits = digitsIn(dialled).replace(/^(?:0044|44)/u, "0");
  if (dialledDigits.length >= 10 && dialledDigits.length <= 11 && dialledDigits.startsWith("0")) {
    return { value: "phone", trigger: dialled.trim().slice(0, 24), source: "shape" };
  }
  if (SORT_CODE.test(value)) {
    return { value: "bank", trigger: value, source: "shape" };
  }
  if (BANK_ACCOUNT_DIGITS.test(value.replace(/\s/gu, "")) && SORT_CODE_ANYWHERE.test(line)) {
    return { value: "bank", trigger: SORT_CODE_ANYWHERE.exec(line)?.[0] ?? "", source: "shape" };
  }
  return undefined;
}
