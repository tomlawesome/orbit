import { expect, test } from "@playwright/test";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * #1302: on a 14" screen the belt's search field, its note and its hit list
 * clashed with the item card. The card is centred on the apex at mid-page
 * (#1247) and widens to 720px while editing (#1248); the field was fixed
 * 20px from the top with its note ending at 70, and the card's room started
 * at 75; the hit list hung 22px off the field's own edge, 202px from the
 * centre line, which is inside the card's berth. Measured before the fix at
 * 1366x768 with the edit panel open: the card's top at 80 under the note's
 * 70, and the hit list (x885-1181, y20-223) lying over the card (x323-1043,
 * from y80).
 *
 * The fix is belt.css's top strip and berth (--belt-strip, --belt-berth):
 * the card never rises into the strip, and the hit list hangs outside the
 * berth from the strip's bottom edge. A search also closes an open paper
 * on the desk, because with the reader out there is no sky beside the pair.
 *
 * The same shape as belt-chrome-viewport.spec.js, for the same reason: it is
 * geometry, it needs a real layout engine, and this harness stands up the
 * app the gate photographs. Desk sizes only -- the pocket (at most 900 wide
 * or 600 tall) has its own search sheet and never draws .find.
 */

/** @typedef {{ name: string, top: number, bottom: number, left: number, right: number }} Edges */

/** The two usual 14" sizes, a 13" MacBook, the gate's own frame, full HD. */
const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1600, height: 1000 },
  { width: 1920, height: 1080 },
];

/** @param {Edges} a @param {Edges} b */
const intersects = (a, b) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** @param {import("@playwright/test").Page} page */
async function openBelt(page) {
  await page.goto(`${APP}/item/i-mot`, { waitUntil: "load" });
  /* The gate's own settle for this screen: the band has its seats and the
     apex has its card, both of which arrive client-side. */
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#seats .seat").length > 0
      && Boolean(document.querySelector(".item-card h2")),
  );
}

/**
 * The boxes of everything that shares the desk sky with the card: the
 * field, its note, the hit list when it is open, the card, and the reading
 * card when a paper is out.
 * @param {import("@playwright/test").Page} page
 */
const measure = (page) => page.evaluate(() => {
  /** @param {string} sel @param {string} name @returns {Edges | null} */
  const edge = (sel, name) => {
    const el = document.querySelector(sel);
    if (!el || getComputedStyle(el).display === "none") return null;
    const r = el.getBoundingClientRect();
    return { name, top: r.y, bottom: r.y + r.height, left: r.x, right: r.x + r.width };
  };
  /** @type {Edges[]} */
  const search = [];
  for (const [sel, name] of [["#find", "the search field"], [".findnote", "the search field's note"],
    [".hits.open", "the hit list"]]) {
    const box = edge(sel, name);
    if (box) search.push(box);
  }
  return {
    search,
    card: edge("#cardwrap", "the item card"),
    reader: edge("#readcard.open", "the reading card"),
    hitRows: document.querySelectorAll(".hits.open button").length,
  };
});

/**
 * Nothing the search draws lies over the card or an open paper, and the hit
 * list is inside the frame.
 * @param {Awaited<ReturnType<typeof measure>>} seen
 * @param {string} where
 * @param {number} width
 */
function expectClear(seen, where, width) {
  expect(seen.card, `${where}: the card was not found`).not.toBeNull();
  const occupied = [seen.card, seen.reader].filter(Boolean);
  for (const part of seen.search) {
    for (const body of occupied) {
      expect(intersects(part, /** @type {Edges} */ (body)), `${part.name} overlaps ${body?.name} ${where}`).toBe(false);
    }
    if (part.name === "the hit list") {
      expect(part.right, `the hit list runs off the right of the frame ${where}`).toBeLessThanOrEqual(width - 16);
      expect(part.left, `the hit list runs off the left of the frame ${where}`).toBeGreaterThanOrEqual(16);
    }
  }
}

for (const { width, height } of VIEWPORTS) {
  test.describe(`${width}x${height}`, () => {
    test.use({ viewport: { width, height }, reducedMotion: "reduce" });

    test("the search field, its note and its hit list stay clear of the card at rest", async ({ page }) => {
      await openBelt(page);
      const where = `at ${width}x${height}, at rest`;
      expectClear(await measure(page), where, width);
      await page.fill("#find", "o");
      const typed = await measure(page);
      expect(typed.hitRows, `the hit list has no rows ${where}`).toBeGreaterThan(0);
      expectClear(typed, `${where}, typing`, width);
    });

    test("...and while the edit panel has the card at its widest", async ({ page }) => {
      await openBelt(page);
      await page.getByRole("button", { name: "edit", exact: true }).click();
      await expect(page.locator("#lanes")).toHaveClass(/editing/);
      /* the width rides a .75s transition in the lanes; reduced motion does
         not stop that one, so wait for the card to arrive at 720 */
      await expect.poll(() => page.locator("#cardwrap").evaluate((el) => el.getBoundingClientRect().width)).toBe(720);
      const where = `at ${width}x${height}, editing`;
      expectClear(await measure(page), where, width);
      await page.fill("#find", "o");
      const typed = await measure(page);
      expect(typed.hitRows, `the hit list has no rows ${where}`).toBeGreaterThan(0);
      expectClear(typed, `${where}, typing`, width);
    });

    test("...and with a paper open, which the search closes", async ({ page }) => {
      await openBelt(page);
      /* `force`: a paper's mark breathes forever (document-preview.spec.js). */
      await page.locator('#seats .seat .hit[aria-label^="MOT certificate 2025"]').click({ force: true });
      await expect(page.locator("#readcard")).toBeVisible();
      await page.fill("#find", "o");
      await expect(page.locator("#readcard")).toHaveCount(0);
      /* the lanes close over .75s; the card is back on the centre line when
         its centre is */
      await expect.poll(() => page.locator("#cardwrap").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return Math.round(r.x + r.width / 2);
      })).toBe(width / 2);
      const where = `at ${width}x${height}, after a paper was open`;
      const typed = await measure(page);
      expect(typed.hitRows, `the hit list has no rows ${where}`).toBeGreaterThan(0);
      expectClear(typed, where, width);
    });

    test("the card is centred on the apex unless that would put it in the top strip", async ({ page }) => {
      await openBelt(page);
      const rest = await page.locator("#cardwrap").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { mid: r.y + r.height / 2, top: r.y };
      });
      /* a resting card is short enough everywhere here: exactly on the apex */
      expect(Math.abs(rest.mid - height / 2)).toBeLessThanOrEqual(1);
      await page.getByRole("button", { name: "edit", exact: true }).click();
      await expect.poll(() => page.locator("#cardwrap").evaluate((el) => el.getBoundingClientRect().width)).toBe(720);
      const editing = await page.locator("#cardwrap").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { mid: r.y + r.height / 2, top: r.y };
      });
      /* the strip is 90 deep: the edit form either sits on the apex with
         its top below the strip, or starts at the strip's bottom edge */
      expect(editing.top).toBeGreaterThanOrEqual(90 - 0.5);
      if (editing.top > 90.5) expect(Math.abs(editing.mid - height / 2)).toBeLessThanOrEqual(1);
    });
  });
}
