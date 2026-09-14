import { describe, expect, it } from "vitest";

import {
  DESCRIBER_WORDS,
  foldBriefForms,
  isNameWord,
  providerTaggedOrganisations,
  providerWordRuns,
  type ProviderMention,
} from "./extraction-provider-runs";
import type { CandidateKind } from "./extraction-sieve";
import type { TagForKind, TaggedCandidate } from "./extraction-stages";

// The bins are counted over mentions written out by hand here: the question
// is what the counting does with a page's names, not whether the sieve can
// cut them out of a page.

function mention(value: string, line = value): ProviderMention {
  return { value, line };
}

let nextIndex = 0;

function organisation(
  value: string,
  tags: Array<TagForKind["organisation"]>,
  kind: CandidateKind = "organisation",
): TaggedCandidate {
  return {
    kind,
    value,
    index: nextIndex++,
    line: value,
    tags: tags.map((tag) => ({ value: tag, trigger: "", source: "label" as const })),
  };
}

const runsOf = (mentions: readonly ProviderMention[]): string[] =>
  providerWordRuns(mentions).map((run) => `${run.display} (${run.count})`);

describe("which words may carry a run", () => {
  it("reads the taxonomy's own words as describers, not as names", () => {
    for (const word of ["insurance", "policy", "warranty", "mortgage", "broadband", "pension"]) {
      expect(DESCRIBER_WORDS.has(word)).toBe(true);
      expect(isNameWord(word)).toBe(false);
    }
  });

  it("reads the generic company forms as describers", () => {
    for (const word of ["ltd", "limited", "plc", "llp", "group", "the", "of", "and", "&", "uk"]) {
      expect(isNameWord(word)).toBe(false);
    }
  });

  it("reads the word that says which organisation as a name word", () => {
    for (const word of ["hedgerow", "millbrook", "Calderhythe", "THORNFIELD"]) {
      expect(isNameWord(word)).toBe(true);
    }
  });

  it("bins nothing at all where a name is describers from end to end", () => {
    expect(runsOf([mention("The Insurance Company Ltd"), mention("UK Insurance Group")])).toEqual([]);
  });
});

describe("counting the runs", () => {
  it("counts every run of words that carries a name word, and no other", () => {
    // "millbrook energy" and "millbrook", less "energy" alone -- the
    // taxonomy calls energy a kind of thing, not a name. The two are
    // printed equally often, so the longer is the one that survives.
    expect(runsOf([mention("Millbrook Energy")])).toEqual(["Millbrook Energy (1)"]);
  });

  it("folds a run into the longer run it sits inside where both are as common", () => {
    // "colworth", "colworth &", "& drake" and "drake" say nothing the
    // name they are cut from does not.
    expect(runsOf([mention("Colworth & Drake"), mention("Colworth & Drake")]))
      .toEqual(["Colworth & Drake (2)"]);
  });

  it("keeps a run the page prints more often than the name around it", () => {
    const runs = providerWordRuns([
      mention("Calderwell Motor Services Ltd"),
      mention("Calderwell Motor Services Ltd"),
      mention("Calderwell"),
    ]);
    expect(runs.map((run) => `${run.display} (${run.count})`))
      .toEqual(["Calderwell (3)", "Calderwell Motor Services Ltd (2)"]);
  });

  it("adds up the runs across every mention, however the sieve cut them", () => {
    const runs = providerWordRuns([
      mention("Millbrook Energy Ltd"),
      mention("Millbrook Energy"),
      mention("your supplier is Millbrook Energy Ltd"),
    ]);
    // Every cut carries the words the name shares, so what the three
    // mentions have in common outcounts the fullest cut of it -- which is
    // the whole method: the repeated words rise. "Millbrook" alone is as
    // common as "Millbrook Energy", so it folds into it.
    expect(runs.find((run) => run.run === "millbrook energy")?.count).toBe(3);
    expect(runs.find((run) => run.run === "millbrook energy ltd")?.count).toBe(2);
    expect(runs.some((run) => run.run === "millbrook")).toBe(false);
  });

  it("ignores case, so one name printed two ways is one bin", () => {
    const runs = providerWordRuns([
      mention("MILLBROOK ENERGY"),
      mention("Millbrook Energy"),
      mention("Millbrook Energy"),
    ]);
    expect(runs[0].run).toBe("millbrook energy");
    expect(runs[0].count).toBe(3);
  });

  it("keeps an ampersand as a word of its own, because names are built from it", () => {
    const runs = providerWordRuns([
      mention("Fenwick & Vale Gas Services Ltd"),
      mention("Fenwick & Vale"),
    ]);
    expect(runs[0].run).toBe("fenwick & vale");
    expect(runs[0].count).toBe(2);
  });

  it("names each run the way the page printed it most often", () => {
    const runs = providerWordRuns([
      mention("MILLBROOK ENERGY LTD"),
      mention("Millbrook Energy Ltd"),
      mention("Millbrook Energy Ltd"),
    ]);
    expect(runs[0].display).toBe("Millbrook Energy Ltd");
  });

  it("hands back the mentions a run came from, each once, first seen first", () => {
    const first = mention("Hedgerow Home Insurance Services Ltd", "Intermediary Hedgerow Home Insurance Services Ltd");
    const second = mention("Hedgerow Home Insurance", "Administered by Hedgerow Home Insurance");
    const other = mention("Thornfield Assurance plc", "Underwritten by Thornfield Assurance plc");
    const runs = providerWordRuns([first, second, other]);
    expect(runs.find((run) => run.run === "hedgerow home insurance")?.mentions)
      .toEqual([first, second]);
    expect(runs.find((run) => run.run === "thornfield assurance plc")?.mentions)
      .toEqual([other]);
  });

  it("says nothing about a page with no kept names", () => {
    expect(providerWordRuns([])).toEqual([]);
  });

  it("gives the same bins for the same mentions, and leaves them as it found them", () => {
    const mentions = [mention("Millbrook Energy Ltd"), mention("Millbrook Energy")];
    const before = JSON.stringify(mentions);
    expect(runsOf(mentions)).toEqual(runsOf(mentions));
    expect(JSON.stringify(mentions)).toBe(before);
  });
});

