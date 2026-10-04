import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-R6: decide() had no disposed guard — SignIn.svelte already
 * carries the same pattern for the same race (a fetch still in flight
 * once the component is gone). Resuming anyway could yank a reader who
 * has already left onto /home (handOn()'s location.replace), or leave
 * enterNewcomer()'s launch classes added to document.body — a global,
 * not scoped to this component — for whatever screen the reader is on by
 * then.
 *
 * `Arrival.svelte` is not import-tested here — a `.svelte` file needs the
 * compiler this suite does not pull in for a source check — so this pins
 * the fix the same way `v19-flight-mark-ride.test.mjs` pins a `.svelte`
 * fix it cannot import-test either.
 */

const ARRIVAL = readFileSync(
  resolve(import.meta.dirname, "../../web/src/lib/arrival/Arrival.svelte"),
  "utf8",
);

describe("#1151 W1-R6: decide() checks disposed after every await", () => {
  it("declares disposed and sets it in the component's own teardown", () => {
    expect(ARRIVAL).toMatch(/let disposed = false;/u);
    const teardown = ARRIVAL.slice(ARRIVAL.indexOf("return () => {"), ARRIVAL.indexOf("return () => {") + 120);
    expect(teardown).toMatch(/disposed = true;/u);
  });

  it("guards after the session fetch, the json parse, and the workspace read", () => {
    const decide = ARRIVAL.slice(ARRIVAL.indexOf("async function decide()"), ARRIVAL.indexOf("function handOn()"));
    const guardCount = [...decide.matchAll(/if \(disposed\) return;/gu)].length;
    expect(guardCount).toBeGreaterThanOrEqual(3);
    // specifically guarded right after each await, not just somewhere in the function
    expect(decide).toMatch(/await fetch\(.*\);[\s\S]{0,400}?if \(disposed\) return;/u);
    expect(decide).toMatch(/await response\.json\(\)\.catch\(.*\);\s*\n\s*if \(disposed\) return;/u);
    expect(decide).toMatch(/workspace = await readWorkspace\(\);\s*\n\s*if \(disposed\) return;/u);
  });

  it("also guards enterNewcomer's own await, which mutates document.body", () => {
    const enterNewcomer = ARRIVAL.slice(ARRIVAL.indexOf("async function enterNewcomer"));
    expect(enterNewcomer.slice(0, 400)).toMatch(/await tick\(\);\s*\n\s*if \(disposed\) return;/u);
  });
});
