import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-Q3: dropMark() and reset() both carried the identical
 * `querySelectorAll("#login-glyph svg,#dusk-glyph svg")` loop restoring
 * glyph visibility. A third glyph added to one would have no reason to be
 * added to the other, so reset()'s teardown path (fired on component
 * destroy, e.g. a reader navigating away mid-flight) could silently leave
 * a new glyph hidden.
 *
 * The fix pulls the loop into one restoreGlyphVisibility() both call.
 */

const FLIGHT = readFileSync(
  resolve(import.meta.dirname, "../../web/src/lib/flight/Flight.svelte"),
  "utf8",
);

describe("#1151 W1-Q3: one shared glyph-visibility restore", () => {
  it("declares restoreGlyphVisibility with the querySelectorAll loop", () => {
    const fn = FLIGHT.slice(FLIGHT.indexOf("function restoreGlyphVisibility()"), FLIGHT.indexOf("function restoreGlyphVisibility()") + 300);
    expect(fn).toMatch(/document\.querySelectorAll\("#login-glyph svg,#dusk-glyph svg"\)/u);
  });

  it("dropMark() and reset() both call it instead of repeating the loop", () => {
    const dropMark = FLIGHT.slice(FLIGHT.indexOf("function dropMark()"), FLIGHT.indexOf("function dropMark()") + 200);
    expect(dropMark).toMatch(/restoreGlyphVisibility\(\);/u);
    const reset = FLIGHT.slice(FLIGHT.indexOf("export function reset()"), FLIGHT.indexOf("export function reset()") + 500);
    expect(reset).toMatch(/restoreGlyphVisibility\(\);/u);
  });

  it("the loop itself appears exactly once in the file", () => {
    const matches = [...FLIGHT.matchAll(/document\.querySelectorAll\("#login-glyph svg,#dusk-glyph svg"\)/gu)];
    expect(matches.length).toBe(1);
  });
});
