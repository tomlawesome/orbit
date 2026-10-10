import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
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

/**
 * #1369, pipeline 2332: `householdDateFromToday` is a Node import. A function
 * handed to `page.evaluate` runs in the browser, where the import does not
 * exist, so a call inside one throws "_householdDates is not defined". The
 * date is worked out in the spec and passed in as an argument instead.
 */
const BROWSER_CALLS = new Set(["evaluate", "evaluateHandle", "evaluateAll", "addInitScript", "waitForFunction", "$eval", "$$eval"]);

function callsInsideTheBrowser(path) {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node, inBrowser) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && BROWSER_CALLS.has(node.expression.name.text)) {
      visit(node.expression, inBrowser);
      node.arguments.forEach((argument) =>
        visit(argument, inBrowser || ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)),
      );
      return;
    }
    if (inBrowser && ts.isIdentifier(node) && node.text === "householdDateFromToday") {
      found.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, (child) => visit(child, inBrowser));
  };
  visit(source, false);
  return found;
}

describe("householdDateFromToday runs in the spec, never in the browser", () => {
  it("is not called inside a function handed to the page", () => {
    const offenders = tsFiles(e2eDirectory).flatMap((path) =>
      callsInsideTheBrowser(path).map((line) => `${path.slice(e2eDirectory.length)}:${line}`),
    );

    expect(
      offenders,
      `These calls run in the browser, where householdDateFromToday does not ` +
        `exist. Work the date out in the spec and pass it to page.evaluate as ` +
        `an argument. See #1369.`,
    ).toEqual([]);
  });
});
