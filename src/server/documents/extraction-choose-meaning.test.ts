import { describe, expect, it } from "vitest";

import {
  chooseCostWithModel,
  chooseDatesWithModel,
  chooseProviderByRules,
  chooseProviderWithModel,
  chooseRecurrenceWithModel,
  chooseReferenceWithModel,
  chooseSubtypeWithModel,
  providerShortlistEntries,
  subtypeShortlistEntries,
  type MeaningTransport,
} from "./extraction-choose-meaning";
import type { CandidateKind } from "./extraction-sieve";
import { shortlistExcerpt, type ShortlistEntry } from "./extraction-shortlist";
import type { Tag, TagForKind, TaggedCandidate } from "./extraction-stages";

// Stage 3 never reads the page, so these shortlists are built by hand: the
// question is what the choice does with tagged candidates and the blocks
// they came from, not whether the sieve can produce them.

type TagInput<K extends CandidateKind> =
  | TagForKind[K]
  | {
    value: TagForKind[K];
    trigger?: string;
    source?: "label" | "shape";
    /** The stage 2 sieves that agreed on the tag. Absent means the words
     * beside the candidate were the only sieve that looked, which is what
     * every tag was before stage 2 grew more of them. */
    sieves?: string[];
    strength?: number;
  };

/** Two sieves agreeing, which is what stage 3 now needs before it answers
 * at all: the words beside the name, and the name printed throughout the
 * document (ADR-0026 stage 2, owner 2026-09-11). */
const AGREED = ["language-fact", "printed-throughout"];

let nextIndex = 0;

function candidate<K extends CandidateKind>(
  kind: K,
  value: string,
  tags: Array<TagInput<K>>,
  line?: string,
  currency?: string,
): TaggedCandidate<K> {
  return {
    kind,
    value,
    index: nextIndex++,
    line: line ?? value,
    ...(currency === undefined ? {} : { currency }),
    tags: tags.map((tag): Tag<K> =>
      typeof tag === "string"
        ? { value: tag, trigger: "", source: "label" }
        : { trigger: "", source: "label", ...tag },
    ),
  };
}

/** A transport that answers every call with the same reply and records what
 * it was asked. */
function fakeModel(...replies: string[]): MeaningTransport & { prompts: string[] } {
  const prompts: string[] = [];
  const transport = async (prompt: string): Promise<string> => {
    prompts.push(prompt);
    return replies[prompts.length - 1] ?? replies.at(-1) ?? "";
  };
  return Object.assign(transport, { prompts });
}

