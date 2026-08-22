import { describe, expect, it } from "vitest";

/*
 * §15, the 08-17 morning batch (owner): "we should be able to click the sun in
 * the center of the dial and go to the given household's view." The sun's
 * address is the one piece of that wiring that is not DOM — home.behaviour.js
 * is imperative DOM by design and this suite runs in node — so the seam the
 * markup and the flight BOTH write through is what gets pinned here.
 *
 * Importing a module from web/ is fine: root vitest excludes web/ from test
 * COLLECTION, not from resolution (see v19-placement.test.mjs).
 */
import { sunHref } from "../../web/src/routes/home/home.behaviour.js";
import { galaxyOf } from "../../web/src/lib/data/chart.js";
import { WORKSPACE_FIXTURE } from "../../web/src/lib/data/fixtures/workspace.js";

const TODAY = "2026-08-13"; // DESIGN_TODAY: the date every mockup was drawn against
const GALAXY = galaxyOf(WORKSPACE_FIXTURE, TODAY);
const PRIMARY = WORKSPACE_FIXTURE.activeHouseholdId;

describe("the sun's address", () => {
  it("is the household's own screen", () => {
    expect(sunHref("hh-lawson-1")).toBe("/household/hh-lawson-1");
  });

  it("encodes an id rather than trusting it into the path", () => {
    expect(sunHref("a b/c")).toBe("/household/a%20b%2Fc");
  });

  it("points the fixture's active household at the household route the gate loads", () => {
    /* Requirement 4 of the ruling: under ORBIT_FIXTURES the active household
       id exists, so the click lands on a real screen in fixture mode — the
       same path the fidelity gate reads the household screen at. */
    expect(PRIMARY).toBeTruthy();
    expect(WORKSPACE_FIXTURE.households.some((one) => one.id === PRIMARY)).toBe(true);
    expect(sunHref(PRIMARY)).toBe("/household/hh-lawson-1");
  });

  it("has a real destination for every household a flight can land on", () => {
    /* A flight re-letters the name under the sun and re-points the sun with
       it, keyed by the galaxy key. So every key in the galaxy must be a
       household id this workspace actually holds, or a flight would hand the
       sun an address that 404s. */
    const ids = new Set(WORKSPACE_FIXTURE.households.map((one) => one.id));
    const keys = Object.keys(GALAXY);
    expect(keys.length).toBeGreaterThan(1);
    for (const key of keys) {
      expect(ids.has(key)).toBe(true);
      expect(sunHref(key)).toBe(`/household/${key}`);
    }
  });
});
