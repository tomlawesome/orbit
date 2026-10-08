import { describe, expect, it } from "vitest";

// #1319 — editing in the drawer's own rows: what the rows hold (draftOf), how
// a typed reminders row reads (remindersOf), what a save sends (editsOf) and
// the choices the choosers offer. Pure, no DOM. Whether a save is allowed,
// and what the kind schedules, are the engine's since #1325 (ADR-0034):
// src/lib/refusals.test.ts and src/lib/item-kind.test.ts.
import {
  PERIODS, TYPES, amendedOf, chooserAskOf, draftOf, editsOf, periodChoices, periodWords,
  proposedItemOf, remindersOf, remindersWords, sectionChoices, typeChoices,
} from "../../web/src/lib/editing/item-draft.js";

/** A stored item, as the workspace holds it. */
const item = (over = {}) => ({
  id: "i1",
  householdId: "h1",
  sectionId: "vehicle",
  title: "MOT",
  subtype: "inspection",
  scheduleKind: "service",
  provider: "Kwik Fit",
  reference: "R-1",
  dueDate: "2026-11-01",
  recurrenceMonths: 12,
  costMinor: 5400,
  currency: "GBP",
  reminderDays: [21, 7],
  notes: "bring V5C",
  ...over,
});

describe("remindersOf", () => {
  it("reads every number, furthest first, once each", () => {
    expect(remindersOf("7d before · 21d before")).toEqual([21, 7]);
    expect(remindersOf("7, 21, 7, 90")).toEqual([90, 21, 7]);
  });

  it("is empty when there is no number", () => {
    expect(remindersOf("")).toEqual([]);
    expect(remindersOf("none")).toEqual([]);
    expect(remindersOf(undefined)).toEqual([]);
  });

  it("round-trips remindersWords", () => {
    expect(remindersWords([21, 7])).toBe("21d before · 7d before");
    expect(remindersOf(remindersWords([30, 14, 1]))).toEqual([30, 14, 1]);
  });
});

describe("draftOf", () => {
  it("holds every value the read view shows, as the rows type it", () => {
    expect(draftOf(item())).toEqual({
      title: "MOT",
      dueDate: "2026-11-01",
      sectionId: "vehicle",
      kind: "inspection",
      recurrence: 12,
      cost: "£54.00",
      provider: "Kwik Fit",
      reference: "R-1",
      reminders: "21d before · 7d before",
      notes: "bring V5C",
    });
  });

  it("writes the cost with its own currency's sign", () => {
    expect(draftOf(item({ currency: "EUR" })).cost).toBe("€54.00");
    expect(draftOf(item({ currency: "USD" })).cost).toBe("$54.00");
    expect(draftOf(item({ currency: undefined })).cost).toBe("£54.00");
    expect(draftOf(item({ currency: "JPY" })).cost).toBe("54.00");
  });

  it("holds an empty cost, and nulls, as empty rows", () => {
    const draft = draftOf(item({
      costMinor: null, provider: null, reference: null, notes: null, dueDate: null, reminderDays: null, recurrenceMonths: null,
    }));
    expect(draft).toMatchObject({
      cost: "", provider: "", reference: "", notes: "", dueDate: "", reminders: "", recurrence: 0,
    });
  });

  it("reads the kind from the subtype, or from the schedule without one", () => {
    expect(draftOf(item({ subtype: "renewal", scheduleKind: "renewal" })).kind).toBe("renewal");
    expect(draftOf(item({ subtype: null, scheduleKind: "expiry" })).kind).toBe("document");
    expect(draftOf(item({ subtype: null, scheduleKind: null })).kind).toBeNull();
  });
});

describe("editsOf: what the rows hold, as intent", () => {
  it("sends the fields as typed, and the kind chosen", () => {
    expect(editsOf(draftOf(item()))).toEqual({
      sectionId: "vehicle",
      title: "MOT",
      provider: "Kwik Fit",
      reference: "R-1",
      cost: "£54.00",
      dueDate: "2026-11-01",
      recurrenceMonths: 12,
      reminderDays: [21, 7],
      notes: "bring V5C",
      kind: "inspection",
    });
  });

  it("reads the typed reminders row, and leaves the cost as typed for the engine", () => {
    const edits = editsOf({ ...draftOf(item()), title: "  MOT test ", cost: "£1,250.5", reminders: "3d before · 30d before" });
    expect(edits).toMatchObject({ title: "  MOT test ", cost: "£1,250.5", reminderDays: [30, 3] });
  });

  it("never sends what the engine decides from the kind", () => {
    const edits = editsOf({ ...draftOf(item()), kind: "document" });
    expect(edits).toMatchObject({ kind: "document", recurrenceMonths: 12 });
    expect(edits).not.toHaveProperty("scheduleKind");
    expect(edits).not.toHaveProperty("subtype");
    expect(edits).not.toHaveProperty("status");
  });

  it("refuses nothing itself: an empty name and no section still go to the engine to judge", () => {
    expect(editsOf({ ...draftOf(item()), title: "", sectionId: null })).toMatchObject({ title: "", sectionId: null });
  });

  it("sends a cleared date and cost as left out", () => {
    const edits = editsOf({ ...draftOf(item()), dueDate: "", cost: "" });
    expect(edits.dueDate).toBeUndefined();
    expect(edits.cost).toBeUndefined();
    expect(edits).toHaveProperty("cost");
  });
});

