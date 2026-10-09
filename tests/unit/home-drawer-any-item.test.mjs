import { describe, expect, it } from "vitest";

import { corridorOf, itemStateOf, manifestRowOf } from "../../web/src/lib/data/chart.js";

/*
 * #1319 stage 3b (the coordinator's ruling, 2026-10-08): the drawer opens any
 * item by id, retired and completed ones included. The row an addressed item
 * is drawn as says its state in its meta, and an item that is not active
 * never wears an urgency.
 */

const TODAY = "2026-10-08";
const household = {
  id: "h1",
  name: "Home",
  sections: [{ id: "s1", name: "Car" }],
  items: [
    { id: "live", title: "MOT", status: "active", sectionId: "s1", dueDate: "2026-10-20", recurrenceMonths: 12 },
    { id: "gone", title: "Old policy", status: "archived", sectionId: "s1", dueDate: "2026-09-01" },
    { id: "stop", title: "Gym", status: "cancelled", sectionId: "s1" },
    { id: "done", title: "Fit the alarm", status: "active", sectionId: "s1" },
    { id: "bare", title: "Someday", status: "active", sectionId: "s1" },
  ],
  activities: [
    { itemId: "done", kind: "created", occurredAt: "2026-05-01T09:00:00.000Z" },
    { itemId: "done", kind: "service_completed", occurredAt: "2026-06-13T09:00:00.000Z", effectiveDate: "2026-06-12" },
    { itemId: "bare", kind: "created", occurredAt: "2026-05-01T09:00:00.000Z" },
  ],
};
const item = (id) => household.items.find((one) => one.id === id);

describe("an item's state, for its row", () => {
  it("names a retired, cancelled or expired item, and says it can be restored", () => {
    expect(itemStateOf(item("gone"), household.activities)).toEqual({ word: "retired", restorable: true });
    expect(itemStateOf(item("stop"), household.activities)).toEqual({ word: "cancelled", restorable: true });
    expect(itemStateOf({ ...item("live"), status: "expired" })).toEqual({ word: "expired", restorable: true });
  });

  it("says when a one-off was done, by the day it was done, not the day it was recorded", () => {
    expect(itemStateOf(item("done"), household.activities)).toEqual({ word: "done 12 Jun", restorable: false });
  });

  it("says nothing of an active item waiting for its date, or one never done", () => {
    expect(itemStateOf(item("live"), household.activities)).toBeNull();
    expect(itemStateOf(item("bare"), household.activities)).toBeNull();
  });
});

describe("a row for any item", () => {
  it("wears the ended tone for an item that is not active, its date kept", () => {
    const row = manifestRowOf(household, item("gone"), TODAY);
    expect(row).toMatchObject({ id: "gone", band: "ended", state: "retired", restorable: true, dueDate: "2026-09-01", section: "Car" });
  });

  it("puts an asked-for retired item on the corridor at its date, never in the red zone or the count", () => {
    const workspace = { households: [household], activeHouseholdId: "h1" };
    const without = corridorOf(workspace, TODAY);
    const withIt = corridorOf(workspace, TODAY, { include: "gone" });
    const ids = (c) => [...c.overdue, ...c.current, ...c.months.flatMap((m) => m.rows), ...c.undated].map((r) => r.id);
    expect(ids(without)).not.toContain("gone");
    expect(ids(withIt)).toContain("gone");
    expect(withIt.overdue.map((r) => r.id)).not.toContain("gone");
    expect(withIt.total).toBe(without.total);
  });
});
