import { describe, expect, it } from "vitest";
import type { GroupBin } from "./extraction-subtype-bins";
import { termEndRole } from "./extraction-term-end";

const bin = (group: string): GroupBin =>
  ({ group, count: 1, places: { title: 0, heading: 0, body: 1 }, sources: [] });
const kinds = (...groups: string[]) => ({ kinds: groups.map(bin), qualifiers: [] });

describe("termEndRole", () => {
  it("renews when a renewing kind is best supported", () => {
    expect(termEndRole(kinds("Insurance"), undefined)).toBe("renewal");
  });

  it("expires when a finite kind is best supported", () => {
    expect(termEndRole(kinds("Warranty"), undefined)).toBe("expiry");
  });

  it("does not let a paper word outrank a finite thing ranked below it", () => {
    expect(termEndRole(kinds("Contract", "Loan"), undefined)).toBe("expiry");
  });

  it("renews when nothing decides but the page speaks of renewing", () => {
    expect(termEndRole(kinds(), "please renew before the date shown")).toBe("renewal");
  });

  it("expires when nothing decides and the page says nothing of renewing", () => {
    expect(termEndRole(kinds(), "your certificate is enclosed")).toBe("expiry");
  });

  it("expires when there is no text to read at all", () => {
    expect(termEndRole(kinds(), undefined)).toBe("expiry");
  });

  it("decides every kind that bounds a term, not just the common ones", () => {
    expect(termEndRole(kinds("Identity document"), undefined)).toBe("renewal");
    expect(termEndRole(kinds("Benefit"), undefined)).toBe("renewal");
    expect(termEndRole(kinds("Savings"), undefined)).toBe("expiry");
    expect(termEndRole(kinds("Prescription"), undefined)).toBe("expiry");
    expect(termEndRole(kinds("Fine"), undefined)).toBe("expiry");
  });

  it("leaves a kind with no term of its own to the wording", () => {
    expect(termEndRole(kinds("Pension"), "reviewed annually")).toBe("renewal");
    expect(termEndRole(kinds("Bank account"), "the bond matures on the date shown")).toBe("expiry");
  });

  it("does not let a word every page uses decide against the thing the page is about", () => {
    // An insurance schedule says "claim" more often than "insurance".
    expect(termEndRole(kinds("Claim", "Insurance"), undefined)).toBe("renewal");
    // A certificate's end is a visit, which the date sieve names itself.
    expect(termEndRole(kinds("Certificate"), "valid for ten years")).toBe("expiry");
  });

  it("renews on a cycle word when the kind is unknown", () => {
    expect(termEndRole(kinds(), "billed every 12 months at the price shown")).toBe("renewal");
    expect(termEndRole(kinds(), "a rolling agreement charged per month")).toBe("renewal");
  });

  it("expires when the wording speaks more of an end than of a cycle", () => {
    expect(termEndRole(kinds(), "this warranty renews nothing: one-off cover, final payment made")).toBe("expiry");
  });
});
