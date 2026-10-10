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
 * #1336 moved the floor itself out of the browser: archive.js no longer
 * exports PASSPHRASE_MIN, the engine's number arrives on the session as
 * limits.passphraseMin, and passphraseFloor() (archive.js) turns it into the
 * gate every button waits on (shut while the number is unknown). What this
 * file protects is unchanged: every gate reads one named floor, none spells
 * a number.
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
  it("imports passphraseFloor from archive.js in both desk and pocket archives", () => {
    for (const path of FILES) {
      const src = read(path);
      expect(src, `${path} should import passphraseFloor from ./archive.js`)
        .toMatch(/import\s*\{[^}]*\bpassphraseFloor\b[^}]*\}\s*from\s*"\.\/archive\.js"/);
    }
  });

  it("never gates passIn's length on a bare number -- every gate reads the engine's floor", () => {
    for (const path of FILES) {
      const src = read(path);
      expect(src, `${path} still has a bare-number passphrase gate`).not.toMatch(/passIn\.length\s*<\s*\d|passphraseLength\(passIn\)\s*<\s*\d/);
      expect(src, `${path} should gate on passphraseMin instead`).toMatch(/passphraseLength\(passIn\)\s*<\s*passphraseMin\b/);
      expect(src, `${path} should derive passphraseMin from passphraseFloor(limits)`).toMatch(/passphraseMin\s*=\s*\$derived\(passphraseFloor\(limits\)\)/);
    }
  });
});
