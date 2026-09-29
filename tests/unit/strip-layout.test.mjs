import { describe, expect, it } from "vitest";

import { assignTiers, leaderPathOf, monthTicks, stripActsOf, UNSCHEDULED_X, xOfDays } from "../../web/src/routes/home/strip-layout.js";

/* #1161, C · unrolled (design/v19/search/round-1/BUILD.md §3/§4): the desk
   search strip's pure geometry, tested the way pocket-dial.js's spacing law
   is — directly, off the screen. */

describe("xOfDays", () => {
  it("places the axis's own limits at its own edges", () => {
    expect(xOfDays(-40)).toBeCloseTo(30, 5);
    expect(xOfDays(356)).toBeCloseTo(790, 5);
  });

  it("places today a little past the axis's left third", () => {
    expect(xOfDays(0)).toBeCloseTo(106.8, 1);
  });

  it("clamps beyond either limit rather than running off the axis", () => {
    expect(xOfDays(-400)).toBeCloseTo(30, 5);
    expect(xOfDays(4000)).toBeCloseTo(790, 5);
  });
});

describe("monthTicks", () => {
  it("ticks every 1st-of-month from tomorrow through +356 days", () => {
    const ticks = monthTicks("2026-08-13");
    expect(ticks.map((t) => t.name)).toEqual([
      "SEP", "OCT", "NOV", "DEC", "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG",
    ]);
    expect(ticks[0]).toMatchObject({ name: "SEP", days: 19 });
    expect(ticks.at(-1)).toMatchObject({ name: "AUG", days: 353 });
  });

  it("never ticks a month beyond the +356 day ceiling", () => {
    const ticks = monthTicks("2026-08-13");
    for (const tick of ticks) expect(tick.days).toBeLessThanOrEqual(356);
  });
});

describe("assignTiers", () => {
  it("puts an isolated mark's label above, on the axis", () => {
    const [a] = assignTiers([{ x: 200, width: 80 }]);
    expect(a).toMatchObject({ tier: 0, labelled: true, flip: false });
  });

  it("drops a close neighbour's label below rather than overlapping it", () => {
    const [a, b] = assignTiers([{ x: 200, width: 80 }, { x: 211, width: 80 }]);
    expect(a.tier).toBe(0);
    expect(b).toMatchObject({ tier: 1, labelled: true });
  });

  it("leaves a third mark with neither tier free unlabelled, not overlapping", () => {
    const marks = [{ x: 200, width: 80 }, { x: 211, width: 80 }, { x: 205, width: 80 }];
    const placed = assignTiers(marks);
    const unlabelled = placed.filter((m) => !m.labelled);
    expect(unlabelled).toHaveLength(1);
    expect(placed.filter((m) => m.labelled)).toHaveLength(2);
  });

  it("flips a label whose width would run past the strip's right edge", () => {
    const [a] = assignTiers([{ x: 780, width: 60 }]);
    expect(a.flip).toBe(true);
  });

  it("does not flip a label that fits inside the strip", () => {
    const [a] = assignTiers([{ x: 200, width: 60 }]);
    expect(a.flip).toBe(false);
  });
});

describe("leaderPathOf", () => {
  it("runs the horizontal segment from x to x+width, tier 0, unflipped", () => {
    expect(leaderPathOf({ x: 200, width: 80, r: 4, tier: 0, flip: false })).toBe("M200 71 V62 H280");
  });

  it("runs the horizontal segment from x to x+width, tier 1, unflipped", () => {
    expect(leaderPathOf({ x: 200, width: 80, r: 4, tier: 1, flip: false })).toBe("M200 81 V102 H280");
  });

  it("mirrors the run to x-width under a flipped, right-anchored label", () => {
    expect(leaderPathOf({ x: 780, width: 60, r: 4, tier: 0, flip: true })).toBe("M780 71 V62 H720");
  });
});

describe("the unscheduled anchor", () => {
  it("sits at the axis's own right edge, x=790", () => {
    expect(UNSCHEDULED_X).toBe(790);
    expect(xOfDays(356)).toBeCloseTo(UNSCHEDULED_X, 5);
  });
});

/* #1162: the note-line acts BUILD.md §1 left inert, wired up. */
describe("stripActsOf", () => {
  const closest = { id: "i-boiler", title: "boiler service" };

  it("at rest, offers complete-the-closest then add, unarmed", () => {
    const acts = stripActsOf({ searchQuery: "", nothing: false, query: "", closest, completeArmed: false });
    expect(acts).toEqual([
      { kind: "complete", itemId: "__complete__", title: 'complete "boiler service"', target: closest },
      { kind: "add", itemId: "__add__", title: "add an item", name: "" },
    ]);
  });

  it("at rest with nothing due, offers only add", () => {
    const acts = stripActsOf({ searchQuery: "", nothing: false, query: "", closest: null, completeArmed: false });
    expect(acts).toEqual([{ kind: "add", itemId: "__add__", title: "add an item", name: "" }]);
  });

  it("armed, the complete act's title asks for the second tap", () => {
    const acts = stripActsOf({ searchQuery: "", nothing: false, query: "", closest, completeArmed: true });
    expect(acts[0]).toMatchObject({ title: 'tap again to complete "boiler service"' });
  });

  it("a query with real matches offers no act", () => {
    const acts = stripActsOf({ searchQuery: "mo", nothing: false, query: "mo", closest, completeArmed: false });
    expect(acts).toEqual([]);
  });

  it("a query matching nothing offers add-as-an-item, carrying the typed name", () => {
    const acts = stripActsOf({ searchQuery: "zzz", nothing: true, query: "zzz", closest, completeArmed: false });
    expect(acts).toEqual([{ kind: "add", itemId: "__add__", title: 'add "zzz" as an item', name: "zzz" }]);
  });
});
