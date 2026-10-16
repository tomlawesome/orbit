import { describe, expect, it } from "vitest";
import { householdToday } from "./household-date";
import { snoozeRefusal } from "./refusals";

describe("householdToday", () => {
  it("is the calendar date in the household's own zone", () => {
    const lateEvening = new Date("2026-10-08T23:30:00.000Z");
    expect(householdToday("Europe/London", lateEvening)).toBe("2026-10-09");
    expect(householdToday("UTC", lateEvening)).toBe("2026-10-08");
    expect(householdToday("America/New_York", lateEvening)).toBe("2026-10-08");
  });

  it("is the household's date, not UTC's, where the two differ at this instant", () => {
    const earlyMorningUtc = new Date("2026-10-08T03:00:00.000Z");
    expect(householdToday("Pacific/Auckland", earlyMorningUtc)).toBe("2026-10-08");
    expect(householdToday("America/Los_Angeles", earlyMorningUtc)).toBe("2026-10-07");
    expect(earlyMorningUtc.toISOString().slice(0, 10)).toBe("2026-10-08");
  });

  it("reads an unknown zone as UTC", () => {
    expect(householdToday("Not/AZone", new Date("2026-10-08T23:30:00.000Z"))).toBe("2026-10-08");
  });
});

describe("the snooze floor (#1325)", () => {
  it("must land after today", () => {
    expect(snoozeRefusal("2026-10-08", "2026-10-08")).toBe("snoozeFloor");
    expect(snoozeRefusal("2026-10-07", "2026-10-08")).toBe("snoozeFloor");
    expect(snoozeRefusal("2026-10-09", "2026-10-08")).toBeNull();
  });
});
