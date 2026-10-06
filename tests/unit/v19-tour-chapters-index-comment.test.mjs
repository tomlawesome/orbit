import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W3-Q3: chapters/index.js's own header said "Four of the twelve are
 * cut... not padded with placeholders for the eight still to come", a
 * work-in-progress note the file had already outgrown — all twelve
 * chapters are imported and listed in CHAPTERS, none missing. The stale
 * comment would tell the next maintainer eight chapters are absent.
 */

const INDEX = readFileSync(
  resolve(import.meta.dirname, "../../web/src/lib/tour/chapters/index.js"),
  "utf8",
);

describe("#1151 W3-Q3: the chapter registry's comment matches its own code", () => {
  it("no longer claims only four of twelve are cut", () => {
    expect(INDEX).not.toMatch(/Four of the twelve are cut/u);
    expect(INDEX).not.toMatch(/eight still to come/u);
  });

  it("says all twelve are cut", () => {
    expect(INDEX).toMatch(/all twelve are cut/u);
  });

  it("CHAPTERS still lists all twelve imports", () => {
    const imports = [...INDEX.matchAll(/^import \w+ from "\.\/\d\d-[\w-]+\.js";$/gmu)];
    expect(imports.length).toBe(12);
  });
});
