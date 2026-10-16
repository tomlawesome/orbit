import { describe, expect, it } from "vitest";

// #1319 — the due date's month calendar: pure date arithmetic on YYYY-MM-DD
// strings read in UTC, Monday-first, always six rows of seven.
import {
  addDays, addMonths, dowOf, isoOf, monthGrid, relWords, restingDay, spokenDate, stepDay,
} from "../../web/src/lib/editing/calendar.js";
import { bandOf, daysBetween } from "../../web/src/lib/format.js";

const TODAY = "2026-10-08"; // a Thursday

describe("day arithmetic", () => {
  it("reads Monday as 0 and Sunday as 6", () => {
    expect(dowOf("2026-10-05")).toBe(0);
    expect(dowOf("2026-10-08")).toBe(3);
    expect(dowOf("2026-10-11")).toBe(6);
  });

  it("builds an iso day from an overflowing month or day", () => {
    expect(isoOf(2026, 12, 1)).toBe("2027-01-01");
    expect(isoOf(2026, 9, 0)).toBe("2026-09-30");
    expect(isoOf(2026, 9, 1 - 3)).toBe("2026-09-28");
  });

  it("adds days across month, year and leap boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-10-08", -8)).toBe("2026-09-30");
  });

  it("counts days from today, negative once passed", () => {
    expect(daysBetween(TODAY, TODAY)).toBe(0);
    expect(daysBetween(TODAY, "2026-10-24")).toBe(16);
    expect(daysBetween(TODAY, "2026-10-07")).toBe(-1);
  });

  it("says a day aloud", () => {
    expect(spokenDate("2026-10-08")).toBe("Thursday 8 October 2026");
    expect(spokenDate("2028-02-29")).toBe("Tuesday 29 February 2028");
  });
});

describe("addMonths", () => {
  it("holds the day to the end of a shorter month", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2026-05-31", 1)).toBe("2026-06-30");
  });

  it("lands on 29 February in a leap year, and 28 February after it", () => {
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2028-01-29", 1)).toBe("2028-02-29");
    expect(addMonths("2028-02-29", 12)).toBe("2029-02-28");
    expect(addMonths("2028-02-29", -12)).toBe("2027-02-28");
    expect(addMonths("2028-02-29", 48)).toBe("2032-02-29");
  });

  it("crosses year ends in both directions and keeps an ordinary day", () => {
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
    expect(addMonths("2026-10-08", 0)).toBe("2026-10-08");
    expect(addMonths("2026-10-08", 14)).toBe("2027-12-08");
  });
});

describe("relWords and bandOf", () => {
  it("speaks today, the future and the past, singular and plural", () => {
    expect(relWords(TODAY, TODAY)).toBe("today");
    expect(relWords("2026-10-09", TODAY)).toBe("in 1 day");
    expect(relWords("2026-10-24", TODAY)).toBe("in 16 days");
    expect(relWords("2026-10-07", TODAY)).toBe("1 day overdue");
    expect(relWords("2026-10-05", TODAY)).toBe("3 days overdue");
  });

  it("bands a day at its boundaries: overdue, to 30 days, to 90, later", () => {
    const at = (days) => bandOf(daysBetween(TODAY, addDays(TODAY, days)));
    expect(at(-1)).toBe("overdue");
    expect(at(0)).toBe("due-soon");
    expect(at(30)).toBe("due-soon");
    expect(at(31)).toBe("upcoming");
    expect(at(90)).toBe("upcoming");
    expect(at(91)).toBe("ok");
  });
});