describe("choosing the provider where the page states it", () => {
  it("takes the brand a plan is held with, not the parent behind it", () => {
    const line = "Fenwick Mobile is a trading name of Anglia Communications Networks Ltd, registered in England.";
    expect(chooseProviderByRules([
      candidate("organisation", "Fenwick Mobile", [
        { value: "provider", trigger: "is a trading name of", sieves: AGREED },
      ], line),
      candidate("organisation", "of Anglia Communications Networks Ltd", [
        { value: "subsidiary", trigger: "a trading name of" },
      ], line),
    ])).toBe("Fenwick Mobile");
  });

  it("never answers with the parent when the page names no brand in front of it", () => {
    const line = "A trading name of Alderway Communications Ltd · Registered office: Unit 14";
    expect(chooseProviderByRules([
      candidate("organisation", "of Alderway Communications Ltd", [
        { value: "subsidiary", trigger: "A trading name of" },
      ], line),
    ])).toBeUndefined();
  });

  it("takes the firm that sold the policy over the underwriter behind it", () => {
    const line = "Underwritten by Cambrian Re on behalf of Thornfield Assurance plc · arranged by Hedgerow Home Insurance Services Ltd";
    expect(chooseProviderByRules([
      candidate("organisation", "Cambrian Re Insurance Company Ltd", [
        { value: "underwriter", trigger: "Underwritten by" },
      ], line),
      candidate("organisation", "of Thornfield Assurance plc", [
        { value: "on-behalf-of", trigger: "on behalf of" },
      ], line),
      candidate("organisation", "Hedgerow Home Insurance Services Ltd", [
        { value: "administrator", trigger: "arranged by", sieves: AGREED },
      ], line),
    ])).toBe("Hedgerow Home Insurance Services Ltd");
  });

  it("reads the intermediary as the firm the household deals with", () => {
    const line = "Intermediary Hedgerow Home Insurance Services Ltd";
    expect(chooseProviderByRules([
      candidate("organisation", "Hedgerow Home Insurance Services Ltd", [
        { value: "administrator", trigger: "Intermediary", sieves: AGREED },
      ], line),
    ])).toBe("Hedgerow Home Insurance Services Ltd");
  });

  it("takes the administrator, who is who the household deals with", () => {
    const line = "Underwritten by Corvane Insurance plc · administered by Bellward Warranty Administration Ltd";
    expect(chooseProviderByRules([
      candidate("organisation", "Corvane Insurance plc", [
        { value: "underwriter", trigger: "Underwritten by" },
      ], line),
      candidate("organisation", "Bellward Warranty Administration Ltd", [
        { value: "administrator", trigger: "administered by", sieves: AGREED },
      ], line),
    ])).toBe("Bellward Warranty Administration Ltd");
  });

  it("does not read 'managed by' or 'arranged by' as the household's own dealings", () => {
    const line = "Default fund Ashcombe Balanced Growth, managed by Ashcombe Asset Management Ltd";
    expect(chooseProviderByRules([
      candidate("organisation", "Ashcombe Asset Management Ltd", [
        { value: "administrator", trigger: "managed by" },
      ], line),
    ])).toBeUndefined();
  });

  it("takes the principal a signature was given on behalf of", () => {
    const line = "R. Thackeray, licence 745231 · for and on behalf of Fenwick & Vale Gas Services Ltd";
    expect(chooseProviderByRules([
      candidate("organisation", "of Fenwick & Vale Gas Services Ltd", [
        { value: "on-behalf-of", trigger: "on behalf of", sieves: AGREED },
      ], line),
    ])).toBe("Fenwick & Vale Gas Services Ltd");
  });

  it("reads a name on to its legal suffix where the candidate stopped short", () => {
    const signature = "FOR AND ON BEHALF OF Thornleigh Electrical Contractors Ltd";
    expect(chooseProviderByRules([
      candidate("organisation", "FOR AND ON BEHALF OF Thornleigh Electrical", [
        { value: "on-behalf-of", trigger: "ON BEHALF OF", sieves: AGREED },
      ], signature),
    ])).toBe("Thornleigh Electrical Contractors Ltd");
  });

  it("ignores a person labelled the way an organisation would be", () => {
    expect(chooseProviderByRules([
      candidate("organisation", "LANDLORD Mr N. Castellan", [
        { value: "on-behalf-of", trigger: "on behalf of" },
      ], "LANDLORD Mr N. Castellan"),
    ])).toBeUndefined();
  });

  it("ignores print the reader's eye joins up but Tika does not", () => {
    expect(chooseProviderByRules([
      candidate("organisation", "UN DE RWR ITIN G", [
        { value: "administrator", trigger: "Intermediary" },
      ], "UN DE RWR ITIN G"),
      candidate("organisation", "Intermediary Hedgerow Home Insurance Services Ltd", [
        { value: "administrator", trigger: "Intermediary", sieves: AGREED },
      ], "Intermediary Hedgerow Home Insurance Services Ltd"),
    ])).toBe("Hedgerow Home Insurance Services Ltd");
  });

  it("ignores a phrase that has not finished", () => {
    const line = "ClearBourne Water is a trading name of Bourne Valley Water and";
    expect(chooseProviderByRules([
      candidate("organisation", "of Bourne Valley Water and", [
        { value: "subsidiary", trigger: "a trading name of" },
      ], line),
    ])).toBeUndefined();
  });

  it("never answers with the underwriter, the regulator or the installer", () => {
    expect(chooseProviderByRules([
      candidate("organisation", "Palisade Insurance Company plc", [
        { value: "underwriter", trigger: "Underwritten by" },
      ], "Underwritten by Palisade Insurance Company plc, regulated by the FCA"),
      candidate("organisation", "the Financial Conduct Authority", [
        { value: "regulator", trigger: "authorised and regulated by" },
      ], "authorised and regulated by the Financial Conduct Authority"),
      candidate("organisation", "SunHarvest Installations Ltd", [
        { value: "installer", trigger: "installed by" },
      ], "The meter was installed by SunHarvest Installations Ltd"),
    ])).toBeUndefined();
  });

  it("says nothing when the page states two different principals", () => {
    expect(chooseProviderByRules([
      candidate("organisation", "Colworth & Drake Insurance Services Ltd", [
        { value: "administrator", trigger: "administered by" },
      ], "administered by Colworth & Drake Insurance Services Ltd"),
      candidate("organisation", "Marchfield Broking Ltd", [
        { value: "administrator", trigger: "arranged by" },
      ], "arranged by Marchfield Broking Ltd"),
    ])).toBeUndefined();
  });

  it("says nothing at all where the page states none of it", () => {
    expect(chooseProviderByRules([
      candidate("organisation", "Milldown Motoring Club", ["other"], "Milldown Motoring Club — Renewal"),
      candidate("heading", "Milldown Motoring Club — Renewal", ["title"]),
    ])).toBeUndefined();
  });
});

