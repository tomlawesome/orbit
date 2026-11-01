import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1346: `kindOfItem` was written three times (engine item-kind.ts, browser
 * create/entry.js, browser chart.js). The engine now sends `kind` with each
 * item, so no browser copy of the inference remains: `kindOf` (entry.js's and
 * belt.js's export) and `kindOfItem` (chart.js's) do not appear in web/src.
 * Only the whole identifiers count; an unrelated `kindOfFile` helper is not
 * the item inference.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const SRC = join(ROOT, "web/src");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(js|ts|svelte)$/u.test(entry.name)) out.push(full);
  }
  return out;
}

describe("#1346: the browser does not infer an item's kind", () => {
  it("web/src has no kindOf or kindOfItem", () => {
    const found = [];
    for (const file of walk(SRC)) {
      readFileSync(file, "utf8").split("\n").forEach((line, at) => {
        if (/\bkindOf(Item)?\b/u.test(line)) found.push(`${relative(ROOT, file)}:${at + 1}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });
});
