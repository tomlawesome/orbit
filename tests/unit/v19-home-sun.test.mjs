import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { FURNACE, POCKET_SUN_R, SUN_R, UNIT, sideOf, sunOf } from "$lib/sun/furnace.js";
import { DEFAULT_THEME, THEME_PACKS } from "$lib/theme.js";

const WEB = resolve(import.meta.dirname, "../../web");

describe("the dial's sun is the Furnace (#1250)", () => {
  it("keeps today's size, from one constant", () => {
    expect(SUN_R).toBe(7);
    expect(POCKET_SUN_R).toBeCloseTo(8);
    expect(sideOf(SUN_R) * UNIT).toBeCloseTo(SUN_R);
  });

  it("gives every pack a sun: after dark follows star chart, clouds follows dawn", () => {
    expect(THEME_PACKS.map((p) => [p, sunOf(p)])).toEqual([
      ["starchart", "starchart"], ["afterdark", "starchart"], ["clouds", "dawn"],
      ["dawn", "dawn"], ["retrograde", "retrograde"],
    ]);
    expect(sunOf(DEFAULT_THEME)).toBe("starchart");
    expect(sunOf(undefined)).toBe("starchart");
  });

  it("ships a still for each sun, and only those", () => {
    for (const key of Object.keys(FURNACE)) {
      expect(existsSync(resolve(WEB, `static/sun/furnace-${key}.webp`)), key).toBe(true);
    }
  });
});
