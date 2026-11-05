import { describe, expect, it } from "vitest";

import { constellationPlanetsOf, ringDotsOf } from "../../web/src/lib/data/chart.js";
import { BAND_VAR } from "../../web/src/lib/data/bands.js";

/*
 * #1463 (audit Low b1 L-Q1, from #1586): the administration roster's ring
 * tones had no --ink-mid, so a system with nothing scheduled fell back to
 * --ok (green) while bands.js gives an unscheduled or ended planet --ink-mid.
 * A ring dot keeps the planet's own tone for every tone bands.js can give.
 */
const SCALE = { centre: 20, spread: 4, rMin: 1, rScale: 0.5 };

describe("ringDotsOf tones", () => {
  it("keeps --ink-mid as --ink-mid, not --ok", () => {
    const [dot] = ringDotsOf([[0, 0, 2, "--ink-mid"]], SCALE);
    expect(dot.tone).toBe("--ink-mid");
  });

  it.each([...new Set(Object.values(BAND_VAR))])("keeps the band tone %s", (tone) => {
    const [dot] = ringDotsOf([[0, 0, 2, tone]], SCALE);
    expect(dot.tone).toBe(tone);
  });

  it("gives an unscheduled system's dots --ink-mid end to end", () => {
    const planets = constellationPlanetsOf([{ id: "u1", status: "active", dueDate: null }], "2026-11-05");
    expect(planets).toHaveLength(1);
    expect(ringDotsOf(planets, SCALE)[0].tone).toBe(BAND_VAR.unscheduled);
    expect(ringDotsOf(planets, SCALE)[0].tone).toBe("--ink-mid");
  });
});
