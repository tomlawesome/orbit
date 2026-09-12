import { describe, expect, it } from "vitest";

import {
  DROPPED_WORDS,
  chooseSubtypeByDescriberRuns,
  describerRuns,
  isDescriberWord,
  subtypeOfRun,
  type DescriberRun,
} from "./subtype-describer-runs";
import type { SubtypeSource } from "./extraction-subtype-bins";
import type { CandidateKind } from "./extraction-sieve";
import type { TagForKind, TaggedCandidate } from "./extraction-stages";

// The runs are counted over lines written out by hand here: the question is
// what the counting does with what a page says about itself, not whether the
// sieve can cut those lines out of a page.

function source(value: string, line = value): SubtypeSource {
  return { value, line };
}

let nextIndex = 0;

function candidate(
  value: string,
  kind: CandidateKind,
  tags: Array<TagForKind["organisation"]> = [],
): TaggedCandidate {
  return {
    kind,
    value,
    index: nextIndex++,
    line: value,
    tags: tags.map((tag) => ({ value: tag, trigger: "", source: "label" as const })),
  } as TaggedCandidate;
}

const printed = (runs: ReadonlyArray<DescriberRun>): string[] =>
  runs.map((run) => `${run.display} (${run.count})`);

describe("which words may carry a run", () => {
  it("counts a word the taxonomy uses to describe a document", () => {
    expect(isDescriberWord("insurance")).toBe(true);
    expect(isDescriberWord("Certificate")).toBe(true);
  });

  it("does not count a word that names an organisation rather than a kind", () => {
    expect(isDescriberWord("kestrel")).toBe(false);
    expect(isDescriberWord("colworth")).toBe(false);
  });

  it("does not count a joining or company-form word, even where the taxonomy uses one", () => {
    expect(isDescriberWord("of")).toBe(false);
    expect(isDescriberWord("ltd")).toBe(false);
    expect(DROPPED_WORDS.has("and")).toBe(true);
    expect(DROPPED_WORDS.has("limited")).toBe(true);
  });
});

describe("reading runs off a line", () => {
  it("drops a joining word out of the sequence rather than breaking the run", () => {
    // "of" is gone, so the three describer words either side of it are one
    // run and not two.
    expect(printed(describerRuns([source("Certificate of Motor Insurance")])))
      .toContain("Certificate Motor Insurance (1)");
  });

  it("stops a run at a word that names an organisation", () => {
    const runs = printed(describerRuns([source("Kestrel Travel Insurance")]));
    expect(runs).toContain("Travel Insurance (1)");
    expect(runs.some((run) => run.toLowerCase().includes("kestrel"))).toBe(false);
  });

  it("ranks the run the sources print most often first", () => {
    const runs = describerRuns([
      source("Home Insurance"),
      source("Home Insurance"),
      source("Boiler Service"),
    ]);
    expect(runs[0]?.run).toBe("home insurance");
  });

  it("folds a run into a longer run printed exactly as often", () => {
    // "home", "insurance" and "home insurance" are all printed twice, so
    // only the longest of them is a bin of its own.
    const runs = printed(describerRuns([source("Home Insurance"), source("Home Insurance")]));
    expect(runs).toContain("Home Insurance (2)");
    expect(runs).not.toContain("Insurance (2)");
  });

  it("keeps a shorter run the sources print more often than the longer one", () => {
    const runs = describerRuns([
      source("Home Insurance"),
      source("Insurance Certificate"),
      source("Motor Insurance"),
    ]);
    expect(runs[0]?.run).toBe("insurance");
    expect(runs[0]?.count).toBe(3);
  });

  it("answers with the spelling the sources printed most often", () => {
    const runs = describerRuns([source("HOME INSURANCE"), source("Home Insurance"), source("Home Insurance")]);
    expect(runs[0]?.display).toBe("Home Insurance");
  });

  it("says nothing about a line with no describer word in it", () => {
    expect(describerRuns([source("Kestrel & Drake Ltd")])).toEqual([]);
  });
});

describe("turning a run into a subtype", () => {
  it("composes a qualifier and a kind the run says together", () => {
    expect(subtypeOfRun("home insurance")).toBe("Home Insurance");
  });

  it("answers with the kind alone where the run carries no qualifier", () => {
    expect(subtypeOfRun("insurance")).toBe("Insurance");
  });

  it("answers nothing for a qualifier the taxonomy does not let stand alone", () => {
    expect(subtypeOfRun("home")).toBeUndefined();
  });

  it("answers with a qualifier the taxonomy does let stand alone", () => {
    expect(subtypeOfRun("mot")).toBe("MOT");
  });
});

describe("choosing the subtype", () => {
  it("answers from the best-supported run", () => {
    const chosen = chooseSubtypeByDescriberRuns([
      candidate("Home Insurance Certificate", "heading"),
      candidate("Home Insurance", "heading"),
      candidate("Kestrel & Drake Ltd", "organisation", ["provider"]),
    ]);
    expect(chosen).toBe("Home Insurance");
  });

  it("passes over a best run that says nothing on its own", () => {
    // "home" outnumbers everything but cannot stand alone, so the answer is
    // the next run that composes one.
    const chosen = chooseSubtypeByDescriberRuns([
      candidate("Home", "heading"),
      candidate("Home", "heading"),
      candidate("Home", "heading"),
      candidate("Boiler Service", "heading"),
    ]);
    expect(chosen).toBe("Boiler Service");
  });

  it("answers nothing where the page describes itself with no taxonomy word", () => {
    expect(chooseSubtypeByDescriberRuns([
      candidate("Kestrel & Drake Ltd", "organisation", ["provider"]),
    ])).toBeUndefined();
  });
});
