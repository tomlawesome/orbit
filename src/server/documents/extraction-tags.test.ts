import { describe, expect, it } from "vitest";

import { assignContextRoles, type LocatedDate } from "./context-roles";
import { sieve, type CandidateKind } from "./extraction-sieve";
import { tagCandidates } from "./extraction-tags";
import { validateChecksumIdentifier } from "./reference-checksums";

const tagged = (text: string) => tagCandidates(text, sieve(text));

// The first candidate of `kind`, optionally the one with a given value --
// the sieve keeps several overlapping readings of the same words, and a test
// about tagging should say which one it means.
function candidate(text: string, kind: CandidateKind, value?: string) {
  const found = tagged(text).find(
    (c) => c.kind === kind && (value === undefined || c.value.startsWith(value)),
  );
  if (!found) throw new Error(`no ${kind} candidate ${value ?? ""} in: ${text}`);
  return found;
}

const tagValues = (text: string, kind: CandidateKind, value?: string) =>
  candidate(text, kind, value).tags.map((tag) => tag.value);

// Builds a `LocatedDate` the way `context-roles.test.ts` does, so a date's
// tag can be compared against the module it is supposed to come from.
function dateAt(text: string, needle: string): LocatedDate {
  return { value: needle, index: text.indexOf(needle), length: needle.length };
}

describe("a label beside the candidate", () => {
  it("reads a forward trigger for every kind", () => {
    expect(tagValues("Renewal premium £612.40", "amount")).toContain("total");
    expect(tagValues("Policy number MTR-8823-0145", "identifier")).toContain("policy");
    const insurer = "Underwritten by Meridian General Insurance Company plc";
    expect(tagValues(insurer, "organisation", "Meridian")).toContain("underwriter");
    expect(tagValues("Section 4 Making a claim", "heading")).toContain("section");
  });

  it("reads a backward trigger for every kind", () => {
    expect(tagValues("£51.03 each month", "amount")).toContain("instalment");
    expect(tagValues("MTR-8823-0145 is your policy number", "identifier")).toContain("policy");
    const admin = "Hartley Claims Services Ltd administers your policy";
    expect(tagValues(admin, "organisation", "Hartley")).toContain("administrator");
    expect(tagValues("Making a claim continued", "heading")).toContain("section");
  });

  it("quotes the words that justified the tag, verbatim", () => {
    const tag = candidate("Renewal premium £612.40", "amount").tags[0];
    expect(tag).toEqual({ value: "total", trigger: "Renewal premium", source: "label" });
  });

  it("lets the nearest trigger win when two scopes cover one candidate", () => {
    expect(tagValues("Total: last year you paid £588.10", "amount")).toEqual(["previous"]);
  });

  it("stops a scope at a termination term", () => {
    const text = "Amount due £120.00 but £95.00 was paid in error";
    expect(tagValues(text, "amount", "12000")).toEqual(["due"]);
    expect(tagValues(text, "amount", "9500")).toEqual(["other"]);
  });
});

describe("a candidate no trigger reaches", () => {
  it("falls back to the kind's `other` and says it has no trigger", () => {
    const tag = candidate("The figure of £42.00 appears at the foot", "amount").tags[0];
    expect(tag).toEqual({ value: "other", trigger: "", source: "label" });
  });
});

describe("the candidate's own shape", () => {
  it("tags a checksum-valid identifier as the organisation's own number", () => {
    // Constructed, not real: the first 7 digits are 1234567, whose weighted
    // sum is 112, so check digits 82 make the total 194 -- 2 x 97.
    expect(validateChecksumIdentifier("123456782")).toEqual({
      valid: true,
      kind: "gb-vat",
      normalized: "GB123456782",
    });
    const tags = candidate("VAT registration GB 123 4567 82", "identifier").tags;
    expect(tags).toContainEqual({ value: "company", trigger: "gb-vat", source: "shape" });
  });

  it("tags a letterhead as `other`, never as the provider", () => {
    const letterhead = "COLWORTH & DRAKE INSURANCE SERVICES LTD";
    const tags = candidate(letterhead, "organisation").tags;
    expect(tags).toContainEqual({ value: "other", trigger: letterhead, source: "shape" });
    expect(tags.map((tag) => tag.value)).not.toContain("provider");
  });

  it("calls the page's first short block its title and the rest sections", () => {
    const page = ["Motor Insurance Schedule", "Making a claim", "What is not covered"].join(" \n\n");
    const headings = tagged(page).filter((c) => c.kind === "heading");
    expect(headings.map((c) => c.tags.map((tag) => [tag.value, tag.source]))).toEqual([
      [["title", "shape"]],
      [["section", "shape"]],
      [["section", "shape"]],
    ]);
  });
});

