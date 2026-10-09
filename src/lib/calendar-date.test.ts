import { describe, expect, it } from "vitest";
import { calendarDate, isCalendarDate } from "./calendar-date";

describe("isCalendarDate", () => {
  it.each(["2026-01-01", "2026-12-31", "2028-02-29", "2000-02-29", "2026-02-28", "2026-04-30", "0001-01-01"])(
    "accepts the real day %s",
    (value) => expect(isCalendarDate(value)).toBe(true),
  );

  it.each([
    "2026-02-31", "2026-13-45", "2026-00-10", "2026-01-00", "2026-04-31", "2027-02-29", "1900-02-29", "2100-02-29",
    "2026-1-1", "26-01-01", "2026-01-01T00:00:00Z", " 2026-01-01", "2026-01-01 ", "2026/01/01", "", "２０２６-０１-０１",
  ])("refuses %j", (value) => expect(isCalendarDate(value)).toBe(false));

  it.each([undefined, null, 20260101, new Date(0), {}])("refuses a non-string, %j", (value) => {
    expect(isCalendarDate(value)).toBe(false);
  });

  it("does not let the machine's time zone move a day", () => {
    expect(isCalendarDate("2026-03-29")).toBe(true);
    expect(isCalendarDate("2026-10-25")).toBe(true);
  });
});

describe("the zod calendarDate", () => {
  it("passes a real day through and refuses the rest with a message", () => {
    expect(calendarDate.parse("2026-07-22")).toBe("2026-07-22");
    const refused = calendarDate.safeParse("2026-02-31");
    expect(refused.success).toBe(false);
    if (!refused.success) expect(refused.error.issues[0].message).toMatch(/real calendar day/u);
    expect(calendarDate.safeParse(20260722).success).toBe(false);
  });
});
