import { describe, expect, it } from "vitest";

// Create and edit on a phone (#1120, design/v19/phone-vision/proposal.md §2.5)
// and the owner's #1058 decisions it carries (#1069): the kind → schedule
// mapping, the recurrence range, the section with no default, and the one
// command both create and edit build from the same form.
import {
  RECURRENCE_MAX, REMINDER_DEFAULT, blankEntry, createCommandOf, entryChanged, entryOf, entryOfProposal, fieldsOf,
  kindOf, minorOf, recurrenceOfChoice, recurrenceWords, refusalOf, reviewItemOf, scheduleOf, stepRecurrence,
  toggleReminder,
} from "../../web/src/routes/create/entry.js";
import { upsertCommand } from "../../web/src/lib/data/commands.js";

/** A filled entry that can be saved. */
const filled = (/** @type {Partial<import("../../web/src/routes/create/entry.js").Entry>} */ over = {}) => ({
  ...blankEntry({ name: "Car MOT", householdId: "hh-1" }),
  kind: /** @type {const} */ ("inspection"),
  sectionId: "s-vehicles",
  dueDate: "2027-03-01",
  ...over,
});

describe("kind → schedule (#1058)", () => {
  it("maps each kind the way the owner decided", () => {
    expect(scheduleOf("service")).toEqual({ scheduleKind: "service", subtype: "service" });
    expect(scheduleOf("renewal")).toEqual({ scheduleKind: "renewal", subtype: "renewal" });
    expect(scheduleOf("inspection")).toEqual({ scheduleKind: "service", subtype: "inspection" });
    expect(scheduleOf("document")).toEqual({ scheduleKind: "expiry", subtype: "document" });
    expect(scheduleOf("suggestion")).toEqual({ scheduleKind: undefined, subtype: "suggestion" });
    expect(scheduleOf(null)).toEqual({ scheduleKind: undefined, subtype: undefined });
  });

  it("reads an existing item's kind back from its subtype, then its schedule", () => {
    expect(kindOf({ subtype: "inspection", scheduleKind: "service" })).toBe("inspection");
    expect(kindOf({ subtype: "boiler", scheduleKind: "renewal" })).toBe("renewal");
    expect(kindOf({ subtype: null, scheduleKind: "expiry" })).toBe("document");
    expect(kindOf({ subtype: null, scheduleKind: null })).toBeNull();
  });

  it("an inspection comes round; a document happens once; a suggestion schedules nothing", () => {
    const mot = fieldsOf(filled());
    expect(mot).toMatchObject({ scheduleKind: "service", recurrenceMonths: 12, dueDate: "2027-03-01" });
    const passport = fieldsOf(filled({ kind: "document", recurrence: 12 }));
    expect(passport).toMatchObject({ scheduleKind: "expiry", recurrenceMonths: undefined });
    const undated = fieldsOf(filled({ kind: "document", dueDate: "" }));
    expect(undated).toMatchObject({ scheduleKind: undefined, dueDate: undefined });
    const idea = fieldsOf(filled({ kind: "suggestion" }));
    expect(idea).toMatchObject({ scheduleKind: undefined, dueDate: undefined, recurrenceMonths: undefined });
  });
});

describe("recurrence: once, or every 1 to 120 months (#1058)", () => {
  it("steps within the range and never past either end", () => {
    expect(stepRecurrence(0, -1)).toBe(0);
    expect(stepRecurrence(0, 1)).toBe(1);
    expect(stepRecurrence(RECURRENCE_MAX, 1)).toBe(RECURRENCE_MAX);
    expect(stepRecurrence(119, 5)).toBe(RECURRENCE_MAX);
    expect(stepRecurrence(Number.NaN, 1)).toBe(1);
  });

  it("says the value in words, with once as its zero", () => {
    expect(recurrenceWords(0)).toBe("once");
    expect(recurrenceWords(1)).toBe("every month");
    expect(recurrenceWords(6)).toBe("every 6 months");
  });

  it("writes once as no recurrence at all", () => {
    expect(fieldsOf(filled({ recurrence: 0 })).recurrenceMonths).toBeUndefined();
  });

  it("the desk's own select reads the same range (#1069)", () => {
    expect(recurrenceOfChoice("once", "")).toBe(0);
    expect(recurrenceOfChoice("monthly", "")).toBe(1);
    expect(recurrenceOfChoice("yearly", "")).toBe(12);
    expect(recurrenceOfChoice("custom", "6")).toBe(6);
    expect(recurrenceOfChoice("custom", "400")).toBe(RECURRENCE_MAX);
    expect(recurrenceOfChoice("custom", "0")).toBe(1);
    expect(recurrenceOfChoice("custom", "not a number")).toBe(1);
  });
});

describe("the refusal beside the save button", () => {
  it("has no section by default, and will not save without one (#1058)", () => {
    const entry = blankEntry({ name: "Boiler service", householdId: "hh-1" });
    expect(entry.sectionId).toBeNull();
    expect(refusalOf(entry)).toBe("not yet — choose a section");
  });

  it("names the first thing missing, in order", () => {
    expect(refusalOf(filled({ name: "  " }))).toBe("not yet — give it a name");
    expect(refusalOf(filled({ cost: "eighty" }))).toBe("not yet — use a dot for pence, for example 12.50");
    expect(refusalOf(filled({ dueDate: "" }))).toBe("not yet — a repeat needs a due date");
    expect(refusalOf(filled({ dueDate: "", recurrence: 0 }))).toBeNull();
    expect(refusalOf(filled())).toBeNull();
  });
});

