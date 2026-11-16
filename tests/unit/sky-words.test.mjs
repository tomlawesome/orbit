import { describe, expect, it } from "vitest";

import { labelWords, warningHint } from "../../web/src/lib/data/sky-words.js";

/* #1461/#1462: the words of Settings' Planets group (L's own sentences). */
describe("labelWords", () => {
  it.each([
    [0, "none"],
    [1, "within 1 day"],
    [30, "within 30 days"],
    [365, "every planet"],
  ])("%i reads %j", (days, words) => {
    expect(labelWords(days)).toBe(words);
  });
});

describe("warningHint", () => {
  it("is singular for 1 day", () => {
    expect(warningHint(1)).toBe("Your first warning is 1 day before, so each planet sits 1 day nearer the sun, unless an item has its own reminders: then it sits by its largest own day.");
  });

  it("says N days for 14", () => {
    expect(warningHint(14)).toBe("Your first warning is 14 days before, so each planet sits 14 days nearer the sun, unless an item has its own reminders: then it sits by its largest own day.");
  });

  it("says a month for 30 (L's own sentence)", () => {
    expect(warningHint(30)).toBe("Your first warning is 30 days before, so each planet sits a month nearer the sun, unless an item has its own reminders: then it sits by its largest own day.");
  });

  it("#1738 W-F1/W-F2/W-F3: says an item with its own reminders sits by its largest own day, not the first warning", () => {
    const hint = warningHint(14);
    expect(hint, "names items with their own reminders").toMatch(/own reminders?/i);
    expect(hint, "says which of their days is used").toMatch(/largest|furthest|longest/i);
  });

  it.each([null, undefined, 0, 2.5])("is empty for %s", (value) => {
    expect(warningHint(value)).toBe("");
  });
});
