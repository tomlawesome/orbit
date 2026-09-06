// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { tourHasSomethingToShow } from "../../web/src/lib/tour/offer.js";

/*
 * #864: "the tour doesn't move to anything."
 *
 * v19-tour-walk.test.mjs's `stage()` always plants `svg.dial`, `.sun-link`
 * and `.hero-foot` — the markup home/+page.svelte draws ONLY when the reader
 * belongs to a household (the `{:else}` branch of `{#if view?.emptySky}`,
 * line ~952). A reader who belongs to none — §11/#453's "adrift" sky, drawn
 * when `view.emptySky` is true — gets `.adrift` instead: no dial, no
 * sun-link, no hero-foot. `#manifest-top` is the one container that survives
 * regardless (it sits outside that if/else), empty of its `.corridor`.
 *
 * The tour's very first stop, "chart" (stops.js), targets
 * ".dial .chrome, .sun-link" — both absent on this sky. Rather than putting
 * the card up over a screen where nothing lights (what an administrator with
 * no household yet would see as "the tour doesn't move to anything"), the
 * decided fix (#864) is not to offer the walk at all until there is a
 * household to walk through — matching #484, which seeds demo data on first
 * run specifically so the tour has something to show.
 *
 * `tourHasSomethingToShow` (offer.js) is Tour.svelte's own gate, read from
 * the same `adrift` mark both dialects draw for `view.emptySky` (see
 * home/+page.svelte and pocket.svelte). This is the seam Tour.svelte's
 * `begin()` calls before ever constructing the walk, so it is exercised here
 * from a bare DOM exactly as the four existing tour suites exercise
 * engine.js.
 */

/** The "adrift" home screen: no household, so no dial at all. */
const ADRIFT = `
  <div class="adrift"></div>
  <div id="manifest-top"></div>
  <button id="nstar"></button>
  <button class="orb"></button>
`;

/** The ordinary home screen: a household, so the dial is drawn. */
const SKY = `
  <svg class="dial"><g class="chrome"></g><a class="sun-link"></a></svg>
  <div class="minisys"></div>
  <div class="hero-foot"></div>
  <div id="manifest-top"><div class="corridor"><div class="today"></div></div></div>
  <button id="nstar"></button>
  <button class="orb"></button>
`;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("whether the walk is offered (#864)", () => {
  it("is not offered on a household-less (adrift) sky", () => {
    document.body.innerHTML = ADRIFT;
    expect(tourHasSomethingToShow(document)).toBe(false);
  });

  it("is offered exactly as today on a sky with a household", () => {
    document.body.innerHTML = SKY;
    expect(tourHasSomethingToShow(document)).toBe(true);
  });
});
