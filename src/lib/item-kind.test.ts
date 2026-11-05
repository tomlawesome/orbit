import { describe, expect, it } from "vitest";
import * as itemKind from "./item-kind";
import { itemOfIntent, type ItemIntent } from "./item-kind";

/* ADR-0043 (#1466 note 53014, #1468 Part B): an item has no type. A new item
   with a date is a renewal, a dateless one is unscheduled, and an edit keeps
   the schedule kind it was stored with. `itemOfIntent(intent, stored)` takes
   no kind. */

const intent = (over: Partial<ItemIntent> = {}): ItemIntent => ({
  id: "mot", sectionId: "garage", title: "MOT", currency: "GBP", dueDate: "2026-11-02", recurrenceMonths: 12, ...over,
});

describe("the type vocabulary has left the module", () => {
  it.each(["itemKinds", "kindHasDate", "kindRecurs", "scheduleOfKind", "kindOfItem"])("exports no %s", (name) => {
    expect(itemKind).not.toHaveProperty(name);
  });
});

describe("itemOfIntent, a new item", () => {
  it("with a date and a repeat is an active renewal with no subtype", () => {
    const item = itemOfIntent(intent());
    expect(item).toMatchObject({ status: "active", scheduleKind: "renewal", dueDate: "2026-11-02", recurrenceMonths: 12 });
    expect(item.subtype).toBeUndefined();
  });

  it("with a date and no repeat (0 or absent) is a renewal that happens once", () => {
    for (const recurrenceMonths of [0, undefined]) {
      const item = itemOfIntent(intent({ recurrenceMonths }));
      expect(item).toMatchObject({ scheduleKind: "renewal", dueDate: "2026-11-02", recurrenceMonths: undefined });
      expect(item.subtype).toBeUndefined();
    }
  });

  it("with no date has no schedule, no repeat and no subtype", () => {
    const item = itemOfIntent(intent({ dueDate: undefined }));
    expect(item).toMatchObject({ scheduleKind: undefined, dueDate: undefined, recurrenceMonths: undefined, status: "active" });
    expect(item.subtype).toBeUndefined();
  });

  it("holds a repeat to 120 months", () => {
    expect(itemOfIntent(intent({ recurrenceMonths: 120 })).recurrenceMonths).toBe(120);
    expect(itemOfIntent(intent({ recurrenceMonths: 500 })).recurrenceMonths).toBe(120);
  });
});

describe("itemOfIntent, an edit keeps the stored schedule kind", () => {
  it("keeps a service item's schedule kind and subtype while the date and repeat change", () => {
    const stored = { subtype: "inspection", scheduleKind: "service" as const, status: "active" as const };
    expect(itemOfIntent(intent({ dueDate: "2027-03-01", recurrenceMonths: 6 }), stored)).toMatchObject({
      scheduleKind: "service", subtype: "inspection", dueDate: "2027-03-01", recurrenceMonths: 6, status: "active",
    });
  });

  it("keeps a free-text subtype and the stored status", () => {
    const stored = { subtype: "MOT", scheduleKind: "service" as const, status: "cancelled" as const };
    expect(itemOfIntent(intent(), stored)).toMatchObject({ scheduleKind: "service", subtype: "MOT", status: "cancelled" });
  });

  it("keeps an expiry an expiry, and an expiry takes no repeat", () => {
    const stored = { subtype: "Passport", scheduleKind: "expiry" as const, status: "active" as const };
    expect(itemOfIntent(intent({ recurrenceMonths: 12 }), stored)).toMatchObject({
      scheduleKind: "expiry", subtype: "Passport", recurrenceMonths: undefined,
    });
  });

  it("gives a dateless stored item a renewal when it is given a date", () => {
    const item = itemOfIntent(intent(), { status: "active" });
    expect(item).toMatchObject({ scheduleKind: "renewal", dueDate: "2026-11-02", recurrenceMonths: 12 });
    expect(item.subtype).toBeUndefined();
  });

  it("keeps a stored subtype word on a dateless item given a date, without reading it as a type", () => {
    // `suggestion` and the rest are inert text now: the date makes it a renewal, the word stays.
    const item = itemOfIntent(intent(), { subtype: "suggestion", status: "active" });
    expect(item).toMatchObject({ scheduleKind: "renewal", subtype: "suggestion" });
  });

  it("drops the schedule and repeat when the date is cleared, keeping the subtype", () => {
    const stored = { subtype: "MOT", scheduleKind: "service" as const, status: "active" as const };
    expect(itemOfIntent(intent({ dueDate: undefined }), stored)).toMatchObject({ scheduleKind: undefined, recurrenceMonths: undefined, subtype: "MOT" });
  });
});
