import { describe, expect, it } from "vitest";

import { pageBlocks, sieve } from "./extraction-sieve";

const PAGE = [
  "Your motor insurance renewal — policy MTR-8823-0145",
  "COLWORTH & DRAKE INSURANCE SERVICES LTD",
  "Underwritten by Meridian General Insurance Company plc · arranged by Colworth & Drake Insurance Services Ltd",
  "Policy number MTR-8823-0145",
  "Account number: 7724 6650 18",
  "Renewal premium £612.40 including insurance premium tax. Last year you paid £588.10.",
  "Current period of insurance 15 October 2025 to 15 October 2026. Please reply by 24 September 2026.",
  "Page 1 of 3",
].join(" \n\n");

const of = (kind: string) => sieve(PAGE).filter((c) => c.kind === kind);

describe("the sieve keeps every candidate and chooses nothing", () => {
  it("splits Tika output into blocks with whitespace collapsed", () => {
    expect(pageBlocks(" a  b \n\n\n c\n").map((b) => b.line)).toEqual(["a b", "c"]);
  });

  it("finds every date, uncapped, in page order", () => {
    expect(of("date").map((c) => c.value)).toEqual(["2025-10-15", "2026-10-15", "2026-09-24"]);
  });

  it("finds every amount in minor units with its currency, and skips bare integers", () => {
    expect(of("amount").map((c) => [c.value, c.currency])).toEqual([
      ["61240", "GBP"],
      ["58810", "GBP"],
    ]);
  });

  it("finds identifiers, including spaced digit groups compared without the spaces", () => {
    const values = of("identifier").map((c) => c.value);
    expect(values).toContain("MTR-8823-0145");
    expect(values).toContain("7724665018");
  });

  it("finds every organisation named, whether in a letterhead, prose or capitals", () => {
    const values = of("organisation").map((c) => c.value);
    expect(values).toContain("COLWORTH & DRAKE INSURANCE SERVICES LTD");
    expect(values).toContain("Meridian General Insurance Company plc");
    expect(values).toContain("Colworth & Drake Insurance Services Ltd");
  });

  it("does not let a title-case line above the letterhead run into the name", () => {
    const text = "Some Heading Line \n\nHighways and Vehicle Licensing Authority Executive agency for vehicles";
    const values = sieve(text).filter((c) => c.kind === "organisation").map((c) => c.value);
    expect(values).toContain("Highways and Vehicle Licensing Authority");
  });

  it("treats short unpunctuated blocks as headings and attaches the block to every candidate", () => {
    expect(of("heading").map((c) => c.value)).toContain("Policy number MTR-8823-0145");
    const premium = of("amount")[0];
    expect(premium.line).toBe("Renewal premium £612.40 including insurance premium tax. Last year you paid £588.10.");
  });
});
