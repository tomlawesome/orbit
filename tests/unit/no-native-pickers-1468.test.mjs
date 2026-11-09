import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1468 Part A, point 5 (spec: note 53008; owner decision 43): no native
 * picker anywhere in the web app. A `<select>` and an `<input type="date">`
 * open the browser's own control, which wears no Orbit look; every choice is
 * made on the chooser card (web/src/lib/editing). The allow-list starts empty
 * and stays empty: a new site is a failing test, not an entry here.
 *
 * Scans every .svelte, .js and .html file under web/src. Text inside
 * comments (a doc comment that names `<select>`, such as the tour chapter's)
 * is not a site.
 */

const SRC = resolve(import.meta.dirname, "../../web/src");
/** Files allowed to hold a native picker. Empty on purpose (#1468). */
const ALLOWED = /** @type {string[]} */ ([]);

/** @param {string} dir @returns {string[]} */
function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path);
    return /\.(svelte|js|html)$/u.test(name) ? [path] : [];
  });
}

/** The text with comments blanked, keeping every newline so line numbers hold. @param {string} text */
function withoutComments(text) {
  const blank = (/** @type {string} */ span) => span.replace(/[^\n]/gu, " ");
  return text
    .replace(/<!--[^]*?-->/gu, blank)
    .replace(/\/\*[^]*?\*\//gu, blank)
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/gu, (whole, lead) => lead + blank(whole.slice(lead.length)));
}

/** `<select` as an element, and an `<input` whose attributes say type="date". */
const SELECT = /<select(?=[\s>/])/gu;
const DATE_INPUT = /<input(?=[\s/>])(?:[^<>{}]|\{[^}]*\})*?\btype\s*=\s*(["']?)date\1(?=[\s/>])/gu;

/** @returns {string[]} "path:line  what" for each site */
function sites() {
  const found = /** @type {string[]} */ ([]);
  for (const file of filesUnder(SRC)) {
    const path = relative(SRC, file);
    if (ALLOWED.includes(path)) continue;
    const text = withoutComments(readFileSync(file, "utf8"));
    for (const [pattern, what] of /** @type {const} */ ([[SELECT, "<select>"], [DATE_INPUT, '<input type="date">']])) {
      for (const match of text.matchAll(pattern)) {
        found.push(`web/src/${path}:${text.slice(0, match.index).split("\n").length}  ${what}`);
      }
    }
  }
  return found;
}

describe("no native pickers in web/src (#1468 Part A)", () => {
  it("keeps the allow-list empty", () => {
    expect(ALLOWED).toEqual([]);
  });

  it("has no <select> and no <input type=\"date\"> in any .svelte, .js or .html file", () => {
    expect(sites(), "each of these opens the browser's own picker; use the chooser card").toEqual([]);
  });

  it("does not take a comment that names <select> for a site (the tour chapter's note)", () => {
    const comment = "/** the real control is `#f-recur`, a `<select>`; <!-- <input type=\"date\"> --> */";
    expect(withoutComments(comment).match(SELECT)).toBeNull();
    expect(withoutComments(comment).match(DATE_INPUT)).toBeNull();
    expect(withoutComments('<input id="x" type="date">').match(DATE_INPUT)).not.toBeNull();
    expect(withoutComments("<select id=\"x\">").match(SELECT)).not.toBeNull();
  });
});
