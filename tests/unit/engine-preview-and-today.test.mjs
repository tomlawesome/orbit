import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import * as format from "../../web/src/lib/format.js";
import { addMonths } from "../../web/src/lib/editing/calendar.js";
import { periodChoices } from "../../web/src/lib/editing/item-draft.js";

/*
 * #1337 (the completion preview and "today" come from the engine). Decided
 * 2026-10-09: the draft's "then <date>" shows the date the engine's dry run of
 * item.complete answers (`preview.nextDate`) instead of adding months in the
 * browser; the engine always sends `household.today`, so the browser's UTC-date
 * fallback goes; web/src has one `daysBetween` and one `bandOf`, in
 * web/src/lib/format.js; calendar.js's `addMonths` stays for calendar paging only.
 *
 * The tripwires read source text, so they count definitions (a function, a
 * binding, an object-literal member), never uses or imports.
 */

const WEB_SRC = join(process.cwd(), "web/src");

function sourceFiles(dir = WEB_SRC) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(js|mjs|ts|svelte)$/.test(entry.name)) out.push(path);
  }
  return out;
}
const rel = (path) => relative(WEB_SRC, path).split("\\").join("/");
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
const files = sourceFiles().map((path) => ({ path: rel(path), text: stripComments(readFileSync(path, "utf8")) }));

/** Where `name` is defined: `function name(`, `const|let|var name =`, `name: (…) =>` / `name: function`. */
function definitionsOf(name) {
  const patterns = [
    new RegExp(`\\bfunction\\s*\\*?\\s*${name}\\s*\\(`, "g"),
    new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=`, "g"),
    new RegExp(`(?:^|[\\s,{])${name}\\s*:\\s*(?:async\\s*)?(?:\\(|function\\b|[A-Za-z_$][\\w$]*\\s*=>)`, "gm"),
  ];
  const found = [];
  for (const { path, text } of files) {
    for (const pattern of patterns) {
      for (const _match of text.matchAll(pattern)) found.push(path);
    }
  }
  return found;
}

describe("one daysBetween and one bandOf, in format.js (#1337)", () => {
  it("format.js exports daysBetween and bandOf", () => {
    expect(typeof format.daysBetween, "daysBetween").toBe("function");
    expect(typeof format.bandOf, "bandOf").toBe("function");
  });

  it("daysBetween counts whole calendar days between two bare dates, in either direction", () => {
    expect(format.daysBetween("2026-10-10", "2026-10-10")).toBe(0);
    expect(Math.abs(format.daysBetween("2026-12-31", "2027-01-01"))).toBe(1);
    expect(Math.abs(format.daysBetween("2026-02-27", "2026-03-01"))).toBe(2);
    // Across a clock change: still whole days, no off-by-one from a 23-hour day.
    expect(Math.abs(format.daysBetween("2026-03-28", "2026-03-30"))).toBe(2);
    expect(Math.abs(format.daysBetween("2026-10-24", "2026-10-26"))).toBe(2);
    expect(format.daysBetween("2026-01-01", "2026-03-01")).toBe(-format.daysBetween("2026-03-01", "2026-01-01"));
  });

  for (const name of ["daysBetween", "bandOf"]) {
    it(`${name} has exactly one definition in web/src, and it is in lib/format.js`, () => {
      expect(definitionsOf(name)).toEqual(["lib/format.js"]);
    });
  }

  it("no other file works out calendar days between by rounding a division by a day's milliseconds", () => {
    const copies = files
      .filter(({ path }) => path !== "lib/format.js")
      .filter(({ text }) => /Math\.round\([^\n]*\/\s*(?:86_?400_?000|DAY_MS|864e5)/.test(text))
      .map(({ path }) => path);
    expect(copies).toEqual([]);
  });
});

describe("no UTC-date fallback for today in the browser (#1337)", () => {
  it("web/src never reads the clock's UTC date as a calendar date", () => {
    const pattern = /new Date\(\s*\)\s*\.toISOString\(\)\s*\.(?:slice\(\s*0\s*,\s*10\s*\)|substring\(\s*0\s*,\s*10\s*\)|split\(\s*["']T["']\s*\)\s*\[\s*0\s*\])/;
    const offenders = files.filter(({ text }) => pattern.test(text)).map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it("todayOf, where it still exists, does not fall back to the clock", () => {
    for (const { path, text } of files) {
      const start = text.search(/function\s+todayOf\s*\(|\btodayOf\s*=/);
      if (start < 0) continue;
      const body = text.slice(start, start + 600);
      const end = body.indexOf("\n}");
      const own = end < 0 ? body : body.slice(0, end);
      expect(own, `${path} todayOf`).not.toMatch(/new Date|Date\.now|toISOString/);
    }
  });
});

describe("the draft's \"then <date>\" is the engine's, not added in the browser (#1337)", () => {
  it("item-draft.js does not import or call addMonths", () => {
    const draft = files.find(({ path }) => path === "lib/editing/item-draft.js");
    expect(draft).toBeDefined();
    expect(draft.text).not.toMatch(/\baddMonths\b/);
  });

  it("with no engine preview given, no period's note is a date the browser worked out", () => {
    const notes = periodChoices(12, "2026-01-31").map((choice) => choice.note);
    for (const note of notes) expect(note ?? "", note).not.toMatch(/^then\b/);
  });

  it("addMonths stays, for calendar paging only: calendar.js alone refers to it", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    const users = files.filter(({ text }) => /\baddMonths\b/.test(text)).map(({ path }) => path);
    expect(users).toEqual(["lib/editing/calendar.js"]);
  });
});
