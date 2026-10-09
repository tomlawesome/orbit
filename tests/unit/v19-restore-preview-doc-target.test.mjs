import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-R12: restoring a removed paper from its preview must act on the
 * paper it started with. If the reader moved on to a different paper while
 * the restore was in flight, a failure used to be blamed on whichever paper
 * happened to be open after the await.
 *
 * The belt that first carried this fix is gone (#1319); the drawer's
 * PreviewCard (lib/reading/PreviewCard.svelte) restore() holds the same
 * shape: it captures the target and the preview's own generation (`token`,
 * the same one show() and hide() advance) before the await, restores the
 * captured target, and only shows a problem if the preview is still on that
 * generation afterwards.
 *
 * A `.svelte` file is pinned against its own text, as
 * v19-flight-mark-ride.test.mjs does.
 */

const CARD = readFileSync(
  resolve(import.meta.dirname, "../../web/src/lib/reading/PreviewCard.svelte"),
  "utf8",
);

describe("#1151 W1-R12: restore() targets the paper it started with", () => {
  const start = CARD.indexOf("async function restore()");
  const fn = CARD.slice(start, CARD.indexOf("\n  }\n", start));

  it("captures the target and the preview's own generation before the await", () => {
    expect(start).toBeGreaterThan(-1);
    expect(fn).toMatch(/const target = shown;/u);
    expect(fn).toMatch(/const mine = token;/u);
    const captureIndex = fn.indexOf("const mine = token;");
    const awaitIndex = fn.indexOf("await onrestore(");
    expect(captureIndex).toBeGreaterThan(-1);
    expect(awaitIndex).toBeGreaterThan(captureIndex);
  });

  it("only blames the paper it was restoring, not whatever is open now", () => {
    expect(fn).toMatch(/if \(mine === token\) problem =/u);
  });

  it("still restores the right paper regardless: it came from the capture, not live state", () => {
    expect(fn).toMatch(/await onrestore\(target\);/u);
  });
});
