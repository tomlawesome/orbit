import { describe, expect, it } from "vitest";
import { findChecksumIdentifiers, validateChecksumIdentifier } from "@/server/documents/reference-checksums";

/**
 * Every number below is constructed by running the published check
 * arithmetic forward from arbitrary digits, exactly as
 * `reference-checksums.ts` does internally -- none is copied from a real
 * VAT registration, UTR, or any other real record. See that module's header
 * for why: #929, this test file must not be tuned against or copied from
 * the extraction corpora or any real registration data.
 *
 * `205884260` (lead `2058842` + check `60`) balances HMRC's *old* modulus-97
 * total. `123456727` (lead `1234567` + check `27`) balances only the *9755*
 * variant: the weighted total of `1234567` is 112, so the old-rule check
 * digit is 82, and the 9755 check digit is 82 - 55 = 27. Both were found by
 * solving the published arithmetic for a check value, not by guessing.
 */
describe("validateChecksumIdentifier: GB VAT", () => {
  it("accepts the old modulus-97 form spaced as GB nnn nnnn nn", () => {
    expect(validateChecksumIdentifier("GB 205 8842 60")).toEqual({
      valid: true,
      kind: "gb-vat",
      normalized: "GB205884260",
    });
  });

  it("accepts the same number concatenated with no spaces", () => {
    expect(validateChecksumIdentifier("GB205884260")).toEqual({
      valid: true,
      kind: "gb-vat",
      normalized: "GB205884260",
    });
  });

  it("accepts the bare digits with no GB prefix", () => {
    expect(validateChecksumIdentifier("205 8842 60")).toEqual({
      valid: true,
      kind: "gb-vat",
      normalized: "GB205884260",
    });
  });

  it("accepts a number valid only under the 9755 variant", () => {
    expect(validateChecksumIdentifier("GB 123 4567 27")).toEqual({
      valid: true,
      kind: "gb-vat",
      normalized: "GB123456727",
    });
  });

  it("accepts a branch/government-department suffixed 12-digit form", () => {
    expect(validateChecksumIdentifier("GB 205 8842 60 001")).toEqual({
      valid: true,
      kind: "gb-vat",
      normalized: "GB205884260001",
    });
  });

  it("rejects a valid-looking number with one digit changed", () => {
    // 205884261: same as the valid example above but the last digit is
    // wrong, so neither the old nor the 9755 total balances.
    expect(validateChecksumIdentifier("GB205884261")).toEqual({
      valid: false,
      kind: null,
      normalized: null,
    });
  });

  it("rejects a mutated 9755-only number", () => {
    expect(validateChecksumIdentifier("GB123456728")).toEqual({
      valid: false,
      kind: null,
      normalized: null,
    });
  });

  it("rejects a plausible sequential number that does not balance", () => {
    expect(validateChecksumIdentifier("GB123456789")).toEqual({
      valid: false,
      kind: null,
      normalized: null,
    });
  });
});

/**
 * `1097172564` (check digit `1` + reference `097172564`) and `9987654321`
 * (check digit `9` + reference `987654321`) both balance the published
 * weighted modulus-11 total. `1123456789` (check digit `1` + reference
 * `123456789`) exercises the table's one documented collision: its weighted
 * sum is 230, remainder 10, and the published table maps remainder 10 to
 * check digit `1` -- the same check digit remainder 1 maps to -- which is
 * part of the rule, not an implementation shortcut.
 */
describe("validateChecksumIdentifier: UTR", () => {
  it("accepts a constructed valid UTR", () => {
    expect(validateChecksumIdentifier("1097172564")).toEqual({
      valid: true,
      kind: "utr",
      normalized: "1097172564",
    });
  });

  it("accepts a UTR printed with the common 5+5 space grouping", () => {
    expect(validateChecksumIdentifier("10971 72564")).toEqual({
      valid: true,
      kind: "utr",
      normalized: "1097172564",
    });
  });

  it("accepts a second constructed valid UTR", () => {
    expect(validateChecksumIdentifier("9987654321")).toEqual({
      valid: true,
      kind: "utr",
      normalized: "9987654321",
    });
  });

  it("accepts the remainder-10/remainder-1 collision case", () => {
    expect(validateChecksumIdentifier("1123456789")).toEqual({
      valid: true,
      kind: "utr",
      normalized: "1123456789",
    });
  });

  it("rejects the same digits with the check digit changed", () => {
    expect(validateChecksumIdentifier("2097172564")).toEqual({
      valid: false,
      kind: null,
      normalized: null,
    });
  });

  it("rejects the same digits with a reference digit changed", () => {
    expect(validateChecksumIdentifier("1097172554")).toEqual({
      valid: false,
      kind: null,
      normalized: null,
    });
  });

  it("never reads a GB-prefixed run of digits as a UTR", () => {
    // 10 digits after a GB prefix is not a shape either rule defines.
    expect(validateChecksumIdentifier("GB1097172564")).toEqual({
      valid: false,
      kind: null,
      normalized: null,
    });
  });
});

describe("validateChecksumIdentifier: general rejection", () => {
  it("rejects the empty string", () => {
    expect(validateChecksumIdentifier("").valid).toBe(false);
  });

  it("rejects non-digit garbage", () => {
    expect(validateChecksumIdentifier("not-a-reference").valid).toBe(false);
  });

  it("rejects a digit run of a length neither rule defines", () => {
    expect(validateChecksumIdentifier("12345678").valid).toBe(false); // 8 digits
    expect(validateChecksumIdentifier("123456789012345").valid).toBe(false); // 15 digits
  });
});

describe("findChecksumIdentifiers", () => {
  it("finds a GB VAT number regardless of which provider name introduces it", () => {
    const text =
      "Northfield Gas & Energy Ltd (VAT reg. GB 205 8842 60) " +
      "trading as NORTHFIELD GAS.";
    const matches = findChecksumIdentifiers(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      kind: "gb-vat",
      raw: "GB 205 8842 60",
      normalized: "GB205884260",
    });
    expect(text.slice(matches[0].start, matches[0].end)).toBe("GB 205 8842 60");
  });

  it("finds the same provider fingerprint printed two different ways in one document", () => {
    const text = "Supplier: Northfield Gas & Energy Ltd. VAT number 205884260. " +
      "Registered office details overleaf. VAT: GB205884260.";
    const matches = findChecksumIdentifiers(text);
    expect(matches.map((m) => m.normalized)).toEqual(["GB205884260", "GB205884260"]);
  });

  it("finds a UTR alongside a VAT number in the same text", () => {
    const text = "UTR 1097172564, VAT GB205884260";
    const matches = findChecksumIdentifiers(text);
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ kind: "utr", normalized: "1097172564" });
    expect(matches[1]).toMatchObject({ kind: "gb-vat", normalized: "GB205884260" });
  });

  it("does not report a checksum-invalid decoy that merely looks like a VAT number", () => {
    const text = "Invoice number 205884261 is now overdue.";
    expect(findChecksumIdentifiers(text)).toHaveLength(0);
  });

  it("does not report a valid substring embedded inside a longer digit run", () => {
    // 205884260 (valid on its own) sits inside a 14-digit account number here;
    // it must not be pulled out and reported as a VAT number.
    const text = "Account 12205884260999 was charged.";
    expect(findChecksumIdentifiers(text)).toHaveLength(0);
  });

  it("returns no matches for text with no identifiers at all", () => {
    expect(findChecksumIdentifiers("Thank you for your custom.")).toHaveLength(0);
  });
});
