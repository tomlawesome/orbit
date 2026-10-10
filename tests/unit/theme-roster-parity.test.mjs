import { describe, expect, it } from "vitest";

import { themePackIsDark, themePacks } from "../../src/lib/preferences.ts";
import { THEME_PACKS, THEME_TABLE } from "../../web/src/lib/theme.js";

/*
 * #1331: the engine (src/lib/preferences.ts) and the browser (web/src/lib/
 * theme.js) each kept a roster, and the two had drifted: the engine offered
 * three packs, the browser five. The engine now owns the roster and the dark
 * flag; the browser table must agree with it, pack for pack.
 */

const ALL_FIVE = ["starchart", "afterdark", "clouds", "dawn", "retrograde"];
const DARK = ["starchart", "afterdark", "retrograde"];
const LIGHT = ["clouds", "dawn"];

describe("the engine's roster (#1331)", () => {
  it("offers all five packs", () => {
    expect([...themePacks].sort()).toEqual([...ALL_FIVE].sort());
  });

  it("flags the dark packs dark and the light packs light", () => {
    for (const id of DARK) expect(themePackIsDark(id), id).toBe(true);
    for (const id of LIGHT) expect(themePackIsDark(id), id).toBe(false);
  });
});

describe("the browser table (#1331)", () => {
  it("lists the five packs in order, each with the full set of fields", () => {
    expect(THEME_TABLE.map((row) => row.id)).toEqual(ALL_FIVE);
    for (const row of THEME_TABLE) {
      for (const key of ["id", "title", "ground", "dark", "emphasis", "sun"]) {
        expect(row, `${row.id} has ${key}`).toHaveProperty(key);
      }
    }
  });

  it("THEME_PACKS is the table's ids, in order", () => {
    expect(THEME_PACKS).toEqual(THEME_TABLE.map((row) => row.id));
  });

  it("gives the star-chart pack the ground #060b1c", () => {
    const row = THEME_TABLE.find((r) => r.id === "starchart");
    expect(row?.ground).toBe("#060b1c");
  });
});

describe("browser and engine agree (#1331)", () => {
  it("name the same set of packs", () => {
    expect(new Set(THEME_TABLE.map((row) => row.id))).toEqual(new Set(themePacks));
  });

  it("agree on which packs are dark", () => {
    for (const row of THEME_TABLE) {
      expect(row.dark, `${row.id} dark flag`).toBe(themePackIsDark(row.id));
    }
  });
});
