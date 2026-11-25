import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/*
 * #1964 step 1 (owner decisions 110a, 111a): the rig's time limits and reduced
 * motion are set once, in web/playwright.config.js (covered by
 * web-playwright-config.test.mjs). A spec under web/tests/rig/ therefore does
 * not repeat them:
 *   - no `reducedMotion: "reduce"` (a spec may opt back in with "no-preference");
 *   - no SETTLE constant, import or use (the config's expect timeout covers it);
 *   - no test limit of 60 s or less (RIG_TEST_MS counts as 60000, RIG_TEST_MS * k
 *     as 60000 * k). Limits above 60 s stay allowed until the fake-clock step.
 *
 * The specs are read as text, with comments blanked out first so a comment
 * that mentions these words does not trip the scan. Each failure names the
 * offending file:line.
 */
const root = fileURLToPath(new URL("../", import.meta.url));
const rigDir = resolve(root, "web/tests/rig");
const RIG_TEST_MS = 60_000;

function specFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...specFiles(path));
    else if (/\.spec\.[cm]?[jt]s$/u.test(entry.name)) out.push(path);
  }
  return out.sort();
}

// Blank // and /* */ comments (keeping newlines, so line numbers hold) and leave
// string and template contents alone, so a "//" inside a URL is not a comment.
export function blankComments(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") { out += " "; i++; }
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (; i < stop; i++) out += source[i] === "\n" ? "\n" : " ";
    } else if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < source.length && source[i] !== c) {
        if (source[i] === "\\") { out += source[i++]; }
        if (c !== "`" && source[i] === "\n") break;
        out += source[i++];
      }
      if (i < source.length) out += source[i++];
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

// "20_000", "RIG_TEST_MS", "RIG_TEST_MS * 2", "30_000 * 2"; null if not readable.
function milliseconds(expression) {
  let product = 1;
  for (const term of expression.split("*").map((part) => part.trim())) {
    if (/^\d[\d_]*$/u.test(term)) product *= Number(term.replaceAll("_", ""));
    else if (term === "RIG_TEST_MS") product *= RIG_TEST_MS;
    else return null;
  }
  return product;
}

const specs = specFiles(rigDir).map((path) => ({
  name: relative(root, path),
  text: blankComments(readFileSync(path, "utf8")),
}));

function offences(pattern) {
  const found = [];
  for (const { name, text } of specs) {
    for (const m of text.matchAll(pattern)) found.push(`${name}:${lineOf(text, m.index)}: ${m[0].trim()}`);
  }
  return found;
}

describe("web/tests/rig specs leave the limits to the config (#1964)", () => {
  it("finds the rig specs", () => {
    expect(specs.length).toBeGreaterThan(10);
  });

  it("blanks comments but not strings", () => {
    const blanked = blankComments('a // SETTLE\n/* SETTLE\nSETTLE */ b "http://x" `//`');
    expect(blanked).not.toMatch(/SETTLE/u);
    expect(blanked).toContain('"http://x"');
    expect(blanked.split("\n")).toHaveLength(3);
  });

  it('sets no reducedMotion: "reduce" (the config default covers it)', () => {
    const found = offences(/reducedMotion\s*:\s*["'`]reduce["'`]/gu);
    expect(found, `remove these:\n${found.join("\n")}`).toEqual([]);
  });

  it("defines, imports or uses no SETTLE", () => {
    const found = offences(/\bSETTLE\b/gu);
    expect(found, `remove these:\n${found.join("\n")}`).toEqual([]);
  });

  it("sets no test limit of 60 s or less (describe.configure or test.setTimeout)", () => {
    const found = [];
    const check = (name, text, index, expression) => {
      const ms = milliseconds(expression);
      if (ms !== null && ms <= RIG_TEST_MS) found.push(`${name}:${lineOf(text, index)}: ${expression.trim()} (${ms} ms)`);
    };
    for (const { name, text } of specs) {
      for (const m of text.matchAll(/\b(?:test|testInfo)\.setTimeout\(\s*([^)]*?)\s*\)/gu)) {
        check(name, text, m.index, m[1]);
      }
      for (const m of text.matchAll(/\.configure\(\s*\{([^}]*)\}/gu)) {
        const t = /\btimeout\s*:\s*([^,}]+)/u.exec(m[1]);
        if (t) check(name, text, m.index, t[1]);
      }
    }
    expect(found, `remove these (the config default is ${RIG_TEST_MS} ms):\n${found.join("\n")}`).toEqual([]);
  });
});
