import { describe, expect, it } from "vitest";

// #867 — the pen's whole set of marks: one table (MARKS), the household's
// own assignment order (nextMark, PEN_ORDER) and which glyphs are shipped
// (never a button). Plain data, no DOM — the same shape as the chart
// transform's own tests.
import { MARKS, PEN_ORDER, SHIPPED_MARKS, SHIPPED_SECTION_IDS, inkOf, nextMark } from "../../web/src/lib/marks.js";

describe("the pen's set", () => {
  it("has twelve marks — five shipped glyphs, seven asterisms — the cap", () => {
    expect(Object.keys(MARKS)).toHaveLength(12);
    expect(PEN_ORDER).toHaveLength(7);
    expect(SHIPPED_MARKS.size).toBe(5);
  });

  it("draws every mark from real elements, never raw markup", () => {
    // The ratified design: "nothing filled, one accent dot as today." The
    // accent dot is `.mark i`, drawn in CSS — nothing here carries a fill,
    // and every element is a plain path/rect/node Mark.svelte renders
    // itself rather than an `{@html}` string.
    for (const [icon, glyph] of Object.entries(MARKS)) {
      expect(glyph.paths ?? glyph.rects ?? glyph.nodes, icon).toBeTruthy();
      for (const path of glyph.paths ?? []) expect(typeof path.d, icon).toBe("string");
    }
  });

  it("gives every asterism a fixed ink — icon and accent are never chosen apart", () => {
    expect(PEN_ORDER.map(inkOf)).toEqual(["sage", "blue", "sand", "plum", "coral", "sage", "blue"]);
  });

  it("recycles the five inks after five asterisms — the sixth is sage again, like home", () => {
    // Owner's own words (a-asterisms.html's README): "Boat is sage like
    // Home." Boat is this issue's "hook", the pen's first asterism.
    expect(inkOf("hook")).toBe(inkOf("home"));
    expect(inkOf("belt")).toBe(inkOf("vehicle"));
  });
});

describe("assignment: the first figure the pen has not used", () => {
  it("wears hook, the pen's first asterism, in a household with none yet", () => {
    expect(nextMark([])).toBe("hook");
  });

  it("skips whatever this household has already worn, in pen order", () => {
    expect(nextMark(["hook"])).toBe("kite");
    expect(nextMark(["hook", "kite"])).toBe("ladle");
  });

  it("is not confused by the five shipped glyphs also being worn", () => {
    // Every household wears "home", "vehicle", etc. from the day it exists —
    // none of that should ever count against the seven-asterism pool.
    expect(nextMark(["home", "vehicle", "device", "service"])).toBe("hook");
  });

  it("ignores order: it is the set of worn marks, not the sequence they arrived in", () => {
    expect(nextMark(["kite", "hook"])).toBe("ladle");
  });

  it("recycles from the start once every asterism is worn, rather than leaving a section markless", () => {
    expect(nextMark(PEN_ORDER)).toBe("hook");
    expect(nextMark([...PEN_ORDER, "hook"])).toBe("hook");
  });
});

describe("shipped: which marks are fixed, never a button", () => {
  it("is the household's four real default sections, by id", () => {
    expect(SHIPPED_SECTION_IDS.has("home")).toBe(true);
    expect(SHIPPED_SECTION_IDS.has("vehicle")).toBe(true);
    expect(SHIPPED_SECTION_IDS.has("device")).toBe(true);
    expect(SHIPPED_SECTION_IDS.has("service")).toBe(true);
  });

  it("never includes a user section's own id, however it was named", () => {
    expect(SHIPPED_SECTION_IDS.has("calendar")).toBe(false);
    expect(SHIPPED_SECTION_IDS.has(crypto.randomUUID())).toBe(false);
  });
});