describe("periodWords", () => {
  it("names the band's periods and spells any other", () => {
    expect(periodWords(0)).toBe("does not repeat");
    expect(periodWords(12)).toBe("every year");
    expect(periodWords(24)).toBe("every 2 years");
    expect(periodWords(5)).toBe("every 5 months");
  });
});

describe("periodChoices", () => {
  const due = "2026-10-08";

  it("offers the six periods, once at the top to two years at the foot", () => {
    const choices = periodChoices(12, due);
    expect(choices.map((c) => c.value)).toEqual(PERIODS.map(([n]) => String(n)));
    expect(choices.map((c) => c.value)).toEqual(["0", "1", "3", "6", "12", "24"]);
    expect(choices.map((c) => c.figure)).toEqual(["once", "1", "3", "6", "1", "2"]);
    expect(choices.map((c) => c.unit)).toEqual(["", "month", "months", "months", "year", "years"]);
    expect(choices.every((c) => c.colour === null)).toBe(true);
  });

  it("reads each foot line as the date it would next come round to", () => {
    const notes = periodChoices(12, due).map((c) => c.note);
    expect(notes).toEqual(["once", "then 8 Nov 2026", "then 8 Jan 2027", "then 8 Apr 2027", "then 8 Oct 2027", "then 8 Oct 2028"]);
  });

  it("gives no date to come round to without a due date", () => {
    const notes = periodChoices(12, null).map((c) => c.note);
    expect(notes).toEqual(["once", "", "", "", "", ""]);
  });

  it("holds an end-of-month due date to the shorter month", () => {
    expect(periodChoices(1, "2026-01-31")[1].note).toBe("then 28 Feb 2026");
  });

  it("slots a non-standard period into its place, so keeping it stays a choice", () => {
    const choices = periodChoices(2, due);
    expect(choices.map((c) => c.value)).toEqual(["0", "1", "2", "3", "6", "12", "24"]);
    expect(choices[2]).toMatchObject({
      value: "2", words: "every 2 months", figure: "2", unit: "months", note: "then 8 Dec 2026", colour: null,
    });
    expect(periodChoices(18, due).map((c) => c.value)).toEqual(["0", "1", "3", "6", "12", "18", "24"]);
  });

  it("spells a non-standard whole-year period in years", () => {
    const choices = periodChoices(36, due);
    expect(choices.at(-1)).toMatchObject({ value: "36", figure: "3", unit: "years", words: "every 36 months" });
  });

  it("does not add the standard periods twice, or a 0 for once", () => {
    expect(periodChoices(6, due)).toHaveLength(6);
    expect(periodChoices(0, due)).toHaveLength(6);
  });
});

describe("typeChoices", () => {
  it("offers service, renewal and inspection, each in its colour", () => {
    expect(typeChoices("service")).toEqual([
      { value: "service", words: "service", colour: "service" },
      { value: "renewal", words: "renewal", colour: "renewal" },
      { value: "inspection", words: "inspection", colour: "inspection" },
    ]);
    expect(typeChoices(null).map((c) => c.value)).toEqual(TYPES);
  });

  it("adds the item's own kind, uncoloured, when it is none of the three", () => {
    const choices = typeChoices("document");
    expect(choices.map((c) => c.value)).toEqual([...TYPES, "document"]);
    expect(choices.at(-1)).toEqual({ value: "document", words: "document", colour: null });
  });

  it("does not repeat a listed kind", () => {
    expect(typeChoices("renewal")).toHaveLength(3);
  });
});

