// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  DIMMING_PACKS,
  FORWARD_PACKS,
  applyEmphasis,
  clearEmphasis,
  emphasisModeOf,
  packOf,
} from "../../web/src/lib/tour/emphasis.js";

/*
 * #752, and the owner's ruling of 2026-09-03: the walk emphasises its subject
 * one of two ways, and which one is not a taste — it follows from the pack.
 * Dark skies dim everything else; daylight skies dim NOTHING and push the
 * subject forward by colour, because dimming a light page just greys it.
 *
 * The visual half of that rule lives in tour.css and the behavioural half in
 * emphasis.js, so the first thing pinned here is that the two agree: a pack
 * that is "forward" in the JavaScript and absent from the stylesheet would
 * dim nothing and gain nothing, which is a screen with no emphasis at all.
 */

const web = (path) => resolve(import.meta.dirname, "../../web", path);
const TOUR_CSS = readFileSync(web("src/lib/tour/tour.css"), "utf8");
const PACKS_CSS = readFileSync(web("src/lib/packs.css"), "utf8");

const packsIn = (css) =>
  new Set([...css.matchAll(/\[data-theme=([\w-]+)\]/gu)].map((match) => match[1]));

describe("emphasis mode, per pack", () => {
  it("dims on the dark packs and pushes forward on the daylight ones", () => {
    for (const pack of ["starchart", "afterdark", "retrograde"]) {
      expect(emphasisModeOf(pack), pack).toBe("dim");
    }
    for (const pack of ["atlas", "dawn", "clouds"]) {
      expect(emphasisModeOf(pack), pack).toBe("forward");
    }
  });

  it("classifies every pack that exists, and nothing else", () => {
    expect(new Set([...DIMMING_PACKS, ...FORWARD_PACKS])).toEqual(packsIn(PACKS_CSS));
  });

  it("dims an unknown pack rather than leaving a stop unemphasised", () => {
    expect(emphasisModeOf(undefined)).toBe("dim");
    expect(emphasisModeOf("a-pack-nobody-wrote")).toBe("dim");
  });

  it("agrees with the stylesheet about which packs go the other way", () => {
    /* tour.css overrides only the daylight packs; every other pack takes the
       dimming default, which is the rule stated once in each language. */
    expect(packsIn(TOUR_CSS)).toEqual(new Set(FORWARD_PACKS));
  });

  it("reads the pack where every screen writes it", () => {
    document.documentElement.dataset.theme = "dawn";
    expect(packOf(document)).toBe("dawn");
    delete document.documentElement.dataset.theme;
    expect(packOf(document)).toBe("starchart");
  });
});

const SCREEN = `
  <div class="page">
    <a class="sun-link"><span class="name">Lawson Home</span></a>
    <a class="body-link"><g id="b-closest"></g></a>
    <a class="body-link"><g></g></a>
    <div class="hero-foot"><input></div>
    <div id="manifest-top"></div>
  </div>
`;

const marked = (selector) => [...document.querySelectorAll(selector)];
/** What each matched element is, in one word, for a readable assertion. */
const named = (selector) =>
  marked(selector).map((one) => one.id || one.classList[0] || one.tagName.toLowerCase());

describe("applying the emphasis", () => {
  beforeEach(() => {
    document.body.innerHTML = SCREEN;
    delete document.documentElement.dataset.theme;
  });

  const REGIONS = [".sun-link", ".body-link", ".hero-foot", "#manifest-top"];

  it("lifts the target and drops the rest of the screen behind it", () => {
    const lit = applyEmphasis(document, { regions: REGIONS, target: ".sun-link", mode: "dim" });
    expect(lit.map((one) => one.classList[0])).toEqual(["sun-link"]);
    expect(named("[data-tour-dim].lit")).toEqual(["sun-link"]);
    expect(named("[data-tour-dim]:not(.lit)")).toEqual([
      "body-link", "body-link", "hero-foot", "manifest-top",
    ]);
  });

  it("never dims an element the target is inside of", () => {
    /* #b-closest is a <g> inside one of the body anchors: dimming that anchor
       would take the lit body down with it, because opacity multiplies. */
    applyEmphasis(document, { regions: REGIONS, target: "#b-closest", mode: "dim" });
    const holder = document.querySelector("#b-closest").parentElement;
    expect(holder.hasAttribute("data-tour-dim")).toBe(false);
    expect(document.querySelector("#b-closest").classList.contains("lit")).toBe(true);
    /* the OTHER body still dims — it is not in the way of anything */
    expect(marked(".body-link[data-tour-dim]")).toHaveLength(1);
    expect(named("[data-tour-dim]:not(.lit)")).toEqual([
      "sun-link", "body-link", "hero-foot", "manifest-top",
    ]);
  });

  it("touches nothing but the target on a daylight pack", () => {
    applyEmphasis(document, { regions: REGIONS, target: ".sun-link", mode: "forward" });
    expect(named("[data-tour-dim]")).toEqual(["sun-link"]);
    expect(marked(".lit")).toHaveLength(1);
  });

  it("dims nothing when the stop's target is not on this screen", () => {
    /* An inbox with no mail has no lanes. A page dimmed to nothing, explaining
       nothing, is worse than a page left alone. */
    const lit = applyEmphasis(document, { regions: REGIONS, target: ".lane", mode: "dim" });
    expect(lit).toEqual([]);
    expect(marked("[data-tour-dim]")).toHaveLength(0);
  });

  it("puts the screen back, including what described the card", () => {
    const lit = applyEmphasis(document, { regions: REGIONS, target: ".sun-link", mode: "dim" });
    lit[0].setAttribute("aria-describedby", "tour-copy-1 tour-copy-2");
    clearEmphasis(document);
    expect(marked("[data-tour-dim]")).toHaveLength(0);
    expect(marked(".lit")).toHaveLength(0);
    expect(marked("[aria-describedby]")).toHaveLength(0);
  });
});
