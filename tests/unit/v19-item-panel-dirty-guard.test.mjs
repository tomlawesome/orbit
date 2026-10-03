import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-S5: the belt's complete/reschedule/snooze/edit panels — one
 * `panel` state shared by the desktop's own inline panel and the phone's
 * Sheet face for the same fields — closed with no warning at all: every
 * "never mind" button, Escape, and the phone sheet's own scrim/drag/close
 * dismiss discarded whatever was typed outright.
 *
 * The fix reuses W1-S1's own dirty-check-and-confirm shape (no desktop
 * confirm pattern existed here either) and W1-S2's Sheet confirmDiscard
 * prop for the phone side: open() captures what the panel started as
 * (`formStart` for the desktop's plain fields, `editStart` for the phone
 * edit sheet's own EntryForm, compared with entry.js's own entryChanged —
 * the identical comparison the create form and the review sheet already
 * use), and closePanel()/the Sheet's confirmDiscard both read it before
 * discarding anything. The save-success path (run()'s own `panel = null`
 * after `applyCommand` resolves) is deliberately left alone — nothing is
 * discarded there, it already saved.
 *
 * `+page.svelte` is not import-tested here — a `.svelte` file needs the
 * compiler this suite does not pull in for a source check — so this pins
 * the fix the same way `v19-flight-mark-ride.test.mjs` pins a `.svelte`
 * fix it cannot import-test either.
 */

const ITEM_PAGE = readFileSync(
  resolve(import.meta.dirname, "../../web/src/routes/item/[[id]]/+page.svelte"),
  "utf8",
);

describe("#1151 W1-S5: the belt's panels ask before discarding", () => {
  it("open() captures both halves of the panel's starting state", () => {
    const openFn = ITEM_PAGE.slice(ITEM_PAGE.indexOf("function open(name, item)"), ITEM_PAGE.indexOf("function panelDirty"));
    expect(openFn).toMatch(/editStart = \$state\.snapshot\(editEntry\);/u);
    expect(openFn).toMatch(/formStart = panel \? JSON\.stringify\(form\) : null;/u);
  });

  it("panelDirty() checks the phone edit sheet via entryChanged, and the desktop fields otherwise", () => {
    const fn = ITEM_PAGE.slice(ITEM_PAGE.indexOf("function panelDirty()"), ITEM_PAGE.indexOf("function closePanel"));
    expect(fn).toMatch(/entryChanged\(editEntry, editStart\)/u);
    expect(fn).toMatch(/JSON\.stringify\(form\) !== formStart/u);
  });

  it("closePanel() confirms before discarding, and every never-mind button and Escape use it", () => {
    const fn = ITEM_PAGE.slice(ITEM_PAGE.indexOf("function closePanel()"), ITEM_PAGE.indexOf("function closePanel()") + 200);
    expect(fn).toMatch(/if \(panelDirty\(\) && !confirm\(/u);
    const neverMinds = [...ITEM_PAGE.matchAll(/class="cancel-link" onclick=\{closePanel\}/gu)];
    expect(neverMinds.length).toBeGreaterThanOrEqual(5);
    expect(ITEM_PAGE).toMatch(/if \(event\.key === "Escape" && panel\) \{ closePanel\(\); return; \}/u);
  });

  it("the phone sheet reads the same dirty check through confirmDiscard", () => {
    expect(ITEM_PAGE).toMatch(/confirmDiscard=\{panelDirty\}/u);
  });

  it("leaves the save-success path alone — nothing to confirm once it has saved", () => {
    const run = ITEM_PAGE.slice(ITEM_PAGE.indexOf("async function run("), ITEM_PAGE.indexOf("async function run(") + 400);
    expect(run).toMatch(/await applyCommand\(build\(\)\);\s*\n\s*panel = null;/u);
  });
});
