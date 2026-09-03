// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTour } from "../../web/src/lib/tour/engine.js";
import {
  EXAMPLE_BODY,
  countBodies,
  drawExampleBody,
  needsExampleBody,
  removeExampleBody,
} from "../../web/src/lib/tour/example.js";
import { stopsFor } from "../../web/src/lib/tour/stops.js";

/*
 * #752, the two rules with teeth.
 *
 * THE EXAMPLE BODY is a labelled, bounded exception to §12 of
 * design/owner-decisions.md, and every part of "bounded" is asserted here: it
 * appears only on the stops that ask for it, only on a household with nothing
 * on it, and it is gone the moment the walk moves past it or ends. Its being
 * unpersisted is not a matter of the API being polite about it — nothing in
 * the walk sends anything anywhere except the one record below, which is why
 * `fetch` is watched throughout and expected never to be called.
 *
 * THE RECORD is written once, on skip and on finish alike (#477: remembered
 * on the server, so skipping on a phone holds on the desk). A tour that wrote
 * twice, or wrote on the way past, would be a tour that could never be taken
 * again by anything #753 builds.
 */

const HOME = `
  <svg class="dial"><g class="chrome"></g><a class="sun-link"></a></svg>
  <div class="minisys"></div>
  <div class="hero-foot"></div>
  <div id="manifest-top"><div class="corridor"><div class="today"></div></div></div>
  <button id="nstar"></button>
  <button class="orb"></button>
  <div class="tourcard" tabindex="-1"><p id="tour-copy-1"></p><p id="tour-copy-2"></p></div>
`;

/** The home screen, with however many real bodies this household has. */
function stage({ bodies = 0 } = {}) {
  document.body.innerHTML = HOME;
  const dial = document.querySelector("svg.dial");
  for (let index = 0; index < bodies; index++) {
    const anchor = document.createElement("a");
    anchor.className = "body-link";
    const group = document.createElement("g");
    if (index === 0) group.id = "b-closest";
    anchor.append(group);
    dial.append(anchor);
  }
}

/** A walk over the real stop list, with the outside world stubbed. */
function walk({ bodies = 0 } = {}) {
  stage({ bodies });
  let route = "/home";
  const navigated = [];
  const writes = [];
  const views = [];
  const tour = createTour({
    doc: document,
    stops: stopsFor(),
    routeOf: () => route,
    navigate: async (next) => { route = next; navigated.push(next); },
    writeSeen: async () => { writes.push(Date.now()); },
    onChange: (view) => views.push(view),
    /* The stub screens are already in the document, so nothing here waits;
       this only bounds the one test that navigates to a screen that is not. */
    patience: 20,
  });
  return { tour, navigated, writes, views, route: () => route };
}

