import { describe, expect, it } from "vitest";

import { KEEP_MS, catchUp } from "../../web/src/lib/flight/first-light.js";

/* #1253: the door's sunrise counts from page load, so a transition that
   started late is moved on by its lateness, never so far it jumps in. */
describe("first light catching up", () => {
  it("leaves a transition that started on time alone", () => {
    expect(catchUp(0, 2600)).toBe(0);
    expect(catchUp(-120, 2600)).toBe(0);
    expect(catchUp(Number.NaN, 2600)).toBe(0);
  });

  it("moves a late transition on by exactly its lateness", () => {
    expect(catchUp(700, 2600)).toBe(700);
    expect(catchUp(700, 1050)).toBe(1050 - KEEP_MS);
  });

  it("always leaves KEEP_MS of a transition still to run", () => {
    expect(catchUp(5000, 2600)).toBe(2600 - KEEP_MS);
    expect(catchUp(5000, 300)).toBe(0);
  });

  it("counts what has already run against what is left", () => {
    expect(catchUp(700, 2600, 20)).toBe(700);
    expect(catchUp(3000, 2600, 20)).toBe(2600 - KEEP_MS - 20);
  });

  it("ignores a transition with no end", () => {
    expect(catchUp(700, Number.POSITIVE_INFINITY)).toBe(0);
  });
});
