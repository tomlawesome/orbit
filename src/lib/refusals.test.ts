import { describe, expect, it } from "vitest";
import { completionRefusal, costMinorOf, itemRefusal, Refusal, refusalCodes, refusalWords } from "./refusals";

/* ADR-0034, #1325: the rules and the member's words moved here from the
   browser (create/entry.js refusalOf, editing/item-draft.js editsOf, the
   drawer's completion); these are the cases the browser's suites pinned. */

const filled = (over: Record<string, unknown> = {}) => ({
  title: "MOT", sectionId: "garage", cost: "54.85", dueDate: "2026-11-02", recurrenceMonths: 12, reminderDays: [21, 7], ...over,
});

describe("the member's words", () => {
  it("are the ones the browser said before the rules moved", () => {
    expect(refusalWords).toMatchObject({
      name: "not yet — give it a name",
      section: "not yet — choose a section",
      cost: "not yet — use a dot for pence, for example 12.50",
      repeatNeedsDate: "not yet — a repeat needs a due date",
      reminderCount: "not yet — at most 8 reminders",
      reminderDays: "not yet — a reminder is at most 365 days before",
      completedDate: "not yet — choose the day it was done",
      snoozeFloor: "not yet — snooze to a day after today",
    });
  });

  it("travel as a 422 with the rule's code", () => {
    const refusal = new Refusal("section");
    expect(refusal).toMatchObject({ status: 422, code: "item_section_missing", message: "not yet — choose a section" });
  });
});

describe("costMinorOf reads money the way it is typed", () => {
  it.each([
    ["", undefined], ["84", 8400], ["84.5", 8450], ["£1,200.5", 120050], ["1,250", 125000],
    ["1,250.00", 125000], ["12.50", 1250], [" £ 12 ", 1200],
  ])("%j is %s", (text, minor) => {
    expect(costMinorOf(text)).toBe(minor);
  });

  it.each(["12.345", "12,50", "1,25", "1,2500", "twelve"])("refuses %j", (text) => {
    expect(costMinorOf(text)).toBeNaN();
  });
});

describe("itemRefusal names the first thing missing, in the browser's order", () => {
  it("accepts a filled entry", () => {
    expect(itemRefusal(filled(), "inspection")).toBeNull();
  });

  it("asks for a name, then a section, then a cost that is a sum", () => {
    expect(itemRefusal(filled({ title: "  ", sectionId: null, cost: "12,50" }), "service")).toBe("name");
    expect(itemRefusal(filled({ sectionId: null, cost: "12,50" }), "service")).toBe("section");
    expect(itemRefusal(filled({ cost: "12,50", dueDate: undefined }), "service")).toBe("cost");
  });

  it("refuses a repeat with no due date, only for a kind that comes round", () => {
    expect(itemRefusal(filled({ dueDate: undefined }), "service")).toBe("repeatNeedsDate");
    expect(itemRefusal(filled({ dueDate: undefined }), "document")).toBeNull();
    expect(itemRefusal(filled({ dueDate: undefined }), "suggestion")).toBeNull();
    expect(itemRefusal(filled({ dueDate: undefined }), undefined)).not.toBe("repeatNeedsDate");
    expect(itemRefusal(filled({ dueDate: undefined, recurrenceMonths: 0 }), "service")).toBeNull();
  });

  /* #1316 A4-F3, owner decision 2026-10-11 (option b): an upsert with no type
     and none derivable is refused whatever its date or repeat, because a
     kindless save quietly drops the schedule it was given. */
  describe("refuses an item with no type, whatever its date or repeat (#1316 A4-F3)", () => {
    const kindWords = "not yet — choose a type";
    const kindCode = "item_kind_missing";
    const boiler = { title: "Boiler", sectionId: "s", cost: undefined, reminderDays: undefined };

    it.each([
      ["a due date", { dueDate: "2026-11-02", recurrenceMonths: undefined }],
      ["a repeat and no date", { dueDate: undefined, recurrenceMonths: 12 }],
      ["a date and a repeat", { dueDate: "2026-11-02", recurrenceMonths: 12 }],
      ["no date and no repeat", { dueDate: undefined, recurrenceMonths: undefined }],
    ])("with %s and no kind, in the member's words and code", (_label, dates) => {
      for (const kind of [undefined, null]) {
        const rule = itemRefusal({ ...boiler, ...dates }, kind);
        expect(rule).not.toBeNull();
        expect(refusalWords[rule!]).toBe(kindWords);
        expect(refusalCodes[rule!]).toBe(kindCode);
      }
    });

    it("carries the 422, code and words on a Refusal", () => {
      const rule = itemRefusal({ ...boiler, dueDate: "2026-11-02" }, undefined)!;
      expect(new Refusal(rule)).toMatchObject({ status: 422, code: kindCode, message: kindWords });
    });

    it("still accepts the same item once a type is chosen", () => {
      expect(itemRefusal({ ...boiler, dueDate: "2026-11-02" }, "service")).toBeNull();
      expect(itemRefusal({ ...boiler, dueDate: undefined, recurrenceMonths: undefined }, "document")).toBeNull();
    });
  });

  it("holds the reminders to eight, each at most 365 days before", () => {
    expect(itemRefusal(filled({ reminderDays: [90, 60, 30, 21, 14, 7, 3, 1] }), "service")).toBeNull();
    expect(itemRefusal(filled({ reminderDays: [90, 60, 30, 21, 14, 7, 3, 2, 1] }), "service")).toBe("reminderCount");
    expect(itemRefusal(filled({ reminderDays: [365] }), "service")).toBeNull();
    expect(itemRefusal(filled({ reminderDays: [400] }), "service")).toBe("reminderDays");
  });
});

describe("completionRefusal", () => {
  it("refuses a cost that is not a sum, then a missing day", () => {
    expect(completionRefusal({ completedDate: "2026-10-08", cost: "12,50" })).toBe("cost");
    expect(completionRefusal({ cost: "12.50" })).toBe("completedDate");
    expect(completionRefusal({ completedDate: "2026-10-08", cost: "£12.50" })).toBeNull();
    expect(completionRefusal({ completedDate: "2026-10-08" })).toBeNull();
  });
});
