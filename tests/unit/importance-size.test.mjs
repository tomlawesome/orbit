import { describe, expect, it } from "vitest";

import { bodySize, dialBodiesOf, dialPlacement, importanceSize, POCKET_SIZE, DESK_SIZE, seatBodies } from "../../web/src/lib/data/chart.js";

/*
 * #1463: with the user's "planet size shows" setting on importance, a planet's
 * radius comes from its level, not its cost. The sizes are round 6 P's
 * `impSize` and scenes, in the app's own units (the scene units equal the
 * dial units; the cost ranges are DESK_SIZE and POCKET_SIZE):
 *   desk   imp [4.5, 7.5, 11]    low, normal, high; not set = 4.5 - 0.5 = 4
 *   pocket imp [5, 8, 11.5]      low, normal, high; not set = 5 - 0.5 = 4.5
 *
 * Fixed for the build:
 *  - chart.js exports pure `importanceSize(level, scene)`; level is
 *    "low" | "normal" | "high" | null, scene is "desk" | "pocket".
 *  - dialBodiesOf takes `planetSize: "cost" | "importance"` (default cost).
 *    Each body carries `importance` (the item's level or null) and `hollow`
 *    (true only when importance is drawn AND the level is null).
 *    Under importance, `size` and `pocketSize` are the importance sizes.
 *  - Seating uses the sizes actually drawn.
 */
const TODAY = "2026-11-05";
const item = (id, importance, dueDate, extra = {}) => ({
  id, title: id, status: "active", dueDate, kind: "renewal", costMinor: 15000, recurrenceMonths: 12, importance, ...extra,
});
const HOUSEHOLD = {
  items: [
    item("hi", "high", "2026-12-01"),
    item("mid", "normal", "2026-12-20"),
    item("lo", "low", "2027-01-10"),
    item("none", null, "2027-02-10"),
  ],
};
const bodiesOf = (planetSize) => Object.fromEntries(dialBodiesOf(HOUSEHOLD, { today: TODAY, planetSize }).map((b) => [b.id, b]));

describe("importanceSize", () => {
  it.each([
    ["high", 11], ["normal", 7.5], ["low", 4.5], [null, 4],
  ])("desk: %s is %s", (level, size) => {
    expect(importanceSize(level, "desk")).toBe(size);
  });

  it.each([
    ["high", 11.5], ["normal", 8], ["low", 5], [null, 4.5],
  ])("pocket: %s is %s", (level, size) => {
    expect(importanceSize(level, "pocket")).toBe(size);
  });

  it("treats a missing level like not set", () => {
    expect(importanceSize(undefined, "desk")).toBe(4);
    expect(importanceSize(undefined, "pocket")).toBe(4.5);
  });

  it("orders the three levels and puts not set below low", () => {
    for (const scene of ["desk", "pocket"]) {
      const [none, lo, mid, hi] = [null, "low", "normal", "high"].map((l) => importanceSize(l, scene));
      expect(none).toBeLessThan(lo);
      expect(lo).toBeLessThan(mid);
      expect(mid).toBeLessThan(hi);
    }
  });
});

describe("dialBodiesOf with planetSize importance", () => {
  it("sizes each body by its level on the desk and the pocket", () => {
    const b = bodiesOf("importance");
    expect([b.hi.size, b.mid.size, b.lo.size, b.none.size]).toEqual([11, 7.5, 4.5, 4]);
    expect([b.hi.pocketSize, b.mid.pocketSize, b.lo.pocketSize, b.none.pocketSize]).toEqual([11.5, 8, 5, 4.5]);
  });

  it("carries the item's level on the body", () => {
    const b = bodiesOf("importance");
    expect([b.hi.importance, b.mid.importance, b.lo.importance, b.none.importance]).toEqual(["high", "normal", "low", null]);
  });

  it("marks only the not-set body hollow", () => {
    const b = bodiesOf("importance");
    expect([b.hi.hollow, b.mid.hollow, b.lo.hollow, b.none.hollow]).toEqual([false, false, false, true]);
  });

  it("seats with the sizes drawn, on both scenes", () => {
    const crowded = {
      items: ["high", "high", "normal", null, "low"].map((level, i) => item(`c${i}`, level, "2026-12-01", { reminderDays: null })),
    };
    const bodies = dialBodiesOf(crowded, { today: TODAY, planetSize: "importance" });
    expect(bodies.map((b) => b.size)).toEqual([11, 11, 7.5, 4, 4.5]);
    expect(bodies.map((b) => b.pocketSize)).toEqual([11.5, 11.5, 8, 4.5, 5]);
    for (const [sizeKey, placeKey] of [["size", "placement"], ["pocketSize", "pocketPlacement"]]) {
      const unseated = bodies.map((b) => ({ days: b.drivingDays, size: b[sizeKey], ...dialPlacement(b.drivingDays) }));
      const expected = seatBodies(unseated, (x) => x.size);
      bodies.forEach((b, i) => {
        expect(b[placeKey].angle, `${b.id} ${placeKey}`).toBeCloseTo(expected[i].angle, 9);
      });
    }
  });
});

describe("dialBodiesOf with planetSize cost (or unset)", () => {
  it("leaves today's cost sizes unchanged, with or without the option", () => {
    const explicit = bodiesOf("cost");
    const implicit = bodiesOf(undefined);
    for (const id of ["hi", "mid", "lo", "none"]) {
      expect(explicit[id].size).toBe(bodySize(15000, 12, DESK_SIZE));
      expect(explicit[id].pocketSize).toBe(bodySize(15000, 12, POCKET_SIZE));
      expect(implicit[id].size).toBe(explicit[id].size);
      expect(implicit[id].pocketSize).toBe(explicit[id].pocketSize);
    }
  });

  it("marks nothing hollow under cost, not even a not-set item", () => {
    const b = bodiesOf("cost");
    expect(Object.values(b).some((x) => x.hollow)).toBe(false);
  });

  it("still carries the level on the body under cost (the callout reads it)", () => {
    const b = bodiesOf("cost");
    expect([b.hi.importance, b.none.importance]).toEqual(["high", null]);
  });
});
