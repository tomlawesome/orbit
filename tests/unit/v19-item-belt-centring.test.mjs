import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { APEX_FRAC, geometryOf } from "../../web/src/routes/item/[[id]]/band.js";

/*
 * #1247, the owner's ruling of 2026-10-06: "document cards should always be
 * centralised on the belt. The belt should move up and down with them, and
 * generally be lower. The apex of the centreline of the belt semi circle
 * should be mid-page."
 *
 * Before: the apex hung at 35% of the sky and the card was hung from it a
 * third of the way down (translate -34%), so the card sat mostly below the
 * band's line and a card that grew (the edit panel, #1248) grew away from it.
 * Now the apex is the sky's middle and the card is hung by its own middle, so
 * whatever height the card takes, its centre is the apex.
 */
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const CSS = read("web/src/routes/item/[[id]]/belt.css");
const SHEET = read("design/v19/item-belt.html");

/** Every `.cardwrap` rule that carries a transform, with the block it sets. */
const cardTransforms = (css) =>
  [...css.matchAll(/([^{}]*\.cardwrap)\{([^}]*transform:[^}]*)\}/g)]
    .filter(([, , body]) => /transform:\s*translate/.test(body))
    .map(([, selector, body]) => ({ selector: selector.split("\n").pop().trim(), body }));

describe("the belt's apex is mid-page (#1247)", () => {
  it("hangs the apex of the band's centreline at half the sky's height", () => {
    expect(APEX_FRAC).toBe(0.5);
    for (const [w, h] of [[1600, 1000], [1280, 800], [1280, 720], [1112, 1000], [901, 601]]) {
      const geom = geometryOf(w, h);
      const apex = geom.project(geom.PHI_APEX, geom.A, 0);
      expect(apex.x).toBeCloseTo(w / 2, 9);
      expect(apex.y).toBeCloseTo(Math.round(h / 2), 9);
    }
  });
});

describe("the card is centred on the belt (#1247)", () => {
  it("hangs the desk card by its own middle, in and out of the reading lanes", () => {
    /* The phone's card is in the page's flow beneath its band plate (#1072)
       and carries the swipe's offset (--sdx); it is not hung on the apex. */
    const rules = cardTransforms(CSS).filter(({ body }) => !body.includes("--sdx"));
    /* .cardwrap on its own and .lanes .cardwrap (#1088) — both hang the card. */
    expect(rules.length).toBeGreaterThanOrEqual(2);
    for (const { selector, body } of rules) {
      expect(body, selector).toMatch(/calc\(-50% \+ var\(--cdy\)\)/);
      expect(body, selector).not.toMatch(/-34%/);
    }
    const base = rules.find(({ selector }) => /^\.belt-page \.cardwrap$/.test(selector));
    expect(base?.body).toMatch(/transform-origin:50% 50%/);
  });

  it("keeps the porting sheet in step, so the fidelity gate compares like with like", () => {
    expect(SHEET).toMatch(/const APEX_FRAC = 0\.5;/);
    const rules = cardTransforms(SHEET);
    expect(rules.length).toBeGreaterThanOrEqual(1);
    for (const { selector, body } of rules) {
      expect(body, selector).toMatch(/calc\(-50% \+ var\(--cdy\)\)/);
      expect(body, selector).toMatch(/transform-origin:50% 50%/);
    }
  });
});
