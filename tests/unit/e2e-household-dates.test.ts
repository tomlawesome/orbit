import { describe, expect, it } from "vitest";

import { householdDateFromToday } from "../e2e/support/household-dates";

/**
 * #1369: a seeded due date is counted from the household's own calendar date,
 * not from the UTC date.
 *
 * The test households live in Europe/London. Between 23:00 and 24:00 UTC in
 * UK summer time London is already on the next day, so "20 days ahead" taken
 * from the UTC date shows T-19d. Every case below uses a fixed instant, with
 * the answer worked out by hand, so the result does not depend on when the
 * test runs.
 */

const at = (iso: string) => new Date(iso);

describe("householdDateFromToday", () => {
  it("uses London's date, not UTC's, late in a summer evening", () => {
    // 2026-10-09 23:05 UTC. London is on BST (UTC+1): 2026-10-10 00:05.
    // Today there = 10 Oct. 10 Oct + 20 days = 30 Oct.
    expect(householdDateFromToday(20, "Europe/London", at("2026-10-09T23:05:00Z"))).toBe(
      "2026-10-30",
    );
  });

  it("defaults the zone to Europe/London", () => {
    // Same instant as above; no zone given, so London's 10 Oct applies.
    expect(householdDateFromToday(20, undefined, at("2026-10-09T23:05:00Z"))).toBe(
      "2026-10-30",
    );
  });

  it("agrees with UTC at midday in summer", () => {
    // 2026-10-09 12:00 UTC is 13:00 BST, still 9 Oct. 9 Oct + 20 = 29 Oct.
    expect(householdDateFromToday(20, "Europe/London", at("2026-10-09T12:00:00Z"))).toBe(
      "2026-10-29",
    );
  });

  it("agrees with UTC late in a winter evening", () => {
    // 2026-12-15 23:30 UTC. Winter, London = UTC, so still 15 Dec.
    // 15 Dec + 16 = 31 Dec; + 4 more = 4 Jan 2027.
    expect(householdDateFromToday(20, "Europe/London", at("2026-12-15T23:30:00Z"))).toBe(
      "2027-01-04",
    );
  });

  it("uses a zone behind UTC, where the date is earlier than UTC's", () => {
    // 2026-10-10 02:00 UTC. New York is on EDT (UTC-4): 2026-10-09 22:00.
    // Today there = 9 Oct. 9 Oct + 1 day = 10 Oct.
    expect(
      householdDateFromToday(1, "America/New_York", at("2026-10-10T02:00:00Z")),
    ).toBe("2026-10-10");
  });

  it("returns today's household date for zero days", () => {
    // New York case again: today is 9 Oct there, though UTC says 10 Oct.
    expect(
      householdDateFromToday(0, "America/New_York", at("2026-10-10T02:00:00Z")),
    ).toBe("2026-10-09");
    // London 23:05 UTC in summer: today is 10 Oct.
    expect(householdDateFromToday(0, "Europe/London", at("2026-10-09T23:05:00Z"))).toBe(
      "2026-10-10",
    );
  });

  it("counts backwards for negative days", () => {
    // 2026-10-09 12:00 UTC, London 9 Oct. 9 Oct - 5 days = 4 Oct.
    expect(householdDateFromToday(-5, "Europe/London", at("2026-10-09T12:00:00Z"))).toBe(
      "2026-10-04",
    );
    // 2026-10-02 12:00 UTC, London 2 Oct. 2 Oct - 5 days = 27 Sep.
    expect(householdDateFromToday(-5, "Europe/London", at("2026-10-02T12:00:00Z"))).toBe(
      "2026-09-27",
    );
  });

  it("is not shifted by the UK clocks going back on 2026-10-25", () => {
    // 20 Oct + 10 days = 30 Oct, across the clock change.
    expect(householdDateFromToday(10, "Europe/London", at("2026-10-20T12:00:00Z"))).toBe(
      "2026-10-30",
    );
    // 2026-10-24 23:30 UTC is 00:30 BST on 25 Oct. 25 Oct + 1 = 26 Oct.
    expect(householdDateFromToday(1, "Europe/London", at("2026-10-24T23:30:00Z"))).toBe(
      "2026-10-26",
    );
    // 2026-10-25 23:30 UTC is 23:30 GMT on 25 Oct. 25 Oct + 1 = 26 Oct.
    expect(householdDateFromToday(1, "Europe/London", at("2026-10-25T23:30:00Z"))).toBe(
      "2026-10-26",
    );
  });

  it("is not shifted by the UK clocks going forward on 2026-03-29", () => {
    // 28 Mar + 2 days = 30 Mar, across the clock change.
    expect(householdDateFromToday(2, "Europe/London", at("2026-03-28T12:00:00Z"))).toBe(
      "2026-03-30",
    );
  });

  it("crosses a month end", () => {
    // 30 Jan + 3 days = 2 Feb (January has 31 days).
    expect(householdDateFromToday(3, "Europe/London", at("2026-01-30T12:00:00Z"))).toBe(
      "2026-02-02",
    );
  });

  it("crosses a year end", () => {
    // 30 Dec 2026 + 3 days = 2 Jan 2027.
    expect(householdDateFromToday(3, "Europe/London", at("2026-12-30T12:00:00Z"))).toBe(
      "2027-01-02",
    );
  });

  it("includes the leap day in 2028", () => {
    // 28 Feb 2028 + 1 = 29 Feb; + 2 = 1 Mar.
    expect(householdDateFromToday(1, "Europe/London", at("2028-02-28T12:00:00Z"))).toBe(
      "2028-02-29",
    );
    expect(householdDateFromToday(2, "Europe/London", at("2028-02-28T12:00:00Z"))).toBe(
      "2028-03-01",
    );
  });

  it("returns a plain YYYY-MM-DD string", () => {
    expect(householdDateFromToday(7)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
