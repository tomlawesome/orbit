// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTour } from "../../web/src/lib/tour/engine.js";
import { stopsFor } from "../../web/src/lib/tour/stops.js";

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
 * ".dial .chrome, .sun-link" — both absent on this sky. emphasis.js's own
 * contract for an absent target is deliberate ("a page dimmed to nothing,
 * explaining nothing, is worse than a page left alone") but the walk still
 * puts the card up claiming to be pointing at something, having lit nothing
 * at all — which is exactly what an administrator with no household yet
 * would see as "the tour doesn't move to anything": the first card of the
 * walk, over an untouched screen.
 *
 * v19-tour-walk.test.mjs never plants this DOM, and the e2e journeys
 * (tests/e2e/v19-tour.spec.ts) always create a household through
 * `household.create` before taking the walk, so no existing coverage takes
 * the walk on a genuinely empty sky.
 */

/** The "adrift" home screen: no household, so no dial at all. */
const ADRIFT = `
  <div class="adrift"></div>
  <div id="manifest-top"></div>
  <button id="nstar"></button>
  <button class="orb"></button>
  <div class="tourcard" tabindex="-1"><p id="tour-copy-1"></p><p id="tour-copy-2"></p></div>
`;

function stageAdrift() {
  document.body.innerHTML = ADRIFT;
}

let fetched;

beforeEach(() => {
  fetched = vi.fn();
  vi.stubGlobal("fetch", fetched);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("the walk on a household-less (adrift) sky (#864)", () => {
  it("lights something at stop one instead of pointing at nothing", async () => {
    stageAdrift();
    let route = "/home";
    const tour = createTour({
      doc: document,
      stops: stopsFor(),
      routeOf: () => route,
      navigate: async (next) => { route = next; },
      writeSeen: async () => {},
      onChange: () => {},
      patience: 20,
    });

    await tour.start();

    /* The card is up, claiming to be at stop one of the walk, and it ought
       to be pointing at something real on the screen behind it — not
       standing over an untouched page. */
    expect(document.querySelector(".tourcard")).toBeTruthy();
    expect(document.querySelectorAll(".lit").length).toBeGreaterThan(0);
  });
});