describe("the shortlist the model is shown", () => {
  it("numbers each organisation once, with the sieves that kept it and its block", () => {
    const block = "Administered by Colworth & Drake Insurance Services Ltd, of Bellhaven.";
    const entries = providerShortlistEntries([
      candidate("organisation", "Colworth & Drake Insurance Services Ltd", [
        { value: "administrator", trigger: "Administered by", sieves: AGREED },
      ], block),
      candidate("organisation", "Colworth & Drake Insurance Services Ltd", ["other"], block),
      candidate("organisation", "Meridian General Insurance Company plc", ["other"]),
    ]);
    const excerpt = shortlistExcerpt("Organisations named on this page:", entries);

    // One entry per organisation, whatever the page repeats, best first --
    // and the name nothing spoke for is still offered, below it.
    expect(entries.map((held) => held.value)).toEqual([
      "Colworth & Drake Insurance Services Ltd",
      "Meridian General Insurance Company plc",
    ]);
    expect(excerpt).toContain("1. Colworth & Drake Insurance Services Ltd");
    expect(excerpt).toContain("2. Meridian General Insurance Company plc");
    expect(excerpt).toContain("Administered by");
    expect(excerpt.length).toBeLessThanOrEqual(1_500);
  });

  it("leaves out the bodies a page names for some other reason", () => {
    const entries = providerShortlistEntries([
      candidate("organisation", "Palisade Insurance Company plc", [
        { value: "underwriter", trigger: "Underwritten by" },
      ], "Underwritten by Palisade Insurance Company plc"),
      candidate("organisation", "of Marchfield Holdings Ltd", [
        { value: "subsidiary", trigger: "a trading name of" },
      ], "Kestrel Travel is a trading name of Marchfield Holdings Ltd"),
      candidate("organisation", "Kestrel Travel Insurance Services Ltd", ["other"]),
    ]);

    expect(entries.map((entry) => entry.value)).toEqual(["Kestrel Travel Insurance Services Ltd"]);
  });

  it("offers the taxonomy phrases the page's own words support, and no more", () => {
    const entries = subtypeShortlistEntries([
      candidate("heading", "Home Insurance Policy Schedule", ["title"]),
      candidate("organisation", "Thornfield Assurance plc", ["other"]),
      candidate("amount", "41299", [{ value: "total", trigger: "Total premium" }], "Total premium £412.99", "GBP"),
    ]);

    expect(entries.length).toBeLessThanOrEqual(8);
    expect(entries.map((entry) => entry.value)).toContain("Home Insurance");
    expect(entries.map((entry) => entry.value)).toContain("Insurance");
    // The page never says "boiler", "mobile" or "tenancy", so the taxonomy's
    // other sixty qualifiers are not on the list.
    expect(entries.some((entry) => entry.value.includes("Boiler"))).toBe(false);
  });
});

/** A shortlist entry as stage 3 hands it over. */
function entry(value: string, line: string, currency?: string, display = value): ShortlistEntry {
  return {
    value,
    display,
    ...(currency === undefined ? {} : { currency }),
    line,
    why: ["sieves: label"],
    support: 1,
  };
}

