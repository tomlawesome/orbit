import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-Q6: Sky.svelte's star counts (60 far, 30 near) were bare call-site
 * literals, which read as a second, silently-diverging copy of sky.js's
 * TILED_LAYERS.count (95/46) under a module comment calling this "the
 * desk's own two layers" / "the exact layer recipe". The audit found this
 * is in fact a deliberate, ratified density tuned for the pocket's own much
 * smaller 400x850 tile, not a value meant to track TILED_LAYERS.count — so
 * the fix is naming the constants and saying so, not deriving them from
 * TILED_LAYERS (which would change the tuned density).
 */

const SKY = readFileSync(
  resolve(import.meta.dirname, "../../web/src/lib/pocket/Sky.svelte"),
  "utf8",
);

describe("#1151 W1-Q6: the pocket sky's star counts are named, not bare literals", () => {
  it("declares FAR_COUNT/NEAR_COUNT at the tuned 60/30 values", () => {
    expect(SKY).toMatch(/const FAR_COUNT = 60;/u);
    expect(SKY).toMatch(/const NEAR_COUNT = 30;/u);
  });

  it("the stars() calls use the named constants, not bare numbers", () => {
    expect(SKY).toMatch(/const far = stars\(0, FAR_COUNT, rng\);/u);
    expect(SKY).toMatch(/const near = stars\(1, NEAR_COUNT, rng\);/u);
  });

  it("documents that only the shape, not the count, comes from TILED_LAYERS", () => {
    expect(SKY).toMatch(/Only the shape \(radius\/opacity ranges\) comes from the shared recipe/u);
  });
});