/** Walks to a stop the way a reader does: the card's own Back and Next. */
async function stepTo(tour, index) {
  while (tour.index < index) await tour.go(1);
  while (tour.index > index) await tour.go(-1);
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

describe("the example body", () => {
  it("is drawn only for a household with nothing on it", () => {
    const dialStop = { example: true };
    expect(needsExampleBody(dialStop, { bodyCount: 0 })).toBe(true);
    expect(needsExampleBody(dialStop, { bodyCount: 1 })).toBe(false);
    expect(needsExampleBody({ example: false }, { bodyCount: 0 })).toBe(false);
  });

  it("counts what the reader can already see on either dialect", () => {
    stage({ bodies: 2 });
    expect(countBodies(document)).toBe(2);
    stage();
    expect(countBodies(document)).toBe(0);
  });

  it("says what it is, on the dial and in the manifest", () => {
    stage();
    expect(drawExampleBody(document)).toBe(true);
    const drawn = document.querySelector("svg.dial .tour-example");
    expect(drawn).toBeTruthy();
    expect(drawn.textContent).toContain(EXAMPLE_BODY.label);
    expect(drawn.textContent).toContain("car insurance");
    expect(drawn.textContent).toContain("due in 12 days");
    const row = document.querySelector("#manifest-top .tour-example");
    expect(row.textContent).toContain("Car insurance");
    expect(row.textContent).toContain("example · due in 12 days");
    /* drawn twice is still one example */
    drawExampleBody(document);
    expect(document.querySelectorAll(".tour-example")).toHaveLength(2);
    removeExampleBody(document);
    expect(document.querySelectorAll(".tour-example")).toHaveLength(0);
  });

  it("appears on the empty household's stops 3 to 5 and nowhere else", async () => {
    const { tour } = walk();
    await tour.start();
    expect(document.querySelectorAll(".tour-example")).toHaveLength(0);
    await stepTo(tour, 2);
    expect(document.querySelector("svg.dial .tour-example")).toBeTruthy();
    await stepTo(tour, 4);
    expect(document.querySelector("svg.dial .tour-example")).toBeTruthy();
    await stepTo(tour, 0);
    expect(document.querySelectorAll(".tour-example")).toHaveLength(0);
  });

  it("draws nothing extra where the household has real bodies", async () => {
    const { tour } = walk({ bodies: 2 });
    await tour.start();
    await stepTo(tour, 2);
    expect(document.querySelectorAll(".tour-example")).toHaveLength(0);
    /* the nearest real body is what stop 4 points at instead */
    await stepTo(tour, 3);
    expect(document.querySelector("#b-closest").classList.contains("lit")).toBe(true);
  });

  it("never reaches a server", async () => {
    const { tour } = walk();
    await tour.start();
    await stepTo(tour, 3);
    await tour.skip();
    expect(fetched).not.toHaveBeenCalled();
  });
});

describe("ending the walk", () => {
  it("records it once on skip, and asks for nothing else", async () => {
    const { tour, writes, navigated } = walk();
    await tour.start();
    await tour.skip();
    expect(writes).toHaveLength(1);
    expect(navigated).toEqual([]);
    expect(fetched).not.toHaveBeenCalled();
  });

  it("records it once on finish, by the same door", async () => {
    const { tour, writes } = walk();
    await tour.start();
    await stepTo(tour, stopsFor().length - 1);
    await tour.go(1); // past the last stop IS finish
    expect(writes).toHaveLength(1);
    expect(tour.running).toBe(false);
  });

  it("cannot write twice, however it is ended", async () => {
    const { tour, writes } = walk();
    await tour.start();
    await tour.skip();
    await tour.skip();
    await tour.finish();
    expect(writes).toHaveLength(1);
  });

  it("leaves the screen exactly as it found it", async () => {
    const { tour } = walk();
    await tour.start();
    await stepTo(tour, 2);
    expect(document.body.classList.contains("tour-running")).toBe(true);
    await tour.skip();
    expect(document.body.classList.contains("tour-running")).toBe(false);
    expect(document.querySelectorAll("[data-tour-dim]")).toHaveLength(0);
    expect(document.querySelectorAll(".lit")).toHaveLength(0);
    expect(document.querySelectorAll("[aria-describedby]")).toHaveLength(0);
    expect(document.querySelectorAll(".tour-example")).toHaveLength(0);
  });

  it("records nothing when the walk is merely unmounted", async () => {
    const { tour, writes } = walk();
    await tour.start();
    tour.destroy();
    expect(writes).toEqual([]);
    expect(document.querySelectorAll("[data-tour-dim]")).toHaveLength(0);
  });
});

describe("moving through the walk", () => {
  it("describes the lit thing by the card's own copy, and focuses the card", async () => {
    const { tour, views } = walk();
    await tour.start();
    const lit = [...document.querySelectorAll(".lit")];
    expect(lit.length).toBeGreaterThan(0);
    for (const one of lit) {
      expect(one.getAttribute("aria-describedby")).toBe("tour-copy-1 tour-copy-2");
    }
    expect(document.activeElement).toBe(document.querySelector(".tourcard"));
    expect(views.at(-1)).toMatchObject({ id: "chart", number: 1, total: 8, first: true, last: false });
  });

  it("moves on the arrow keys and leaves on Escape", async () => {
    const { tour, writes } = walk();
    await tour.start();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await Promise.resolve();
    expect(tour.index).toBe(1);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    await Promise.resolve();
    expect(tour.index).toBe(0);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await Promise.resolve();
    expect(writes).toHaveLength(1);
    expect(tour.running).toBe(false);
  });

  it("walks onto the screen a stop names", async () => {
    const { tour, navigated } = walk();
    await tour.start();
    await stepTo(tour, 5); // the inbox's three lanes
    expect(navigated).toEqual(["/inbox"]);
  });
});

/*
 * The card's own contract (#752's acceptance criterion 4). It is a dialog
 * that deliberately does NOT trap the page — the reader is looking at the
 * real screen behind it — and its two copy lines are what the lit element is
 * described by, so their ids and the engine's must be the same two words.
 */
describe("the card", () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "../../web/src/lib/tour/Tour.svelte"),
    "utf8",
  );

  it("is a dialog that does not trap the page", () => {
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="false"');
    expect(source).toContain('tabindex="-1"');
  });

  it("carries the two copy lines the engine describes things by", () => {
    expect(source).toContain('id="tour-copy-1"');
    expect(source).toContain('id="tour-copy-2"');
  });

  it("shows all three doors at every stop", () => {
    expect(source).toContain(">Back<");
    expect(source).toContain(">Skip<");
    expect(source).toMatch(/Finish.*:.*Next|Next.*Finish/su);
  });
});
