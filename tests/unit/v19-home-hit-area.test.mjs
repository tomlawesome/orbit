// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { mountEmptySky } from "../../web/src/routes/home/home.behaviour.js";
import { placeGalaxy } from "../../web/src/routes/home/placement.js";

/*
 * #638: a household's card is an absolutely-positioned 210x160 `.minisys` div
 * holding a 210x160 SVG, but the only things ever DRAWN in it are a ring
 * (r 40 about (ringX, 95)) and a label. The rest of the box was blank canvas
 * that still took pointer events, so on a crowded sky a neighbouring card's
 * blank area could swallow a click aimed at the card actually under the
 * cursor — the failure Playwright caught as 222 retries over 120s on
 * mountEmptySky's newcomer sky, whose `keepOut: 0` makes overlap the normal
 * case rather than an unlucky one.
 *
 * happy-dom has no layout engine: getBoundingClientRect() reports an all-zero
 * box regardless of the CSS in force, and document.elementFromPoint() cannot
 * be trusted to reflect it either (checked directly against this file's own
 * fixture while writing this test). So rather than asking happy-dom to
 * hit-test a point — which it cannot do — this pins the mechanism a real
 * browser's hit-test relies on: the blank box is pointer-events:none (read
 * from the real home.css, not a copy of it), only the ring's hit circle
 * (`.mshit`) and the label text are pointer-events:auto, and a point that
 * lands inside a neighbour's rectangular box but outside that neighbour's
 * actual (circular) hit target is geometrically excluded from it. A separate
 * assertion dispatches a real click at the hit circle and confirms it still
 * reaches the existing handler on the (now pointer-events:none) parent div —
 * bubbling from an "auto" child through a "none" ancestor is what the fix
 * depends on, so it is verified rather than assumed.
 */

const HOME_CSS = readFileSync(
  resolve(import.meta.dirname, "../../web/src/routes/home/home.css"),
  "utf8",
);

const W = 480, H = 480;
// Not hand-picked pixels: this pair and viewport were found by scanning
// placeGalaxy's own answer (the newcomer sky's own camera: null, keepOut: 0)
// for two households whose boxes overlap right at the first one's ring
// centre while that point stays clear of the second one's ring disc — see
// the next test, which checks this fixture actually has that shape before
// anything else relies on it.
const GALAXY = {
  "hh-a": { name: "Household A", pos: [-500, -40] },
  "hh-b": { name: "Household B", pos: [-500, -15] },
};

/** The exact box/ring geometry mountEmptySky computes for one household. */
function ringGeometry(id) {
  const placed = placeGalaxy({ galaxy: GALAXY, camera: null, width: W, height: H, keepOut: 0, screen: W });
  const point = placed.find((p) => p.id === id);
  const away = point.ox > 0;
  const ringX = away ? 210 - 118 : 118;
  const left = W / 2 + point.ox - ringX;
  const top = H / 2 + point.oy - 95;
  return { left, top, ringCx: left + ringX, ringCy: top + 95 };
}

describe("#638: a household card's hit area matches what it draws", () => {
  it("the fixture pair overlaps the way the bug needs, at this viewport", () => {
    const a = ringGeometry("hh-a");
    const b = ringGeometry("hh-b");
    // A's 210x160 box and B's 210x160 box overlap.
    expect(a.left).toBeLessThan(b.left + 210);
    expect(b.left).toBeLessThan(a.left + 210);
    expect(a.top).toBeLessThan(b.top + 160);
    expect(b.top).toBeLessThan(a.top + 160);
    // A's ring centre sits inside B's (blank) box...
    expect(a.ringCx).toBeGreaterThanOrEqual(b.left);
    expect(a.ringCx).toBeLessThanOrEqual(b.left + 210);
    expect(a.ringCy).toBeGreaterThanOrEqual(b.top);
    expect(a.ringCy).toBeLessThanOrEqual(b.top + 160);
    // ...but well clear of B's actual ring disc (radius 40 each, so >80
    // apart means the two discs do not even touch).
    expect(Math.hypot(a.ringCx - b.ringCx, a.ringCy - b.ringCy)).toBeGreaterThan(80);
  });

  it("takes no pointer events on the blank box, and still answers on its own ring", () => {
    document.body.innerHTML = `<style>${HOME_CSS}</style><div id="hero"></div>`;
    const hero = document.getElementById("hero");
    // happy-dom does no layout, so clientWidth/clientHeight are always 0 —
    // pin them to the viewport ringGeometry() above assumes, the same way a
    // real browser's hero element would report its rendered size.
    Object.defineProperty(hero, "clientWidth", { value: W, configurable: true });
    Object.defineProperty(hero, "clientHeight", { value: H, configurable: true });
    const asked = [];
    const unmount = mountEmptySky({ galaxy: GALAXY, onAsk: (id) => asked.push(id) });

    const divs = [...document.querySelectorAll(".minisys")];
    expect(divs).toHaveLength(2);
    const divA = divs.find((d) => d.getAttribute("aria-label") === "Request to join Household A");
    const divB = divs.find((d) => d.getAttribute("aria-label") === "Request to join Household B");
    expect(divA).toBeTruthy();
    expect(divB).toBeTruthy();

    // The blank box takes no pointer events at all...
    expect(getComputedStyle(divB).pointerEvents).toBe("none");
    // ...but B's own hit target (the ring disc, plus its label) still does,
    // so B stays perfectly clickable on the part of it that is actually drawn.
    const hitB = divB.querySelector(".mshit");
    const textB = divB.querySelector("text");
    expect(hitB).toBeTruthy();
    expect(getComputedStyle(hitB).pointerEvents).toBe("auto");
    expect(getComputedStyle(textB).pointerEvents).toBe("auto");

    // The point over A's ring is inside B's rectangular box (previous test)
    // but outside B's actual (circular) hit target — geometrically, in the
    // coordinate space B's own SVG draws in — so a real hit-test lands on A,
    // not on B, however the two boxes happen to overlap.
    const a = ringGeometry("hh-a");
    const b = ringGeometry("hh-b");
    const localX = a.ringCx - b.left, localY = a.ringCy - b.top;
    const bx = Number(hitB.getAttribute("cx"));
    const by = Number(hitB.getAttribute("cy"));
    const br = Number(hitB.getAttribute("r"));
    expect(Math.hypot(localX - bx, localY - by)).toBeGreaterThan(br);

    // A's own hit target is exactly the ring it draws (r 40 about its ring
    // centre) — the point above is that centre by construction.
    const hitA = divA.querySelector(".mshit");
    expect(Number(hitA.getAttribute("cx"))).toBe(118);
    expect(Number(hitA.getAttribute("cy"))).toBe(95);
    expect(Number(hitA.getAttribute("r"))).toBe(40);

    // The click handler still lives on the .minisys div, which is now
    // pointer-events:none — confirm a click dispatched at its pointer-
    // events:auto child still bubbles up to it, rather than assuming a
    // "none" ancestor keeps working just because it compiles.
    hitA.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(asked).toEqual(["hh-a"]);

    unmount();
  });
});
