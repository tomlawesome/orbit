import { describe, expect, it } from "vitest";

import { providerCandidates } from "./provider-stage1-sieve";

// Stage 1 is judged on recall, so these say what reaches the later stages,
// never what the right answer is: choosing is stage 3's job.

const names = (text: string): string[] => providerCandidates(text).map((candidate) => candidate.value);

describe("names with a company form or a trade word", () => {
  it("cuts out a name ending in a legal form", () => {
    expect(names("Invoice from Kestrel Travel Insurance Services Ltd")).toContain("Kestrel Travel Insurance Services Ltd");
  });

  it("cuts out a public body", () => {
    expect(names("Issued by Marchford Borough Council")).toContain("Marchford Borough Council");
  });
});

describe("names the page introduces in a sentence", () => {
  it("takes the words after by, from or with", () => {
    expect(names("Your policy is underwritten by Colworth & Drake")).toContain("Colworth & Drake");
  });
});

describe("any run of capitalised words", () => {
  it("cuts out a name in a trade no word list covers", () => {
    // The shared sieve needs a word from its list -- Ltd, Council, Insurance
    // -- and has none for a nursery, a lettings agent or an alarm company.
    expect(names("Little Acorns Day Nursery")).toContain("Little Acorns Day Nursery");
    expect(names("Thornfield Lettings & Management")).toContain("Thornfield Lettings & Management");
    expect(names("Northgate Home Security")).toContain("Northgate Home Security");
  });

  it("finds a name inside a longer line, not only a line of its own", () => {
    expect(names("Please pay Bramblewood Childcare within 14 days")).toContain("Bramblewood Childcare");
  });

  it("does not end a name on a joining word", () => {
    expect(names("Permits for Marchford Borough Council").every((name) => !/\s(?:for|of|and|the)$/u.test(name)))
      .toBe(true);
  });

  it("keeps nothing one word long", () => {
    expect(names("Invoice")).toEqual([]);
    expect(names("Northgate")).toEqual([]);
  });
});

describe("addresses", () => {
  it("reads the host of an e-mail address as a name", () => {
    expect(names("billing@foxglove-hosting.co.uk")).toContain("Foxglove Hosting");
  });

  it("reads a web address the same way", () => {
    expect(names("www.bracken-vale.com")).toContain("Bracken Vale");
  });

  it("says nothing where the host is one word", () => {
    // "foxglove" alone is a name of one word, and one word is never kept.
    expect(names("hello@foxglove.co.uk")).toEqual([]);
  });
});

describe("what stage 1 hands on", () => {
  it("keeps every candidate in page order", () => {
    const found = providerCandidates("Kestrel Travel Ltd\n\nPaid to Colworth & Drake");
    expect(found.map((candidate) => candidate.index)).toEqual([...found.map((c) => c.index)].sort((a, b) => a - b));
  });

  it("keeps each name once per place it is printed, not once per page", () => {
    const found = names("Kestrel Travel Ltd\n\nKestrel Travel Ltd");
    expect(found.filter((name) => name === "Kestrel Travel Ltd")).toHaveLength(2);
  });

  it("tags everything it finds as an organisation", () => {
    expect(providerCandidates("Marchford Borough Council").every((c) => c.kind === "organisation")).toBe(true);
  });

  it("attaches the block a name was printed in", () => {
    const [first] = providerCandidates("Invoice from Kestrel Travel Ltd");
    expect(first?.line).toBe("Invoice from Kestrel Travel Ltd");
  });
});
