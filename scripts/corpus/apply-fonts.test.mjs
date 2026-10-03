import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * X-Q1 (#1151): the DOCS table is a plain object literal, so two entries
 * keyed by the same filename collide -- JavaScript silently keeps only the
 * later one, dropping the earlier document's font assignment with no
 * warning at all. "vehicle-service-record.html" was defined twice: once for
 * holdout4/ (#1007's fourth hold-out wave) and once for sources/ (#1007's
 * twelve tuning documents), both happening to pick the same document name.
 * This reads the keys back out of the source so it fails again if the
 * DOCS table ever grows a new collision.
 */
describe("apply-fonts DOCS table", () => {
  it("has no duplicate keys", () => {
    const source = readFileSync(new URL("./apply-fonts.mjs", import.meta.url), "utf8");
    const keys = [...source.matchAll(/^ {2}"([^"]+\.html)":\s*\{/gmu)].map((match) => match[1]);
    expect(keys.length).toBeGreaterThan(0);

    const seen = new Set();
    const duplicates = [];
    for (const key of keys) {
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
    expect(duplicates).toEqual([]);
  });
});
