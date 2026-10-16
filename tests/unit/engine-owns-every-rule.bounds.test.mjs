import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1333 (WI-3 of #1328): the engine validates what it stores, and each rule
 * lives in one place. The behaviour is pinned beside the code (workspace.test.ts,
 * portable-archive-import.test.ts, reviewed-intake.test.ts); this pins the
 * shape, so a second copy of a number or a check cannot quietly come back --
 * the way engine-owns-every-rule.test.mjs pins the browser's side of the seam.
 */

const SRC = resolve(import.meta.dirname, "../../src");

/** @param {string} dir @returns {string[]} */
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__fixtures__" ? [] : sources(path);
    return /\.ts$/u.test(entry.name) && !/\.test\.ts$/u.test(entry.name) ? [path] : [];
  });
}

const files = sources(SRC).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, "utf8") }));
const file = (/** @type {string} */ name) => files.find(({ path }) => path === name)?.text ?? "";

/** Every non-test engine file whose text matches `pattern`. @param {RegExp} pattern */
const where = (pattern) => files.filter(({ text }) => pattern.test(text)).map(({ path }) => path);

/** Lines of `name` matching `pattern`, as `file:text`. @param {string} name @param {RegExp} pattern */
const lines = (name, pattern) =>
  file(name).split("\n").filter((line) => pattern.test(line)).map((line) => `${name}: ${line.trim().slice(0, 100)}`);

describe("the engine reads its sources", () => {
  it("finds them", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(file("lib/domain.ts")).not.toBe("");
  });
});

describe("item bounds are named once, in domain.ts (#1333)", () => {
  const names = ["TITLE_MAX", "NOTES_MAX", "COST_MINOR_MAX", "RECURRENCE_MAX", "REMINDER_MAX", "REMINDER_DAYS_MAX"];

  it.each(names)("%s is defined in domain.ts and nowhere else", (name) => {
    expect(where(new RegExp(`export const ${name}\\b`, "u"))).toEqual(["lib/domain.ts"]);
  });

  it("the cost ceiling's digits are written once", () => {
    expect(where(/100_?000_?000/u)).toEqual(["lib/domain.ts"]);
  });

  // A bound is a number of two or more digits inside min/max/optionalText on an item field.
  const bareBound = /\b(title|subtype|provider|reference|notes|costMinor|recurrenceMonths|reminderDays)\b.*\b(max|min|optionalText)\(\s*[\d_]{2,}/u;

  it.each([
    "lib/workspace.ts",
    "server/portable-archive-repository.ts",
    "server/reviewed-intake.ts",
    "server/documents/suggestions.ts",
  ])("%s has no bare bound literal on an item field", (name) => {
    expect(lines(name, bareBound)).toEqual([]);
  });
});

describe("a calendar date is checked in one place (#1333)", () => {
  it("the date shape is spelled out only in calendar-date.ts (a timestamp is another thing)", () => {
    expect(where(/\\d\{4\}-\\d\{2\}-\\d\{2\}\$/u).filter((path) => path !== "lib/calendar-date.ts")).toEqual([]);
  });
});

describe("currency and time zone are checked in one place (#1333)", () => {
  // The one tolerated exception is the read side: a stored row is parsed by shape only
  // (validate on write, tolerate on read), in workspace.ts's `readRules` and nowhere else.
  it("only the read rules size a currency with a bare length or a letter pattern", () => {
    expect(where(/currency[^\n]*(length\(3\)|\[A-Z\]\{3\})/iu)).toEqual(["lib/workspace.ts"]);
    expect(lines("lib/workspace.ts", /currency[^\n]*length\(3\)/iu)).toHaveLength(1);
    expect(where(/CURRENCY_CODE\s*=\s*\//u)).toEqual([]);
  });

  it("the platform lists are read in platform-lists.ts alone", () => {
    expect(where(/supportedValuesOf/u)).toEqual(["lib/platform-lists.ts"]);
  });

  it("only the read rules leave a time zone as any string", () => {
    expect(where(/timezone[^\n]*z\.string\(\)\.min\(1\)\.max\(80\)/u)).toEqual(["lib/workspace.ts"]);
    expect(lines("lib/workspace.ts", /timezone[^\n]*z\.string\(\)\.min\(1\)\.max\(80\)/u)).toHaveLength(1);
  });

  it("every write path takes the strict rules: commands never name the read rules", () => {
    expect(file("lib/workspace.ts").match(/\breadRules\b/gu)).toHaveLength(4);
    expect(where(/\bstored(Item|Activity|Household)Schema\b/u).sort()).toEqual(["lib/workspace.ts", "server/workspace-repository.ts"]);
  });
});

describe("one passwordLength counts a password or passphrase (#1333)", () => {
  it.each(["lib/auth/password.ts", "lib/recovery-bundle.ts", "server/portable-archive.ts"])(
    "%s measures through it",
    (name) => {
      expect(file(name)).toMatch(/\bpasswordLength\b/u);
    },
  );

  it.each(["lib/recovery-bundle.ts", "server/portable-archive.ts"])("%s does not count a passphrase's UTF-16 units", (name) => {
    expect(lines(name, /passphrase\.length|value\.length\s*>=\s*MIN_/u)).toEqual([]);
  });
});
