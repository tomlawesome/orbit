import { describe, expect, it } from "vitest";
import { createTestWorkspace } from "./test-workspace";
import { activeHousehold, createEmptyWorkspace, createHousehold, initialScheduleKind, reduceWorkspace, workspaceCommandSchema, workspaceItemSchema } from "./workspace";

describe("household workspace", () => {
  it("starts with no sample records and requires first-run setup", () => {
    const initial = createEmptyWorkspace();
    const household = activeHousehold(initial);

    expect(initial.householdLanding).toBe("choose");
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
    expect(next.householdLanding).toBe("active");
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
      expectedVersion: 1,
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
      expectedVersion: 1,
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

  it("preserves no-schedule state when editing an unscheduled item", () => {
    expect(initialScheduleKind()).toBe("renewal");
    expect(initialScheduleKind({ scheduleKind: "service" })).toBe("service");
    expect(initialScheduleKind({ scheduleKind: undefined })).toBe("none");

    const scheduleKind = initialScheduleKind({ scheduleKind: undefined });
    expect(workspaceItemSchema.safeParse({
      id: "unscheduled-item",
      sectionId: "home",
      title: "Unscheduled item",
      currency: "GBP",
      status: "active",
      scheduleKind: scheduleKind === "none" ? undefined : scheduleKind,
    }).success).toBe(true);
  });

  it("requires a positive expected version for item transitions", () => {
    const command = {
      type: "item.archive",
      householdId: "household",
      itemId: "item",
      activity: {
        id: "activity",
        itemId: "item",
        kind: "archived" as const,
        occurredAt: "2026-07-25T10:00:00.000Z",
      },
    };

    expect(workspaceCommandSchema.safeParse(command).success).toBe(false);
    expect(workspaceCommandSchema.safeParse({ ...command, expectedVersion: 0 }).success).toBe(false);
    expect(workspaceCommandSchema.safeParse({ ...command, expectedVersion: 1 }).success).toBe(true);
  });

  /*
   * THE ARRIVAL'S CREATE (#410, §15 — "first-run asks three things only").
   * The card knows a name, a time zone and a currency; the sections are the
   * server's, so there is one place that decides what a new system starts with.
   */
  describe("household.create from the arrival's three answers", () => {
    const threeAnswers = {
      type: "household.create",
      household: {
        id: "11111111-2222-3333-4444-555555555555",
        name: "Lawson Home",
        timezone: "Europe/London",
        currency: "GBP",
        onboardingComplete: true,
      },
    };

    it("applies the default sections when the payload carries none", () => {
      const parsed = workspaceCommandSchema.parse(threeAnswers);
      expect(parsed.type).toBe("household.create");
      if (parsed.type !== "household.create") throw new Error("unreachable");
      expect(parsed.household.sections.map((section) => section.name))
        .toEqual(["Home", "Vehicles", "Devices", "Services"]);
      /* each default gets its own identity, never the shared slug-as-id */
      expect(new Set(parsed.household.sections.map((section) => section.id)).size).toBe(4);
      expect(parsed.household.sections.map((section) => section.id))
        .not.toContain("home");
    });

    it("fills the rest of the household the browser cannot know", () => {
      const parsed = workspaceCommandSchema.parse(threeAnswers);
      if (parsed.type !== "household.create") throw new Error("unreachable");
      expect(parsed.household).toMatchObject({
        memberCount: 1,
        canManage: true,
        onboardingComplete: true,
        items: [],
      });
    });

    it("still takes the shipped dashboard's whole household unchanged", () => {
      const household = createHousehold({ id: "22222222-3333-4444-5555-666666666666", name: "The cottage" });
      const parsed = workspaceCommandSchema.parse({ type: "household.create", household });
      if (parsed.type !== "household.create") throw new Error("unreachable");
      expect(parsed.household.sections).toEqual(household.sections);
    });

    it("bounds the words it is given", () => {
      const tooLong = { ...threeAnswers.household, name: "x".repeat(61) };
      expect(workspaceCommandSchema.safeParse({ type: "household.create", household: tooLong }).success).toBe(false);
      const noName = { ...threeAnswers.household, name: "   " };
      expect(workspaceCommandSchema.safeParse({ type: "household.create", household: noName }).success).toBe(false);
      const badCurrency = { ...threeAnswers.household, currency: "POUNDS" };
      expect(workspaceCommandSchema.safeParse({ type: "household.create", household: badCurrency }).success).toBe(false);
      const emptySections = { ...threeAnswers.household, sections: [] };
      expect(workspaceCommandSchema.safeParse({ type: "household.create", household: emptySections }).success).toBe(false);
    });

    it("reduces to an active household with the defaults in place", () => {
      const parsed = workspaceCommandSchema.parse(threeAnswers);
      if (parsed.type !== "household.create") throw new Error("unreachable");
      const next = reduceWorkspace(createEmptyWorkspace(), parsed);
      expect(next.householdLanding).toBe("active");
      expect(next.activeHouseholdId).toBe(threeAnswers.household.id);
      expect(activeHousehold(next).sections.map((section) => section.name))
        .toEqual(["Home", "Vehicles", "Devices", "Services"]);
    });
  });
});
