import { describe, expect, it } from "vitest";
import { createTestWorkspace } from "./test-workspace";
import { AppError } from "./errors";
import { activeHousehold, createEmptyWorkspace, createHousehold, initialScheduleKind, parseWorkspaceCommand, reduceWorkspace, workspaceCommandSchema, workspaceItemSchema, workspaceSchema, type WorkspaceState } from "./workspace";
import { COST_MINOR_MAX, NOTES_MAX, RECURRENCE_MAX, REMINDER_DAYS_MAX, REMINDER_MAX, TITLE_MAX, defaultSections, type HomeItem } from "./domain";

const defaultSectionsForTest = () => defaultSections.map((section) => ({ ...section }));

/** The test workspace with one more renewal item, shaped by `changes`. */
function withItem(state: WorkspaceState, changes: Partial<HomeItem> & { id: string }): WorkspaceState {
  const household = activeHousehold(state);
  const item: HomeItem = {
    sectionId: "home", title: changes.id, currency: "GBP", status: "active", version: 1,
    scheduleKind: "renewal", dueDate: "2026-07-22", recurrenceMonths: 12, ...changes,
  };
  return { ...state, households: [{ ...household, items: [item, ...household.items] }] };
}

/** Completes `itemId` on `completedDate`, sending only what a client may. */
function complete(state: WorkspaceState, itemId: string, completedDate: string): WorkspaceState {
  return reduceWorkspace(state, {
    type: "item.complete",
    householdId: "our-home",
    itemId,
    expectedVersion: 1,
    completedDate,
    activity: { id: `complete-${itemId}`, itemId, occurredAt: `${completedDate}T10:00:00.000Z` },
  });
}

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

  it("moves items from removed sections into the section the command names", () => {
    const initial = createTestWorkspace();
    const household = activeHousehold(initial);
    const retained = household.sections.filter((section) => section.id !== "vehicle");
    const destination = retained[retained.length - 1].id;
    expect(destination).not.toBe(retained[0].id);
    const next = reduceWorkspace(initial, {
      type: "sections.replace",
      householdId: household.id,
      sections: retained,
      moveItemsTo: destination,
    });

    expect(activeHousehold(next).sections).toEqual(retained);
    expect(activeHousehold(next).items.find((item) => item.id === "car-insurance")?.sectionId).toBe(destination);
  });

  it("leaves everything as it was when a section that holds items is dropped with no destination, as the engine refuses to", () => {
    const initial = createTestWorkspace();
    const household = activeHousehold(initial);
    const retained = household.sections.filter((section) => section.id !== "vehicle");
    expect(reduceWorkspace(initial, { type: "sections.replace", householdId: household.id, sections: retained })).toEqual(initial);
    expect(reduceWorkspace(initial, {
      type: "sections.replace", householdId: household.id, sections: retained, moveItemsTo: "vehicle",
    })).toEqual(initial);
  });

  it("upserts and archives an item without deleting its history", () => {
    const initial = createEmptyWorkspace();
    const item = {
      id: "roof-cover",
      sectionId: "home",
      title: "Roof cover",
      currency: "GBP",
      dueDate: "2026-12-01",
    };
    const created = reduceWorkspace(initial, { type: "item.upsert", householdId: "local-home", kind: "renewal", item });
    const archived = reduceWorkspace(created, {
      type: "item.archive",
      householdId: "local-home",
      itemId: item.id,
      expectedVersion: 1,
      activity: {
        id: "activity-archive",
        itemId: item.id,
        occurredAt: "2026-07-25T10:00:00.000Z",
      },
    });

    expect(activeHousehold(created).items[0]).toMatchObject({ ...item, status: "active", scheduleKind: "renewal", subtype: "renewal" });
    expect(activeHousehold(archived).items.find((entry) => entry.id === item.id)).toMatchObject({
      status: "archived",
      version: 2,
    });
    expect(activeHousehold(archived).activities[0]).toMatchObject({ itemId: item.id, kind: "archived" });
  });

  it("completes a recurring event and works out its next date from the period", () => {
    const initial = createTestWorkspace();
    const activity = {
      id: "activity-renewal",
      itemId: "car-insurance",
      occurredAt: "2026-07-25T10:00:00.000Z",
      effectiveDate: "2026-07-25",
      previousDate: "2026-07-22",
      costMinor: 61000,
    };
    // #1324: no next date is sent; the item's 12-month period gives it.
    const completed = reduceWorkspace(initial, {
      type: "item.complete",
      householdId: "our-home",
      itemId: "car-insurance",
      expectedVersion: 1,
      completedDate: "2026-07-25",
      costMinor: 61000,
      activity,
    });
    const household = activeHousehold(completed);

    expect(household.items.find((item) => item.id === "car-insurance")).toMatchObject({
      dueDate: "2027-07-25",
      scheduleKind: "renewal",
      recurrenceMonths: 12,
      reminderDays: [30, 7, 1],
      costMinor: 61000,
      status: "active",
    });
    // The activity records the next date the engine chose.
    // The activity records the kind the engine named (#1325) and the next date it chose.
    expect(household.activities[0]).toEqual({ ...activity, kind: "renewal_completed", nextDate: "2027-07-25" });
  });

  it("clamps a month-end completion to the end of a shorter month", () => {
    const initial = withItem(createTestWorkspace(), { id: "monthly", recurrenceMonths: 1, dueDate: "2026-01-31" });
    const household = activeHousehold(complete(initial, "monthly", "2026-01-31"));
    expect(household.items.find((item) => item.id === "monthly")?.dueDate).toBe("2026-02-28");
  });

  it("ends the schedule when the item has no period", () => {
    const initial = withItem(createTestWorkspace(), { id: "once", recurrenceMonths: undefined, reminderDays: [7] });
    const household = activeHousehold(complete(initial, "once", "2026-07-25"));
    const item = household.items.find((entry) => entry.id === "once");
    expect(item).toMatchObject({ status: "active" });
    expect(item?.dueDate).toBeUndefined();
    expect(item?.scheduleKind).toBeUndefined();
    expect(item?.reminderDays).toBeUndefined();
    expect(household.activities[0]?.nextDate).toBeUndefined();
  });

  it("ends the schedule when an expiry is completed (#1005)", () => {
    const initial = withItem(createTestWorkspace(), { id: "passport", scheduleKind: "expiry", recurrenceMonths: undefined });
    const household = activeHousehold(complete(initial, "passport", "2026-07-25"));
    const item = household.items.find((entry) => entry.id === "passport");
    expect(item?.dueDate).toBeUndefined();
    expect(item?.scheduleKind).toBeUndefined();
  });

  it("refuses a next due date sent with a completion (#1324)", () => {
    const command = {
      type: "item.complete",
      householdId: "our-home",
      itemId: "car-insurance",
      expectedVersion: 1,
      completedDate: "2026-07-25",
      activity: { id: "a", itemId: "car-insurance", occurredAt: "2026-07-25T10:00:00.000Z" },
    };
    expect(parseWorkspaceCommand(command)).toMatchObject({ type: "item.complete", completedDate: "2026-07-25" });

    for (const sent of [
      { ...command, nextDate: "2027-07-25" },
      { ...command, activity: { ...command.activity, nextDate: "2027-07-25" } },
    ]) {
      expect(() => parseWorkspaceCommand(sent)).toThrow(AppError);
      try {
        parseWorkspaceCommand(sent);
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_command", status: 400 });
        expect((error as Error).message).toMatch(/does not send the next due date/);
      }
      // The schema on its own refuses it too, rather than quietly dropping it.
      expect(workspaceCommandSchema.safeParse(sent).success).toBe(false);
    }
  });

  describe("an item carries intent, and the engine refuses in the member's words (#1325)", () => {
    const upsert = (item: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
      type: "item.upsert",
      householdId: "our-home",
      kind: "service",
      item: { id: "mot", sectionId: "garage", title: "MOT", currency: "GBP", dueDate: "2026-11-02", recurrenceMonths: 12, ...item },
      ...extra,
    });
    const refusalOf = (input: unknown) => {
      try {
        parseWorkspaceCommand(input);
      } catch (error) {
        return error as AppError;
      }
      return null;
    };

    it("parses the kind beside the item", () => {
      expect(parseWorkspaceCommand(upsert())).toMatchObject({ type: "item.upsert", kind: "service", item: { title: "MOT" } });
    });

    it.each(["scheduleKind", "subtype", "status"])("refuses a client-sent %s", (field) => {
      const sent = upsert({ [field]: field === "status" ? "active" : "service" });
      expect(refusalOf(sent)).toMatchObject({ code: "invalid_command", status: 400 });
      expect(refusalOf(sent)?.message).toMatch(/works them out from the kind/);
      // The schema on its own refuses it too, rather than quietly dropping it.
      expect(workspaceCommandSchema.safeParse(sent).success).toBe(false);
    });

    it("refuses a missing name, section, bad cost, dateless repeat and too many reminders in the member's words", () => {
      expect(refusalOf(upsert({ title: " " }))).toMatchObject({ status: 422, code: "item_name_missing", message: "not yet — give it a name" });
      expect(refusalOf(upsert({ sectionId: null }))).toMatchObject({ code: "item_section_missing", message: "not yet — choose a section" });
      expect(refusalOf(upsert({ cost: "12,50" }))).toMatchObject({ code: "cost_format", message: "not yet — use a dot for pence, for example 12.50" });
      expect(refusalOf(upsert({ dueDate: undefined }))).toMatchObject({ code: "repeat_needs_date" });
      expect(refusalOf(upsert({ reminderDays: [1, 2, 3, 4, 5, 6, 7, 8, 9] }))).toMatchObject({ message: "not yet — at most 8 reminders" });
      expect(refusalOf(upsert({ reminderDays: [366] }))).toMatchObject({ message: "not yet — a reminder is at most 365 days before" });
    });

    it("reads a typed cost into minor units, and refuses one sent both ways", () => {
      expect(parseWorkspaceCommand(upsert({ cost: "£1,250.50" }))).toMatchObject({ item: { costMinor: 125050 } });
      expect((parseWorkspaceCommand(upsert({ cost: "" })) as { item: object }).item).not.toHaveProperty("costMinor");
      expect(refusalOf(upsert({ cost: "12", costMinor: 1200 }))).toMatchObject({ code: "invalid_command" });
    });

    it("maps the kind in the reducer: a new item is active with the kind's schedule", () => {
      const state = reduceWorkspace(createTestWorkspace(), parseWorkspaceCommand(upsert({ sectionId: "home" }, { kind: "inspection" })));
      expect(activeHousehold(state).items[0]).toMatchObject({ id: "mot", status: "active", scheduleKind: "service", subtype: "inspection" });
    });

    it("reads a completion's typed cost, onto its activity too, and asks for its day", () => {
      const complete = {
        type: "item.complete", householdId: "our-home", itemId: "car-insurance", expectedVersion: 1, completedDate: "2026-07-25",
        activity: { id: "a", itemId: "car-insurance", occurredAt: "2026-07-25T10:00:00.000Z" },
      };
      expect(parseWorkspaceCommand({ ...complete, cost: "£610" })).toMatchObject({ costMinor: 61000, activity: { costMinor: 61000 } });
      expect(refusalOf({ ...complete, cost: "6,10" })).toMatchObject({ code: "cost_format" });
      expect(refusalOf({ ...complete, completedDate: "" })).toMatchObject({ code: "completed_date_missing", message: "not yet — choose the day it was done" });
    });
  });

  describe("activity kinds are the engine's (#1325)", () => {
    const status = (to: "active" | "cancelled", extra: Record<string, unknown> = {}) => ({
      type: "item.status", householdId: "our-home", itemId: "car-insurance", expectedVersion: 1, status: to,
      activity: { id: `status-${to}`, itemId: "car-insurance", occurredAt: "2026-07-25T10:00:00.000Z", ...extra },
    });

    it("records a cancellation and a restore", () => {
      const cancelled = reduceWorkspace(createTestWorkspace(), parseWorkspaceCommand(status("cancelled")));
      expect(activeHousehold(cancelled).activities[0]).toMatchObject({ id: "status-cancelled", kind: "cancelled" });
      const restored = reduceWorkspace(cancelled, parseWorkspaceCommand({ ...status("active"), expectedVersion: 2 }));
      expect(activeHousehold(restored).activities[0]).toMatchObject({ id: "status-active", kind: "restored" });
    });

    it("names a service's completion a service completed", () => {
      const state = withItem(createTestWorkspace(), { id: "boiler", scheduleKind: "service" });
      expect(activeHousehold(complete(state, "boiler", "2026-07-25")).activities[0]).toMatchObject({ kind: "service_completed" });
    });

    it("names created and updated for an upsert, and archived, rescheduled and snoozed for theirs", () => {
      const at = "2026-07-25T10:00:00.000Z";
      const upsert = (id: string, title: string, version?: number) => parseWorkspaceCommand({
        type: "item.upsert", householdId: "our-home", kind: "service",
        item: { id, sectionId: "home", title, currency: "GBP", ...(version ? { version } : {}) },
        activity: { id: `upsert-${title}`, itemId: id, occurredAt: at },
      });
      let state = reduceWorkspace(createTestWorkspace(), upsert("boiler", "Boiler"));
      expect(activeHousehold(state).activities[0]).toMatchObject({ id: "upsert-Boiler", kind: "created" });
      state = reduceWorkspace(state, upsert("boiler", "Boiler service", 2));
      expect(activeHousehold(state).activities[0]).toMatchObject({ id: "upsert-Boiler service", kind: "updated" });

      const transition = (type: string, extra: Record<string, unknown>) => parseWorkspaceCommand({
        type, householdId: "our-home", itemId: "car-insurance", expectedVersion: 1,
        activity: { id: type, itemId: "car-insurance", occurredAt: at }, ...extra,
      });
      for (const [type, extra, kind] of [
        ["item.reschedule", { dueDate: "2026-09-01" }, "rescheduled"],
        ["item.snooze", { snoozedUntil: "2026-08-01" }, "snoozed"],
        ["item.archive", {}, "archived"],
      ] as const) {
        const next = reduceWorkspace(createTestWorkspace(), transition(type, extra));
        expect(activeHousehold(next).activities[0]).toMatchObject({ id: type, kind });
      }
    });

    it.each(["item.upsert", "item.archive", "item.reschedule", "item.snooze"])("refuses a kind sent on %s", (type) => {
      const activity = { id: "a", itemId: "car-insurance", kind: "updated", occurredAt: "2026-07-25T10:00:00.000Z" };
      const command = type === "item.upsert"
        ? { type, householdId: "our-home", item: { id: "car-insurance", sectionId: "home", title: "Car", currency: "GBP" }, activity }
        : { type, householdId: "our-home", itemId: "car-insurance", expectedVersion: 1, dueDate: "2026-09-01", snoozedUntil: "2026-08-01", activity };
      expect(() => parseWorkspaceCommand(command)).toThrow(/does not send its activity's kind/);
      expect(workspaceCommandSchema.safeParse(command).success).toBe(false);
    });

    it("refuses a kind sent on a completion or a status change", () => {
      expect(() => parseWorkspaceCommand(status("cancelled", { kind: "cancelled" }))).toThrow(/does not send its activity's kind/);
      expect(() => parseWorkspaceCommand({
        type: "item.complete", householdId: "our-home", itemId: "car-insurance", expectedVersion: 1, completedDate: "2026-07-25",
        activity: { id: "a", itemId: "car-insurance", kind: "renewal_completed", occurredAt: "2026-07-25T10:00:00.000Z" },
      })).toThrow(/does not send its activity's kind/);
    });
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

  describe("the engine validates what it stores (#1333)", () => {
    const base = { householdId: "our-home", itemId: "mot", expectedVersion: 1 };
    const activity = { id: "a-1", itemId: "mot", occurredAt: "2026-07-01T10:00:00.000Z" };
    const refused = (input: unknown) => {
      let failure: unknown = null;
      try {
        parseWorkspaceCommand(input);
      } catch (error) {
        failure = error;
      }
      return failure !== null;
    };
    const upsertWith = (item: Record<string, unknown>) => ({
      type: "item.upsert",
      householdId: "our-home",
      kind: "service",
      item: { id: "mot", sectionId: "garage", title: "MOT", currency: "GBP", dueDate: "2026-11-02", ...item },
    });
    const setupWith = (changes: Record<string, unknown>) => ({
      type: "household.update",
      householdId: "our-home",
      name: "Home",
      timezone: "Europe/London",
      currency: "GBP",
      ...changes,
    });

    it.each(["2026-02-31", "2026-13-45", "2027-02-29", "2026-04-31", "2026-00-10", "2026-01-00"])(
      "refuses %s as a due, snooze or completed date",
      (date) => {
        expect(refused({ type: "item.reschedule", ...base, dueDate: date, activity })).toBe(true);
        expect(refused({ type: "item.snooze", ...base, snoozedUntil: date, activity })).toBe(true);
        expect(refused({ type: "item.complete", ...base, completedDate: date, activity })).toBe(true);
        expect(refused(upsertWith({ dueDate: date }))).toBe(true);
        expect(refused(upsertWith({ snoozedUntil: date }))).toBe(true);
      },
    );

    it.each(["2028-02-29", "2026-12-31", "2000-02-29"])("accepts the real day %s", (date) => {
      expect(refused({ type: "item.reschedule", ...base, dueDate: date, activity })).toBe(false);
      expect(refused(upsertWith({ dueDate: date }))).toBe(false);
    });

    it.each(["1900-02-29", "2100-02-29"])("applies the century rule: %s is not a day", (date) => {
      expect(refused({ type: "item.reschedule", ...base, dueDate: date, activity })).toBe(true);
    });

    it.each(["ZZZ", "gbp", "GB", "£££", "GBPP", "XXX"])("refuses %s as a currency everywhere one is stored", (currency) => {
      expect(refused(upsertWith({ currency }))).toBe(true);
      expect(refused(setupWith({ currency }))).toBe(true);
      expect(refused({ ...setupWith({ currency }), type: "household.setup", sections: defaultSectionsForTest() })).toBe(true);
      expect(refused({ type: "household.create", household: { id: "h-1", name: "Home", timezone: "Europe/London", currency } })).toBe(true);
    });

    it.each(["GBP", "EUR", "USD", "JPY"])("accepts the currency %s", (currency) => {
      expect(refused(upsertWith({ currency }))).toBe(false);
      expect(refused(setupWith({ currency }))).toBe(false);
    });

    it.each(["Not/AZone", "America/New York", "Mars/Olympus", "Europe/London ", "GMT+1"])("refuses %s as a time zone", (timezone) => {
      expect(refused(setupWith({ timezone }))).toBe(true);
      expect(refused({ ...setupWith({ timezone }), type: "household.setup", sections: defaultSectionsForTest() })).toBe(true);
      expect(refused({ type: "household.create", household: { id: "h-1", name: "Home", timezone, currency: "GBP" } })).toBe(true);
    });

    it.each(["Europe/London", "America/New_York", "Asia/Kolkata", "Asia/Calcutta", "UTC"])(
      "accepts %s as a time zone, UTC and the zones the platform names under another spelling included",
      (timezone) => {
        expect(refused(setupWith({ timezone }))).toBe(false);
      },
    );

    it("reads what is already stored: a zone, currency or activity date the write path would refuse still parses (#1333)", () => {
      const stored = {
        version: 1,
        householdLanding: "active",
        activeHouseholdId: "our-home",
        households: [{
          id: "our-home", name: "Home", timezone: "America/New York", currency: "ZZZ", memberCount: 1,
          sections: defaultSectionsForTest().map((section) => ({ ...section, id: section.name })),
          items: [{ id: "mot", sectionId: "Home", title: "MOT", currency: "XXX", status: "active" }],
          activities: [{ id: "a-1", itemId: "mot", kind: "updated", occurredAt: "2026-07-01T10:00:00.000Z", effectiveDate: "2026-02-31" }],
        }],
      };
      const parsed = workspaceSchema.parse(stored);
      expect(parsed.households[0]).toMatchObject({ timezone: "America/New York", currency: "ZZZ" });
      expect(parsed.households[0].items[0].currency).toBe("XXX");
      expect(parsed.households[0].activities[0].effectiveDate).toBe("2026-02-31");
      // ...while the same values are refused as a write.
      expect(workspaceItemSchema.safeParse({ ...stored.households[0].items[0] }).success).toBe(false);
      expect(refused(setupWith({ timezone: "America/New York" }))).toBe(true);
    });

    it("builds the item bounds from the numbers domain.ts exports", () => {
      expect(refused(upsertWith({ title: "x".repeat(TITLE_MAX) }))).toBe(false);
      expect(refused(upsertWith({ title: "x".repeat(TITLE_MAX + 1) }))).toBe(true);
      expect(refused(upsertWith({ notes: "x".repeat(NOTES_MAX + 1) }))).toBe(true);
      expect(refused(upsertWith({ costMinor: COST_MINOR_MAX }))).toBe(false);
      expect(refused(upsertWith({ costMinor: COST_MINOR_MAX + 1 }))).toBe(true);
      expect(refused(upsertWith({ recurrenceMonths: RECURRENCE_MAX }))).toBe(false);
      expect(refused(upsertWith({ recurrenceMonths: RECURRENCE_MAX + 1 }))).toBe(true);
      // The intent schema reads 0 as "once": the member clearing a repeat.
      expect(refused(upsertWith({ recurrenceMonths: 0 }))).toBe(false);
      expect(refused(upsertWith({ reminderDays: Array.from({ length: REMINDER_MAX }, (_, day) => day) }))).toBe(false);
      expect(refused(upsertWith({ reminderDays: [REMINDER_DAYS_MAX] }))).toBe(false);
    });

    it("pins the numbers themselves, so a change to one is a decision", () => {
      expect([TITLE_MAX, NOTES_MAX, COST_MINOR_MAX, RECURRENCE_MAX, REMINDER_MAX, REMINDER_DAYS_MAX])
        .toEqual([100, 2_000, 100_000_000, 120, 8, 365]);
    });
  });
});
