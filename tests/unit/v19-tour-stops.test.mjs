import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  TOUR_REGIONS,
  TOUR_STOPS,
  copyOf,
  stopsFor,
  targetOf,
} from "../../web/src/lib/tour/stops.js";

/*
 * #752: the first-run walk is a DATA list, and this is what that promise is
 * worth — "adding, removing or re-targeting a stop touches no component
 * logic" is only true if the list is the thing under test.
 *
 * Three things are pinned here:
 *
 *  1. the ratified order and the ratified four-stop phone cut (#477);
 *  2. the copy, including stop 7's forward-never-redirect line — the #336
 *     ruling names the tour as one of the places that must say it loudly, so
 *     it is asserted character for character rather than paraphrased;
 *  3. that every selector a stop names EXISTS in the markup it names it
 *     against. A stop pointing at a class nobody renders is a stop that
 *     silently explains nothing, which is exactly the failure a data list
 *     makes easy — the screens moved, the list did not.
 */

const web = (path) => resolve(import.meta.dirname, "../../web", path);

/* Where each route's markup actually lives. Home is two dialects plus the
   behaviour module that writes the constellations, and the tour's own
   example.js, which is what draws `.tour-example` into the dial. */
const MARKUP = {
  "/home": [
    "src/routes/home/+page.svelte",
    "src/routes/home/pocket.svelte",
    "src/routes/home/home.behaviour.js",
    "src/lib/tour/example.js",
  ],
  "/inbox": ["src/routes/inbox/+page.svelte", "src/lib/Chrome.svelte"],
  "/settings/mail": ["src/routes/settings/mail/+page.svelte"],
};

const SOURCE = Object.fromEntries(
  Object.entries(MARKUP).map(([route, files]) => [
    route,
    files.map((file) => readFileSync(web(file), "utf8")).join("\n"),
  ]),
);

/**
 * Every name that source assigns to a `class`, `className` or `id`, whether
 * it is written as a literal, a Svelte expression or a DOM assignment.
 */
function namesIn(source) {
  const names = new Set();
  const attributes = /(?:class(?:Name)?|id)\s*[=:]\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/gu;
  for (const match of source.matchAll(attributes)) {
    for (const word of (match[1] ?? match[2] ?? match[3] ?? "").matchAll(/[A-Za-z][\w-]*/gu)) {
      names.add(word[0]);
    }
  }
  /* `class:open` and friends — Svelte's directive form of the same thing. */
  for (const match of source.matchAll(/class:([\w-]+)/gu)) names.add(match[1]);
  return names;
}

/** The class and id names one CSS selector depends on. */
function tokensOf(selector) {
  return [...selector.matchAll(/[.#]([\w-]+)/gu)].map((match) => match[1]);
}

describe("the stop list", () => {
  it("walks the ratified eight, in the ratified order", () => {
    expect(TOUR_STOPS.map((stop) => stop.id)).toEqual([
      "chart", "sun", "dial", "body", "manifest", "inbox", "relay", "create",
    ]);
    expect(TOUR_STOPS.map((stop) => stop.route)).toEqual([
      "/home", "/home", "/home", "/home", "/home", "/inbox", "/settings/mail", "/home",
    ]);
  });

  it("cuts to the phone's four: sky, dial, inbox, relay", () => {
    expect(stopsFor({ phone: true }).map((stop) => stop.id)).toEqual([
      "chart", "dial", "inbox", "relay",
    ]);
    expect(stopsFor().map((stop) => stop.id)).toEqual(TOUR_STOPS.map((stop) => stop.id));
  });

  it("speaks the ratified copy, two lines a stop", () => {
    for (const stop of TOUR_STOPS) {
      expect(stop.copy, stop.id).toHaveLength(2);
      for (const line of stop.copy) expect(line.trim(), stop.id).not.toBe("");
    }
    expect(TOUR_STOPS[0].copy).toEqual([
      "This is your star chart.",
      "Every sun is a household you belong to.",
    ]);
    expect(TOUR_STOPS[2].copy).toEqual([
      "Bodies orbit by when they're due.",
      "The nearer the ring, the sooner.",
    ]);
  });

  it("says the forward-never-redirect line at the relay (#336)", () => {
    const relay = TOUR_STOPS.find((stop) => stop.id === "relay");
    expect(relay.copy[1]).toBe(
      "Your mail is never redirected — it keeps arriving exactly where it always has.",
    );
  });

  it("asks for the example body on stops 3 to 5 and nowhere else", () => {
    expect(TOUR_STOPS.filter((stop) => stop.example).map((stop) => stop.id)).toEqual([
      "dial", "body", "manifest",
    ]);
  });

  it("takes the pocket's target where the dialect differs", () => {
    const chart = TOUR_STOPS[0];
    expect(targetOf(chart)).toBe(chart.target);
    expect(targetOf(chart, { phone: true })).toBe(chart.phoneTarget);
    const relay = TOUR_STOPS.find((stop) => stop.id === "relay");
    /* One screen, both dialects: nothing to swap. */
    expect(targetOf(relay, { phone: true })).toBe(relay.target);
  });

  it("only claims something is an example when the example is drawn", () => {
    const body = TOUR_STOPS.find((stop) => stop.id === "body");
    expect(copyOf(body, { example: true })[1]).toBe(
      "This one's an example — car insurance, due in 12 days.",
    );
    expect(copyOf(body)[1]).toBe(body.copy[1]);
    expect(copyOf(body)[1]).not.toMatch(/example/u);
  });
});

describe("what the stops point at", () => {
  it("names something the screen actually renders, on every stop", () => {
    for (const stop of TOUR_STOPS) {
      const source = SOURCE[stop.route];
      expect(source, `${stop.id}: no markup listed for ${stop.route}`).toBeTruthy();
      const names = namesIn(source);
      const selectors = [stop.target, stop.phoneTarget].filter(Boolean).join(",");
      for (const token of tokensOf(selectors)) {
        expect(names.has(token), `${stop.id}: nothing in ${stop.route} is "${token}"`).toBe(true);
      }
    }
  });

  it("can dim every screen it walks onto", () => {
    for (const stop of TOUR_STOPS) {
      expect(TOUR_REGIONS[stop.route], stop.route).toBeTruthy();
      expect(TOUR_REGIONS[stop.route].length, stop.route).toBeGreaterThan(0);
    }
  });

  it("only marks regions the screen renders", () => {
    for (const [route, regions] of Object.entries(TOUR_REGIONS)) {
      const names = namesIn(SOURCE[route]);
      for (const token of regions.flatMap(tokensOf)) {
        expect(names.has(token), `${route}: nothing is "${token}"`).toBe(true);
      }
    }
  });
});
