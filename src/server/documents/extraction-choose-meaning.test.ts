import { describe, expect, it } from "vitest";

import {
  chooseDateToActOnWithModel,
  chooseMeaningFieldsWithModel,
  chooseProviderByRules,
  providerExcerpt,
  subtypeExcerpt,
  type MeaningTransport,
} from "./extraction-choose-meaning";
import type { CandidateKind } from "./extraction-sieve";
import type { Tag, TagForKind, TaggedCandidate } from "./extraction-stages";

// Stage 3 never reads the page, so these shortlists are built by hand: the
// question is what the choice does with tagged candidates and the blocks
// they came from, not whether the sieve can produce them.

type TagInput<K extends CandidateKind> =
  | TagForKind[K]
  | { value: TagForKind[K]; trigger?: string; source?: "label" | "shape" };

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
        { value: "provider", trigger: "is a trading name of" },
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
        { value: "administrator", trigger: "arranged by" },
      ], line),
    ])).toBe("Hedgerow Home Insurance Services Ltd");
  });

  it("reads the intermediary as the firm the household deals with", () => {
    const line = "Intermediary Hedgerow Home Insurance Services Ltd";
    expect(chooseProviderByRules([
      candidate("organisation", "Hedgerow Home Insurance Services Ltd", [
        { value: "administrator", trigger: "Intermediary" },
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
        { value: "administrator", trigger: "administered by" },
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
        { value: "on-behalf-of", trigger: "on behalf of" },
      ], line),
    ])).toBe("Fenwick & Vale Gas Services Ltd");
  });

  it("reads a name on to its legal suffix where the candidate stopped short", () => {
    const signature = "FOR AND ON BEHALF OF Thornleigh Electrical Contractors Ltd";
    expect(chooseProviderByRules([
      candidate("organisation", "FOR AND ON BEHALF OF Thornleigh Electrical", [
        { value: "on-behalf-of", trigger: "ON BEHALF OF" },
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
        { value: "administrator", trigger: "Intermediary" },
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

describe("the excerpt the model is asked about", () => {
  it("names each organisation once, with its label and its block, inside the limit", () => {
    const block = "Administered by Colworth & Drake Insurance Services Ltd, of Bellhaven.";
    const excerpt = providerExcerpt([
      candidate("organisation", "Colworth & Drake Insurance Services Ltd", [
        { value: "administrator", trigger: "Administered by" },
      ], block),
      candidate("organisation", "Colworth & Drake Insurance Services Ltd", ["other"], block),
      candidate("organisation", "Meridian General Insurance Company plc", ["other"]),
    ]);

    expect(excerpt).toContain("Organisations named on this page:");
    expect(excerpt).toContain("Administered by");
    expect(excerpt).toContain("Meridian General Insurance Company plc");
    // One line per organisation, whatever the page repeats.
    expect(excerpt.split("\n")).toHaveLength(3);
    expect(excerpt.length).toBeLessThanOrEqual(1_500);
  });

  it("leaves out the bodies a page names for some other reason", () => {
    const excerpt = providerExcerpt([
      candidate("organisation", "Palisade Insurance Company plc", [
        { value: "underwriter", trigger: "Underwritten by" },
      ], "Underwritten by Palisade Insurance Company plc"),
      candidate("organisation", "of Marchfield Holdings Ltd", [
        { value: "subsidiary", trigger: "a trading name of" },
      ], "Kestrel Travel is a trading name of Marchfield Holdings Ltd"),
      candidate("organisation", "Kestrel Travel Insurance Services Ltd", ["other"]),
    ]);

    expect(excerpt).not.toContain("Palisade");
    expect(excerpt).not.toContain("Marchfield");
    expect(excerpt).toContain("Kestrel Travel Insurance Services Ltd");
  });

  it("prints the headings, then the names and the labelled amounts", () => {
    const excerpt = subtypeExcerpt([
      candidate("heading", "SCHEDULE OF COVER", ["section"]),
      candidate("heading", "Policy Schedule — Thornfield Assurance plc", ["title"]),
      candidate("organisation", "Thornfield Assurance plc", ["other"]),
      candidate("amount", "41299", [{ value: "total", trigger: "Total premium" }], "Total premium £412.99", "GBP"),
    ]);

    expect(excerpt.split("\n")).toEqual([
      "What this page prints:",
      "Policy Schedule — Thornfield Assurance plc",
      "SCHEDULE OF COVER",
      "Named on the page: Thornfield Assurance plc",
      "Amounts printed: Total premium GBP 412.99",
    ]);
    expect(excerpt.length).toBeLessThanOrEqual(700);
  });
});

describe("asking the model about what the rules could not settle", () => {
  const shortlist = [
    candidate("organisation", "Calderhythe District Council", ["other"], "issued by Calderhythe District Council"),
    candidate("organisation", "Wealdshire County Council", ["other"], "Wealdshire County Council £1,412.87"),
    candidate("heading", "Council Tax Demand Notice 2026/27", ["title"]),
  ];

  it("asks only about the field the rules left blank, from the taxonomy's own words", async () => {
    const model = fakeModel('{"kind_of_thing": "Tax", "what_it_is_for": "Council tax"}');

    const filled = await chooseMeaningFieldsWithModel(
      shortlist,
      { provider: "Calderhythe District Council" },
      model,
    );

    expect(model.prompts).toHaveLength(1);
    expect(model.prompts[0]).toContain('【template_start】{"kind_of_thing":"","what_it_is_for":""}【template_end】');
    expect(model.prompts[0]).toContain("kind_of_thing must be one of: Insurance, Plan,");
    expect(model.prompts[0]).toContain("what_it_is_for must be one of: Motor, Driving,");
    expect(model.prompts[0]).toContain("What this page prints:");
    expect(filled).toEqual({ subtype: "Council tax Tax" });
  });

  it("composes what the page is with the taxonomy's own group names, not the words the model used", async () => {
    const filled = await chooseMeaningFieldsWithModel(
      shortlist,
      { provider: "Calderhythe District Council" },
      fakeModel('{"kind_of_thing": "Cover", "what_it_is_for": "Car"}'),
    );

    expect(filled.subtype).toBe("Motor Insurance");
  });

  it("keeps the kind alone when what it is for is not a taxonomy qualifier", async () => {
    const filled = await chooseMeaningFieldsWithModel(
      shortlist,
      { provider: "Calderhythe District Council" },
      fakeModel('{"kind_of_thing": "Statement", "what_it_is_for": "the second quarter"}'),
    );

    expect(filled.subtype).toBe("Statement");
  });

  it("takes a qualifier on its own only where the taxonomy lets it stand alone", async () => {
    const standalone = await chooseMeaningFieldsWithModel(
      shortlist,
      { provider: "Calderhythe District Council" },
      fakeModel('{"kind_of_thing": "", "what_it_is_for": "MOT"}'),
    );
    expect(standalone.subtype).toBe("MOT");

    const notStandalone = await chooseMeaningFieldsWithModel(
      shortlist,
      { provider: "Calderhythe District Council" },
      fakeModel('{"kind_of_thing": "", "what_it_is_for": "Dental"}'),
    );
    expect(notStandalone.subtype).toBeUndefined();
  });

  it("refuses a kind the taxonomy does not carry", async () => {
    const filled = await chooseMeaningFieldsWithModel(
      shortlist,
      { provider: "Calderhythe District Council" },
      fakeModel('{"kind_of_thing": "Council tax demand notice", "what_it_is_for": "Council tax"}'),
    );

    expect(filled.subtype).toBe("Council tax");
  });

  it("renders the template's own structured prompt for the provider", async () => {
    const model = fakeModel('{"provider": "Calderhythe District Council"}', "");

    const filled = await chooseMeaningFieldsWithModel(shortlist, {}, model);

    expect(model.prompts[0]).toContain("【task】structured");
    expect(model.prompts[0]).toContain('【template_start】{"provider":""}【template_end】');
    expect(model.prompts[0]).toContain("Organisations named on this page:");
    expect(filled.provider).toBe("Calderhythe District Council");
  });

  it("accepts an answer that is one of the candidates, legal suffix aside", async () => {
    const model = fakeModel('{"provider": "Calderhythe District Council Ltd"}', "");

    const filled = await chooseMeaningFieldsWithModel(shortlist, {}, model);

    expect(filled.provider).toBe("Calderhythe District Council Ltd");
  });

  it("refuses a provider the shortlist does not carry", async () => {
    const model = fakeModel('{"provider": "Calderhythe Borough Council"}', "");

    const filled = await chooseMeaningFieldsWithModel(shortlist, {}, model);

    expect(filled.provider).toBeUndefined();
  });

  it("leaves subtype blank when the model answers with words of its own", async () => {
    const filled = await chooseMeaningFieldsWithModel(
      shortlist,
      { provider: "Calderhythe District Council" },
      fakeModel('{"kind_of_thing": "Annual demand notice", "what_it_is_for": "living here"}'),
    );

    expect(filled.subtype).toBeUndefined();
  });

  it("reads a bare string reply as the kind it names", async () => {
    const filled = await chooseMeaningFieldsWithModel(
      shortlist,
      { provider: "Calderhythe District Council" },
      fakeModel("Tax"),
    );

    expect(filled.subtype).toBe("Tax");
  });

  it("leaves the field blank when the model answers with nothing", async () => {
    const filled = await chooseMeaningFieldsWithModel(shortlist, {}, fakeModel('{"provider": null}', ""));

    expect(filled).toEqual({});
  });
});

describe("asking the model which date the household must act on", () => {
  const page = [
    candidate("date", "2026-10-31", ["other"], "31 October 2026"),
    candidate("date", "2026-11-19", ["other"], "MOT valid, expiry on record 19 November 2026"),
    candidate("date", "2027-01-14", [{ value: "renewal", trigger: "valid to" }], "insurance valid to 14 January 2027"),
  ];
  const offered = ["2026-10-31", "2026-11-19"];
  const decided = [{ date: "2027-01-14", role: "renewal" }];

  it("asks about the dates no rule could label, with the line each was printed on", async () => {
    const model = fakeModel('{"date_to_act_on": "2026-10-31", "what_it_is_for": "renewal"}');

    const picked = await chooseDateToActOnWithModel(page, offered, decided, model);

    expect(model.prompts).toHaveLength(1);
    expect(model.prompts[0]).toContain('【template_start】{"date_to_act_on":"","what_it_is_for":""}【template_end】');
    expect(model.prompts[0]).toContain("what_it_is_for must be one of: renewal, expiry, due, service, start, issued, none");
    expect(model.prompts[0]).toContain('2026-10-31: "31 October 2026"');
    expect(model.prompts[0]).toContain("Already understood, so not in question: 2027-01-14 (renewal)");
    expect(picked).toEqual({ date: "2026-10-31", role: "renewal" });
  });

  it("reads an answer written the way the page printed it", async () => {
    const picked = await chooseDateToActOnWithModel(
      page,
      offered,
      decided,
      fakeModel('{"date_to_act_on": "31 October 2026", "what_it_is_for": "due"}'),
    );

    expect(picked).toEqual({ date: "2026-10-31", role: "due" });
  });

  it("refuses a date that is not one of the ones offered", async () => {
    const picked = await chooseDateToActOnWithModel(
      page,
      offered,
      decided,
      fakeModel('{"date_to_act_on": "2027-01-14", "what_it_is_for": "renewal"}'),
    );

    expect(picked).toBeUndefined();
  });

  it("refuses a job outside the vocabulary, and takes none as an answer", async () => {
    const invented = await chooseDateToActOnWithModel(
      page,
      offered,
      decided,
      fakeModel('{"date_to_act_on": "2026-10-31", "what_it_is_for": "tax point"}'),
    );
    const nothing = await chooseDateToActOnWithModel(
      page,
      offered,
      decided,
      fakeModel('{"date_to_act_on": "2026-10-31", "what_it_is_for": "none"}'),
    );

    expect(invented).toBeUndefined();
    expect(nothing).toBeUndefined();
  });

  it("does not ask at all when the rules labelled every date", async () => {
    const model = fakeModel('{"date_to_act_on": "2026-10-31", "what_it_is_for": "renewal"}');

    expect(await chooseDateToActOnWithModel(page, [], decided, model)).toBeUndefined();
    expect(model.prompts).toHaveLength(0);
  });
});
