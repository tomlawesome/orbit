import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * ADR-0034 decision 5 (#1325): the engine owns every rule, and the seam is
 * enforced rather than promised. The lint rule in eslint.config.mjs stops
 * browser code importing the engine; this pins that the rule functions the
 * browser used to carry -- whether a change is allowed, what state it
 * produces -- are gone from web/src, so a copy cannot quietly come back.
 *
 * The belt page (routes/item/) kept its own refusals until it retired with
 * #1319 (decision 6); its exemption retired with it.
 */

const WEB_SRC = resolve(import.meta.dirname, "../../web/src");

/** @param {string} dir @returns {string[]} */
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(js|ts|svelte)$/u.test(entry.name) ? [path] : [];
  });
}

const files = sources(WEB_SRC)
  .map((path) => ({ path: relative(WEB_SRC, path), text: readFileSync(path, "utf8") }));

/** Every file under web/src where `pattern` matches. @param {RegExp} pattern */
const where = (pattern) => files.filter(({ text }) => pattern.test(text)).map(({ path }) => path);

describe("the browser carries no rules (ADR-0034, #1325)", () => {
  it("reads the front end's sources", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(["refusalOf", "scheduleOf", "fieldsOf", "nextDateAfter"])("%s is gone", (name) => {
    expect(where(new RegExp(`\\b${name}\\b`, "u"))).toEqual([]);
  });

  it("the snooze floor is the engine's: neither its words nor its check are in the browser", () => {
    expect(where(/snooze to a day after today/u)).toEqual([]);
    expect(where(/until\s*(<=|>)\s*(today|view\.today|detail\.today)\b/u)).toEqual([]);
  });

  it("the locked-key refusal is worded by the engine, not the browser (#1335)", () => {
    expect(where(/encrypted details are locked/u)).toEqual([]);
  });

  it("no browser module words a refusal the engine words", () => {
    const words = [
      "give it a name", "choose a section", "a repeat needs a due date", "use a dot for pence",
      "reminders", "a reminder is at most", "choose the day it was done",
    ].map((phrase) => `not yet — ${phrase}`);
    expect(words.flatMap((phrase) => where(new RegExp(phrase, "u")))).toEqual([]);
  });
});
