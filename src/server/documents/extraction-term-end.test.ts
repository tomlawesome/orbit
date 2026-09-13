import { describe, expect, it } from "vitest";
import type { GroupBin } from "./extraction-subtype-bins";
import { termEndRole } from "./extraction-term-end";

const bin = (group: string): GroupBin => ({ group, count: 1, sources: [] });

describe("termEndRole", () => {
  it("renews when a renewing kind is best supported", () => {
    expect(termEndRole([bin("Insurance")], undefined)).toBe("renewal");
  });

  it("expires when a finite kind is best supported", () => {
    expect(termEndRole([bin("Warranty")], undefined)).toBe("expiry");
  });

  it("does not let a paper word outrank a finite thing ranked below it", () => {
    expect(termEndRole([bin("Contract"), bin("Loan")], undefined)).toBe("expiry");
  });

  it("renews when nothing decides but the page speaks of renewing", () => {
    expect(termEndRole([], "please renew before the date shown")).toBe("renewal");
  });

  it("expires when nothing decides and the page says nothing of renewing", () => {
    expect(termEndRole([], "your certificate is enclosed")).toBe("expiry");
  });

  it("expires when there is no text to read at all", () => {
    expect(termEndRole([], undefined)).toBe("expiry");
  });
});
