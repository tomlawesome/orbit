import { expect, test } from "@playwright/test";

const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * THE CREATE DRAWER ON A PHONE (#1263; was the create card's ring, #1175).
 *
 * The create questions stand in the belong card's "name your own system"
 * drawer since the arrival flies once. On a phone that card is one column at
 * door-phone.css's floor: fields 48px at 16px, the handle 13px mono on a 44px
 * hit area, nothing in the drawer under 12px, nothing wider than the screen,
 * and the card capped at 80vh so Create is reached by scrolling the card,
 * never the page.
 *
 * Runs in both the Chromium `fidelity` project and the WebKit `pocket-webkit`
 * project (web/playwright.config.js), at the two phone widths the pocket is
 * drawn at. Reached through the fixture harness's `?arrival=newcomer&drawer=1`,
 * the same fixture screens.spec.js's `newcomer-drawer` frame opens.
 */

const WIDTHS = [
  { name: "390x844", viewport: { width: 390, height: 844 } },
  { name: "360x780", viewport: { width: 360, height: 780 } },
];

for (const width of WIDTHS) {
  test(`the create drawer stands whole at the phone's floor at ${width.name}`, async ({ page }) => {
    await page.setViewportSize(width.viewport);
    await page.goto(`${APP}/?arrival=newcomer&drawer=1`, { waitUntil: "load" });
    await page.waitForSelector(".nf .belong #hhname", { state: "visible", timeout: 20_000 });
    /* the card's 1.1s fade and the drawer's .3s open */
    await page.waitForTimeout(1500);

    const seen = await page.evaluate(() => {
      /** @param {Element | null} el */
      const box = (el) => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
      };
      const card = document.querySelector(".nf .belong");
      const handle = document.querySelector(".nf .belong .own button");
      const drawer = document.querySelector(".nf .belong .create");
      /* every piece of text in the drawer and the footer, by its computed size */
      const sizes = [...(document.querySelectorAll(".nf .belong .own *, .nf .belong .create *"))]
        .filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim()))
        .filter((el) => el.getClientRects().length > 0 && !el.classList.contains("asklabel"))
        .map((el) => ({ text: (el.textContent ?? "").trim().slice(0, 30), size: parseFloat(getComputedStyle(el).fontSize) }));
      return {
        inner: { w: window.innerWidth, h: window.innerHeight },
        overflow: document.documentElement.scrollWidth,
        card: box(card),
        cardScrolls: card ? card.scrollHeight > card.clientHeight : false,
        handle: box(handle),
        handleFont: handle ? getComputedStyle(handle).fontSize : "",
        handleFamily: handle ? getComputedStyle(handle).fontFamily : "",
        handleExpanded: handle?.getAttribute("aria-expanded") ?? null,
        drawerInCard: Boolean(card && drawer && card.contains(drawer)),
        name: box(document.querySelector("#hhname")),
        nameFont: getComputedStyle(/** @type {Element} */ (document.querySelector("#hhname"))).fontSize,
        tz: box(document.querySelector("#tz")),
        tzFont: getComputedStyle(/** @type {Element} */ (document.querySelector("#tz"))).fontSize,
        cur: box(document.querySelector("#cur")),
        act: box(document.querySelector("#gobtn")),
        sizes,
        ring: document.querySelectorAll(".ringcard").length,
      };
    });

    const { w, h } = seen.inner;
    expect(seen.overflow, "nothing wider than the screen").toBeLessThanOrEqual(w);
    expect(seen.ring, "no ring holds the questions any more").toBe(0);
    expect(seen.drawerInCard, "the drawer stands in the belong card").toBe(true);
    expect(seen.handleExpanded).toBe("true");

    const card = /** @type {NonNullable<typeof seen.card>} */ (seen.card);
    expect(card.left, "whole: not off the left").toBeGreaterThanOrEqual(0);
    expect(card.right, "whole: not off the right").toBeLessThanOrEqual(w);
    expect(card.height, "capped at 80vh").toBeLessThanOrEqual(h * 0.8 + 1);

    const handle = /** @type {NonNullable<typeof seen.handle>} */ (seen.handle);
    expect(handle.height, "the handle's 44px hit area").toBeGreaterThanOrEqual(44);
    expect(seen.handleFont, "the handle at 13px").toBe("13px");
    expect(seen.handleFamily, "the handle in the mono face").toMatch(/mono/i);

    for (const field of [seen.name, seen.tz, seen.cur]) {
      const f = /** @type {NonNullable<typeof field>} */ (field);
      expect(f.height, "48px fields").toBeGreaterThanOrEqual(47.5);
      expect(f.right, "inside the screen").toBeLessThanOrEqual(w);
    }
    expect(seen.nameFont, "16px in the fields (no iOS zoom)").toBe("16px");
    expect(seen.tzFont).toBe("16px");
    const act = /** @type {NonNullable<typeof seen.act>} */ (seen.act);
    expect(act.height, "a 44px act").toBeGreaterThanOrEqual(44);

    for (const { text, size } of seen.sizes) {
      expect(size, `"${text}" is under the 12px floor`).toBeGreaterThanOrEqual(12);
    }

    /* Create is reached in the card, by scrolling the card */
    await page.locator("#gobtn").scrollIntoViewIfNeeded();
    const after = await page.evaluate(() => {
      const b = /** @type {Element} */ (document.querySelector("#gobtn")).getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, page: document.scrollingElement?.scrollTop ?? 0 };
    });
    expect(after.bottom, "Create in view").toBeLessThanOrEqual(h);
    expect(after.top).toBeGreaterThanOrEqual(0);
    expect(after.page, "the page itself does not scroll").toBe(0);
  });
}