describe("asking a model to choose the provider", () => {
  const shortlist = providerShortlistEntries([
    candidate("organisation", "Calderhythe District Council", [
      { value: "provider", trigger: "printed 4 times", sieves: ["printed-throughout"] },
    ], "issued by Calderhythe District Council"),
    candidate("organisation", "Wealdshire County Council", [
      { value: "provider", trigger: "printed 2 times", sieves: ["printed-throughout"] },
    ], "Wealdshire County Council £1,412.87"),
  ]);

  it("asks in plain English over a numbered list, with none allowed", async () => {
    const model = fakeModel("1");
    await chooseProviderWithModel(shortlist, model);

    expect(model.prompts).toHaveLength(1);
    expect(model.prompts[0]).toContain("Which of these organisations does this household hold the thing with");
    expect(model.prompts[0]).toContain("Answer none if none of them is it.");
    expect(model.prompts[0]).toContain("1. Calderhythe District Council");
    expect(model.prompts[0]).toContain("2. Wealdshire County Council");
    // The shortlist and its blocks, never the page.
    expect(model.prompts[0].length).toBeLessThanOrEqual(1_800);
  });

  it("takes the entry the model numbered", async () => {
    expect(await chooseProviderWithModel(shortlist, fakeModel("2"))).toBe("Wealdshire County Council");
  });

  it("takes the name written out, legal suffix aside", async () => {
    const named = providerShortlistEntries([
      candidate("organisation", "Millbrook Energy Ltd", [
        { value: "provider", trigger: "your supplier is", sieves: AGREED },
      ], "your supplier is Millbrook Energy Ltd"),
    ]);
    expect(await chooseProviderWithModel(named, fakeModel("Millbrook Energy"))).toBe("Millbrook Energy Ltd");
  });

  it("takes none for an answer", async () => {
    expect(await chooseProviderWithModel(shortlist, fakeModel("none"))).toBeUndefined();
  });

  it("refuses a name the shortlist does not carry", async () => {
    expect(await chooseProviderWithModel(shortlist, fakeModel("Ravensmere Borough Council"))).toBeUndefined();
    expect(await chooseProviderWithModel(shortlist, fakeModel("9"))).toBeUndefined();
  });

  it("asks nothing where the sieves kept no name at all", async () => {
    const model = fakeModel("1");
    expect(await chooseProviderWithModel([], model)).toBeUndefined();
    expect(model.prompts).toHaveLength(0);
  });
});

describe("asking a model what type of thing this is", () => {
  const shortlist = subtypeShortlistEntries([
    candidate("heading", "Home Insurance Policy Schedule", ["title"]),
  ]);

  it("takes the phrase the model numbered, in the taxonomy's own words", async () => {
    const chosen = await chooseSubtypeWithModel(shortlist, fakeModel("1"));
    expect(shortlist.map((held) => held.value)).toContain(chosen);
  });

  it("takes the phrase written out", async () => {
    expect(await chooseSubtypeWithModel(shortlist, fakeModel("Home Insurance"))).toBe("Home Insurance");
  });

  it("leaves the field blank when the model answers with words of its own", async () => {
    expect(await chooseSubtypeWithModel(shortlist, fakeModel("a letter about a house"))).toBeUndefined();
  });

  it("takes none for an answer", async () => {
    expect(await chooseSubtypeWithModel(shortlist, fakeModel("none"))).toBeUndefined();
  });
});

describe("asking a model which number is the household's reference", () => {
  const shortlist = [
    entry("PN-88421-K", "Policy number PN-88421-K"),
    entry("7738 2204 91", "Customer reference 7738 2204 91"),
  ];

  it("takes the entry the model numbered", async () => {
    expect(await chooseReferenceWithModel(shortlist, fakeModel("2"))).toBe("7738 2204 91");
  });

  it("reads a reference the model wrote without its spaces", async () => {
    expect(await chooseReferenceWithModel(shortlist, fakeModel("7738220491"))).toBe("7738 2204 91");
  });

  it("refuses a number the list does not carry, and takes none", async () => {
    expect(await chooseReferenceWithModel(shortlist, fakeModel("VAT 442 8891 06"))).toBeUndefined();
    expect(await chooseReferenceWithModel(shortlist, fakeModel("none"))).toBeUndefined();
  });
});

