/**
 * Checksum-valid UK reference numbers, #980.
 *
 * A provider name varies -- `Northfield Gas & Energy Ltd`, `NORTHFIELD GAS`,
 * `Northfield Gas & Energy` are all the same provider, spelled three ways a
 * naive matcher has to reconcile. A checksum-valid GB VAT number does not
 * vary: either the digits satisfy the published check rule or they do not,
 * and when they do, the number is a far stronger fingerprint for "this is
 * the same provider" than any string comparison over names can be.
 *
 * Two jobs live here: validate a single candidate string against the known
 * check rules, and scan a block of document text for every substring that is
 * checksum-valid under one of them.
 *
 * ## Where these rules came from
 *
 * The check rules implemented below -- HMRC's modulus-97 rule for GB VAT
 * registration numbers (including the "9755" variant used for numbers
 * issued after the original 97-based range filled up) and the weighted
 * modulus-11 rule for the Unique Taxpayer Reference -- are published
 * specifications: facts about how a government body forms and checks a
 * number, not anyone's copyrightable expression. They are implemented here
 * directly from that published arithmetic.
 *
 * A prior survey of existing implementations turned up `python-stdnum`
 * (https://github.com/arthurdejong/python-stdnum, LGPL-licensed) as a place
 * these algorithms are named and collected. That project's source was not
 * read or copied for this module -- LGPL terms and this codebase's licence
 * position do not mix -- but it is credited here as the survey source that
 * pointed at "GB VAT modulus 97" and "UTR modulus 11" as the identifiers
 * worth implementing.
 *
 * ## Every test number in the companion test file is constructed
 *
 * No real VAT number, UTR, or other registration appears anywhere near this
 * module. Test fixtures are built by running the check arithmetic forward
 * from arbitrary digits until it balances, exactly as this module's own
 * functions do, and are commented as constructed at their use site.
 */

/** The identifier kinds this module knows how to checksum-validate. */
export type ChecksumIdentifierKind = "gb-vat" | "utr";

/** The result of validating one candidate string. */
export interface ChecksumValidation {
  valid: boolean;
  kind: ChecksumIdentifierKind | null;
  /** The canonical digit form (VAT: `GB` + 9 or 12 digits; UTR: 10 digits). */
  normalized: string | null;
}

/** One checksum-valid identifier found while scanning free text. */
export interface ChecksumMatch {
  kind: ChecksumIdentifierKind;
  /** The exact substring matched, spacing and all. */
  raw: string;
  normalized: string;
  /** Offsets into the scanned text, end exclusive. */
  start: number;
  end: number;
}

/**
 * HMRC's GB VAT modulus-97 weights, applied to the first 7 of the 9 core
 * digits. The last 2 of the 9 are the check digits, added to the weighted
 * sum as a two-digit number.
 */
const VAT_WEIGHTS = [8, 7, 6, 5, 4, 3, 2];

function floorMod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/**
 * True when `nineDigits` (exactly 9 digits, no separators) satisfies either
 * of HMRC's two published GB VAT checks.
 *
 * The "old" check: multiply the first 7 digits by 8,7,6,5,4,3,2, sum the
 * products, add the last 2 digits as a number, and require the total to be
 * divisible by 97.
 *
 * The "9755" check: the same total **plus 55** must be divisible by 97. The
 * rule is described as "add 55, then subtract 97 until the result is zero or
 * negative, and the check digits are what is left". Equivalently, a 9755
 * check digit is the old-style check digit minus 55, modulo 97 -- which is
 * where the name comes from. The sign matters: plus 55 and minus 55 accept
 * disjoint sets of numbers, so getting it backwards rejects every genuine
 * modern registration while accepting a different, wrong set.
 *
 * This covers numbers issued once the straightforward range was exhausted.
 * A candidate is accepted if either rule balances.
 */
function gbVatChecksumValid(nineDigits: string): boolean {
  const digits = nineDigits.split("").map(Number);
  const weightedSum = VAT_WEIGHTS.reduce((sum, weight, i) => sum + weight * digits[i], 0);
  const checkValue = digits[7] * 10 + digits[8];
  const total = weightedSum + checkValue;
  return floorMod(total, 97) === 0 || floorMod(total + 55, 97) === 0;
}

/**
 * The UTR's published weighted modulus-11 check. The first of the 10 digits
 * is the check digit; the remaining 9 are weighted 6,7,8,9,10,5,4,3,2 in
 * order, summed, and taken modulo 11. That remainder is looked up in the
 * published table below to get the expected check digit.
 *
 * The table has 11 entries for a remainder that can be 0..10 but only 10
 * possible check digits, so two remainders (0 and 10) share a check digit --
 * that collision is part of the published rule, not a bug in this table.
 */
