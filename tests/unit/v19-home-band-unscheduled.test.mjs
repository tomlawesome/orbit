import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { BAND_VAR, T_CLASS } from "../../web/src/routes/home/bands.js";

/*
 * #1151 W1-F3: an active item with no due date gets band "unscheduled" from
 * chart.js's bandOfKind(kind, null), and lands in manifestGroupsOf's `later`
 * list alongside every scheduled item. Both copies of BAND_VAR — the shared
 * bands.js CorridorRow.svelte reads, and pocket.svelte's own local copy for
 * the phone search sheet — only defined overdue/due-soon/upcoming/ok/ended,
 * so `BAND_VAR[row.band]` was `undefined` for that one row, and
 * `var(${undefined})` is an invalid custom-property reference the browser
 * silently drops: a search result for that item showed no urgency dot or
 * trail colour, where every other result was coloured.
 *
 * The fix gives "unscheduled" the same quiet ink tone as "ended" — no due
 * date carries no urgency either — in both copies.
 */

describe("#1151 W1-F3: home/bands.js defines a tone for an unscheduled item", () => {
  it("BAND_VAR and T_CLASS both have an unscheduled key, matching ended's quiet tone", () => {
    expect(BAND_VAR.unscheduled).toBe(BAND_VAR.ended);
    expect(BAND_VAR.unscheduled).toBeTruthy();
    expect(T_CLASS.unscheduled).toBe(T_CLASS.ended);
  });
});

describe("#1151 W1-Q10: pocket.svelte imports BAND_VAR/tlabel rather than keeping its own copy", () => {
  const POCKET = readFileSync(
    resolve(import.meta.dirname, "../../web/src/routes/home/pocket.svelte"),
    "utf8",
  );

  it("imports both from bands.js", () => {
    expect(POCKET).toMatch(/import \{ BAND_VAR, tlabel \} from "\.\/bands\.js";/u);
  });

  it("no longer declares a local copy of either", () => {
    expect(POCKET).not.toContain("const BAND_VAR =");
    expect(POCKET).not.toContain("const tlabel =");
  });
});
