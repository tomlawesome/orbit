import { describe, expect, it } from "vitest";

import {
  DESCRIBER_WORDS,
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
    // "millbrook energy" and its two single words, less "energy" alone --
    // the taxonomy calls energy a kind of thing, not a name.
    expect(runsOf([mention("Millbrook Energy")]))
      .toEqual(["Millbrook Energy (1)", "Millbrook (1)"]);
  });

  it("adds up the runs across every mention, however the sieve cut them", () => {
    const runs = providerWordRuns([
      mention("Millbrook Energy Ltd"),
      mention("Millbrook Energy"),
      mention("your supplier is Millbrook Energy Ltd"),
    ]);
    const millbrook = runs.find((run) => run.run === "millbrook");
    const full = runs.find((run) => run.run === "millbrook energy ltd");
    // Every cut carries the word, so the word outcounts the fullest cut of
    // it -- which is the whole method: the repeated words rise.
    expect(millbrook?.count).toBe(3);
    expect(full?.count).toBe(2);
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
    const runs = providerWordRuns([mention("Fenwick & Vale Gas Services Ltd")]);
    expect(runs.some((run) => run.run === "fenwick & vale")).toBe(true);
  });

  it("puts the most printed run first, and the longer run where two are level", () => {
    const runs = providerWordRuns([
      mention("Calderwell Motor Services Ltd"),
      mention("Calderwell Motor Services Ltd"),
      mention("Calderwell"),
    ]);
    expect(runs[0].run).toBe("calderwell");
    expect(runs[0].count).toBe(3);
    // Level at two: the longest of them leads.
    expect(runs[1].run).toBe("calderwell motor services ltd");
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
    const hedgerow = runs.find((run) => run.run === "hedgerow");
    expect(hedgerow?.mentions).toEqual([first, second]);
    expect(runs.find((run) => run.run === "thornfield")?.mentions).toEqual([other]);
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
