// The shortlist-recall counting is what `eval:shortlist` and the real-document
// bundle both report, so a mistake here reads as an extraction result rather
// than as a counting bug -- the number looks like accuracy and is quoted as
// accuracy. These tests pin the counting itself: the invariants between the
// four columns, what `wanted` counts, subtype's deliberate lack of a rank, and
// that a miss names the document and the answer it could not find.
//
// The documents are the corpus's own full pages, not text written here, so the
// shortlists under test are the ones the extractor really builds.

import { describe, expect, it } from "vitest";
import { EXTRACTION_CORPUS } from "./extraction-corpus";
import {
  RECALL_FIELDS,
  countShortlistRecall,
  emptyRecallTallies,
  formatRecallTable,
  recallMisses,
  type RecallDocument,
  type RecallTallies,
} from "./extraction-shortlist-recall";

// Six is enough to exercise every field and keeps the suite quick; the pages
// are long, and sieving and tagging each one is the expensive part.
const SAMPLE = EXTRACTION_CORPUS.slice(0, 6);

const countAll = (documents: readonly RecallDocument[]): RecallTallies => {
  const tallies = emptyRecallTallies();
  for (const document of documents) countShortlistRecall(tallies, document);
  return tallies;
};

describe("emptyRecallTallies", () => {
  it("starts every field at zero with no misses", () => {
    const tallies = emptyRecallTallies();
    expect(Object.keys(tallies).sort()).toEqual([...RECALL_FIELDS].sort());
    for (const field of RECALL_FIELDS) {
      expect(tallies[field]).toEqual({
        top1: 0, top2: 0, top3: 0, found: 0, wanted: 0, entries: 0, lists: 0, misses: [],
      });
    }
  });

  it("hands back a fresh set each time, not a shared one", () => {
    const first = emptyRecallTallies();
    first.dates.wanted += 1;
    expect(emptyRecallTallies().dates.wanted).toBe(0);
  });
});

describe("countShortlistRecall over real corpus pages", () => {
  const tallies = countAll(SAMPLE);

  it("builds one list per document for every field", () => {
    for (const field of RECALL_FIELDS) {
      expect(tallies[field].lists).toBe(SAMPLE.length);
    }
  });

  it("keeps the four columns in their nesting order", () => {
    for (const field of RECALL_FIELDS) {
      const { top1, top2, top3, found, wanted } = tallies[field];
      expect(top1).toBeLessThanOrEqual(top2);
      expect(top2).toBeLessThanOrEqual(top3);
      expect(top3).toBeLessThanOrEqual(found);
      expect(found).toBeLessThanOrEqual(wanted);
    }
  });

  it("counts one wanted answer per answer the corpus declares", () => {
    const declared = (pick: (document: (typeof SAMPLE)[number]) => boolean): number =>
      SAMPLE.filter(pick).length;

    expect(tallies.dates.wanted).toBe(
      SAMPLE.reduce((total, document) => total + document.expected.dates.length, 0),
    );
    expect(tallies.reference.wanted).toBe(declared((d) => d.expected.reference !== undefined));
    expect(tallies.cost.wanted).toBe(declared((d) => d.expected.costMinor !== undefined));
    expect(tallies.provider.wanted).toBe(declared((d) => d.expected.provider !== undefined));
    expect(tallies.subtype.wanted).toBe(declared((d) => d.expected.subtype !== undefined));
    expect(tallies.recurrence.wanted).toBe(
      declared((d) => d.expected.recurrenceMonths !== undefined),
    );
  });

  // Without this the miss assertions below would pass against a pipeline that
  // finds nothing at all, which is the failure they are meant to catch.
  it("finds real answers on the shortlists, so a miss means something", () => {
    const found = RECALL_FIELDS.reduce((total, field) => total + tallies[field].found, 0);
    expect(found).toBeGreaterThan(0);
    expect(tallies.dates.found).toBeGreaterThan(0);
  });

  it("records a miss for every wanted answer that was not on its list", () => {
    for (const field of RECALL_FIELDS) {
      const { found, wanted, misses } = tallies[field];
      expect(misses).toHaveLength(wanted - found);
    }
  });

  it("never claims a rank for subtype, whose shortlist has no best-first order", () => {
    expect(tallies.subtype.top1).toBe(0);
    expect(tallies.subtype.top2).toBe(0);
    expect(tallies.subtype.top3).toBe(0);
    // It still answers "was it on the list at all".
    expect(tallies.subtype.wanted).toBeGreaterThan(0);
  });

  it("adds to the tallies it is given rather than replacing them", () => {
    const one = countAll(SAMPLE.slice(0, 3));
    const two = countAll(SAMPLE);
    expect(two.dates.lists).toBe(SAMPLE.length);
    expect(two.dates.wanted).toBeGreaterThanOrEqual(one.dates.wanted);
  });
});

