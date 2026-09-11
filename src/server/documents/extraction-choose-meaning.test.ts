import { describe, expect, it } from "vitest";

import {
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
): TaggedCandidate<K> {
  return {
    kind,
    value,
    index: nextIndex++,
    line: line ?? value,
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

  it("puts the heading stage 2 called the title first", () => {
    const excerpt = subtypeExcerpt([
      candidate("heading", "SCHEDULE OF COVER", ["section"]),
      candidate("heading", "Policy Schedule — Thornfield Assurance plc", ["title"]),
      candidate("organisation", "Thornfield Assurance plc", ["other"]),
    ]);

    expect(excerpt.split("\n").slice(0, 2)).toEqual([
      "Headings printed on this page:",
      "Policy Schedule — Thornfield Assurance plc",
    ]);
    expect(excerpt).toContain("SCHEDULE OF COVER");
  });
});

describe("asking the model about what the rules could not settle", () => {
  const shortlist = [
    candidate("organisation", "Calderhythe District Council", ["other"], "issued by Calderhythe District Council"),
    candidate("organisation", "Wealdshire County Council", ["other"], "Wealdshire County Council £1,412.87"),
    candidate("heading", "Council Tax Demand Notice 2026/27", ["title"]),
  ];

  it("asks only about the field the rules left blank", async () => {
    const model = fakeModel('{"document_title": "Council Tax Demand Notice"}');

    const filled = await chooseMeaningFieldsWithModel(
      shortlist,
      { provider: "Calderhythe District Council" },
      model,
    );

    expect(model.prompts).toHaveLength(1);
    expect(model.prompts[0]).toContain('【template_start】{"document_title":""}【template_end】');
    expect(model.prompts[0]).toContain("Headings printed on this page:");
    expect(filled).toEqual({ subtype: "Council Tax Demand Notice" });
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

  it("refuses a title no heading prints, and accepts one printed inside a heading", async () => {
    const rewritten = await chooseMeaningFieldsWithModel(
      shortlist,
      { provider: "Calderhythe District Council" },
      fakeModel('{"document_title": "Annual council tax bill"}'),
    );
    expect(rewritten.subtype).toBeUndefined();

    const quoted = await chooseMeaningFieldsWithModel(
      shortlist,
      { provider: "Calderhythe District Council" },
      fakeModel('{"document_title": "Council Tax Demand"}'),
    );
    expect(quoted.subtype).toBe("Council Tax Demand");
  });

  it("reads a bare string reply as well as a template-shaped one", async () => {
    const filled = await chooseMeaningFieldsWithModel(
      shortlist,
      { provider: "Calderhythe District Council" },
      fakeModel("Council Tax Demand Notice"),
    );

    expect(filled.subtype).toBe("Council Tax Demand Notice");
  });

  it("leaves the field blank when the model answers with nothing", async () => {
    const filled = await chooseMeaningFieldsWithModel(shortlist, {}, fakeModel('{"provider": null}', ""));

    expect(filled).toEqual({});
  });
});
