import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #873: the launch stutters because the mark's ride from the lockup to
 * centre screen (and back) used to animate `left`/`top`/`width`/`height` via
 * a CSS transition — four layout-triggering properties on a `position:fixed`
 * box, for the full 1080ms/923ms of the ride, running at the same time as
 * the canvas engine's own rAF loop (`engine.js`) is already spending the
 * frame budget on the star field. That is the shape the issue names: two
 * per-frame-costly things competing for the same 16ms.
 *
 * `Flight.svelte` is not import-tested here — a `.svelte` file needs the
 * compiler this suite does not pull in for a source check — so this pins
 * the fix the same way `v19-tour-emphasis.test.mjs` and
 * `v19-home-hit-area.test.mjs` pin CSS: against the component's own text.
 * Each assertion below fails if the specific cause this issue fixed comes
 * back, not merely if the file changes shape.
 */

const FLIGHT_SVELTE = readFileSync(
  resolve(import.meta.dirname, "../../web/src/lib/flight/Flight.svelte"),
  "utf8",
);

describe("#873: the mark's ride is driven by transform, not layout", () => {
  it("never builds a transition string naming left/top/width/height", () => {
    // The old `rideTransition()` built exactly this: four `<prop> <ms>ms
    // cubic-bezier(...)` clauses, one each for left/top/width/height. If a
    // later edit reintroduces that box-geometry ride, this fails.
    for (const prop of ["left", "top", "width", "height"]) {
      expect(FLIGHT_SVELTE).not.toMatch(
        new RegExp(`["'\`]${prop} ["'+]|\\+ ["']${prop} `, "u"),
      );
    }
    expect(FLIGHT_SVELTE).not.toMatch(/rideTransition/u);
  });

  it("plays the ride as a translate()+scale() Web Animation", () => {
    expect(FLIGHT_SVELTE).toMatch(/function flip\(/u);
    expect(FLIGHT_SVELTE).toMatch(/markEl\.animate\(/u);
    // Both keyframes name transform only — nothing else is an animated
    // property of this Animation, so nothing else can force layout.
    const flipBody = FLIGHT_SVELTE.slice(
      FLIGHT_SVELTE.indexOf("function flip("),
      FLIGHT_SVELTE.indexOf("function dropMark("),
    );
    expect(flipBody).toMatch(/transform:\s*`translate\(/u);
    expect(flipBody).toMatch(/\{\s*transform:\s*"none"\s*\}/u);
    expect(flipBody).not.toMatch(/\b(left|top|width|height):/u);
  });

  it("leaves dropMark()'s own .collapse rule free to run", () => {
    // flight.css's `.collapse{transition:opacity .55s ease .1s,transform .7s
    // cubic-bezier(.6,0,.9,.4)}` only takes effect if nothing inline on
    // markEl still claims the `transition` shorthand for `transform`. The
    // ride's own fallback must therefore name opacity and nothing else.
    const flipBody = FLIGHT_SVELTE.slice(
      FLIGHT_SVELTE.indexOf("function flip("),
      FLIGHT_SVELTE.indexOf("function dropMark("),
    );
    expect(flipBody).toMatch(/style\.transition\s*=\s*"opacity \.4s ease"/u);
  });

  it("sets the mark's resting geometry unconditionally, live or pinned", () => {
    // Fixture screenshots (the v19 fidelity gate) always call the ascent
    // pinned, which takes the `instant` branch. That branch must still see
    // the exact same final left/top/width/height this always wrote, or a
    // pinned first-run screen would move pixels on the gate.
    for (const fn of ["liftMark", "landMark"]) {
      const start = FLIGHT_SVELTE.indexOf(`function ${fn}(`);
      const end = FLIGHT_SVELTE.indexOf("\n  }", start);
      const body = FLIGHT_SVELTE.slice(start, end);
      expect(body).toMatch(/if \(!instant\) flip\(/u);
      // the box is moved to rest (left/top/width/height) before that branch
      // is even reached — not inside a deferred requestAnimationFrame
      expect(body).not.toMatch(/requestAnimationFrame\(settle\)/u);
    }
  });
});