describe("sectionChoices and chooserAskOf", () => {
  const sections = [
    { id: "home", name: "Home", icon: "home", visible: true },
    { id: "vehicle", name: "Vehicles", icon: "vehicle" },
    { id: "device", name: "Devices", icon: "device", visible: false },
  ];

  it("offers the visible sections in their colours, and the item's own even if hidden", () => {
    expect(sectionChoices(sections, null).map((c) => c.value)).toEqual(["home", "vehicle"]);
    expect(sectionChoices(sections, "device")).toEqual([
      { value: "home", words: "Home", colour: "home" },
      { value: "vehicle", words: "Vehicles", colour: "vehicles" },
      { value: "device", words: "Devices", colour: "devices" },
    ]);
  });

  it("asks the card for what the value being chosen needs", () => {
    const draft = draftOf(item());
    const today = "2026-10-08";
    expect(chooserAskOf({ key: "due", label: "next due" }, draft, sections, today))
      .toEqual({ key: "due", label: "next due", heading: "due date", today, value: "2026-11-01", choices: [] });
    expect(chooserAskOf({ key: "type", label: "type" }, draft, sections, today))
      .toMatchObject({ value: "inspection", heading: "type" });
    expect(chooserAskOf({ key: "section", label: "section" }, draft, sections, today).value).toBe("vehicle");
    const months = chooserAskOf({ key: "months", label: "repeats" }, draft, sections, today);
    expect(months.value).toBe("12");
    expect(months.choices).toHaveLength(6);
  });

  it("asks the calendar for no day when the draft has none", () => {
    const ask = chooserAskOf({ key: "due", label: "next due" }, { ...draftOf(item()), dueDate: "" }, sections, "2026-10-08");
    expect(ask.value).toBeNull();
  });
});

// #1319 — a suggestion is reviewed in its home drawer: the relay's proposal as
// the item the rows edit, and the rows' save as the amended item approval sends.
describe("a suggestion amended in its drawer", () => {
  const suggestion = (over = {}) => ({
    id: "r-insurance", receiptId: "r-insurance", householdId: null, title: "Home insurance renewal",
    currency: "GBP", sourceDocument: "policy-schedule.pdf", renewsOn: "2026-10-03", costMinor: 40000,
    proposal: {
      title: "Home insurance renewal", provider: "Harbour Mutual", subtype: "insurance",
      scheduleKind: "renewal", dueDate: "2026-10-03", recurrenceMonths: 12, costMinor: 40000, currency: "GBP",
    },
    ...over,
  });
  const where = { householdId: "h1", sectionId: "s-home" };

  it("holds what the relay read, with a new entry's reminders and the section it would file into", () => {
    const item = proposedItemOf(/** @type {any} */ (suggestion()), where);
    expect(item).toMatchObject({
      id: "r-insurance", householdId: "h1", sectionId: "s-home", status: "suggested", title: "Home insurance renewal",
      provider: "Harbour Mutual", dueDate: "2026-10-03", recurrenceMonths: 12, costMinor: 40000, reminderDays: [21, 7],
    });
    const draft = draftOf(item);
    expect(draft).toMatchObject({ title: "Home insurance renewal", kind: "renewal", cost: "£400.00", recurrence: 12 });
  });

  it("falls back to the row's own readings where the proposal is silent", () => {
    const item = proposedItemOf(/** @type {any} */ (suggestion({ proposal: undefined, provider: "Harbour" })), where);
    expect(item).toMatchObject({ title: "Home insurance renewal", provider: "Harbour", dueDate: "2026-10-03", costMinor: 40000 });
  });

  it("sends the amended fields, the relay's own reading and the kind, and hands the section apart", () => {
    const item = proposedItemOf(/** @type {any} */ (suggestion()), where);
    const draft = { ...draftOf(item), cost: "£420.00", reference: "HM-7", sectionId: "s-dates" };
    const { item: amended, sectionId } = amendedOf(item, editsOf(draft));
    expect(sectionId).toBe("s-dates");
    expect(amended).toMatchObject({
      title: "Home insurance renewal", provider: "Harbour Mutual", reference: "HM-7", cost: "£420.00",
      dueDate: "2026-10-03", recurrenceMonths: 12, subtype: "insurance", scheduleKind: "renewal", kind: "renewal",
      currency: "GBP",
    });
    expect(amended).not.toHaveProperty("sectionId");
  });

  it("sends the new kind when the type was changed, for the engine to map", () => {
    const item = proposedItemOf(/** @type {any} */ (suggestion()), where);
    expect(amendedOf(item, editsOf({ ...draftOf(item), kind: "service" })).item).toMatchObject({ kind: "service" });
  });
});
