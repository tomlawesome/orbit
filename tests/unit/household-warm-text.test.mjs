import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #854: --warm is an orange accent that, drawn as letterforms, fails WCAG 2.2
 * SC 1.4.3 (4.5:1) on the light packs (dawn, clouds): 2.64:1 on --bg and
 * 3.08:1 on --panel. Each pack therefore defines --warm-text, the colour for
 * text in that hue (equal to --warm on the dark packs).
 *
 * The promise: the household page stylesheet never sets a text colour to bare
 * var(--warm). Borders, backgrounds, outlines, fills and box-shadows may
 * still use it. This parses the real household.css (not a copy) and reports
 * every offending rule with its line number, not just the first.
 */

const HOUSEHOLD_CSS = readFileSync(
  resolve(import.meta.dirname, "../../web/src/routes/household/[id]/household.css"),
  "utf8",
);

/** Every `color: var(--warm)` declaration (property exactly `color`) as "line N: selector". */
function warmTextOffenders(css) {
  // Blank comments out but keep their newlines, so line numbers stay true.
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const offenders = [];
  for (const rule of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1].replace(/\s+/g, " ").trim();
    const bodyStart = rule.index + rule[0].indexOf("{") + 1;
    let offset = 0;
    for (const decl of rule[2].split(";")) {
      const match = /^\s*color\s*:\s*var\(\s*--warm\s*\)\s*(!important)?\s*$/.exec(decl);
      if (match) {
        const at = bodyStart + offset + decl.indexOf("color");
        const line = clean.slice(0, at).split("\n").length;
        offenders.push(`line ${line}: ${selector}`);
      }
      offset += decl.length + 1;
    }
  }
  return offenders;
}

describe("household.css: text in the warm hue uses --warm-text (#854, WCAG 1.4.3)", () => {
  it("the matcher sees a color:var(--warm) and ignores a border", () => {
    const sample = ".a b{color:var(--warm)}\n.c{border:1px dashed var(--warm)}\n.d{border-color:var(--warm)}";
    expect(warmTextOffenders(sample)).toEqual(["line 1: .a b"]);
  });

  it("never sets color to bare var(--warm)", () => {
    expect(warmTextOffenders(HOUSEHOLD_CSS)).toEqual([]);
  });
});
