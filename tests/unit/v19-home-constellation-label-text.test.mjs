// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { mountHome } from "../../web/src/routes/home/home.behaviour.js";

/*
 * WEB6 (#1316): another household's constellation label shows the household's
 * name as literal text. A name that looks like markup must never become an
 * element, and must never run script. Same fixture shape as
 * v19-home-hit-area.test.mjs: happy-dom does no layout, so the hero's size is
 * pinned by hand.
 */

const W = 480, H = 480;
const PAYLOAD = "<img src=x onerror=window.__xss=1>";
const GALAXY = {
  "hh-me": { name: "Household Me", pos: [-500, -40], planets: [] },
  "hh-other": { name: PAYLOAD, pos: [-500, -15], planets: [] },
};

describe("WEB6: a household's name is shown as text in the home sky", () => {
  it("draws a markup-looking name as literal text, creating no element", () => {
    document.body.innerHTML =
      '<div id="hero"></div><div id="cam-far"></div><div id="cam-near"></div>' +
      '<svg><g id="fartile"></g><g id="neartile"></g></svg>';
    const hero = document.getElementById("hero");
    Object.defineProperty(hero, "clientWidth", { value: W, configurable: true });
    Object.defineProperty(hero, "clientHeight", { value: H, configurable: true });

    const unmount = mountHome({ galaxy: GALAXY, primary: "hh-me" });
    try {
      const cards = document.querySelectorAll("#hero .minisys");
      expect(cards).toHaveLength(1);
      const card = cards[0];
      expect(card.querySelector("text").textContent).toBe("<IMG SRC=X ONERROR=WINDOW.__XSS=1>");
      expect(card.getAttribute("aria-label")).toBe(`Fly to ${PAYLOAD}`);

      expect(document.querySelector("img")).toBeNull();
      expect(window.__xss).toBeUndefined();

      const svg = card.querySelector("svg");
      expect(svg).toBeTruthy();
      expect(svg.querySelectorAll("text")).toHaveLength(1);
      expect(svg.querySelectorAll("path")).toHaveLength(1);
      expect(svg.querySelector("circle.msring")).toBeTruthy();
      expect(svg.querySelector("circle.mshit")).toBeTruthy();
    } finally {
      unmount();
    }
  });
});
