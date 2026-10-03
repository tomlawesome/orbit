import { expect, test } from "@playwright/test";

const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * THE FIRST-RUN CREATE SCREEN ON A PHONE (#1175).
 *
 * The desk's ring holds the questions because it is 500px across; on the
 * owner's iPhone that same 500px ring stood at the screen's left edge with
 * 110px off the right, the form inside it. No check looked: the `first-run`
 * fidelity frame is the desk at 1600x1000, and pocket-measure has no state
 * for the arrival. Since the fix the create card stands in the door's own
 * phone column (`.ringcard`, door-phone.css): the login ring at its station,
 * the question inside it, the fields beneath, the act a full-width pill.
 *
 * Runs in both the Chromium `fidelity` project and the WebKit `pocket-webkit`
 * project (web/playwright.config.js), at the two phone widths the pocket is
 * drawn at. Reached through the fixture harness's own `?arrival=create`
 * (web/src/routes/+page.js), the same door screens.spec.js's `first-run`
 * frame opens.
 */

const WIDTHS = [
  { name: "390x844", viewport: { width: 390, height: 844 } },
  { name: "360x780", viewport: { width: 360, height: 780 } },
];

for (const width of WIDTHS) {
  test(`the create card's ring and form stand centred and whole at ${width.name}`, async ({ page }) => {
    await page.setViewportSize(width.viewport);
    await page.goto(`${APP}/?arrival=create`, { waitUntil: "load" });
    await page.waitForSelector("#hhname", { state: "visible", timeout: 20_000 });
    /* the ring's .8s reveal and .5s travel to the card's station */
    await page.waitForTimeout(1500);

    const seen = await page.evaluate(() => {
      /** @param {string} selector */
      const box = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height, cx: (b.left + b.right) / 2 };
      };
      return {
        inner: { w: window.innerWidth, h: window.innerHeight },
        overflow: document.documentElement.scrollWidth,
        ring: box(".ringcard .bigring"),
        stroke: box(".ringcard .bigring .ringstroke"),
        ask: box(".ringcard #formlayer .card .ask"),
        askText: document.querySelector(".ringcard #formlayer .card .ask")?.textContent?.trim() ?? "",
        askShown: (() => { const el = document.querySelector(".ringcard #formlayer .card .ask"); return el ? getComputedStyle(el).clipPath === "none" && getComputedStyle(el).clip === "auto" && el.getBoundingClientRect().width > 100 : false; })(),
        name: box("#hhname"),
        act: box("#gobtn"),
      };
    });

    const { w, h } = seen.inner;
    expect(seen.overflow, "nothing wider than the screen").toBeLessThanOrEqual(w);
    expect(seen.ring, "the ring is drawn").not.toBeNull();
    const ring = /** @type {NonNullable<typeof seen.ring>} */ (seen.ring);
    expect(ring.width, "the login ring's own size, never the desk's 500px").toBeLessThanOrEqual(302.5);
    expect(ring.width).toBeGreaterThanOrEqual(239.5);
    expect(Math.abs(ring.cx - w / 2), "centred on the screen").toBeLessThanOrEqual(1);
    expect(ring.left, "whole: not off the left").toBeGreaterThanOrEqual(0);
    expect(ring.right, "whole: not off the right").toBeLessThanOrEqual(w);
    expect(ring.top).toBeGreaterThanOrEqual(0);
    const stroke = /** @type {NonNullable<typeof seen.stroke>} */ (seen.stroke);
    expect(Math.abs(stroke.width - ring.width), "the stroke fills its ring").toBeLessThanOrEqual(1);

    expect(seen.askText).toBe("Name your first system");
    expect(seen.askShown, "the ring holds the question on a phone").toBe(true);
    const ask = /** @type {NonNullable<typeof seen.ask>} */ (seen.ask);
    expect(Math.abs((ask.top + ask.bottom) / 2 - (ring.top + ring.bottom) / 2), "at the ring's centre").toBeLessThanOrEqual(2);

    const name = /** @type {NonNullable<typeof seen.name>} */ (seen.name);
    expect(name.top, "the fields stand under the ring").toBeGreaterThan(ring.bottom);
    expect(name.height, "48px fields (§1.7)").toBeGreaterThanOrEqual(47.5);
    const act = /** @type {NonNullable<typeof seen.act>} */ (seen.act);
    expect(act.height, "a 44px act").toBeGreaterThanOrEqual(44);
    expect(act.bottom, "the act on the first screen").toBeLessThanOrEqual(h);
    expect(Math.abs(act.width - name.width), "full width in the column, like the fields").toBeLessThanOrEqual(1);
  });
}
