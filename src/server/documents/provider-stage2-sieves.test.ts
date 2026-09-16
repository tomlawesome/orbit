import { describe, expect, it } from "vitest";

import type { Candidate } from "./extraction-sieve";
import { chooseProvider, readProviders, type ProviderVote } from "./provider-stage2-sieves";

// Every organisation named here is invented for this file. None is a
// provider from either corpus, and none is a hold-out answer.

let nextIndex = 0;
const cand = (value: string, line: string): Candidate => ({ kind: "organisation", value, index: nextIndex++, line });

const rulesFired = (votes: ProviderVote[]): string[] => votes.map((v) => v.rule);
const reading = (text: string, candidates: Candidate[], name: string) =>
  readProviders(text, candidates).find((r) => r.name === name);

describe("R1: looks like an organisation", () => {
  it("votes against a name that is nothing but document labels", () => {
    const text = "Statement Date\n14 March 2026";
    const candidates = [cand("Statement Date", "Statement Date")];
    const result = reading(text, candidates, "Statement Date");
    expect(rulesFired(result?.votes ?? [])).toContain("R1");
    expect(result?.score).toBeLessThan(0);
  });

  it("votes against a street name with no company word, but not one that has one", () => {
    const text = "Foundry Lane\nCindermoor Water House";
    const candidates = [cand("Foundry Lane", "Foundry Lane"), cand("Cindermoor Water House", "Cindermoor Water House")];
    const street = reading(text, candidates, "Foundry Lane");
    const company = reading(text, candidates, "Cindermoor Water House");
    expect(rulesFired(street?.votes ?? [])).toContain("R1");
    expect(rulesFired(company?.votes ?? [])).not.toContain("R1");
  });

  it("votes against letter-spaced OCR debris", () => {
    const text = "F O R M W B";
    const candidates = [cand("F O R M W B", "F O R M W B")];
    const result = reading(text, candidates, "F O R M W B");
    expect(result?.votes.find((v) => v.rule === "R1")?.trigger).toContain("letter-spaced");
  });
});

describe("R2: printed throughout", () => {
  it("weights a name in proportion to how many blocks it is printed in", () => {
    const text = [
      "Welcome to Fenwick Boiler Care",
      "About your cover",
      "Fenwick Boiler Care, page 2",
      "Thank you for choosing Fenwick Boiler Care",
      "Marrowfield Insurance Group",
      "Fenwick Boiler Care, page 4",
    ].join("\n");
    const candidates = [
      cand("Fenwick Boiler Care", "Welcome to Fenwick Boiler Care"),
      cand("Fenwick Boiler Care", "Fenwick Boiler Care, page 2"),
      cand("Fenwick Boiler Care", "Thank you for choosing Fenwick Boiler Care"),
      cand("Fenwick Boiler Care", "Fenwick Boiler Care, page 4"),
      cand("Marrowfield Insurance Group", "Marrowfield Insurance Group"),
    ];
    const top = reading(text, candidates, "Fenwick Boiler Care");
    const rival = reading(text, candidates, "Marrowfield Insurance Group");
    expect(top?.votes.find((v) => v.rule === "R2")?.weight).toBeCloseTo(2, 5);
    expect(rival?.votes.find((v) => v.rule === "R2")?.weight).toBeCloseTo(0.5, 5);
  });
});

describe("R3a: stated as the principal", () => {
  it("votes for a name a cue phrase introduces", () => {
    const text = "Welcome to Hallowdene District Council";
    const candidates = [cand("Hallowdene District Council", "Welcome to Hallowdene District Council")];
    const result = reading(text, candidates, "Hallowdene District Council");
    expect(result?.votes.find((v) => v.rule === "R3a")?.weight).toBeGreaterThan(0);
  });
});

describe("R3b: stated as a backer", () => {
  it("votes against a name a backer phrase introduces", () => {
    const text = "Your policy is underwritten by Silverlatch Finance";
    const candidates = [cand("Silverlatch Finance", "Your policy is underwritten by Silverlatch Finance")];
    const result = reading(text, candidates, "Silverlatch Finance");
    expect(result?.votes.find((v) => v.rule === "R3b")?.weight).toBeLessThan(0);
  });

  it("votes against a name that is itself an overseer", () => {
    const text = "Complain to the Northshire Regulation Authority";
    const candidates = [cand("Northshire Regulation Authority", "Complain to the Northshire Regulation Authority")];
    const result = reading(text, candidates, "Northshire Regulation Authority");
    const overseerVote = result?.votes.find((v) => v.rule === "R3b" && v.trigger.includes("overseer"));
    expect(overseerVote?.weight).toBe(-3);
  });
});

