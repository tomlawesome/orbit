import { describe, expect, it } from "vitest";
import { createTestWorkspace } from "./test-workspace";
import { activeHousehold, createEmptyWorkspace, createHousehold, reduceWorkspace, workspaceItemSchema } from "./workspace";

describe("household workspace", () => {
  it("starts with no sample records and requires first-run setup", () => {
    const initial = createEmptyWorkspace();
    const household = activeHousehold(initial);

    expect(household.items).toEqual([]);
    expect(household.activities).toEqual([]);
    expect(household.onboardingComplete).toBe(false);
  });

  it("completes first-run setup with the selected categories", () => {
    const initial = createEmptyWorkspace();
    const sections = [{
      id: "property",
      name: "Property",
      icon: "home" as const,
      accent: "sage" as const,
      visible: true,
    }];
    const configured = reduceWorkspace(initial, {
      type: "household.setup",
      householdId: "local-home",
      name: "The cottage",
      timezone: "Europe/Dublin",
      currency: "EUR",
      sections,
    });

    expect(activeHousehold(configured)).toMatchObject({
      name: "The cottage",
      timezone: "Europe/Dublin",
      currency: "EUR",
      onboardingComplete: true,
      sections,
    });
  });

  it("updates household details after first-run setup", () => {
    const initial = createTestWorkspace();
    const household = activeHousehold(initial);
    const updated = reduceWorkspace(initial, {
      type: "household.update",
      householdId: household.id,
      name: "The cottage",
      timezone: "Europe/Dublin",
      currency: "EUR",
    });

    expect(activeHousehold(updated)).toMatchObject({
      name: "The cottage",
      timezone: "Europe/Dublin",
      currency: "EUR",
    });
  });

  it("creates a household with the default sections and makes it active", () => {
    const initial = createEmptyWorkspace();
    const household = createHousehold({ id: "the-cottage", name: "The cottage" });
    const next = reduceWorkspace(initial, { type: "household.create", household });

    expect(next.activeHouseholdId).toBe("the-cottage");
    expect(activeHousehold(next).sections.map((section) => section.name)).toEqual(["Home", "Vehicles", "Devices", "Services"]);
    expect(activeHousehold(next).items).toEqual([]);
  });

  it("moves items from removed sections into the first retained section", () => {
    const initial = createTestWorkspace();
    const household = activeHousehold(initial);
    const retained = household.sections.filter((section) => section.id !== "vehicle");
    const next = reduceWorkspace(initial, {
      type: "sections.replace",
      householdId: household.id,
      sections: retained,
    });

    expect(activeHousehold(next).sections).toEqual(retained);
    expect(activeHousehold(next).items.find((item) => item.id === "car-insurance")?.sectionId).toBe(retained[0].id);
  });

  it("upserts and archives an item without deleting its history", () => {
    const initial = createEmptyWorkspace();
    const item = {
      id: "roof-cover",
      sectionId: "home",
      title: "Roof cover",
      currency: "GBP",
      status: "active" as const,
      dueDate: "2026-12-01",
      scheduleKind: "renewal" as const,
    };
    const created = reduceWorkspace(initial, { type: "item.upsert", householdId: "local-home", item });
    const archived = reduceWorkspace(created, {
      type: "item.archive",
      householdId: "local-home",
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
    const initial = createTestWorkspace();
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
