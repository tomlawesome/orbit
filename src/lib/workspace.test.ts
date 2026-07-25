import { describe, expect, it } from "vitest";
import { activeHousehold, createDemoWorkspace, createHousehold, reduceWorkspace, workspaceItemSchema } from "./workspace";

describe("household workspace", () => {
  it("creates a household with the default sections and makes it active", () => {
    const initial = createDemoWorkspace();
    const household = createHousehold({ id: "the-cottage", name: "The cottage" });
    const next = reduceWorkspace(initial, { type: "household.create", household });

    expect(next.activeHouseholdId).toBe("the-cottage");
    expect(activeHousehold(next).sections.map((section) => section.name)).toEqual(["Home", "Vehicles", "Devices", "Services"]);
    expect(activeHousehold(next).items).toEqual([]);
  });

  it("upserts and archives an item without deleting its history", () => {
    const initial = createDemoWorkspace();
    const item = {
      id: "roof-cover",
      sectionId: "home",
      title: "Roof cover",
      currency: "GBP",
      status: "active" as const,
      dueDate: "2026-12-01",
      scheduleKind: "renewal" as const,
    };
    const created = reduceWorkspace(initial, { type: "item.upsert", householdId: "our-home", item });
    const archived = reduceWorkspace(created, {
      type: "item.archive",
      householdId: "our-home",
      itemId: item.id,
      activity: {
        id: "activity-archive",
        itemId: item.id,
        kind: "archived",
        occurredAt: "2026-07-25T10:00:00.000Z",
      },
    });

    expect(activeHousehold(created).items[0]).toMatchObject(item);
    expect(activeHousehold(archived).items.find((entry) => entry.id === item.id)).toMatchObject({
      status: "archived",
      version: 2,
    });
    expect(activeHousehold(archived).activities[0]).toMatchObject({ itemId: item.id, kind: "archived" });
  });

  it("completes a recurring event, advances its date, and preserves the activity", () => {
    const initial = createDemoWorkspace();
    const activity = {
      id: "activity-renewal",
      itemId: "car-insurance",
      kind: "renewal_completed" as const,
      occurredAt: "2026-07-25T10:00:00.000Z",
      effectiveDate: "2026-07-25",
      previousDate: "2026-07-22",
      nextDate: "2027-07-22",
      costMinor: 61000,
    };
    const completed = reduceWorkspace(initial, {
      type: "item.complete",
      householdId: "our-home",
      itemId: "car-insurance",
      completedDate: "2026-07-25",
      nextDate: "2027-07-22",
      costMinor: 61000,
      activity,
    });
    const household = activeHousehold(completed);

    expect(household.items.find((item) => item.id === "car-insurance")).toMatchObject({
      dueDate: "2027-07-22",
      costMinor: 61000,
      status: "active",
    });
    expect(household.activities[0]).toEqual(activity);
  });

  it("requires a date when a renewal or service schedule is selected", () => {
    expect(workspaceItemSchema.safeParse({
      id: "boiler",
      sectionId: "home",
      title: "Boiler",
      currency: "GBP",
      status: "active",
      scheduleKind: "service",
    }).success).toBe(false);
  });
});
