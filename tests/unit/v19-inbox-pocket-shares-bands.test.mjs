import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-Q10 (inbox half): inbox/pocket.svelte's local BANDS table was a
 * fourth copy of a band→class lookup, already diverging from bands.js's
 * own T_CLASS in nothing but name (both map overdue/due-soon/upcoming/ok
 * identically and unscheduled to "ended"), with nothing tying them
 * together. The home half (pocket.svelte's BAND_VAR/tlabel) is covered by
 * v19-home-band-unscheduled.test.mjs.
 *
 * inbox/+page.svelte's own TONES is deliberately left alone: its
 * unscheduled entry ("--ink-faint") actually disagrees in value with
 * bands.js's BAND_VAR ("--ink-mid"), so merging it would change what
 * colour the inbox shows today — a design call, not a plain dedup.
 */

const INBOX_POCKET = readFileSync(
  resolve(import.meta.dirname, "../../web/src/routes/inbox/pocket.svelte"),
  "utf8",
);

describe("#1151 W1-Q10: inbox/pocket.svelte shares bands.js's T_CLASS", () => {
  it("imports T_CLASS from home/bands.js", () => {
    expect(INBOX_POCKET).toMatch(/import \{ T_CLASS \} from "\.\.\/home\/bands\.js";/u);
  });

  it("no longer declares its own BANDS table", () => {
    expect(INBOX_POCKET).not.toMatch(/const BANDS =/u);
  });

  it("the filed mark reads T_CLASS instead", () => {
    expect(INBOX_POCKET).toMatch(/\{T_CLASS\[entry\.band\] \?\? 'ended'\}/u);
  });
});
