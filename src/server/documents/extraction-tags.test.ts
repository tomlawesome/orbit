import { describe, expect, it } from "vitest";

import { assignContextRoles, type LocatedDate } from "./context-roles";
import { sieve, type CandidateKind } from "./extraction-sieve";
import { STRENGTH_WEAK } from "./extraction-stages";
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

  it("names the brand in front of a trading-name sentence, and the parent behind it", () => {
    const line = "Fenwick Mobile is a trading name of Anglia Communications Networks Ltd";
    expect(tagValues(line, "organisation", "Fenwick")).toContain("provider");
    expect(tagValues(line, "organisation", "of Anglia")).toContain("subsidiary");
  });

  it("reads the firm that sold or arranged a policy as one the household deals with", () => {
    const arranged = "Underwritten by MERIDIAN COVER · arranged by Colworth & Drake Insurance Services Ltd";
    expect(tagValues(arranged, "organisation", "Colworth")).toContain("administrator");
    const sold = "Intermediary Hedgerow Home Insurance Services Ltd";
    expect(tagValues(sold, "organisation", "Intermediary Hedgerow")).toContain("administrator");
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

describe("a qualifier beside an amount", () => {
  it("beats the plain label it contains, however much nearer that label sits", () => {
    expect(tagValues("Net premium (excluding Insurance Premium Tax) £368.74", "amount")).toEqual(["other"]);
    expect(tagValues("Premium excluding Insurance Premium Tax £133.00", "amount")).toEqual(["other"]);
    expect(tagValues("Insurance Premium Tax at 12% £44.25", "amount")).toEqual(["other"]);
    expect(tagValues("Annual premium, including Insurance Premium Tax £159.60", "amount")).toEqual(["total"]);
  });

  it("reads a cover limit, an excess and a deposit as none of the household's price", () => {
    expect(tagValues("Motor legal expenses cover Up to £100,000 per claim", "amount")).toEqual(["other"]);
    expect(tagValues("Compulsory excess £150", "amount")).toEqual(["other"]);
    expect(tagValues("Deposit, collected on or after 14 March 2026 £37.99", "amount")).toEqual(["other"]);
    expect(tagValues("PRICE PAID FOR APPLIANCE \n\n£549.99", "amount")).toEqual(["other"]);
  });

  // The label is the first tag; an amount sieve reading the same figure a
  // second way adds its own tag beside it (`extraction-amount-sieves.ts`),
  // which is evidence for stage 3 rather than a different answer.
  it("reads the figure printed beside the real one as a rival", () => {
    expect(tagValues("Estimated total for 2026/27 if generation is unchanged £355.00", "amount")[0]).toBe("rival");
    expect(tagValues("Total payable if paying monthly £442.34", "amount")[0]).toBe("rival");
    expect(tagValues("Annual premium (if selected instead) £351.00", "amount")[0]).toBe("rival");
    expect(tagValues("PAYMENT FROM 20 JUNE 2026 \n\n£891.47 per month", "amount")[0]).toBe("rival");
    expect(tagValues("£14.00/mo for your first 6 months", "amount")[0]).toBe("rival");
  });

  it("keeps last year's figure out of this year's price", () => {
    expect(tagValues("Last year your annual premium was £578.90", "amount")[0]).toBe("previous");
  });

  // Owner, 2026-09-12: "words before and/or after, for things like Balance,
  // Invoice amount, due, Total ... Grand, final, Outstanding, Charge, Fee".
  it("reads the words the owner named as the price", () => {
    expect(tagValues("Contract price £2,340.00, paid in full 12 May 2026", "amount")[0]).toBe("total");
    expect(tagValues("Amount charged £9.99", "amount")[0]).toBe("due");
    expect(tagValues("Balance due £45.00", "amount")[0]).toBe("due");
    expect(tagValues("Invoice total £120.00", "amount")[0]).toBe("total");
    expect(tagValues("Final total £120.00", "amount")[0]).toBe("total");
    expect(tagValues("Annual permit fee paid: £45.00", "amount")[0]).toBe("total");
  });

  it("does not read a loan's outstanding balance as its price", () => {
    expect(tagValues("OUTSTANDING BALANCE AT 31 MARCH 2026 £164,611.07", "amount")).toEqual(["other"]);
  });

  it("reads a comparison figure and the second permit as rivals", () => {
    expect(tagValues("Equivalent monthly price (for comparison only) £322.50", "amount")[0]).toBe("rival");
    expect(tagValues("this service would otherwise cost £148 if booked separately", "amount")[0]).toBe("rival");
    expect(tagValues("A second permit for another vehicle at this household costs £90.00 per year.", "amount")[0]).toBe("rival");
  });

  // Owner, 2026-09-13: Orbit tracks the whole commitment, so a fixed-term
  // contract costs everything paid over its term.
  it("reads the whole-term sum, the year's total paid monthly and the plan's yearly price as the price", () => {
    expect(tagValues("giving a total payable over the 24  month minimum  term of £599.76.", "amount")[0]).toBe("total");
    expect(tagValues("Total premiums payable over full term approximately £7,800.00", "amount")[0]).toBe("total");
    expect(tagValues("THIS MONTH 'S INSTALMENT \n\n£14.99 \n\nANNUAL TOTAL IF PAID  MONTHLY \n\n£179.88", "amount", "17988")[0]).toBe("total");
    expect(tagValues("Paid monthly, your 12 month plan is equivalent to £119.88 a year.", "amount")[0]).toBe("total");
  });

  it("reads a per-claim limit, a penalty and a balloon payment as not the price", () => {
    expect(tagValues("Plumbing emergencies £300 per claim, up to 3 claims a year", "amount")[0]).toBe("other");
    expect(tagValues("Vet fees, per condition per year £7,500", "amount")[0]).toBe("other");
    expect(tagValues("may receive a Penalty Charge Notice of £70", "amount")[0]).toBe("other");
    expect(tagValues("Optional final payment (due 5 March 2030) £8,245.00", "amount")[0]).toBe("other");
  });

  it("lets a sentence in the next block say nothing about the figure above it", () => {
    const text = "ANNUAL  PREMIUM \n\n£186.00 \n\nThis schedule confirms your cover from 4 October 2026 to 4 October 2027.";
    expect(tagValues(text, "amount", "18600")[0]).toBe("total");
  });
});

describe("how a page prices a plan", () => {
  it("reads the monthly charge as an instalment, and a bare fee as the price", () => {
    expect(tagValues("£23.00/mo standard monthly charge", "amount")).toEqual(["instalment"]);
    expect(tagValues("Monthly membership fee, collected by Direct Debit £42.50", "amount")).toEqual(["instalment"]);
    expect(tagValues("Your monthly premium £34.62", "amount")).toEqual(["instalment"]);
    expect(tagValues("Fee £182.00", "amount")).toEqual(["total"]);
    expect(tagValues("Joining fee (payable on signing, non-refundable) £25.00", "amount")).toEqual(["other"]);
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

describe("a reference with a noun in front of it", () => {
  it("names that noun and not the household", () => {
    expect(tagValues("Property reference CH-14-SC-2261", "identifier")).toEqual(["other"]);
    expect(tagValues("Authority reference AUT/4471/EW", "identifier")).toEqual(["other"]);
    expect(tagValues("operating under contract reference HCS/CT/2244", "identifier")).toEqual(["other"]);
    expect(tagValues("prepared with reference to code NWSC-18", "identifier")).toEqual(["other"]);
  });

  it("still reads the nouns a page uses for the household's own file", () => {
    expect(tagValues("Order reference ORD-2026-0417726", "identifier")).toContain("reference");
    expect(tagValues("Payment reference TFC-014-2627", "identifier")).toContain("reference");
    expect(tagValues("Account reference TFC-014-2627", "identifier")).toContain("account");
    expect(tagValues("Policy ref MTR-8823-0145", "identifier")).toContain("policy");
  });
});

describe("the numbers a page heads without the word 'number'", () => {
  it("reads a bare account label, but not a web page's own navigation", () => {
    expect(tagValues("GENERATION ACCOUNT SEG-4471-0932", "identifier")).toContain("account");
    expect(tagValues("ACCOUNT 8847 2210 55", "identifier")).toContain("account");
    // The navigation label says nothing, and the number is printed inside
    // the address bar's own URL, which is never anybody's reference.
    expect(tagValues("My Account myaccount.example/billing/2026-03/summary", "identifier")).toEqual(["web"]);
  });

  it("reads the document's own number on a plan, a licence and a test record", () => {
    expect(tagValues("PLAN NUMBER WPP-0077410-6", "identifier")).toContain("policy");
    expect(tagValues("Licence number CBL-774-2091", "identifier")).toContain("certificate");
    expect(tagValues("Test number 1847 2205 9631", "identifier")).toContain("certificate");
  });
});

describe("one label naming one value", () => {
  it("keeps the nearest value and leaves the rest of the block unlabelled", () => {
    const page = "Account number 7734 2210 91 · Mobile number 07700 900123";
    const identifiers = tagged(page).filter((c) => c.kind === "identifier");
    expect(identifiers.map((c) => [c.value, c.tags[0].value])).toEqual([
      ["7734 2210 91", "account"],
      // The mobile number is left to its own shape, which says what it is.
      ["07700", "phone"],
      ["900123", "other"],
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

  it("reads a bare one-word label, and marks it weak where it is only a word in prose", () => {
    expect(tagValues("Policy \n\nMTR-8823-0145", "identifier")).toEqual(["policy"]);
    expect(tagValues("Membership \n\nWX-4471-B", "identifier")).toEqual(["customer"]);
    // Pages run the noun straight into the number ("Certificate CSS-0417"),
    // so a bare noun is still a label -- but a weak one, and stage 3 hears
    // it behind every label the page spelled out.
    expect(candidate("Your policy covers item AB-12345 at home", "identifier").tags[0])
      .toEqual({ value: "policy", trigger: "policy", source: "label", strength: STRENGTH_WEAK });
  });
});

describe("a date range", () => {
  const roles = (text: string) =>
    tagged(text)
      .filter((c) => c.kind === "date")
      .map((c) => c.tags[0].value);

  it("starts at the first date and ends at the second", () => {
    expect(roles("Current period of insurance 15 October 2025 to 15 October 2026")).toEqual([
      "start",
      "expiry",
    ]);
    expect(roles("Charge for the year 1 April 2026 to 31 March 2027")).toEqual(["start", "expiry"]);
    expect(roles("cover from 14 June 2026 until 13 June 2031")).toEqual(["start", "expiry"]);
  });

  it("expires instead when the term is a guarantee, warranty or certificate", () => {
    expect(roles("Cover under this certificate runs from 14 June 2026 to 13 June 2031")).toEqual([
      "start",
      "expiry",
    ]);
    expect(roles("Guarantee period 14 March 2026 to 14 March 2036")).toEqual(["start", "expiry"]);
  });

  it("says nothing about two dates the page never called a term", () => {
    expect(roles("01/04/2025 – 31/03/2026")).toEqual(["other", "other"]);
    expect(roles("Quarter 1 1 Apr 2025 – 30 Jun 2025")).toEqual(["other", "other"]);
  });

  it("says nothing about a period the page is only reporting on", () => {
    expect(roles("Statement period 1 April 2025 to 31 March 2026")).toEqual(["other", "other"]);
    expect(roles("Billing period 01/03/2026 – 31/05/2026")).toEqual(["other", "other"]);
    expect(roles("For the scheme year 6 April 2025 to 5 April 2026")).toEqual(["other", "other"]);
  });

  it("gives way to a label that sits nearer than the connector", () => {
    expect(roles("Period of cover 15 October 2025 to 15 October 2026 is your renewal date")).toEqual([
      "start",
      "renewal",
    ]);
  });
});

describe("a date that bounds a term without saying which kind", () => {
  const roles = (text: string) =>
    tagged(text)
      .filter((c) => c.kind === "date")
      .map((c) => c.tags[0].value);

  // A term end is an `expiry` here whatever kind of term it bounds; the
  // chooser is what names it a renewal or an expiry, from the page's kind
  // (extraction-term-end.ts).
  it("is always an expiry at this stage, whatever kind of term it bounds", () => {
    expect(roles("Valid to 31 March 2027")).toEqual(["expiry"]);
    expect(roles("Minimum term 24 months — ends 20 March 2027")).toEqual(["expiry"]);
    expect(roles("Cheddleton Rail — Season Ticket\n\nVALID FROM 01/09/2026\n\nVALID UNTIL 31/08/2027")).toEqual([
      "start",
      "expiry",
    ]);
  });

  it("expires when the term simply runs out", () => {
    expect(roles("This guarantee is valid until 30 June 2027")).toEqual(["expiry"]);
    expect(roles("Expiry date 08 September 2027")).toEqual(["expiry"]);
  });

  it("expires when the block says the thing is used up or given back", () => {
    expect(roles("Quote reference AMB-77410. Valid until: 6 November 2026")).toEqual(["expiry"]);
    expect(roles("Lesson credits are valid until 2 March 2027, after which any unused credit is forfeited")).toEqual(["expiry"]);
  });

  it("says nothing when the period belongs to the organisation", () => {
    expect(roles("SCHEME REGISTRATION VALID TO 30 April 2027")).toEqual(["other"]);
    expect(roles("Registered with the Gas Safe Register, valid to 30 April 2027")).toEqual(["other"]);
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
