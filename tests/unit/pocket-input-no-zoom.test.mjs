import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * A pocket text field is 16px or more at every text size, so iOS Safari does
 * not zoom the page when the field is focused (#1180). The floor is the token
 * `--p-type-input` (max(16px, 1rem)); `--p-type-body` is 1rem, which is 15px at
 * the standard text size, so a field sized by it zooms on an iPhone there.
 * One rule, one token: the shared `.p-input` owns the field's type and a screen
 * adds only what is its own (#1356).
 *
 * Read from the files, no DOM, as text-size.test.mjs does for its file checks.
 * The fidelity spec (web/tests/fidelity/pocket-administration.spec.js) measures
 * the same thing in a browser.
 */

const WEB_SRC = resolve(import.meta.dirname, "../../web/src");
const read = (/** @type {string} */ path) => readFileSync(resolve(WEB_SRC, path), "utf8");

/** @param {string} dir @returns {string[]} */
function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === ".svelte-kit") return [];
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** The style a file carries, comments removed: the file itself for css, the <style> blocks for svelte.
 *  @param {string} path */
function styleOf(path) {
  const text = readFileSync(path, "utf8");
  const style = path.endsWith(".svelte")
    ? [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n")
    : text;
  return style.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every declaration block with its selector (at-rule wrappers are not selectors).
 *  @param {string} style @returns {{ selector: string, declarations: string }[]} */
function rulesOf(style) {
  return [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), declarations: m[2] }));
}

/** The values of a rule's `font` and `font-size` declarations.
 *  @param {string} declarations @returns {string[]} */
const fontValuesOf = (declarations) =>
  [...declarations.matchAll(/(?:^|;)\s*font(?:-size)?\s*:\s*([^;]+)/g)].map((m) => m[1].trim());

/** The selectors that name a text field. */
const TEXT_FIELD = /input|textarea|\.p-input|\.pk-field|\.pick-filter|\.st-input/;

describe("a pocket text field takes its size from the 16px floor", () => {
  it("the shared .p-input names --p-type-input in its font, not --p-type-body", () => {
    const rule = rulesOf(styleOf(resolve(WEB_SRC, "lib/pocket/kit.css"))).find((r) => r.selector === ".p-input");
    expect(rule, "kit.css has a .p-input rule").toBeDefined();
    const fonts = fontValuesOf(rule?.declarations ?? "");
    expect(fonts).toHaveLength(1);
    expect(fonts[0]).toContain("--p-type-input");
    expect(fonts[0]).not.toContain("--p-type-body");
  });

  it("no text-field rule anywhere in web/src sizes by the body token or a bare 1rem", () => {
    const offenders = [];
    for (const path of filesUnder(WEB_SRC).filter((f) => /\.(css|svelte)$/.test(f))) {
      for (const { selector, declarations } of rulesOf(styleOf(path))) {
        if (!TEXT_FIELD.test(selector)) continue;
        for (const value of fontValuesOf(declarations)) {
          if (/--p-type-body\b/.test(value) || /(^|\s)1rem(?=[\s/]|$)/.test(value)) {
            offenders.push(`${relative(WEB_SRC, path)}: ${selector} { font: ${value} }`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("settings carries no second copy of the field's type; both password inputs are .p-input", () => {
    const src = read("routes/settings/pocket.svelte");
    for (const { selector, declarations } of rulesOf(styleOf(resolve(WEB_SRC, "routes/settings/pocket.svelte")))) {
      if (/\.st-input/.test(selector)) {
        expect(fontValuesOf(declarations), `${selector} sets its own font`).toEqual([]);
      }
    }
    for (const id of ["st-current", "st-new"]) {
      const tag = src.match(new RegExp(`<input[^>]*\\bid="${id}"[^>]*>`))?.[0];
      expect(tag, `settings/pocket.svelte has the #${id} input`).toBeDefined();
      expect(tag).toMatch(/class="[^"]*\bp-input\b[^"]*"/);
    }
  });

  it("the --p-type-body token's comment no longer promises no-zoom inputs", () => {
    const line = read("lib/pocket/tokens.css").split("\n").find((l) => l.includes("--p-type-body:"));
    expect(line, "tokens.css declares --p-type-body").toBeDefined();
    expect(line).not.toContain("no iOS zoom");
  });
});