const UTR_WEIGHTS = [6, 7, 8, 9, 10, 5, 4, 3, 2];
const UTR_CHECK_DIGIT_BY_REMAINDER = [2, 1, 9, 8, 7, 6, 5, 4, 3, 2, 1];

function utrChecksumValid(tenDigits: string): boolean {
  const digits = tenDigits.split("").map(Number);
  const checkDigit = digits[0];
  const weightedSum = UTR_WEIGHTS.reduce((sum, weight, i) => sum + weight * digits[i + 1], 0);
  return UTR_CHECK_DIGIT_BY_REMAINDER[weightedSum % 11] === checkDigit;
}

/**
 * Classifies an already-normalized digit string (no spaces, no `GB`
 * prefix) as a checksum-valid identifier, or returns null.
 *
 * `allowUtr` is false when the caller has already stripped a `GB` prefix --
 * a GB-prefixed run of digits is never a UTR, whatever its length.
 */
function classifyDigits(
  digits: string,
  allowUtr: boolean,
): { kind: ChecksumIdentifierKind; normalized: string } | null {
  if ((digits.length === 9 || digits.length === 12) && gbVatChecksumValid(digits.slice(0, 9))) {
    // The 12-digit form is the 9-digit number plus a 3-digit branch/division
    // suffix (used by, among others, government departments with multiple
    // registrations). The suffix carries no checksum of its own; only the
    // leading 9 digits are checked.
    return { kind: "gb-vat", normalized: `GB${digits}` };
  }
  if (allowUtr && digits.length === 10 && utrChecksumValid(digits)) {
    return { kind: "utr", normalized: digits };
  }
  return null;
}

/**
 * Validates a single candidate string and reports what kind of
 * checksum-valid identifier it is, if any.
 *
 * Accepts the common printed forms: an optional leading `GB` (with or
 * without a following space), and digits grouped with single spaces however
 * a document happens to print them -- `GB 205 8842 10`, `GB205884210`,
 * `205 8842 10` all normalize to the same thing before the checksum runs.
 */
export function validateChecksumIdentifier(candidate: string): ChecksumValidation {
  const noSpaces = candidate.trim().replace(/\s+/gu, "");
  const hasGbPrefix = /^gb/iu.test(noSpaces);
  const digits = hasGbPrefix ? noSpaces.slice(2) : noSpaces;

  if (digits.length === 0 || !/^\d+$/u.test(digits)) {
    return { valid: false, kind: null, normalized: null };
  }

  const classified = classifyDigits(digits, !hasGbPrefix);
  if (!classified) return { valid: false, kind: null, normalized: null };
  return { valid: true, ...classified };
}

/**
 * A candidate span in free text: an optional `GB` prefix followed by digits
 * and single interior spaces, bounded so it cannot be a substring of a
 * longer digit run or an alphanumeric code (`(?<![\w-])` / `(?![\w-])`
 * refuse to start or end next to a letter, digit or hyphen).
 *
 * The length bound (6 to 14 characters after the first digit) covers the 9
 * and 12-digit VAT forms and the 10-digit UTR form, with up to 3 single
 * spaces of grouping.
 */
const CANDIDATE_SPAN = /(?<![\w-])(?:GB\s?)?\d[\d ]{5,14}\d(?![\w-])/giu;

/**
 * Scans `text` for every checksum-valid identifier it contains, in order of
 * appearance. Only checksum-valid matches are returned -- an ordinary
 * 9-digit invoice number that happens not to satisfy the VAT rule is not a
 * false positive here, because it is simply never reported.
 *
 * Overlapping candidate spans are not produced by `CANDIDATE_SPAN` (the
 * regex is greedy and boundary-anchored), so no de-duplication step is
 * needed beyond what the regex already guarantees.
 */
export function findChecksumIdentifiers(text: string): ChecksumMatch[] {
  const matches: ChecksumMatch[] = [];

  for (const match of text.matchAll(CANDIDATE_SPAN)) {
    const raw = match[0];
    // Double-spaced or irregularly spaced runs are not a document's way of
    // printing one of these identifiers; skip rather than guess.
    if (/ {2,}/u.test(raw)) continue;

    const hasGbPrefix = /^gb/iu.test(raw);
    const digits = (hasGbPrefix ? raw.slice(2) : raw).replace(/\s+/gu, "");
    if (!/^\d+$/u.test(digits)) continue;

    const classified = classifyDigits(digits, !hasGbPrefix);
    if (!classified) continue;

    matches.push({
      kind: classified.kind,
      raw,
      normalized: classified.normalized,
      start: match.index,
      end: match.index + raw.length,
    });
  }

  return matches;
}