describe("dates", () => {
  it("take their tag from the ConText roles module, with the trigger that won", () => {
    const text = "Renewal date: 1 October 2026. Cover starts 5 April 2025.";
    const dates = tagged(text).filter((c) => c.kind === "date");
    const roles = assignContextRoles(text, [dateAt(text, "1 October 2026"), dateAt(text, "5 April 2025")]);
    expect(dates.map((c) => c.tags.map((tag) => tag.value))).toEqual(roles.map((role) => [role]));
    expect(dates.map((c) => c.tags[0].trigger)).toEqual(["Renewal date", "Cover starts"]);
  });
});

describe("a label Tika put in a block of its own", () => {
  it("reaches forward across the block boundary to the value below it", () => {
    const council = "COUNCIL TAX ACCOUNT NUMBER \n\n8845612033";
    expect(tagValues(council, "identifier")).toContain("account");
    const warranty = "EXTENDED WARRANTY PRICE PAID \n\n£69.99 (inc. IPT)";
    expect(tagValues(warranty, "amount")).toContain("total");
  });

  it("reaches backward to the value above it", () => {
    const cover = ["Your current cover", "Roadside Assist", "£84.99", "per year"].join(" \n\n");
    const tag = candidate(cover, "amount").tags[0];
    expect(tag).toEqual({ value: "total", trigger: "per year", source: "label" });
  });

  it("stops at the first block below that holds a candidate of its kind", () => {
    const page = ["Policy number", "MTR-8823-0145", "Account number", "7724665018"].join(" \n\n");
    const identifiers = tagged(page).filter((c) => c.kind === "identifier");
    expect(identifiers.map((c) => [c.value, c.tags[0].value])).toEqual([
      ["MTR-8823-0145", "policy"],
      ["7724665018", "account"],
    ]);
  });

  it("trusts a bare one-word label only when it is the whole block", () => {
    expect(tagValues("Policy \n\nMTR-8823-0145", "identifier")).toEqual(["policy"]);
    expect(tagValues("Membership \n\nWX-4471-B", "identifier")).toEqual(["customer"]);
    expect(tagValues("Your policy covers item AB-12345 at home", "identifier")).toEqual(["other"]);
  });
});

describe("a date range", () => {
  const roles = (text: string) =>
    tagged(text)
      .filter((c) => c.kind === "date")
      .map((c) => c.tags[0].value);

  it("starts at the first date and expires at the second", () => {
    expect(roles("Current period of insurance 15 October 2025 to 15 October 2026")).toEqual([
      "start",
      "expiry",
    ]);
    expect(roles("Charge for the year 1 April 2026 to 31 March 2027")).toEqual(["start", "expiry"]);
    expect(roles("cover from 14 June 2026 until 13 June 2031")).toEqual(["start", "expiry"]);
  });

  it("gives way to a label that sits nearer than the connector", () => {
    expect(roles("15 October 2025 to 15 October 2026 is your renewal date")).toEqual([
      "start",
      "renewal",
    ]);
  });

  it("names the connector as the trigger", () => {
    const text = "Current period of insurance 15 October 2025 to 15 October 2026";
    const first = tagged(text).find((c) => c.kind === "date");
    expect(first?.tags[0]).toEqual({ value: "start", trigger: "to", source: "label" });
  });
});

describe("the stage's contract", () => {
  const page = [
    "Your motor insurance renewal",
    "COLWORTH & DRAKE INSURANCE SERVICES LTD",
    "Policy number MTR-8823-0145",
    "Renewal premium £612.40. Last year you paid £588.10.",
    "Renewal date: 15 October 2026",
  ].join(" \n\n");

  it("gives every candidate at least one tag and keeps the sieve's order", () => {
    const candidates = sieve(page);
    const result = tagCandidates(page, candidates);
    expect(result.map((c) => [c.kind, c.value])).toEqual(candidates.map((c) => [c.kind, c.value]));
    expect(result.every((c) => c.tags.length > 0)).toBe(true);
  });

  it("lets one candidate carry a label tag and a shape tag at once", () => {
    const tags = candidate("Our VAT number is GB 123 4567 82", "identifier").tags;
    expect(tags.map((tag) => tag.source)).toEqual(["label", "shape"]);
    expect(tags.map((tag) => tag.value)).toEqual(["company", "company"]);
  });
});