describe("monthGrid", () => {
  const flat = (weeks) => weeks.flat();

  it("is always six weeks of seven, whatever the month", () => {
    for (let month = 0; month < 12; month++) {
      const weeks = monthGrid(2026, month, TODAY);
      expect(weeks).toHaveLength(6);
      for (const week of weeks) expect(week).toHaveLength(7);
    }
    // February 2027 is four exact weeks (it starts on a Monday); the grid still has six.
    expect(monthGrid(2027, 1, TODAY)).toHaveLength(6);
  });

  it("starts on a Monday and runs 42 consecutive days", () => {
    for (const [year, month] of [[2026, 9], [2026, 1], [2027, 1], [2028, 1], [2026, 11]]) {
      const days = flat(monthGrid(year, month, TODAY));
      expect(dowOf(days[0].iso)).toBe(0);
      days.forEach((day, i) => expect(day.iso).toBe(addDays(days[0].iso, i)));
    }
  });

  it("marks the neighbouring months' days off and the month's own on", () => {
    const days = flat(monthGrid(2026, 9, TODAY)); // October 2026 starts on a Thursday
    expect(days[0].iso).toBe("2026-09-28");
    expect(days.slice(0, 3).every((d) => d.off)).toBe(true);
    expect(days[3]).toMatchObject({ iso: "2026-10-01", day: 1, off: false });
    expect(days.filter((d) => !d.off)).toHaveLength(31);
    expect(days[41]).toMatchObject({ iso: "2026-11-08", off: true });
  });

  it("needs no lead-in when the month starts on a Monday", () => {
    const weeks = monthGrid(2027, 1, TODAY); // 1 February 2027 is a Monday
    expect(weeks[0][0]).toMatchObject({ iso: "2027-02-01", off: false });
    expect(weeks[4].every((d) => d.off)).toBe(true);
    expect(flat(weeks).filter((d) => !d.off)).toHaveLength(28);
  });

  it("leads in six days when the month starts on a Sunday", () => {
    const weeks = monthGrid(2026, 1, TODAY); // 1 February 2026 is a Sunday
    expect(weeks[0][0].iso).toBe("2026-01-26");
    expect(weeks[0][6]).toMatchObject({ iso: "2026-02-01", off: false });
    expect(weeks[0].slice(0, 6).every((d) => d.off)).toBe(true);
  });

  it("counts a leap February as 29 days", () => {
    expect(flat(monthGrid(2028, 1, TODAY)).filter((d) => !d.off)).toHaveLength(29);
    expect(flat(monthGrid(2026, 1, TODAY)).filter((d) => !d.off)).toHaveLength(28);
  });

  it("takes a month past either end of the year as the next or last year's", () => {
    const next = flat(monthGrid(2026, 12, TODAY)); // month 12 is January 2027
    expect(next.find((d) => d.iso === "2027-01-01").off).toBe(false);
    expect(next.find((d) => d.iso === "2026-12-31").off).toBe(true);
    const last = flat(monthGrid(2026, -1, TODAY)); // month -1 is December 2025
    expect(last.find((d) => d.iso === "2025-12-31").off).toBe(false);
    expect(last.find((d) => d.iso === "2026-01-01").off).toBe(true);
  });

  it("flags today once, and the days before it as past", () => {
    const days = flat(monthGrid(2026, 9, TODAY));
    expect(days.filter((d) => d.today).map((d) => d.iso)).toEqual([TODAY]);
    expect(days.filter((d) => d.past).every((d) => d.iso < TODAY)).toBe(true);
    expect(days.find((d) => d.iso === "2026-10-07").past).toBe(true);
    expect(days.find((d) => d.iso === TODAY).past).toBe(false);
    expect(days.find((d) => d.iso === "2026-10-09").past).toBe(false);
  });

  it("flags no day as today when today is outside the grid", () => {
    expect(flat(monthGrid(2027, 5, TODAY)).some((d) => d.today)).toBe(false);
  });
});

describe("stepDay", () => {
  it("steps a day or a week with the arrows", () => {
    expect(stepDay(TODAY, "ArrowLeft")).toBe("2026-10-07");
    expect(stepDay(TODAY, "ArrowRight")).toBe("2026-10-09");
    expect(stepDay(TODAY, "ArrowUp")).toBe("2026-10-01");
    expect(stepDay(TODAY, "ArrowDown")).toBe("2026-10-15");
  });

  it("takes Home and End to the week's Monday and Sunday, and holds there", () => {
    expect(stepDay(TODAY, "Home")).toBe("2026-10-05");
    expect(stepDay(TODAY, "End")).toBe("2026-10-11");
    expect(stepDay("2026-10-05", "Home")).toBe("2026-10-05");
    expect(stepDay("2026-10-11", "End")).toBe("2026-10-11");
    expect(stepDay("2026-10-11", "Home")).toBe("2026-10-05");
  });

  it("pages a month with PageUp and PageDown, clamping a short month", () => {
    expect(stepDay(TODAY, "PageUp")).toBe("2026-09-08");
    expect(stepDay(TODAY, "PageDown")).toBe("2026-11-08");
    expect(stepDay("2026-03-31", "PageUp")).toBe("2026-02-28");
    expect(stepDay("2026-01-31", "PageDown")).toBe("2026-02-28");
  });

  it("pages a year with Shift, clamping 29 February", () => {
    expect(stepDay(TODAY, "PageUp", true)).toBe("2025-10-08");
    expect(stepDay(TODAY, "PageDown", true)).toBe("2027-10-08");
    expect(stepDay("2028-02-29", "PageUp", true)).toBe("2027-02-28");
    expect(stepDay("2028-02-29", "PageDown", true)).toBe("2029-02-28");
  });

  it("is null for a key that is not the calendar's", () => {
    expect(stepDay(TODAY, "Enter")).toBeNull();
    expect(stepDay(TODAY, "a")).toBeNull();
    expect(stepDay(TODAY, "Tab", true)).toBeNull();
  });
});

describe("restingDay", () => {
  it("keeps the draft day when it is in the month shown", () => {
    expect(restingDay(2026, 9, "2026-10-20", "2026-10-08")).toBe("2026-10-20");
  });

  it("falls back to the chosen day's date when the draft is in another month", () => {
    expect(restingDay(2026, 10, "2026-10-20", "2026-10-08")).toBe("2026-11-08");
    expect(restingDay(2027, 9, "2026-10-20", "2026-10-08")).toBe("2027-10-08");
    expect(restingDay(2026, 10, null, "2026-10-08")).toBe("2026-11-08");
  });

  it("holds the chosen date to the shown month's length", () => {
    expect(restingDay(2026, 1, null, "2026-01-31")).toBe("2026-02-28");
    expect(restingDay(2028, 1, null, "2026-01-31")).toBe("2028-02-29");
    expect(restingDay(2026, 3, null, "2026-01-31")).toBe("2026-04-30");
  });

  it("rests on the 1st with nothing chosen", () => {
    expect(restingDay(2026, 10, null, null)).toBe("2026-11-01");
    expect(restingDay(2026, 10, "2026-10-20", null)).toBe("2026-11-01");
  });
});
