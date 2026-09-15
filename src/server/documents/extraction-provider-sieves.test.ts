import { describe, expect, it } from "vitest";

import {
  LANGUAGE_FACT,
  PROVIDER_SIEVES,
  providerPageFacts,
  providerTagsFromVotes,
  runProviderSieves,
  type OrganisationCandidate,
  type ProviderVote,
} from "./extraction-provider-sieves";
import { STRENGTH_STATED, STRENGTH_WEAK, type Tag } from "./extraction-stages";

// Each sieve is one way of asking whether an organisation is the one the
// household would contact. The text here is written for the sieve under
// test and nothing else, so a sieve that starts answering from the shape of
// a page rather than from its words fails here first.

function organisation(text: string, name: string, from = 0): OrganisationCandidate {
  const index = text.indexOf(name, from);
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return {
    value: name,
    index,
    line: text.slice(start, end === -1 ? text.length : end).replace(/\s+/gu, " ").trim(),
  };
}

/** One sieve's votes about one organisation, over the facts of a whole
 * page: the way stage 2 runs it. */
function votesFrom(
  sieveName: string,
  text: string,
  candidate: OrganisationCandidate,
  all: readonly OrganisationCandidate[] = [candidate],
  labels: ReadonlyArray<Tag<"organisation"> | undefined> = [],
): ProviderVote[] {
  const sieve = PROVIDER_SIEVES.find((entry) => entry.name === sieveName);
  if (!sieve) throw new Error(`no sieve called ${sieveName}`);
  return sieve.read(candidate, all, providerPageFacts(text, all, labels));
}

describe("the contact-details sieve", () => {
  it("keeps the organisation whose name is in the address the page says to write to", () => {
    const text = "Questions about your account: help@millbrookenergy.example or 0330 100 2020.";
    const votes = votesFrom("contact-details", text, organisation(text, "Millbrook Energy Ltd"));

    expect(votes).toEqual([{
      sieve: "contact-details",
      tag: "provider",
      trigger: "millbrookenergy.example",
      weight: STRENGTH_STATED,
    }]);
  });

  it("reads a web address the same way as an e-mail domain", () => {
    const text = "Manage your plan at kestrelbroadband.example/myaccount at any time.";
    expect(votesFrom("contact-details", text, organisation(text, "Kestrel Broadband"))).toHaveLength(1);
  });

  it("matches a name the page abbreviates to its initials", () => {
    const text = "Enquiries 0300 555 0142 · hvla.example/tax";
    const candidate = organisation(text, "Highways and Vehicle Licensing Authority");
    expect(votesFrom("contact-details", text, candidate)).toHaveLength(1);
  });

  it("says nothing where the name shares only a word every company uses", () => {
    const text = "Write to us at customer.services@othertrader.example.";
    const candidate = { value: "Marchfield Group Services Ltd", index: 0, line: text };
    expect(votesFrom("contact-details", text, candidate)).toEqual([]);
  });

  it("does not read a full stop with no space after it as a web address", () => {
    const text = "The work was done to the Wiring Safety.Code published in 2024.";
    const candidate = { value: "Wiring Safety Contractors Ltd", index: 0, line: text };
    expect(votesFrom("contact-details", text, candidate)).toEqual([]);
  });
});

describe("the contact-block sieve", () => {
  it("keeps a name printed where the page says how to get in touch", () => {
    const text = "Colefield Broadcast Licensing Authority Limited · Enquiries 0300 660 4192";
    const votes = votesFrom("contact-block", text, organisation(text, "Colefield Broadcast Licensing Authority Limited"));

    expect(votes[0].tag).toBe("provider");
    expect(votes[0].weight).toBe(STRENGTH_STATED);
  });

  it("reads an invitation with nothing to reach them by as the weaker reason", () => {
    const text = "If any of the details are wrong, contact us using the address below.";
    const candidate = { value: "Colefield Broadcast Licensing Authority Limited", index: 0, line: text };
    expect(votesFrom("contact-block", text, candidate)[0].weight).toBe(STRENGTH_WEAK);
  });

  it("says nothing about a name in an ordinary sentence", () => {
    const text = "Your cover was arranged in March and runs for twelve months.";
    const candidate = { value: "Marchfield Broking Ltd", index: 0, line: text };
    expect(votesFrom("contact-block", text, candidate)).toEqual([]);
  });
});

