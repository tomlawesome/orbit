import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #854 / #1685: --warm is an orange accent that, drawn as letterforms, fails
 * WCAG 2.2 SC 1.4.3 (4.5:1) on the light packs (dawn, clouds). Text in that
 * hue uses --warm-text. The promise: no stylesheet under web/src (every .css
 * file and every <style> block in a .svelte file) sets `color` to bare
 * var(--warm). Borders, backgrounds, outlines, fills and box-shadows may.
 * This scans the real files (not copies) and reports every offender as
 * "path:line: selector", with the line true in the original file.
 */

const SRC = resolve(import.meta.dirname, "../../web/src");

const blank = (s) => s.replace(/[^\n]/g, " ");

/** Keep only the <style> blocks of a .svelte file; all else blanked, lines preserved. */
function styleOnly(svelte) {
  let out = "";
  let last = 0;
  for (const m of svelte.matchAll(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi)) {
    out += blank(svelte.slice(last, m.index + m[1].length)) + m[2];
    last = m.index + m[1].length + m[2].length;
  }
  return out + blank(svelte.slice(last));
}

const DECL = /^\s*color\s*:\s*var\(\s*--warm\s*\)\s*(!important)?\s*$/;

/** Every `color: var(--warm)` declaration (property exactly `color`) as { line, selector }. */
function warmTextOffenders(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, blank);
  const stack = [];
  const found = [];
  let start = 0;
  let paren = 0;
  let quote = "";
  const lineAt = (i) => clean.slice(0, i).split("\n").length;
  const flush = (end) => {
    const text = clean.slice(start, end);
    if (DECL.test(text)) {
      const named = stack.filter((s) => !s.startsWith("@"));
      const selector = (named.length ? named : stack).at(-1) ?? "";
      found.push({ line: lineAt(start + text.indexOf("color")), selector });
    }
  };
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") paren++;
    else if (c === ")") paren = Math.max(0, paren - 1);
    else if (paren === 0) {
      if (c === "{") {
        stack.push(clean.slice(start, i).replace(/\s+/g, " ").trim());
        start = i + 1;
      } else if (c === ";") {
        flush(i);
        start = i + 1;
      } else if (c === "}") {
        flush(i);
        stack.pop();
        start = i + 1;
      }
    }
  }
  return found;
}

function walk(dir) {
  const files = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) files.push(...walk(p));
    else if (/\.(css|svelte)$/.test(e.name)) files.push(p);
  }
  return files;
}

function report(path, text) {
  const body = path.endsWith(".svelte") ? styleOnly(text) : text;
  return warmTextOffenders(body).map((o) => `${relative(SRC, path)}:${o.line}: ${o.selector}`);
}

describe("no stylesheet in web/src sets text to bare --warm (#854, #1685, WCAG 1.4.3)", () => {
  it("the matcher sees a color:var(--warm) and ignores a border", () => {
    const sample = ".a b{color:var(--warm)}\n.c{border:1px dashed var(--warm)}\n.d{border-color:var(--warm)}\n.e{background:var(--warm)}";
    expect(warmTextOffenders(sample)).toEqual([{ line: 1, selector: ".a b" }]);
  });

  it("sees a declaration spanning lines, !important, and one nested in @media or :global", () => {
    const sample = [
      ".a {",
      "  color:",
      "    var(--warm) !important;",
      "}",
      "@media (min-width: 600px) {",
      "  .b :global(.x) {",
      "    color: var(--warm);",
      "  }",
      "}",
    ].join("\n");
    expect(warmTextOffenders(sample)).toEqual([
      { line: 2, selector: ".a" },
      { line: 7, selector: ".b :global(.x)" },
    ]);
  });

  it("reports the line in the original .svelte file for a style block", () => {
    const svelte = ["<script>", "  let x = 1;", "</script>", "<p>hi</p>", "<style>", "  .ok { border-color: var(--warm); }", "  .bad {", "    color: var(--warm);", "  }", "</style>"].join("\n");
    expect(report(join(SRC, "x.svelte"), svelte)).toEqual(["x.svelte:8: .bad"]);
  });

  it("never sets color to bare var(--warm) in any stylesheet under web/src", () => {
    const offenders = walk(SRC)
      .sort()
      .flatMap((p) => report(p, readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
  });
});