describe("a brief form of a name is the same organisation", () => {
  const foldedOf = (mentions: readonly ProviderMention[]): string[] =>
    foldBriefForms(providerWordRuns(mentions)).map((run) => `${run.display} (${run.count})`);

  it("folds a fragment into the fuller name a page abbreviates, not against it", () => {
    // The page says "Fernhill Appliance Care" twice and "Fernhill" alone
    // once more -- a running head, a footer, "thank you for choosing
    // Fernhill". One organisation, so one bin, and the rival named three
    // times no longer sits above it on the fragment's count.
    expect(foldedOf([
      mention("Fernhill Appliance Care"),
      mention("Fernhill Appliance Care"),
      mention("Fernhill"),
      mention("Redhurst Insurance"),
      mention("Redhurst Insurance"),
    ])).toEqual(["Fernhill (3)", "Redhurst Insurance (2)"]);
  });

  it("offers the wording the page uses most, and says what else it was called", () => {
    const [fernhill] = foldBriefForms(providerWordRuns([
      mention("Fernhill Appliance Care"),
      mention("Fernhill Appliance Care"),
      mention("Fernhill"),
    ]));
    expect(fernhill?.display).toBe("Fernhill");
    expect(fernhill?.wordings).toEqual(["Fernhill Appliance Care"]);
  });

  it("keeps a brief form the page uses in its own right", () => {
    // "Kestrel" is printed four times where nothing longer is, and the
    // sentence it once fell into is not a name the page uses. A longer
    // string printed once does not swallow a name printed five times.
    expect(foldedOf([
      mention("also from Kestrel"),
      mention("Kestrel"),
      mention("Kestrel"),
      mention("Kestrel"),
      mention("Kestrel"),
    ])).toEqual(["Kestrel (5)", "also from Kestrel (1)"]);
  });

  it("carries a fragment's blocks to the name it folds into", () => {
    const full = mention("Bramblewood Childcare Group", "Invoice from Bramblewood Childcare Group");
    const brief = mention("Bramblewood", "Please make cheques payable to Bramblewood");
    const [name] = foldBriefForms(providerWordRuns([full, full, brief]));
    expect(name?.mentions).toEqual([full, brief]);
  });

  it("leaves a page that names two organisations as two bins", () => {
    expect(foldedOf([
      mention("Hallcroft Windows"),
      mention("Hallcroft Windows"),
      mention("Thornleigh Electrical"),
    ])).toEqual(["Hallcroft Windows (2)", "Thornleigh Electrical (1)"]);
  });
});

describe("which organisations the bins are built from", () => {
  it("keeps the organisations a stage 2 sieve read as the provider, whichever sieve", () => {
    const kept = providerTaggedOrganisations([
      organisation("Millbrook Energy Ltd", ["provider"]),
      organisation("Bellward Warranty Administration Ltd", ["administrator", "provider"]),
      organisation("the Financial Conduct Authority", ["regulator"]),
      organisation("Corvane Insurance plc", ["other"]),
      organisation("Renewal Notice", ["provider"], "heading"),
    ]);
    expect(kept.map((candidate) => candidate.value)).toEqual([
      "Millbrook Energy Ltd",
      "Bellward Warranty Administration Ltd",
    ]);
  });
});
