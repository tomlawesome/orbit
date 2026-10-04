import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * #1151 W2-Q8: DeskArchive.svelte and PocketArchive.svelte each gate "bring
 * one in" on the passphrase length twice (the lookInside() guard and the
 * button's own disabled check) with a bare `12`, while both already import
 * from ./archive.js, which exports PASSPHRASE_MIN for exactly this -- the
 * "take it with you" side (passphraseProblem()) already uses it. Four gates,
 * one rule, one constant should be named twice, not the number spelled out
 * four times.
 *
 * Static scan rather than a render: the gate is a bare literal in the
 * source, so reading the two files is a direct, truthful check of the thing
 * the row names, the same reproduce-by-scanning shape as
 * tests/unit/backdrop-mark-divergence.test.mjs.
 */

const FILES = [
  "web/src/routes/household/[id]/DeskArchive.svelte",
  "web/src/routes/household/[id]/PocketArchive.svelte",
];

/** @param {string} relativePath */
function read(relativePath) {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

describe("the passphrase-length gate (#1151 W2-Q8)", () => {
  it("imports PASSPHRASE_MIN from archive.js in both desk and pocket archives", () => {
    for (const path of FILES) {
      const src = read(path);
      expect(src, `${path} should import PASSPHRASE_MIN from ./archive.js`)
        .toMatch(/import\s*\{[^}]*\bPASSPHRASE_MIN\b[^}]*\}\s*from\s*"\.\/archive\.js"/);
    }
  });

  it("never gates passIn's length on a bare 12 -- every gate reads PASSPHRASE_MIN", () => {
    for (const path of FILES) {
      const src = read(path);
      expect(src, `${path} still has a bare-12 passphrase gate`).not.toMatch(/passIn\.length\s*<\s*12\b/);
      expect(src, `${path} should gate on PASSPHRASE_MIN instead`).toMatch(/passIn\.length\s*<\s*PASSPHRASE_MIN\b/);
    }
  });
});