describe("the printed-throughout sieve", () => {
  const running = [
    "Kestrel Broadband · Company no. 08847215 · Page 1 of 3",
    "Broadband Kestrel Fibre 500 service charge £31.00 a month",
    "Kestrel Broadband · Company no. 08847215 · Page 2 of 3",
    "Your contract ends on 14 June 2028.",
    "Kestrel Broadband · Company no. 08847215 · Page 3 of 3",
  ].join("\n");

  it("reads a name in a footer on every sheet as the page saying whose it is", () => {
    const all = [0, 1, 2].map((at) => organisation(running, "Kestrel Broadband", at === 0 ? 0 : running.indexOf("Page " + at) ));
    const votes = votesFrom("printed-throughout", running, all[0], all);

    expect(votes[0].tag).toBe("provider");
    expect(votes[0].weight).toBe(STRENGTH_STATED);
    expect(votes[0].trigger).toContain("across the document");
  });

  it("reads two printings close together as the weaker reason", () => {
    const text = "Aldermoor Dental Practice\n" +
      "Outside the plan, a private examination costs £62.00 and a hygienist appointment £48.00.\n" +
      "Aldermoor Dental Practice is where the plan is used.";
    const all = [
      organisation(text, "Aldermoor Dental Practice"),
      organisation(text, "Aldermoor Dental Practice", 100),
    ];
    expect(votesFrom("printed-throughout", text, all[0], all)[0].weight).toBe(STRENGTH_WEAK);
  });

  it("says nothing about a name the page prints once", () => {
    const text = "The meter was installed by SunHarvest Installations Ltd in 2019.";
    const all = [organisation(text, "SunHarvest Installations Ltd")];
    expect(votesFrom("printed-throughout", text, all[0], all)).toEqual([]);
  });

  it("counts one printing the sieve found twice as one", () => {
    const text = "by Fenwick & Vale Gas Services Ltd";
    const all = [organisation(text, "Fenwick & Vale Gas Services Ltd"), organisation(text, "Fenwick & Vale Gas Services Ltd")];
    expect(votesFrom("printed-throughout", text, all[0], all)).toEqual([]);
  });
});

describe("the address-of sieve", () => {
  it("keeps the organisation a letter is signed off for", () => {
    const text = "Yours sincerely\nR. Achebe, Customer Pricing\nKittiwake Energy Ltd";
    const votes = votesFrom("address-of", text, organisation(text, "Kittiwake Energy Ltd"));

    expect(votes[0].tag).toBe("provider");
    expect(votes[0].trigger).toBe("Yours sincerely");
  });

  it("reads a registered-office block as the legal entity where a trading name is stated", () => {
    const text = "Fenwick Mobile is a trading name of Anglia Communications Networks Ltd.\n" +
      "Anglia Communications Networks Ltd, registered office: Unit 14, company number 04471102.";
    const brand = organisation(text, "Fenwick Mobile");
    const parent = organisation(text, "Anglia Communications Networks Ltd", text.indexOf("\n"));
    const labels: Array<Tag<"organisation"> | undefined> = [
      { value: "provider", trigger: "is a trading name of", source: "label" },
      undefined,
    ];
    const votes = votesFrom("address-of", text, parent, [brand, parent], labels);

    expect(votes[0].tag).toBe("legal-entity");
    expect(votes[0].weight).toBe(STRENGTH_WEAK);
  });

  it("says nothing against a registered-office block where the page states no other name", () => {
    const text = "Kestrel Broadband · Company no. 08847215 · VAT GB 234 5566 12";
    const candidate = organisation(text, "Kestrel Broadband");
    expect(votesFrom("address-of", text, candidate, [candidate], [undefined])).toEqual([]);
  });
});

