import { describe, expect, it } from "vitest";

import {
  bestSupported,
  contextWindow,
  entryChosen,
  replyLines,
  shortlistExcerpt,
  SENTENCE_LIMIT,
  type ShortlistEntry,
} from "./extraction-shortlist";

function entry(value: string, support: number, line = value): ShortlistEntry {
  return { value, display: value, line, why: ["sieves: label"], support };
}

describe("ranking the shortlist", () => {
  it("puts the best-spoken-for first and keeps page order where nothing separates two", () => {
    const ranked = bestSupported([entry("a", 1), entry("b", 3), entry("c", 1)]);
    expect(ranked.map((held) => held.value)).toEqual(["b", "a", "c"]);
  });

  it("hands over no more than the cap", () => {
    const many = Array.from({ length: 20 }, (_, at) => entry(String(at), 20 - at));
    expect(bestSupported(many)).toHaveLength(8);
    expect(bestSupported(many, 3).map((held) => held.value)).toEqual(["0", "1", "2"]);
  });
});

describe("the words either side of the candidate", () => {
  const arranged =
    "This schedule confirms the cover you asked for. Your household policy is arranged by " +
    "Hedgerow Insurance Services Ltd and underwritten by Thornfield Assurance plc. " +
    "Both firms are authorised and regulated by the Financial Conduct Authority.";
  const hedgerow = entry("Hedgerow Insurance Services Ltd", 9, arranged);

  it("gives the whole sentence the candidate sits in, with its own words marked", () => {
    expect(contextWindow(hedgerow, "sentence")).toBe(
      "Your household policy is arranged by «Hedgerow Insurance Services Ltd» " +
      "and underwritten by Thornfield Assurance plc.",
    );
  });

  it("ends a sentence at a table cell or a bullet as well as at a full stop", () => {
    const cells = entry(
      "Millbrook Energy",
      3,
      "Account 7738 2204 91 | Supplier Millbrook Energy Ltd | Tariff Fixed Saver",
    );
    expect(contextWindow(cells, "sentence")).toBe("Supplier «Millbrook Energy» Ltd");
  });

  it("does not let one runaway block fill the excerpt", () => {
    const runaway = entry("Colworth & Drake", 5, `${"word ".repeat(200)}Colworth & Drake${" word".repeat(200)}`);
    const shown = contextWindow(runaway, "sentence");
    expect(shown.length).toBeLessThanOrEqual(SENTENCE_LIMIT + 8);
    expect(shown.startsWith("… ")).toBe(true);
    expect(shown.endsWith(" …")).toBe(true);
    expect(shown).toContain("«Colworth & Drake»");
  });

  it("gives that many words either side, and says where it left more behind", () => {
    expect(contextWindow(hedgerow, "w5")).toBe(
      "… household policy is arranged by «Hedgerow Insurance Services Ltd» " +
      "and underwritten by Thornfield Assurance …",
    );
    expect(contextWindow(hedgerow, "w10")).toBe(
      "… cover you asked for. Your household policy is arranged by " +
      "«Hedgerow Insurance Services Ltd» " +
      "and underwritten by Thornfield Assurance plc. Both firms are authorised …",
    );
  });

  it("stops at the block's own ends rather than inventing words", () => {
    const alone = entry("Kestrel Mutual", 2, "Kestrel Mutual");
    expect(contextWindow(alone, "w15")).toBe("«Kestrel Mutual»");
    expect(contextWindow(alone, "sentence")).toBe("«Kestrel Mutual»");
  });

  it("centres the block control on the candidate rather than starting from the block's head", () => {
    const shown = contextWindow(hedgerow, "block");
    expect(shown).toContain("«Hedgerow Insurance Services Ltd»");
    expect(shown.startsWith("… ")).toBe(true);
    expect(shown.endsWith(" …")).toBe(true);
  });

  it("never cuts a word in half at either end", () => {
    const wordy = entry(
      "Ravensmere",
      1,
      `${"abcdefghij ".repeat(20)}Ravensmere${" klmnopqrst".repeat(20)}`,
    );
    const shown = contextWindow(wordy, "block");
    expect(shown).toBe(`… ${"abcdefghij ".repeat(5)}«Ravensmere»${" klmnopqrst".repeat(5)} …`);
    expect(shown.length).toBeLessThanOrEqual(140 + 4);
  });

  it("falls back to the head of the block where the block does not carry the candidate", () => {
    const minor = { value: "41299", display: "£412.99", line: "Total premium 412.99 GBP", why: [], support: 2 };
    expect(contextWindow(minor, "sentence")).toBe("Total premium 412.99 GBP");
  });
});

describe("the excerpt the model reads", () => {
  it("numbers each entry and gives it its reasons and the words around it", () => {
    const excerpt = shortlistExcerpt("Amounts printed on this page:", [
      { value: "41299", display: "£412.99", line: "Total premium £412.99", why: ["read as the total"], support: 4 },
      { value: "3441", display: "£34.41", line: "Monthly £34.41", why: [], support: 1 },
    ]);

    expect(excerpt.split("\n")).toEqual([
      "Amounts printed on this page:",
      `1. £412.99 (read as the total): "Total premium «£412.99»"`,
      `2. £34.41: "Monthly «£34.41»"`,
    ]);
  });

  it("stops at the limit rather than handing over the page", () => {
    const long = Array.from({ length: 40 }, (_, at) => entry(`candidate ${at}`, 1, "x".repeat(200)));
    expect(shortlistExcerpt("Heading:", long).length).toBeLessThanOrEqual(1_500);
  });
});

describe("reading whatever the model answered", () => {
  const entries = [entry("first", 2), entry("second", 1)];

  it("takes the number it was asked for", () => {
    expect(entryChosen("2", entries)?.value).toBe("second");
    expect(entryChosen("Answer: 1", entries)?.value).toBe("first");
  });

  it("takes the value written out", () => {
    expect(entryChosen("SECOND", entries)?.value).toBe("second");
  });

  it("takes nothing for none, for an empty answer, and for a number off the list", () => {
    expect(entryChosen("none", entries)).toBeUndefined();
    expect(entryChosen("   ", entries)).toBeUndefined();
    expect(entryChosen("7", entries)).toBeUndefined();
  });

  it("asks the field's own matcher where the words are not the list's", () => {
    const matches = (answer: string, held: ShortlistEntry) => answer.includes(held.value);
    expect(entryChosen("the second one", entries, { matches })?.value).toBe("second");
  });

  it("tries the matcher first where a real answer starts with a number", () => {
    const dates = [entry("2026-10-31", 2), entry("2025-11-01", 1)];
    const matches = (answer: string, held: ShortlistEntry) => answer.includes(held.value.slice(0, 4));
    expect(entryChosen("2025-11-01", dates, { matches, matchesFirst: true })?.value).toBe("2025-11-01");
  });
});

describe("reading a reply of any shape", () => {
  it("splits a plain reply into lines", () => {
    expect(replyLines("1 renewal\n2 start")).toEqual(["1 renewal", "2 start"]);
  });

  it("flattens the JSON a structured model returns into the same lines", () => {
    expect(replyLines('[{"date": "1", "what_it_is_for": "renewal"}]')).toEqual(["1 renewal"]);
    expect(replyLines('{"answer": "3"}')).toEqual(["3"]);
    expect(replyLines('{"dates": [{"date": "2", "role": "start"}]}')).toEqual(["2 start"]);
  });

  it("has nothing to read in an empty reply", () => {
    expect(replyLines("")).toEqual([]);
  });
});
