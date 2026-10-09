import { describe, expect, it } from "vitest";
import { addCalendarMonths, nextDueDate } from "./next-due-date";

/* ADR-0034, #1324: the next due date after a completion is the engine's.
   These pin what the browser's nextDateAfter (web/src/lib/data/commands.js)
   used to, now that it is gone. */
describe("addCalendarMonths", () => {
  it("holds the day of the month when it exists", () => {
    expect(addCalendarMonths("2026-08-15", 12)).toBe("2027-08-15");
    expect(addCalendarMonths("2026-08-15", 6)).toBe("2027-02-15");
    expect(addCalendarMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(addCalendarMonths("2026-10-08", 0)).toBe("2026-10-08");
  });

  it("clamps to the end of a shorter month rather than running into the next", () => {
    expect(addCalendarMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addCalendarMonths("2026-05-31", 1)).toBe("2026-06-30");
    expect(addCalendarMonths("2026-08-31", 3)).toBe("2026-11-30");
    expect(addCalendarMonths("2026-03-31", -1)).toBe("2026-02-28");
  });

  it("knows leap years", () => {
    expect(addCalendarMonths("2027-12-31", 2)).toBe("2028-02-29");
    expect(addCalendarMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addCalendarMonths("2028-02-29", 12)).toBe("2029-02-28");
    expect(addCalendarMonths("2028-02-29", 48)).toBe("2032-02-29");
    expect(addCalendarMonths("2099-02-28", 12)).toBe("2100-02-28");
    expect(addCalendarMonths("2099-01-31", 13)).toBe("2100-02-28");
    expect(addCalendarMonths("2399-01-31", 13)).toBe("2400-02-29");
  });
});

describe("nextDueDate", () => {
  const completed = "2026-01-31";

  it.each([
    [1, "2026-02-28"],
    [3, "2026-04-30"],
    [6, "2026-07-31"],
    [12, "2027-01-31"],
    [24, "2028-01-31"],
    [18, "2027-07-31"],
    [7, "2026-08-31"],
    [120, "2036-01-31"],
  ])("a %i-month period comes round on %s", (months, expected) => {
    expect(nextDueDate({ scheduleKind: "renewal", recurrenceMonths: months }, completed)).toBe(expected);
    expect(nextDueDate({ scheduleKind: "service", recurrenceMonths: months }, completed)).toBe(expected);
  });

  it("counts from the day it was done, not the day it was due", () => {
    expect(nextDueDate({ scheduleKind: "renewal", recurrenceMonths: 12 }, "2026-07-25")).toBe("2027-07-25");
  });

  it("gives nothing when the item has no period", () => {
    expect(nextDueDate({ scheduleKind: "renewal" }, completed)).toBeUndefined();
    expect(nextDueDate({ scheduleKind: "service", recurrenceMonths: null }, completed)).toBeUndefined();
    expect(nextDueDate({ scheduleKind: "service", recurrenceMonths: 0 }, completed)).toBeUndefined();
  });

  it("gives nothing for an expiry, which happens once (#1005)", () => {
    expect(nextDueDate({ scheduleKind: "expiry", recurrenceMonths: 12 }, completed)).toBeUndefined();
    expect(nextDueDate({ scheduleKind: "expiry" }, completed)).toBeUndefined();
  });

  it("gives nothing for an unscheduled item", () => {
    expect(nextDueDate({ recurrenceMonths: 12 }, completed)).toBeUndefined();
  });
});
