import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-R8: decide()/saveReview()/complete() all gate on one shared
 * `busy` $state, but ArmButton and Row carry no disabled/busy concept of
 * their own (confirmed by reading both — see the audit finding), so a
 * second tap on another suggestion's act, or the complete button, while
 * the first is still in flight just silently did nothing: an unresponsive
 * control with no feedback.
 *
 * Rather than add a disabled prop to the shared pocket-kit ArmButton/Row
 * (out of this fix's file scope), the fix dims and blocks the whole
 * busy-sensitive area with a `pk-busy`/`pk-foot-busy` class driven straight
 * off the same `busy` flag: `.pk-below` (the manifest and signals rows),
 * the search sheet's own `.pk-results` list, and the search sheet's foot
 * (wrapped in a span, since ArmButton takes no class for this).
 */

const POCKET = readFileSync(
  resolve(import.meta.dirname, "../../web/src/routes/home/pocket.svelte"),
  "utf8",
);
const POCKET_CSS = readFileSync(
  resolve(import.meta.dirname, "../../web/src/routes/home/pocket.css"),
  "utf8",
);

describe("#1151 W1-R8: busy dims and blocks every act while one is in flight", () => {
  it("the manifest/signals list carries pk-busy off the shared busy flag", () => {
    expect(POCKET).toMatch(/<div class="pk-below" class:pk-busy=\{busy\}>/u);
  });

  it("the search sheet's own result list carries pk-busy too", () => {
    expect(POCKET).toMatch(/<div class="pk-results" class:pk-busy=\{busy\} bind:this=\{resultList\}/u);
  });

  it("the complete button is wrapped so it can be dimmed/blocked the same way", () => {
    const foot = POCKET.slice(POCKET.indexOf("{#snippet foot()}"), POCKET.indexOf("{#snippet foot()}") + 500);
    expect(foot).toMatch(/<span class:pk-foot-busy=\{busy\}>/u);
  });

  it("pk-busy/pk-foot-busy actually block taps and dim the area", () => {
    expect(POCKET_CSS).toMatch(/\.pk-below\.pk-busy,\.pk-results\.pk-busy,\.pk-foot-busy\{pointer-events:none;opacity:\.55/u);
  });
});
