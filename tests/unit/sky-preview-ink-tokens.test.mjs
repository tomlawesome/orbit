// #1463 review: the hollow not-set planet's ink once used an undefined token (--due-soon).
// #1466: planets wear their section colour (var(--c-<colour>)); no section colour falls back
// to a neutral ink. Every token a planet's fill/stroke can resolve to must be defined.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SECTION_COLOURS, planetFillOf } from "../../web/src/lib/option-colour.js";
import { BAND_VAR } from "../../web/src/lib/data/bands.js";

const defined = (() => {
  const found = new Set();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".css")) for (const m of readFileSync(p, "utf8").matchAll(/(--[\w-]+)\s*:/g)) found.add(m[1]);
    }
  };
  for (const d of ["web/src", "web/static"]) try { walk(d); } catch {}
  return found;
})();
const tokenOf = (v) => v.match(/^var\((--[\w-]+)\)$/)?.[1];

const preview = readFileSync("web/src/lib/SkyPreview.svelte", "utf8");
const dials = {
  "SkyPreview.svelte": preview,
  "home/+page.svelte": readFileSync("web/src/routes/home/+page.svelte", "utf8"),
  "home/pocket.svelte": readFileSync("web/src/routes/home/pocket.svelte", "utf8"),
};
// The hollow draw: the <circle> line carrying the dotted stroke.
const hollowLine = (src) => src.split("\n").find((l) => l.includes("<circle") && l.includes("stroke-dasharray=\"2 2.5\"")) ?? "";

describe("planet ink tokens are defined (#1463, #1466)", () => {
  it("the stylesheets are found", () => {
    expect(defined.size).toBeGreaterThan(50);
  });
  it("each section colour's planet fill is a defined token", () => {
    expect(SECTION_COLOURS.length).toBeGreaterThan(0);
    for (const c of SECTION_COLOURS) {
      const t = tokenOf(planetFillOf(c));
      expect(t, c).toBe(`--c-${c}`);
      expect(defined.has(t), t).toBe(true);
    }
  });
  it("the no-section fallback ink is a defined token", () => {
    const t = tokenOf(planetFillOf(null));
    expect(t).toBeTruthy();
    expect(defined.has(t), t).toBe(true);
    expect(planetFillOf(undefined)).toBe(planetFillOf(null));
  });
  for (const [name, src] of Object.entries(dials)) {
    it(`${name}: the hollow draw fills and strokes with the section colour, not an urgency token`, () => {
      const line = hollowLine(src);
      expect(line, "hollow circle not found").not.toBe("");
      expect(line).toMatch(/fill:\{planetFillOf\(\w+(\.\w+)*\.sectionColour\)\}/);
      expect(line).toMatch(/stroke:\{planetFillOf\(\w+(\.\w+)*\.sectionColour\)\}/);
      expect(line).not.toMatch(/var\(--/);
      for (const v of Object.values(BAND_VAR)) expect(line).not.toContain(v);
    });
    it(`${name}: every literal var(--token) on a planet circle is defined`, () => {
      const circles = src.split("\n").filter((l) => l.includes("<circle") && l.includes("planetFillOf"));
      expect(circles.length).toBeGreaterThan(0);
      const used = circles.flatMap((l) => [...l.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]));
      expect(used.filter((t) => !defined.has(t))).toEqual([]);
    });
  }
});