describe("asking a model which figure the document costs", () => {
  const shortlist = [
    entry("41299", "Total premium £412.99", "GBP", "£412.99"),
    entry("3441", "Monthly instalment £34.41", "GBP", "£34.41"),
  ];

  it("asks over the figures and the line each was printed on, never the page", async () => {
    const model = fakeModel("1");
    const chosen = await chooseCostWithModel(shortlist, model);

    expect(model.prompts[0]).toContain("1. £412.99");
    expect(model.prompts[0]).toContain("Total premium £412.99");
    expect(chosen).toEqual({ costMinor: 41299, currency: "GBP" });
  });

  it("reads a figure the model wrote out", async () => {
    expect(await chooseCostWithModel(shortlist, fakeModel("£34.41"))).toEqual({
      costMinor: 3441,
      currency: "GBP",
    });
  });

  it("refuses a figure the list does not carry, and takes none", async () => {
    expect(await chooseCostWithModel(shortlist, fakeModel("£99.00"))).toBeUndefined();
    expect(await chooseCostWithModel(shortlist, fakeModel("none"))).toBeUndefined();
  });
});

describe("asking a model how long the thing runs for", () => {
  const shortlist = [
    { ...entry("24", "24-month contract"), display: "24 months" },
    { ...entry("12", "12 months from the start date"), display: "12 months" },
  ];

  it("takes the period the model numbered", async () => {
    expect(await chooseRecurrenceWithModel(shortlist, fakeModel("1"))).toBe(24);
  });

  it("reads a period the model wrote out", async () => {
    expect(await chooseRecurrenceWithModel(shortlist, fakeModel("12 months"))).toBe(12);
  });

  it("refuses a period the list does not carry, and takes none", async () => {
    expect(await chooseRecurrenceWithModel(shortlist, fakeModel("36 months"))).toBeUndefined();
    expect(await chooseRecurrenceWithModel(shortlist, fakeModel("none"))).toBeUndefined();
  });
});

describe("asking a model which dates the household must keep", () => {
  const shortlist = [
    entry("2026-10-31", "Your cover ends on 31 October 2026"),
    entry("2025-11-01", "Cover started 1 November 2025"),
    entry("2026-09-04", "Printed 4 September 2026"),
  ];

  it("asks one question over every date, with the job vocabulary and none allowed", async () => {
    const model = fakeModel("1 renewal");
    const kept = await chooseDatesWithModel(shortlist, model);

    expect(model.prompts).toHaveLength(1);
    expect(model.prompts[0]).toContain("what is each one for");
    expect(model.prompts[0]).toContain("renewal, expiry, due, service, start, issued, none");
    expect(model.prompts[0]).toContain("1. 2026-10-31");
    expect(kept).toEqual([{ date: "2026-10-31", role: "renewal" }]);
  });

  it("reads a line per date, and keeps the page's order of what it was given", async () => {
    expect(await chooseDatesWithModel(shortlist, fakeModel("1 renewal\n2 start\n3 issued"))).toEqual([
      { date: "2026-10-31", role: "renewal" },
      { date: "2025-11-01", role: "start" },
      { date: "2026-09-04", role: "issued" },
    ]);
  });

  it("reads a date written the way the page printed it", async () => {
    expect(await chooseDatesWithModel(shortlist, fakeModel("31 October 2026 renewal"))).toEqual([
      { date: "2026-10-31", role: "renewal" },
    ]);
  });

  it("reads a structured model's JSON reply the same way", async () => {
    const reply = '[{"date": "1", "what_it_is_for": "renewal"}, {"date": "2", "what_it_is_for": "start"}]';
    expect(await chooseDatesWithModel(shortlist, fakeModel(reply))).toEqual([
      { date: "2026-10-31", role: "renewal" },
      { date: "2025-11-01", role: "start" },
    ]);
  });

  it("drops a job outside the vocabulary and a date the list does not carry", async () => {
    expect(await chooseDatesWithModel(shortlist, fakeModel("1 invoiced\n9 renewal\n2 expiry"))).toEqual([
      { date: "2025-11-01", role: "expiry" },
    ]);
  });

  it("takes none for an answer", async () => {
    expect(await chooseDatesWithModel(shortlist, fakeModel("none"))).toEqual([]);
    expect(await chooseDatesWithModel([], fakeModel("1 renewal"))).toEqual([]);
  });
});
