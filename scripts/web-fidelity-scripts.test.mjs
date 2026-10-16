import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/*
 * The web fidelity gates run from web/, so they reach the quarantine list
 * check (scripts/check-quarantine.mjs, exit 1 when an @quarantine tag is not
 * on tests/quarantine.txt) as `node ../scripts/check-quarantine.mjs ..`. It
 * must come first and be joined with `&&`, so a failing check stops the run
 * before Playwright starts. The `:quarantine` runs only report, so they need
 * not run it.
 */
const { scripts } = JSON.parse(
  readFileSync(fileURLToPath(new URL("../web/package.json", import.meta.url)), "utf8"),
);

describe("web fidelity scripts run the quarantine list check first", () => {
  for (const name of ["fidelity", "fidelity:webkit"]) {
    it(`${name} starts with the check, joined with &&`, () => {
      expect(scripts[name]).toMatch(/^node \.\.\/scripts\/check-quarantine\.mjs \.\. && /);
    });
  }
});
