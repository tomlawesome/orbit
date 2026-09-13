import { describe, expect, it } from "vitest";
import { neverTheReference, neverTheReferenceShape } from "./extraction-reference-never";
import type { Tag } from "./extraction-stages";

const tag = (
  value: Tag<"identifier">["value"],
  trigger = "",
  source: "label" | "shape" = "label",
): Tag<"identifier"> => ({ value, trigger, source });

/** What a shape rule is shown: the page either side of the number. */
const around = (before: string, after: string) => ({ before, after });

describe("neverTheReference", () => {
  it("drops a number the page labelled as somebody else's", () => {
    expect(neverTheReference([tag("company", "VAT registration")])).toBe(true);
    expect(neverTheReference([tag("phone", "Telephone")])).toBe(true);
    expect(neverTheReference([tag("bank", "Sort code")])).toBe(true);
    expect(neverTheReference([tag("product", "Promo code")])).toBe(true);
  });

  it("keeps the numbers that can be the household's own", () => {
    expect(neverTheReference([tag("policy", "Policy number")])).toBe(false);
    expect(neverTheReference([tag("other", "")])).toBe(false);
  });

  it("drops a labelled number whatever else the page called it", () => {
    // "Call us on 0345 900 2277 quoting your reference" labels one number
    // twice; the telephone shape is the one that settles it.
    expect(neverTheReference([tag("reference", "reference"), tag("phone", "0345 900 2277", "shape")]))
      .toBe(true);
  });

  it("lets a label overrule check arithmetic, which passes by chance", () => {
    // Roughly one ten-digit number in eleven balances as a UTR, so an
    // account number the page named in so many words keeps its label.
    expect(neverTheReference([tag("account", "Account number"), tag("company", "utr", "shape")]))
      .toBe(false);
    // Nothing spoke for this one, so the arithmetic stands.
    expect(neverTheReference([tag("other", ""), tag("company", "utr", "shape")])).toBe(true);
  });
});

describe("neverTheReferenceShape", () => {
  it("reads a telephone number off its own shape", () => {
    expect(neverTheReferenceShape("0345 900 2277", "call us on 0345 900 2277", around("on ", "0345 900 2277."))
      ?.value).toBe("phone");
    expect(neverTheReferenceShape("07700", "Mobile 07700 900412", around("Mobile ", "07700 900412"))
      ?.value).toBe("phone");
    expect(neverTheReferenceShape("0800", "0800 023 4567", around("", "0800 023 4567"))?.value).toBe("phone");
  });

  it("does not read an account number as a telephone number", () => {
    // Ten digits, but no leading zero: an account number, not a number to
    // dial.
    expect(neverTheReferenceShape("7719 0042 18", "account 7719 0042 18", around("account ", "7719 0042 18")))
      .toBeUndefined();
    // Eight digits is a company registration's length, not a dialled one.
    expect(neverTheReferenceShape("07741932", "No. 07741932", around("No. ", "07741932 ")))
      .toBeUndefined();
  });

  it("reads bank details off the pair a payment slip always prints", () => {
    expect(neverTheReferenceShape("30-92-14", "Sort code 30-92-14", around("", "30-92-14"))?.value)
      .toBe("bank");
    expect(neverTheReferenceShape("60451188", "Account number: 60451188 Sort code: 20-44-71",
      around("", "60451188"))?.value).toBe("bank");
  });

  it("leaves an eight-digit number alone where no sort code sits beside it", () => {
    expect(neverTheReferenceShape("68104472", "Council Tax account 68104472", around("account ", "68104472")))
      .toBeUndefined();
  });

  it("reads a number printed inside an address as part of the address", () => {
    expect(neverTheReferenceShape("PASS2DRIVE", "bookings@pass2drive.example",
      around("bookings@", "PASS2DRIVE.example"))?.value).toBe("web");
    expect(neverTheReferenceShape("ACCOUNT123", "my.bellrush.co.uk/ACCOUNT123",
      around("my.bellrush.co.uk/", "ACCOUNT123"))?.value).toBe("web");
  });

  it("reads a sheet number off the words that number sheets", () => {
    expect(neverTheReferenceShape("3", "Page 3 of 12", around("Page ", "3 of 12"))?.value).toBe("page");
  });

  it("reads a printed date, which the identifier sieve also matches", () => {
    expect(neverTheReferenceShape("02/06/2026", "Date of this Agreement 02/06/2026",
      around("Agreement ", "02/06/2026"))?.value).toBe("date");
    expect(neverTheReferenceShape("2026-04-17", "Issued 2026-04-17", around("Issued ", "2026-04-17"))?.value)
      .toBe("date");
    // A reference that merely starts with a year is not a date.
    expect(neverTheReferenceShape("2026-04417", "Job number 2026-04417", around("number ", "2026-04417")))
      .toBeUndefined();
  });

  it("says nothing about an ordinary reference", () => {
    expect(neverTheReferenceShape("MTR-8823-0145", "Policy number MTR-8823-0145",
      around("Policy number ", "MTR-8823-0145"))).toBeUndefined();
  });
});
