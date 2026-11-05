import { describe, expect, it } from "vitest";

// Create and edit on a phone (#1120, design/v19/phone-vision/proposal.md §2.5)
// and the owner's #1058 decisions it carries (#1069): the kind → schedule
// mapping, the recurrence range, the section with no default, and the one
// command both create and edit build from the same form. Since #1325
// (ADR-0034) the form sends intent: the mapping and the "not yet" refusals
// are the engine's, pinned in src/lib/item-kind.test.ts and
// src/lib/refusals.test.ts.
import {
  RECURRENCE_MAX, REMINDER_DEFAULT, blankEntry, createCommandOf, entryChanged, entryOf, entryOfProposal, intentOf,
  recurrenceOfChoice, recurrenceWords, reviewItemOf, stepRecurrence, toggleReminder,
} from "../../web/src/routes/create/entry.js";
import { upsertCommand } from "../../web/src/lib/data/commands.js";

/** A filled entry that can be saved. */
const filled = (/** @type {Partial<import("../../web/src/routes/create/entry.js").Entry>} */ over = {}) => ({
  ...blankEntry({ name: "Car MOT", householdId: "hh-1" }),
  sectionId: "s-vehicles",
  dueDate: "2027-03-01",
  ...over,
});

describe("no type (ADR-0043): an entry sends a date and a repeat, nothing else", () => {
  it("holds no kind for a stored item, whatever the payload still says", () => {
    expect(entryOf({ kind: "inspection" })).not.toHaveProperty("kind");
    expect(entryOf({})).not.toHaveProperty("kind");
  });

  it("sends no kind beside the item, and never what it schedules", () => {
    const command = createCommandOf(filled(), { householdId: "hh-1", currency: "GBP", id: "new-1" });
    expect(command).not.toHaveProperty("kind");
    for (const field of ["kind", "scheduleKind", "subtype", "status"]) expect(command.item).not.toHaveProperty(field);
  });

  it("a dateless entry sends no repeat, so the engine does not refuse it repeat_needs_date", () => {
    const where = { householdId: "hh-1", currency: "GBP", id: "new-1" };
    for (const recurrence of [12, 1, 0]) {
      const { item } = createCommandOf(filled({ dueDate: "", recurrence }), where);
      expect(item).not.toHaveProperty("dueDate");
      expect(item.recurrenceMonths ?? 0, `recurrence ${recurrence}`).toBe(0);
    }
  });

  it("a dated entry still sends its repeat as answered", () => {
    const { item } = createCommandOf(filled({ dueDate: "2027-03-01", recurrence: 12 }), { householdId: "hh-1", currency: "GBP", id: "new-1" });
    expect(item.recurrenceMonths).toBe(12);
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

  it("sends once as a repeat of 0, for the engine to read", () => {
    expect(intentOf(filled({ recurrence: 0 })).recurrenceMonths).toBe(0);
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

describe("the section (#1058)", () => {
  it("has no default; the engine says what is missing", () => {
    const entry = blankEntry({ name: "Boiler service", householdId: "hh-1" });
    expect(entry.sectionId).toBeNull();
    expect(intentOf(entry).sectionId).toBeNull();
  });
});

describe("the entry's fields", () => {
  it("prefills the name, and nothing else, from search", () => {
    const entry = blankEntry({ name: "  Window cleaner  ", householdId: "hh-1" });
    expect(entry).toMatchObject({ name: "Window cleaner", sectionId: null, reminderDays: REMINDER_DEFAULT });
  });

  it("sends the cost as typed, for the engine to read", () => {
    expect(intentOf(filled({ cost: " £1,200.5 " })).cost).toBe("£1,200.5");
    expect(intentOf(filled({ cost: "" })).cost).toBeUndefined();
  });

  it("keeps reminders furthest-first and toggles one day at a time", () => {
    expect(toggleReminder([21, 7], 30)).toEqual([30, 21, 7]);
    expect(toggleReminder([30, 21, 7], 21)).toEqual([30, 7]);
    // Too many is the engine's refusal, not a silent trim (#1325).
    expect(toggleReminder([90, 60, 30, 21, 14, 7, 3, 1], 2)).toHaveLength(9);
  });

  it("builds one item.upsert for a new entry, with the household's currency", () => {
    const command = createCommandOf(filled({ cost: "54.85", provider: " Kwik Fit " }),
      { householdId: "hh-1", currency: "GBP", id: "new-1" });
    expect(command).toMatchObject({
      type: "item.upsert",
      householdId: "hh-1",
      item: {
        id: "new-1", sectionId: "s-vehicles", title: "Car MOT", provider: "Kwik Fit", cost: "54.85",
        currency: "GBP", dueDate: "2027-03-01", recurrenceMonths: 12, reminderDays: [14, 3],
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
    expect(entry).toMatchObject({ cost: "54.85", recurrence: 12, sectionId: "s-vehicles" });
    expect(entryChanged(entry, entryOf(item))).toBe(false);
    const edits = intentOf({ ...entry, provider: "", recurrence: 24 });
    const command = upsertCommand(/** @type {any} */ (item), edits, { uuid: () => "op", now: () => "2026-09-25T12:00:00.000Z" });
    expect(command).toMatchObject({ item: { title: "Car MOT", recurrenceMonths: 24, cost: "54.85", version: 6 } });
    expect(command.item).not.toHaveProperty("provider");
    expect(command.item).not.toHaveProperty("costMinor");
    expect(command.item).not.toHaveProperty("scheduleKind");
    expect(command).not.toHaveProperty("kind");
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
      name: "Home insurance renewal", householdId: "hh-1", sectionId: null,
      provider: "Harbour Mutual", dueDate: "2026-10-03", recurrence: 12, cost: "400.00",
      reminderDays: REMINDER_DEFAULT,
    });
  });

  it("reads mail that proposed nothing as an empty form, not a guessed one", () => {
    const entry = entryOfProposal({});
    expect(entry).toMatchObject({ name: "", recurrence: 0, cost: "", dueDate: "" });
  });

  it("approves the amended values with the relay's reading and the mail's currency", () => {
    const entry = { ...entryOfProposal(proposal), sectionId: "s-home", provider: "Harbour Mutual plc", cost: "412" };
    const item = reviewItemOf(entry, "GBP", proposal);
    expect(item).toMatchObject({
      title: "Home insurance renewal", provider: "Harbour Mutual plc", cost: "412", currency: "GBP",
      dueDate: "2026-10-03", scheduleKind: "renewal", recurrenceMonths: 12,
      reminderDays: [14, 3],
    });
    expect(item).not.toHaveProperty("sectionId");
    expect(item).not.toHaveProperty("kind");
  });
});