describe("the entry's fields", () => {
  it("prefills the name, and nothing else, from search", () => {
    const entry = blankEntry({ name: "  Window cleaner  ", householdId: "hh-1" });
    expect(entry).toMatchObject({ name: "Window cleaner", kind: null, sectionId: null, reminderDays: REMINDER_DEFAULT });
  });

  it("reads money the way it is typed", () => {
    expect(minorOf("")).toBeUndefined();
    expect(minorOf("84")).toBe(8400);
    expect(minorOf("£1,200.5")).toBe(120050);
    expect(minorOf("12.345")).toBeNaN();
  });

  // #1151 W1-F1/W1-S4: a comma is only ever a thousands separator (this is a
  // UK product), and only in a valid grouping position — never silently
  // reinterpreted as a decimal point.
  it("accepts a comma only as a thousands separator in a valid position", () => {
    expect(minorOf("12,50")).toBeNaN();
    expect(minorOf("1,250")).toBe(125000);
    expect(minorOf("1,250.00")).toBe(125000);
    expect(minorOf("12.50")).toBe(1250);
    expect(minorOf("1,25")).toBeNaN();
    expect(minorOf("1,2500")).toBeNaN();
    expect(minorOf("")).toBeUndefined();
  });

  it("keeps reminders furthest-first and toggles one day at a time", () => {
    expect(toggleReminder([21, 7], 30)).toEqual([30, 21, 7]);
    expect(toggleReminder([30, 21, 7], 21)).toEqual([30, 7]);
  });

  it("builds one item.upsert for a new entry, with the household's currency", () => {
    const command = createCommandOf(filled({ cost: "54.85", provider: " Kwik Fit " }),
      { householdId: "hh-1", currency: "GBP", id: "new-1" });
    expect(command).toMatchObject({
      type: "item.upsert",
      householdId: "hh-1",
      item: {
        id: "new-1", sectionId: "s-vehicles", title: "Car MOT", subtype: "inspection", scheduleKind: "service",
        provider: "Kwik Fit", costMinor: 5485, currency: "GBP", dueDate: "2027-03-01", recurrenceMonths: 12,
        reminderDays: [21, 7], status: "active",
      },
    });
    expect(command.item).not.toHaveProperty("assignee");
  });

  it("edits through the same form: round-trips an item and clears what was emptied", () => {
    const item = {
      id: "i-mot", householdId: "hh-1", sectionId: "s-vehicles", title: "Car MOT", subtype: "inspection",
      scheduleKind: /** @type {const} */ ("service"), provider: "Kwik", reference: null, costMinor: 5485,
      currency: "GBP", dueDate: "2026-08-29", recurrenceMonths: 12, reminderDays: [21, 7], notes: "old",
      status: "active", version: 5,
    };
    const entry = entryOf(item);
    expect(entry).toMatchObject({ kind: "inspection", cost: "54.85", recurrence: 12, sectionId: "s-vehicles" });
    expect(entryChanged(entry, entryOf(item))).toBe(false);
    const edits = fieldsOf({ ...entry, provider: "", recurrence: 24 }, { scheduleKind: item.scheduleKind });
    const command = upsertCommand(/** @type {any} */ (item), edits, { uuid: () => "op", now: () => "2026-09-25T12:00:00.000Z" });
    expect(command.item).toMatchObject({ title: "Car MOT", recurrenceMonths: 24, scheduleKind: "service", version: 5 });
    expect(command.item).not.toHaveProperty("provider");
  });
});

describe("review mode: amending what the relay read (#1120, §2.5, §2.6)", () => {
  const proposal = {
    title: "Home insurance renewal", provider: "Harbour Mutual", costMinor: 40000, currency: "GBP",
    dueDate: "2026-10-03", scheduleKind: "renewal", recurrenceMonths: 12,
  };

  it("pre-fills the form with the readings, and still leaves the section to the reader", () => {
    const entry = entryOfProposal(proposal, { householdId: "hh-1" });
    expect(entry).toMatchObject({
      kind: "renewal", name: "Home insurance renewal", householdId: "hh-1", sectionId: null,
      provider: "Harbour Mutual", dueDate: "2026-10-03", recurrence: 12, cost: "400.00",
      reminderDays: REMINDER_DEFAULT,
    });
    expect(refusalOf(entry)).toBe("not yet — choose a section");
  });

  it("reads mail that proposed nothing as an empty form, not a guessed one", () => {
    const entry = entryOfProposal({});
    expect(entry).toMatchObject({ kind: null, name: "", recurrence: 0, cost: "", dueDate: "" });
  });

  it("approves the amended values with the kind's subtype and the mail's currency", () => {
    const entry = { ...entryOfProposal(proposal), sectionId: "s-home", provider: "Harbour Mutual plc", cost: "412" };
    const item = reviewItemOf(entry, "GBP");
    expect(item).toMatchObject({
      title: "Home insurance renewal", provider: "Harbour Mutual plc", costMinor: 41200, currency: "GBP",
      dueDate: "2026-10-03", scheduleKind: "renewal", recurrenceMonths: 12, subtype: "renewal",
      reminderDays: [21, 7],
    });
    expect(item).not.toHaveProperty("sectionId");
  });
});
