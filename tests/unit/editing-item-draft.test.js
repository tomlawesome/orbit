import { describe, expect, it } from "vitest";

// #1319 — editing in the drawer's own rows: what the rows hold (draftOf), how
// a typed reminders row reads (remindersOf), what a save sends or refuses
// (editsOf) and the choices the choosers offer. Pure, no DOM.
import {
  PERIODS, REMINDER_DAYS_MAX, TYPES, chooserAskOf, draftOf, editsOf, periodChoices, periodWords,
  remindersOf, remindersWords, sectionChoices, typeChoices,
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

describe("editsOf, refusing", () => {
  const refusal = (over) => editsOf({ ...draftOf(item()), ...over }, item());

  it("saves the unchanged draft", () => {
    expect(editsOf(draftOf(item()), item())).toHaveProperty("edits");
  });

  it("refuses without a name or a section", () => {
    expect(refusal({ title: "   " })).toEqual({ refusal: "not yet — give it a name" });
    expect(refusal({ sectionId: null })).toEqual({ refusal: "not yet — choose a section" });
  });

  it("refuses a cost that is not a sum", () => {
    expect(refusal({ cost: "12,50" })).toEqual({ refusal: "not yet — use a dot for pence, for example 12.50" });
    expect(refusal({ cost: "lots" })).toHaveProperty("refusal");
  });

  it("refuses a repeat without a due date", () => {
    expect(refusal({ dueDate: "", recurrence: 12 })).toEqual({ refusal: "not yet — a repeat needs a due date" });
    expect(refusal({ dueDate: "", recurrence: 0 })).toHaveProperty("edits");
  });

  it("refuses more than eight reminders, and one too far ahead", () => {
    const nine = "1 2 3 4 5 6 7 8 9";
    expect(refusal({ reminders: nine })).toEqual({ refusal: "not yet — at most 8 reminders" });
    expect(refusal({ reminders: "1 2 3 4 5 6 7 8" })).toHaveProperty("edits");
    expect(refusal({ reminders: `${REMINDER_DAYS_MAX + 1}d before` }))
      .toEqual({ refusal: `not yet — a reminder is at most ${REMINDER_DAYS_MAX} days before` });
    expect(refusal({ reminders: `${REMINDER_DAYS_MAX}d before` })).toHaveProperty("edits");
  });
});

describe("editsOf, the edits", () => {
  it("sends the fields as the model holds them", () => {
    const { edits } = editsOf(draftOf(item()), item());
    expect(edits).toMatchObject({
      sectionId: "vehicle",
      title: "MOT",
      provider: "Kwik Fit",
      reference: "R-1",
      costMinor: 5400,
      dueDate: "2026-11-01",
      recurrenceMonths: 12,
      reminderDays: [21, 7],
      notes: "bring V5C",
    });
  });

  it("reads the typed rows: trimmed title, the cost's sign dropped, reminders parsed", () => {
    const { edits } = editsOf(
      { ...draftOf(item()), title: "  MOT test ", cost: "£1,250.5", reminders: "3d before · 30d before" }, item());
    expect(edits).toMatchObject({ title: "MOT test", costMinor: 125050, reminderDays: [30, 3] });
  });

  it("keeps the item's own schedule and writes no subtype while the type is unchanged", () => {
    const { edits } = editsOf(draftOf(item()), item());
    expect(edits.scheduleKind).toBe("service");
    expect(edits).not.toHaveProperty("subtype");
  });

  it("writes the new kind's subtype and schedule when the type is retyped", () => {
    const draft = { ...draftOf(item()), kind: "renewal" };
    const { edits } = editsOf(draft, item());
    expect(edits).toMatchObject({ subtype: "renewal", scheduleKind: "renewal" });
  });

  it("retypes to inspection as a service with the inspection subtype", () => {
    const service = item({ subtype: "service", scheduleKind: "service" });
    const { edits } = editsOf({ ...draftOf(service), kind: "inspection" }, service);
    expect(edits).toMatchObject({ subtype: "inspection", scheduleKind: "service" });
  });

  it("retypes to a document as an expiry that does not recur", () => {
    const { edits } = editsOf({ ...draftOf(item()), kind: "document" }, item());
    expect(edits).toMatchObject({ subtype: "document", scheduleKind: "expiry" });
    expect(edits.recurrenceMonths).toBeUndefined();
  });

  it("drops the schedule without a due date", () => {
    const { edits } = editsOf({ ...draftOf(item()), dueDate: "", recurrence: 0 }, item());
    expect(edits.dueDate).toBeUndefined();
    expect(edits.scheduleKind).toBeUndefined();
  });

  it("treats giving a kindless item a type as a retype", () => {
    const plain = item({ subtype: null, scheduleKind: null });
    const { edits } = editsOf({ ...draftOf(plain), kind: "service" }, plain);
    expect(edits).toMatchObject({ subtype: "service", scheduleKind: "service" });
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
