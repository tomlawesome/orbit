// #1463 review: the settings preview's hollow ink must use colour tokens that exist.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BAND_VAR } from "../../web/src/lib/data/bands.js";

const source = readFileSync("web/src/lib/SkyPreview.svelte", "utf8");
const defined = (() => {
  const dirs = ["web/src", "web/static"];
  const found = new Set();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".css")) for (const m of readFileSync(p, "utf8").matchAll(/(--[\w-]+)\s*:/g)) found.add(m[1]);
    }
  };
  for (const d of dirs) try { walk(d); } catch {}
  return found;
})();

describe("SkyPreview hollow ink tokens (#1463)", () => {
  it("every var(--token) in the preview's INK map is defined in the stylesheets", () => {
    const ink = source.match(/const INK = \{([^}]*)\}/)?.[1] ?? "";
    const used = [...ink.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((t) => !defined.has(t))).toEqual([]);
  });
  it("the amber paint uses the same token as the due-soon band", () => {
    const amber = source.match(/amber:\s*"var\((--[\w-]+)\)"/)?.[1];
    expect(amber).toBe(BAND_VAR["due-soon"]);
  });
});
