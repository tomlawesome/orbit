import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W3-Q2: ringcard.css's .bigring .ringstroke/.ringorbit i and
 * notfound.css's .stage .errring/.errring i are byte-identical rings
 * (4.2px #8791b3 stroke; 29.4px #d8b45a orb at left:93.26%/top:24.94%,
 * margin -14.7px), hardcoded independently because the 404 page never
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
    expect(RINGCARD).toMatch(/border:4\.2px solid #8791b3;/u);
    expect(NOTFOUND).toMatch(/border:4\.2px solid #8791b3;/u);
  });

  it("the orb (position, size, margin, colour) matches", () => {
    const orb = /left:93\.26%;top:24\.94%;\s*width:29\.4px;height:29\.4px;margin:-14\.7px 0 0 -14\.7px;\s*border-radius:50%;background:#d8b45a/u;
    expect(RINGCARD).toMatch(orb);
    expect(NOTFOUND).toMatch(orb);
  });

  it("each file points at the other", () => {
    expect(RINGCARD).toMatch(/notfound\.css's \.errring/u);
    expect(NOTFOUND).toMatch(/ringcard\.css's \.bigring/u);
  });
});
