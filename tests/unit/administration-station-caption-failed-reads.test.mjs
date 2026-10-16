// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { mountStation } from "../../web/src/lib/backdrops/station.js";

/*
 * #1442 (review round 3): the desk administration backdrop's caption never
 * prints a blank domain or a made-up number when a read failed.
 *
 * The caption's facts are built on the desk screen (web/src/routes/
 * administration/+page.svelte, loadScreen) from the one readAdminScreen()
 * answer: the collection domain comes from the mail settings (`screen.relay`,
 * null when the mail read failed) and the crew from the people list
 * (`screen.users`, null when the users read failed). Today an unknown domain
 * is "" (so the caption reads "THE PLATFORM · ") and an unknown crew is 0 (so
 * it reads "0 CREW", which says nobody is aboard). The rule:
 *
 *   - an unknown domain gives "THE PLATFORM" and no trailing separator;
 *   - an unknown systems count or crew count leaves that part of the second
 *     line out, with its " · " separator, rather than printing 0 (or "null",
 *     or "undefined");
 *   - what is known is still printed as before.
 *
 * "Unknown" is tested in every form a caller can reasonably hand over (empty,
 * null, undefined, or the key left out), because the caption is the one that
 * must hold whichever the screen chooses. That the screen does not invent the
 * number itself before it gets here is checked in
 * administration-failed-reads-screens.test.mjs.
 */

const GALAXY = {
  "hh-harlow-1": { name: "Harlow Home", pos: [0, 0], planets: [], items: 6 },
  "hh-seaside-4551": {
    name: "Seaside Cottage", pos: [-617, -305], items: 3,
    planets: [[28, 10, 2.2, "--warm"], [-24, -8, 2, "--ok"], [-6, -26, 2.4, "--ok"]],
  },
};

/** @type {(() => void)[]} */
const teardowns = [];
afterEach(() => {
  while (teardowns.length) teardowns.pop()?.();
});

/**
 * The caption's first two lines, as drawn, for the facts given.
 * @param {Record<string, unknown>} facts
 */
function captionFor(facts) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const teardown = mountStation(root, { seed: 424242, galaxy: GALAXY, primary: "hh-harlow-1", facts: /** @type {any} */ (facts) });
  teardowns.push(teardown, () => root.remove());
  const lines = [...root.querySelectorAll("text")].map((node) => node.textContent ?? "");
  /* The station is drawn on two passes, each with the same caption: every
     copy must read alike, so they are compared as one. */
  const platform = [...new Set(lines.filter((line) => line.startsWith("THE PLATFORM")))];
  const crew = [...new Set(lines.filter((line) => /\bABOARD\b|\bCREW\b|\bSYSTEMS?\b/.test(line)))];
  expect(platform, "the caption's first line is not drawn, or its copies differ").toHaveLength(1);
  expect(crew.length, "the caption's copies of the second line differ").toBeLessThanOrEqual(1);
  return { first: platform[0], second: crew[0] ?? "" };
}

const KNOWN = { domain: "in.harlow-home.orbit", systems: 5, crew: 5 };

describe("the station caption with every fact known", () => {
  it("prints the domain and both counts", () => {
    const { first, second } = captionFor(KNOWN);
    expect(first).toBe("THE PLATFORM · IN.HARLOW-HOME.ORBIT");
    expect(second).toBe("5 SYSTEMS ABOARD · 5 CREW");
  });
});

describe("the station caption when the collection domain is unknown (the mail read failed)", () => {
  it.each([
    ["empty", ""],
    ["null", null],
    ["undefined", undefined],
    ["blank", "   "],
  ])("reads 'THE PLATFORM' with no separator or blank after it: domain %s", (_name, domain) => {
    const { first } = captionFor({ ...KNOWN, domain });
    expect(first).toBe("THE PLATFORM");
  });

  it("reads 'THE PLATFORM' when the domain key is left out", () => {
    const { domain: _omitted, ...rest } = KNOWN;
    expect(captionFor(rest).first).toBe("THE PLATFORM");
  });

  it("still prints the counts it does know", () => {
    expect(captionFor({ ...KNOWN, domain: "" }).second).toBe("5 SYSTEMS ABOARD · 5 CREW");
  });
});

describe("the station caption when the crew is unknown (the users read failed)", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("leaves the crew out rather than printing 0, null or undefined: crew %s", (_name, crew) => {
    const { second } = captionFor({ ...KNOWN, crew });
    expect(second).toBe("5 SYSTEMS ABOARD");
  });

  it("leaves the crew out when the crew key is left out", () => {
    const { crew: _omitted, ...rest } = KNOWN;
    expect(captionFor(rest).second).toBe("5 SYSTEMS ABOARD");
  });

  it("keeps the domain line as it was", () => {
    expect(captionFor({ ...KNOWN, crew: null }).first).toBe("THE PLATFORM · IN.HARLOW-HOME.ORBIT");
  });

  it("names a single system in the singular", () => {
    expect(captionFor({ ...KNOWN, systems: 1, crew: null }).second).toBe("1 SYSTEM ABOARD");
  });
});

describe("the station caption when the systems count is unknown", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("leaves the systems out rather than printing 0, null or undefined: systems %s", (_name, systems) => {
    const { second } = captionFor({ ...KNOWN, systems });
    expect(second).toBe("5 CREW");
  });
});

describe("the station caption when nothing is known", () => {
  it("is 'THE PLATFORM' alone, with no second line of counts", () => {
    const { first, second } = captionFor({ domain: "", systems: null, crew: null });
    expect(first).toBe("THE PLATFORM");
    expect(second).toBe("");
  });
});