describe("R4: known by its role", () => {
  it("folds mentions of the role into the full name's block count", () => {
    const text = [
      "Rowanmere Dental Practice",
      "The Practice is open Monday to Friday",
      "Please contact the Practice for an appointment",
      "The Practice reserves the right to amend this schedule",
    ].join("\n");
    const candidates = [cand("Rowanmere Dental Practice", "Rowanmere Dental Practice")];
    const result = reading(text, candidates, "Rowanmere Dental Practice");
    expect(result?.blocks).toBe(4);
    expect(rulesFired(result?.votes ?? [])).toContain("R4");
  });

  it("does not transfer a role's mentions when no name ends in that role word", () => {
    const text = ["Fenwick Boiler Care", "The Scheme changes yearly"].join("\n");
    const candidates = [cand("Fenwick Boiler Care", "Fenwick Boiler Care")];
    const result = reading(text, candidates, "Fenwick Boiler Care");
    expect(rulesFired(result?.votes ?? [])).not.toContain("R4");
    expect(result?.blocks).toBe(1);
  });
});

describe("R5: address, contact details or a shared web host", () => {
  it("caps its vote at 2 even with all three signals present", () => {
    const text = [
      "Ferngale Broadband",
      "Unit 4 Trade Park, call 0114 496 0000",
      "DN4 5PQ",
      "www.ferngale-broadband.co.uk",
    ].join("\n");
    const candidates = [cand("Ferngale Broadband", "Ferngale Broadband")];
    const result = reading(text, candidates, "Ferngale Broadband");
    expect(result?.votes.find((v) => v.rule === "R5")?.weight).toBe(2);
  });

  it("votes for a name next to a postcode alone", () => {
    const text = ["Talbrook Energy", "12 Mill Row", "BS1 4AA"].join("\n");
    const candidates = [cand("Talbrook Energy", "Talbrook Energy")];
    const result = reading(text, candidates, "Talbrook Energy");
    expect(result?.votes.find((v) => v.rule === "R5")?.weight).toBe(1);
  });
});

describe("rule interaction", () => {
  it("lets R3b outweigh R5", () => {
    // Cindermoor Water is the genuine, heavily-printed provider on this page,
    // so the ombudsman's R2 share stays small and does not mask the point:
    // its own R3b penalty beats the R5 credit its address earns it.
    const text = [
      "Cindermoor Water",
      "Cindermoor Water",
      "Cindermoor Water",
      "Cindermoor Water",
      "Cindermoor Water",
      "Refer to the Bellcastle Ombudsman Service",
      "Bellcastle Ombudsman Service, 9 Crown Court",
      "SW1 2AA, call 0207 946 0000",
    ].join("\n");
    const candidates = [
      cand("Cindermoor Water", "Cindermoor Water block 1"),
      cand("Cindermoor Water", "Cindermoor Water block 2"),
      cand("Cindermoor Water", "Cindermoor Water block 3"),
      cand("Cindermoor Water", "Cindermoor Water block 4"),
      cand("Cindermoor Water", "Cindermoor Water block 5"),
      cand("Bellcastle Ombudsman Service", "Refer to the Bellcastle Ombudsman Service"),
      cand("Bellcastle Ombudsman Service", "Bellcastle Ombudsman Service, 9 Crown Court"),
    ];
    const result = reading(text, candidates, "Bellcastle Ombudsman Service");
    expect(result?.votes.find((v) => v.rule === "R5")?.weight).toBeGreaterThan(0);
    expect(result?.score).toBeLessThan(0);
  });

  it("returns undefined from chooseProvider when the top two scores tie", () => {
    const text = [
      "Brackenfield Testing Services",
      "Please retain this for your records",
      "Brackenfield Testing Services",
      "Marrowlight Testing Services",
      "Please retain this for your records too",
      "Marrowlight Testing Services",
    ].join("\n");
    const candidates = [
      cand("Brackenfield Testing Services", "Brackenfield Testing Services"),
      cand("Brackenfield Testing Services", "Brackenfield Testing Services"),
      cand("Marrowlight Testing Services", "Marrowlight Testing Services"),
      cand("Marrowlight Testing Services", "Marrowlight Testing Services"),
    ];
    expect(chooseProvider(text, candidates)).toBeUndefined();
  });

  it("picks the reading with the highest score when there is no tie", () => {
    const text = [
      "Welcome to Oakenfold Leisure Club",
      "Membership Number",
      "Oakenfold Leisure Club",
      "Oakenfold Leisure Club",
      "Underwritten by Priorswood Assurance",
    ].join("\n");
    const candidates = [
      cand("Oakenfold Leisure Club", "Welcome to Oakenfold Leisure Club"),
      cand("Membership Number", "Membership Number"),
      cand("Oakenfold Leisure Club", "Oakenfold Leisure Club"),
      cand("Oakenfold Leisure Club", "Oakenfold Leisure Club"),
      cand("Priorswood Assurance", "Underwritten by Priorswood Assurance"),
    ];
    expect(chooseProvider(text, candidates)).toBe("Oakenfold Leisure Club");
  });
});

describe("grouping", () => {
  it("folds a leading joiner and a trailing legal form into the same reading", () => {
    const text = "Thackery & Vance Ltd\nthe Thackery & Vance";
    const candidates = [
      cand("Thackery & Vance Ltd", "Thackery & Vance Ltd"),
      cand("the Thackery & Vance", "the Thackery & Vance"),
    ];
    const readings = readProviders(text, candidates);
    expect(readings).toHaveLength(1);
    expect(readings[0]?.printings).toBe(2);
  });
});
