import { describe, expect, it } from "vitest";

import { HIT_R, MIN_GAP, spacedBodies } from "../../web/src/routes/home/pocket-dial.js";
import { searchPocket } from "../../web/src/routes/home/pocket-search.js";

/*
 * #1120 step 2: the pocket home's two pure rules, the dial's spacing law
 * (proposal §1.7) and the search sheet's matching (§2.4, #1057).
 */

/** @param {string} id @param {number} days @param {number} x @param {number} y @param {boolean} [suggestion] */
const body = (id, days, x, y, suggestion = false) => ({ id, days, suggestion, placement: { x, y } });

describe("the dial's spacing law", () => {
  it("draws every hit circle at 44px or more, and keeps them from touching", () => {
    const narrowestScale = 336 / 380; // the dial at a 360px screen, 12px gutters
    expect(HIT_R * 2 * narrowestScale).toBeGreaterThanOrEqual(44);
    expect(MIN_GAP * narrowestScale).toBeGreaterThanOrEqual(48);
    expect(MIN_GAP).toBeGreaterThanOrEqual(HIT_R * 2);
  });

  it("keeps the body due sooner when two crowd together", () => {
    const kept = spacedBodies([body("mot", 16, 200, 100), body("gutter", -16, 200, 130)]);
    expect(kept.map((b) => b.id)).toEqual(["gutter"]);
  });

  it("keeps bodies that are far enough apart", () => {
    const kept = spacedBodies([body("a", 3, 100, 100), body("b", 5, 100, 100 + MIN_GAP)]);
    expect(kept.map((b) => b.id)).toEqual(["a", "b"]);
  });

  it("keeps the item over the relay's suggestion on a tie", () => {
    const kept = spacedBodies([body("caught", 10, 50, 50, true), body("item", 10, 60, 50)]);
    expect(kept.map((b) => b.id)).toEqual(["item"]);
  });

  it("leaves no two kept bodies closer than the law allows", () => {
    const crowd = Array.from({ length: 40 }, (_, k) => body(`b${k}`, k, 190 + 140 * Math.cos(k), 190 + 140 * Math.sin(k)));
    const kept = spacedBodies(crowd);
    for (const [i, a] of kept.entries())
      for (const b of kept.slice(i + 1))
        expect(Math.hypot(a.placement.x - b.placement.x, a.placement.y - b.placement.y)).toBeGreaterThanOrEqual(MIN_GAP);
  });
});

describe("the pocket search", () => {
  const items = [
    { id: "gutter", title: "Gutter clearing", section: "Home", provider: null, days: -16 },
    { id: "mot", title: "Car MOT — Volvo V60", section: "Vehicles", provider: "Kwik Fit", days: 16 },
    { id: "boiler", title: "Boiler service", section: "Home", provider: "Moss Heating", days: 22 },
    { id: "passport", title: "Passport", section: "Travel", provider: null, days: null },
  ];
  const attention = items.slice(0, 3);
  const documents = [{ id: "d1", itemId: "mot", itemTitle: "Car MOT — Volvo V60", name: "MOT certificate 2025" }];
  const world = { items, attention, documents };

  it("offers the two nearest attention rows before anything is typed", () => {
    const result = searchPocket("  ", world);
    expect(result.items.map((i) => i.id)).toEqual(["gutter", "mot"]);
    expect(result.complete).toBeNull();
    expect(result.nothing).toBe(false);
  });

  it("puts a title that starts with the query ahead of one that only contains it", () => {
    /* "Car MOT" starts with c; "Gutter clearing" and "Boiler service" only
       contain it, and keep the manifest's order (soonest first) between them. */
    expect(searchPocket("c", world).items.map((i) => i.id)).toEqual(["mot", "gutter", "boiler"]);
  });

  it("matches titles, sections and providers, ignoring case and accents", () => {
    expect(searchPocket("GUTTÉR", world).items.map((i) => i.id)).toEqual(["gutter"]);
    expect(searchPocket("vehicles", world).items.map((i) => i.id)).toEqual(["mot"]);
    expect(searchPocket("kwik", world).items.map((i) => i.id)).toEqual(["mot"]);
  });

  it("lists matching papers after the items, and offers to complete the top match", () => {
    const result = searchPocket("mot", world);
    expect(result.items.map((i) => i.id)).toEqual(["mot"]);
    expect(result.documents.map((d) => d.id)).toEqual(["d1"]);
    expect(result.complete?.id).toBe("mot");
  });

  it("offers no complete for an item with no date", () => {
    expect(searchPocket("passport", world).complete).toBeNull();
  });

  it("says so when nothing matches", () => {
    const result = searchPocket("kayak ", world);
    expect(result).toMatchObject({ query: "kayak", items: [], documents: [], complete: null, nothing: true });
  });
});
