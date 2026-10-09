import { describe, expect, it } from "vitest";
import { itemOfIntent, kindOfItem, scheduleOfKind, type ItemIntent } from "./item-kind";

/* ADR-0034, #1325: what a kind means is the engine's. These are the cases
   the browser's create and drawer suites pinned (scheduleOf, kindOf,
   fieldsOf, editsOf) before the mapping moved. */

const intent = (over: Partial<ItemIntent> = {}): ItemIntent => ({
  id: "mot", sectionId: "garage", title: "MOT", currency: "GBP", dueDate: "2026-11-02", recurrenceMonths: 12, ...over,
});

describe("scheduleOfKind maps each kind the way the owner decided (#1058)", () => {
  it.each([
    ["service", { scheduleKind: "service", subtype: "service" }],
    ["renewal", { scheduleKind: "renewal", subtype: "renewal" }],
    ["inspection", { scheduleKind: "service", subtype: "inspection" }],
    ["document", { scheduleKind: "expiry", subtype: "document" }],
    ["suggestion", { subtype: "suggestion" }],
  ] as const)("%s", (kind, schedule) => {
    expect(scheduleOfKind(kind)).toEqual(schedule);
  });

  it("schedules nothing for no kind", () => {
    expect(scheduleOfKind(null)).toEqual({});
  });
});

describe("kindOfItem reads a stored item", () => {
  it("by its subtype when that is a kind, else by its schedule", () => {
    expect(kindOfItem({ subtype: "inspection", scheduleKind: "service" })).toBe("inspection");
    expect(kindOfItem({ subtype: "MOT", scheduleKind: "service" })).toBe("service");
    expect(kindOfItem({ subtype: "Passport", scheduleKind: "expiry" })).toBe("document");
    expect(kindOfItem({ subtype: "Car", scheduleKind: "renewal" })).toBe("renewal");
    expect(kindOfItem({})).toBeNull();
  });
});

describe("itemOfIntent, a new item", () => {
  it("is active, with the kind's schedule and subtype", () => {
    expect(itemOfIntent(intent(), "inspection", undefined)).toMatchObject({
      status: "active", scheduleKind: "service", subtype: "inspection", dueDate: "2026-11-02", recurrenceMonths: 12,
    });
  });

  it("files a document as an expiry that happens once", () => {
    expect(itemOfIntent(intent(), "document", undefined)).toMatchObject({ scheduleKind: "expiry", subtype: "document", recurrenceMonths: undefined });
  });

  it("schedules nothing for a suggestion, and keeps no date", () => {
    expect(itemOfIntent(intent(), "suggestion", undefined)).toMatchObject({ scheduleKind: undefined, dueDate: undefined, recurrenceMonths: undefined, subtype: "suggestion" });
  });

  it("drops the schedule and the repeat without a due date", () => {
    expect(itemOfIntent(intent({ dueDate: undefined }), "service", undefined)).toMatchObject({ scheduleKind: undefined, recurrenceMonths: undefined });
  });

  it("writes once as no recurrence at all, and holds a repeat to 120 months", () => {
    expect(itemOfIntent(intent({ recurrenceMonths: 0 }), "service", undefined).recurrenceMonths).toBeUndefined();
    expect(itemOfIntent(intent({ recurrenceMonths: 120 }), "service", undefined).recurrenceMonths).toBe(120);
  });
});

describe("itemOfIntent, an edit", () => {
  const stored = { subtype: "MOT", scheduleKind: "service" as const, status: "cancelled" as const };

  it("keeps the item's own schedule, subtype and status while the kind is unchanged", () => {
    expect(itemOfIntent(intent(), "service", stored)).toMatchObject({ scheduleKind: "service", subtype: "MOT", status: "cancelled" });
    expect(itemOfIntent(intent(), undefined, stored)).toMatchObject({ scheduleKind: "service", subtype: "MOT" });
  });

  it("writes the new kind's subtype and schedule when retyped", () => {
    expect(itemOfIntent(intent(), "renewal", stored)).toMatchObject({ scheduleKind: "renewal", subtype: "renewal", status: "cancelled" });
    expect(itemOfIntent(intent(), "document", stored)).toMatchObject({ scheduleKind: "expiry", subtype: "document", recurrenceMonths: undefined });
  });

  it("treats giving a kindless item a kind as a retype", () => {
    expect(itemOfIntent(intent(), "inspection", { status: "active" })).toMatchObject({ scheduleKind: "service", subtype: "inspection" });
  });

  it("drops the schedule when the date is cleared", () => {
    expect(itemOfIntent(intent({ dueDate: undefined }), "service", stored)).toMatchObject({ scheduleKind: undefined, recurrenceMonths: undefined, subtype: "MOT" });
  });
});
