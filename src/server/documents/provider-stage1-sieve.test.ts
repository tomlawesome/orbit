import { describe, expect, it } from "vitest";

import { providerCandidates } from "./provider-stage1-sieve";

// Stage 1 is judged on recall, so these say what reaches the later stages,
// never what the right answer is: choosing is stage 3's job.
//
// Every name here is invented. None is a provider from either corpus, and
// none is a hold-out answer: a test is committed and read forever, so a real
// answer written into one leaks the hold-out to every session after it.

const names = (text: string): string[] => providerCandidates(text).map((candidate) => candidate.value);

describe("names with a company form or a trade word", () => {
  it("cuts out a name ending in a legal form", () => {
    expect(names("Invoice from Kestrel Travel Insurance Services Ltd")).toContain("Kestrel Travel Insurance Services Ltd");
  });

  it("cuts out a public body", () => {
    expect(names("Issued by Ashcombe Borough Council")).toContain("Ashcombe Borough Council");
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
    expect(names("Mossgate Day Nursery")).toContain("Mossgate Day Nursery");
    expect(names("Ravensmoor Lettings & Management")).toContain("Ravensmoor Lettings & Management");
    expect(names("Quillfield Home Security")).toContain("Quillfield Home Security");
  });

  it("finds a name inside a longer line, not only a line of its own", () => {
    expect(names("Please pay Wrenbury Childcare within 14 days")).toContain("Wrenbury Childcare");
  });

  it("does not end a name on a joining word", () => {
    expect(names("Permits for Ashcombe Borough Council").every((name) => !/\s(?:for|of|and|the)$/u.test(name)))
      .toBe(true);
  });

  it("keeps nothing one word long", () => {
    expect(names("Invoice")).toEqual([]);
    expect(names("Northgate")).toEqual([]);
  });
});

describe("addresses", () => {
  it("reads the host of an e-mail address as a name", () => {
    expect(names("billing@harbourlight-hosting.co.uk")).toContain("Harbourlight Hosting");
  });

  it("reads a web address the same way", () => {
    expect(names("www.drummond-hale.com")).toContain("Drummond Hale");
  });

  it("says nothing where the host is one word", () => {
    // "harbourlight" alone is a name of one word, and one word is never kept.
    expect(names("hello@harbourlight.co.uk")).toEqual([]);
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
    expect(providerCandidates("Ashcombe Borough Council").every((c) => c.kind === "organisation")).toBe(true);
  });

  it("attaches the block a name was printed in", () => {
    const [first] = providerCandidates("Invoice from Kestrel Travel Ltd");
    expect(first?.line).toBe("Invoice from Kestrel Travel Ltd");
  });
});
