import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * #1369: no e2e file may seed a date from the UTC calendar.
 *
 * Specs built due dates with `new Date(Date.now() + N * 86400000)
 * .toISOString().slice(0, 10)`, which is the UTC date. The test households
 * live in Europe/London, and between 23:00 and 24:00 UTC in UK summer time
 * London is already on the next day -- so "20 days ahead" showed T-19d and the
 * spec failed for one hour of every day, for half the year.
 *
 * The replacement is `householdDateFromToday(days)` from
 * `tests/e2e/support/household-dates.ts`, which counts from the household's
 * own date.
 *
 * This test is the tripwire. A file that goes back to the UTC date fails here,
 * in the fast suite, rather than in an e2e run that only breaks late in the
 * evening.
 */

const e2eDirectory = new URL("../e2e/", import.meta.url).pathname;

function tsFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return tsFiles(path);
      return entry.name.endsWith(".ts") ? [path] : [];
    })
    .sort();
}

describe("e2e files seed no date from the UTC calendar", () => {
  it("finds e2e files to check, so a rename cannot silently empty this test", () => {
    expect(tsFiles(e2eDirectory).length).toBeGreaterThan(10);
  });

  it("has no line mixing Date.now() with .toISOString().slice(0, 10)", () => {
    const offenders = tsFiles(e2eDirectory).flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(
          ({ line }) =>
            line.includes("Date.now()") && line.includes(".toISOString().slice(0, 10)"),
        )
        .map(({ number }) => `${path.slice(e2eDirectory.length)}:${number}`),
    );

    expect(
      offenders,
      `These lines seed a date from the UTC calendar. Use ` +
        `householdDateFromToday(days) from support/household-dates.ts, which ` +
        `counts from the household's own date. See #1369.`,
    ).toEqual([]);
  });
});
