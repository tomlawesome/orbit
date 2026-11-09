import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1792 (spec-security-fixes.md 2.3 "What a household sees", L14): an export
 * is no longer kept "for a day", and a household keeps only its last
 * `keepPerHousehold`. The card's foot line says so:
 *   n >= 2: "kept here until then · Orbit keeps your last {n}; writing more replaces the oldest"
 *   n == 1: "keeps only your latest; writing another replaces it"
 * and the phone's toast says "download it before {readyUntil}" instead of
 * "download it within a day". The number comes from the export's answer
 * (`keepPerHousehold`, checked against the real route in
 * tests/integration/portable-archive-retention-1792.test.ts).
 *
 * Svelte components are not mounted in this suite for the archive card, so
 * both layouts are pinned on their source, as
 * archive-challenge-opens-once.test.mjs does.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const FILES = [
  "web/src/routes/household/[id]/DeskArchive.svelte",
  "web/src/routes/household/[id]/PocketArchive.svelte",
];

describe.each(FILES)("%s: what the card says about how long and how many exports are kept", (file) => {
  const source = readFileSync(resolve(ROOT, file), "utf8");

  it("no longer says an export is kept for a day", () => {
    // Catches the old promise left on the card: at the new 6 h default a household trusting "a day" finds its link gone.
    expect(source).not.toMatch(/for a day/u);
    expect(source).not.toMatch(/within a day/u);
  });

  it("says how many it keeps, from the number in the export's answer, for two or more", () => {
    expect(source).toMatch(/kept here until then · Orbit keeps your last \{[^}]+\}; writing more replaces the oldest/u);
    expect(source, "the number is the export's answer's").toMatch(/keepPerHousehold/u);
  });

  it("says it keeps only the latest when the number is 1", () => {
    expect(source).toMatch(/keeps only your latest; writing another replaces it/u);
  });
});

describe("PocketArchive.svelte: the toast after writing", () => {
  it("says to download it before the time on the card, not within a day", () => {
    const source = readFileSync(resolve(ROOT, FILES[1]), "utf8");
    expect(source).toMatch(/download it before \$\{readyUntil\}/u);
  });
});