describe("the name-as-heading sieve", () => {
  it("keeps a name printed as the document's masthead", () => {
    const text = "Kestrel Broadband — Contract Summary and Terms";
    const votes = votesFrom("name-as-heading", text, organisation(text, "Kestrel Broadband"));

    expect(votes[0].tag).toBe("provider");
    expect(votes[0].weight).toBe(STRENGTH_WEAK);
  });

  it("refuses a capitalised line that names no organisation", () => {
    const text = "DIRECT DEBIT GUARANTEE";
    const candidate = { value: "DIRECT DEBIT GUARANTEE", index: 0, line: text };
    expect(votesFrom("name-as-heading", text, candidate)).toEqual([]);
  });

  it("says nothing about a name inside a sentence", () => {
    const text = "The payments shown above are collected by Northgate Dental Plan Administration Ltd on the dates given.";
    const candidate = organisation(text, "Northgate Dental Plan Administration Ltd");
    expect(votesFrom("name-as-heading", text, candidate)).toEqual([]);
  });
});

describe("the overseer-name sieve", () => {
  it("reads a body whose name says it oversees a trade as a reason against", () => {
    const text = "Complaints may be referred to the Financial Ombudsman Service.";
    const candidate = organisation(text, "the Financial Ombudsman Service");

    expect(votesFrom("overseer-name", text, candidate)[0].tag).toBe("regulator");
  });

  it("reads an underwriting company the same way", () => {
    const text = "Castlebridge Assistance Underwriting Ltd";
    const candidate = organisation(text, "Castlebridge Assistance Underwriting Ltd");

    expect(votesFrom("overseer-name", text, candidate)[0].tag).toBe("regulator");
  });

  it("leaves a licensing authority a household does deal with alone", () => {
    const text = "Highways and Vehicle Licensing Authority";
    const candidate = organisation(text, "Highways and Vehicle Licensing Authority");

    expect(votesFrom("overseer-name", text, candidate)).toEqual([]);
  });
});

describe("the votes merged into tags", () => {
  it("names every sieve that agreed, and how good the best reason was", () => {
    const text = "Millbrook Energy Ltd\nhelp@millbrookenergy.example\nMillbrook Energy Ltd · Page 2";
    const all = [
      organisation(text, "Millbrook Energy Ltd"),
      organisation(text, "Millbrook Energy Ltd", text.indexOf("Page") - 40),
    ];
    const votes = runProviderSieves(text, all, [
      { value: "provider", trigger: "your supplier is", source: "label" },
      undefined,
    ]);
    const tags = providerTagsFromVotes(votes[0]);

    expect(tags[0].value).toBe("provider");
    expect(tags[0].sieves).toContain(LANGUAGE_FACT);
    expect(tags[0].sieves).toContain("contact-details");
    expect(tags[0].strength).toBe(STRENGTH_STATED);
  });

  it("keeps what the page called an organisation apart from what a sieve read into it", () => {
    const text = "Underwritten by Corvane Insurance plc\nCorvane Insurance plc · Page 2\nCorvane Insurance plc · Page 3";
    const all = [
      organisation(text, "Corvane Insurance plc"),
      organisation(text, "Corvane Insurance plc", 40),
      organisation(text, "Corvane Insurance plc", 70),
    ];
    const votes = runProviderSieves(text, all, [
      { value: "underwriter", trigger: "Underwritten by", source: "label" },
      undefined,
      undefined,
    ]);
    const tags = providerTagsFromVotes(votes[0]);

    // The label the page printed comes first, whatever else agreed about
    // the name: stage 3 reads `underwriter` as never the provider.
    expect(tags[0].value).toBe("underwriter");
    expect(tags.some((tag) => tag.value === "provider")).toBe(true);
  });
});