describe("a page that answers nothing", () => {
  const blank: RecallDocument = {
    name: "blank.pdf",
    text: "There is nothing on this page worth reading.",
    expected: { dates: [], reference: "QX-99-4471" },
  };

  it("names the document, the field and the answer it could not find", () => {
    const tallies = emptyRecallTallies();
    countShortlistRecall(tallies, blank);

    expect(tallies.reference.wanted).toBe(1);
    expect(tallies.reference.found).toBe(0);
    expect(tallies.reference.misses).toEqual([
      expect.stringContaining("blank.pdf: reference QX-99-4471 is not on the shortlist of"),
    ]);
  });

  it("counts a list for a field the page declares no answer for", () => {
    const tallies = emptyRecallTallies();
    countShortlistRecall(tallies, blank);

    expect(tallies.cost.lists).toBe(1);
    expect(tallies.cost.wanted).toBe(0);
    expect(tallies.cost.misses).toEqual([]);
  });
});

describe("recallMisses", () => {
  it("gathers the misses of every field in field order", () => {
    const tallies = emptyRecallTallies();
    tallies.dates.misses.push("a.pdf: dates 2026-01-01 is not on the shortlist of 4");
    tallies.provider.misses.push("b.pdf: provider Acme is not on the shortlist of 3");

    expect(recallMisses(tallies)).toEqual([
      "a.pdf: dates 2026-01-01 is not on the shortlist of 4",
      "b.pdf: provider Acme is not on the shortlist of 3",
    ]);
  });

  it("is empty when nothing was missed", () => {
    expect(recallMisses(emptyRecallTallies())).toEqual([]);
  });
});

describe("formatRecallTable", () => {
  const tallies = emptyRecallTallies();
  tallies.dates = { top1: 3, top2: 4, top3: 5, found: 6, wanted: 8, entries: 40, lists: 4, misses: [] };
  tallies.subtype = { top1: 0, top2: 0, top3: 0, found: 2, wanted: 4, entries: 12, lists: 4, misses: [] };
  const table = formatRecallTable("holdout 3: ", tallies).split("\n");

  it("heads the table with the caller's label", () => {
    expect(table[0]).toContain("holdout 3: ");
    expect(table[0]).toContain("top-1");
    expect(table[0]).toContain("mean entries");
  });

  it("gives one line to each field, in RECALL_FIELDS order", () => {
    expect(table).toHaveLength(RECALL_FIELDS.length + 1);
    RECALL_FIELDS.forEach((field, index) => {
      expect(table[index + 1].startsWith(field)).toBe(true);
    });
  });

  it("prints each column as count over wanted with its percentage", () => {
    const dates = table[RECALL_FIELDS.indexOf("dates") + 1];
    expect(dates).toContain("3/8 (37.5%)");
    expect(dates).toContain("4/8 (50.0%)");
    expect(dates).toContain("5/8 (62.5%)");
    expect(dates).toContain("6/8 (75.0%)");
    // 40 entries over 4 lists.
    expect(dates.trimEnd().endsWith("10.0")).toBe(true);
  });

  it("writes n/a in the rank columns for subtype, and still gives it an on-list figure", () => {
    const subtype = table[RECALL_FIELDS.indexOf("subtype") + 1];
    expect(subtype).toContain("n/a");
    expect(subtype).toContain("2/4 (50.0%)");
  });

  it("writes n/a rather than dividing by zero for a field nothing was counted for", () => {
    const line = formatRecallTable("", emptyRecallTallies()).split("\n")[
      RECALL_FIELDS.indexOf("cost") + 1
    ];
    expect(line).toContain("0/0 (n/a)");
    expect(line.trimEnd().endsWith("n/a")).toBe(true);
  });
});
