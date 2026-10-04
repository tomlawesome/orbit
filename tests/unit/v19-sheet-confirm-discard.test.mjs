import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-S2: Sheet.svelte's `dismiss()` is shared by every dismiss path —
 * the scrim tap, dragging the sheet down, the keyboard's "close" word, and
 * Escape — and used to fire unconditionally, so a scrim tap or a stray
 * drag-down discarded an edited form (the review-and-amend sheet most of
 * all) with no chance to change your mind.
 *
 * The fix adds an optional `confirmDiscard` prop, read right before each
 * dismiss. Undefined (every existing caller, unchanged) keeps today's
 * one-tap close exactly as it was — this is the backward-compatibility
 * this test's last case pins. When it reports something to lose, the first
 * dismiss arms rather than closing, reusing the pocket kit's own
 * arm-then-fire pattern (arm.js's `createArm`, already proven by
 * pocket-kit.test.mjs) instead of a new confirm mechanism; the second
 * dismiss — or the close word, which now reads "tap again to close" while
 * armed — fires for real.
 *
 * Activating this for the review-and-amend sheet needs ReviewSheet.svelte
 * to pass `confirmDiscard`, which is out of this change's file scope — see
 * the session's own report. This test only pins Sheet.svelte's own half of
 * the contract, the way `v19-flight-mark-ride.test.mjs` pins a `.svelte`
 * fix it cannot import-test either.
 */

const SHEET = readFileSync(
  resolve(import.meta.dirname, "../../web/src/lib/pocket/Sheet.svelte"),
  "utf8",
);

describe("#1151 W1-S2: Sheet.svelte arms a dismiss instead of firing it blind", () => {
  it("reads confirmDiscard right before dismissing, via the kit's own arm pattern", () => {
    expect(SHEET).toMatch(/import \{ createArm \} from "\.\/arm\.js";/u);
    const dismiss = SHEET.slice(SHEET.indexOf("function dismiss()"), SHEET.indexOf("function dismiss()") + 200);
    expect(dismiss).toMatch(/confirmDiscard\?\.\(\)\s*&&\s*!dismissArm\.tap\(\)/u);
  });

  it("every dismiss path shares the one guarded function", () => {
    // scrim tap and the close word
    expect(SHEET).toMatch(/onclick=\{dismiss\}/gu);
    // Escape, via holdSheet's own hook
    expect(SHEET).toMatch(/onescape:\s*dismiss/u);
    // drag-down release
    expect(SHEET).toMatch(/outcome === "close"\)\s*dismiss\(\)/u);
  });

  it("the close word says so while armed, and nothing else changes when confirmDiscard is never passed", () => {
    expect(SHEET).toMatch(/\{dismissArmed \? "tap again to close" : "close"\}/u);
    // undefined confirmDiscard short-circuits the whole guard: `undefined?.()`
    // is undefined, which is falsy, so dismiss proceeds exactly as before.
    expect(SHEET).toMatch(/confirmDiscard\s*=\s*undefined,/u);
  });
});

/*
 * #1151 R8/S5: the history-popstate $effect (the OS/browser back gesture) set
 * `open = false` directly, never calling `dismiss()` — so confirmDiscard,
 * read only inside dismiss(), was never consulted on that path and a dirty
 * form was discarded with no "tap again to close" prompt. The fix routes the
 * same branch through dismiss(); when the reader declines (dismiss() leaves
 * `open` true because the tap only armed), the entry the browser already
 * popped is pushed back so the sheet stays backed by one.
 */
describe("#1151 R8/S5: the OS/browser back gesture goes through the same guard", () => {
  const popstateBranch = SHEET.slice(
    SHEET.indexOf("} else if (open && pushed && !mine)"),
    SHEET.indexOf("} else if (!open && pushed)"),
  );

  it("calls dismiss() rather than setting open = false directly", () => {
    expect(popstateBranch).toMatch(/dismiss\(\);/u);
    expect(popstateBranch).not.toMatch(/^\s*open = false;/mu);
  });

  it("pushes the popped history entry back when dismiss() declines (open stays true)", () => {
    expect(popstateBranch).toMatch(/if \(open\)\s*\{[\s\S]*pushState\(/u);
  });
});
