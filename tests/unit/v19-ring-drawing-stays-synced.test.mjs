import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W3-Q2: ringcard.css's .bigring .ringstroke/.ringorbit i and
 * notfound.css's .stage .errring/.errring i are byte-identical rings
 * (orbit-site's lit line at --stroke 3.4px with its two halos; 29.4px
 * gold-planet orb at left:93.26%/top:24.94%, margin -14.7px; the wake, #1253), hardcoded independently because the 404 page never
 * loads ringcard.css (+error.svelte links plain CSS only, deliberately —
 * see its own header) — there is no shared CSS variable a bundler could
 * tie them to without breaking that separation.
 *
 * Rather than force a structural merge across that deliberate boundary
 * (risking the pixel-exact fidelity baselines neither file's own tests run
 * here), both files now cross-reference each other in a comment, and this
 * test is the real guard: it fails the moment the two numbers actually
 * diverge, which a comment alone cannot do.
 */

const RINGCARD = readFileSync(
  resolve(import.meta.dirname, "../../web/src/lib/ringcard.css"),
  "utf8",
);
const NOTFOUND = readFileSync(
  resolve(import.meta.dirname, "../../web/static/screens/notfound.css"),
  "utf8",
);

describe("#1151 W3-Q2: the two independent rings stay numerically identical", () => {
  it("the stroke (width, colour) matches", () => {
    for (const css of [RINGCARD, NOTFOUND]) {
      expect(css).toMatch(/--stroke:3\.4px/u);
      expect(css).toMatch(/linear-gradient\(180deg,rgba\(108,118,160,\.6\) 0%,rgba\(170,178,207,\.85\) 50%,#ead2a4 86%,#ffe2a8 100%\)/u);
      // the line and its halos at 2.25x and 5.6x, .12 and .05
      expect(css).toMatch(/rgba\(0,0,0,0\.12\) calc\(100% - var\(--stroke\) \* 4\.125\)/u);
      expect(css).toMatch(/rgba\(0,0,0,0\.05\) calc\(100% - var\(--stroke\) \* 5\.8\)/u);
    }
  });

  it("the orb (position, size, margin, colour) matches", () => {
    const orb = /left:93\.26%;top:24\.94%;\s*width:29\.4px;height:29\.4px;margin:-14\.7px 0 0 -14\.7px;\s*border-radius:50%;background:none/u;
    const world = /inset:-78\.6%;\s*background:url\(\/flight\/door\/planet-gold\.webp\) center\/100% no-repeat/u;
    const wake = /left:-2\.0833%;top:-2\.0833%;width:104\.1667%;height:104\.1667%/u;
    for (const css of [RINGCARD, NOTFOUND]) {
      expect(css).toMatch(orb);
      expect(css).toMatch(world);
      expect(css).toMatch(wake);
    }
  });

  it("each file points at the other", () => {
    expect(RINGCARD).toMatch(/notfound\.css's \.errring/u);
    expect(NOTFOUND).toMatch(/ringcard\.css's \.bigring/u);
  });
});
