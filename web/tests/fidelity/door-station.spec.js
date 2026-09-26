import { expect, test } from "@playwright/test";
import { APP, DOOR_STATES } from "./pocket-states.js";

/*
 * THE DOOR'S STATION AND THE WELL'S FIT ON A PHONE (#1127, #1120 step c;
 * design/v19/phone-vision/review-round.md §2.7, §2.8).
 *
 * The owner, on a real phone: the door's ring sat too high. It now stands at
 * the upper-middle, measured as its centre's share of the visible height:
 * 40% where the ring has nothing but the gate or a line under it (the bare
 * door, the held dawn, the goodbye, the invite's outcome, another status),
 * 30% where a card stands under it. Over a card the ring is 240px under
 * 760px of visible height and 302.4px from there up.
 *
 * The 404's well is fitted by its own box (the two 4s, x 440-1160 in scene
 * units, and the glow, y 130-770) rather than the whole 1600x1000 scene, so
 * at 390 the 4s span ~339px and at 360 ~318px, and the glow still ends above
 * the heading.
 *
 * Measured at the real floors (390x664, 360x640: the browser's bars take the
 * rest) and at a tall phone (390x844), with reduced motion so nothing is
 * mid-transition.
 */

const SIZES = [
  { width: 390, height: 664 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
];

/** How near the measured centre must be to its station, in px. */
const TOLERANCE = 2;

/**
 * Each state names what draws its ring and where the ring's centre belongs.
 * @type {{ slug: string, state: string, ring: string, share: number, card?: boolean }[]}
 */
const STATIONS = [
  { slug: "door", state: "rest", ring: "#dawn .glyph svg", share: 0.4 },
  { slug: "login", state: "starting", ring: "#dawn .glyph svg", share: 0.4 },
  { slug: "logout", state: "rest", ring: "#dusk .glyph svg", share: 0.4 },
  { slug: "invite", state: "used", ring: ".invite-card .invite-ring", share: 0.4 },
  { slug: "500", state: "rest", ring: ".stage .errring", share: 0.4 },
  { slug: "login", state: "local-card", ring: ".ringcard .bigring", share: 0.3, card: true },
  { slug: "login", state: "first-administrator", ring: ".ringcard .bigring", share: 0.3, card: true },
  { slug: "setup", state: "rest", ring: ".ringcard .bigring", share: 0.3, card: true },
  { slug: "approve", state: "open", ring: ".ringcard .bigring", share: 0.3, card: true },
];

for (const size of SIZES) {
  test.describe(`the door's station at ${size.width}x${size.height}`, () => {
    test.use({ viewport: size, hasTouch: true, isMobile: true, reducedMotion: "reduce" });

    for (const station of STATIONS) {
      const door = DOOR_STATES.find((s) => s.slug === station.slug && s.state === station.state);
      if (!door) throw new Error(`no door state ${station.slug} · ${station.state} in pocket-states.js`);

      test(`${door.name}: the ring's centre at ${station.share * 100}% of the visible height`, async ({ page }) => {
        await door.reach(page);
        await page.evaluate(() => document.fonts.ready);
        /* reduced motion still crossfades the card in over .7s (ringcard.css) */
        await page.waitForTimeout(900);

        const rect = await page.locator(station.ring).first().boundingBox();
        expect(rect, `${station.ring} has no box`).toBeTruthy();
        const r = /** @type {{x:number,y:number,width:number,height:number}} */ (rect);
        const visible = await page.evaluate(() => window.innerHeight);
        const centre = r.y + r.height / 2;
        console.log(`${size.width}x${size.height} ${door.name}: ring centre ${centre.toFixed(1)}px = ${(centre / visible * 100).toFixed(1)}% of ${visible}, ${r.width.toFixed(1)}px across`);

        expect(Math.abs(centre - station.share * visible), `centre ${centre.toFixed(1)}px, wanted ${(station.share * visible).toFixed(1)}px`)
          .toBeLessThanOrEqual(TOLERANCE);
        if (station.card) {
          expect(r.width, "the ring over a card").toBeCloseTo(visible < 760 ? 240 : 302.4, 0);
        }
      });
    }
  });
}

for (const size of SIZES) {
  test.describe(`the well's fit at ${size.width}x${size.height}`, () => {
    test.use({ viewport: size, hasTouch: true, isMobile: true });

    test("the 4s span the width inside the gutters and the glow ends above the heading", async ({ page }) => {
      await page.goto(`${APP}/door-station-no-such-page`, { waitUntil: "load" });
      await page.waitForSelector(".world[data-rasterised=ready]");

      const m = await page.evaluate(() => {
        const svg = /** @type {SVGSVGElement} */ (document.querySelector(".world > svg"));
        const box = svg.getBoundingClientRect();
        const k = box.width / 1600;
        const gutter = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--p-gutter"));
        const heading = /** @type {HTMLElement} */ (document.querySelector("h1.offchart")).getBoundingClientRect();
        return {
          k,
          fours: 720 * k,
          left: box.left + 440 * k,
          right: box.left + 1160 * k,
          glowBottom: box.top + 770 * k,
          headingTop: heading.top,
          gutter,
          vw: document.documentElement.clientWidth,
          vh: window.innerHeight,
        };
      });
      console.log(`${size.width}x${size.height} 404: 4s span ${m.fours.toFixed(1)}px (x ${m.left.toFixed(1)}-${m.right.toFixed(1)}), glow bottom ${m.glowBottom.toFixed(1)}px, heading top ${m.headingTop.toFixed(1)}px`);

      /* the fit: --kw = min((100cqw - 2 gutters) / 760, 58cqh / 640) */
      const k = Math.min((m.vw - 2 * m.gutter) / 760, (0.58 * m.vh) / 640);
      expect(m.k).toBeCloseTo(k, 3);
      expect(Math.abs(m.fours - 720 * k)).toBeLessThanOrEqual(1);
      /* the 4s stand inside the screen, centred */
      expect(m.left).toBeGreaterThanOrEqual(0);
      expect(m.right).toBeLessThanOrEqual(m.vw);
      expect(Math.abs((m.left + m.right) / 2 - m.vw / 2)).toBeLessThanOrEqual(1);
      expect(m.glowBottom, "the glow runs into the heading").toBeLessThan(m.headingTop);
    });
  });
}
