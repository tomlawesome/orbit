import { expect, test } from "@playwright/test";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * #1129: on the built pocket dial, fixture bodies sit ~35px apart while the
 * accessibility minimum tap target is 44px, so a naive fix that just grew
 * every body's tap circle to 44px would make neighbouring circles overlap —
 * and a tap between two close bodies could raise the wrong one's sheet.
 *
 * The fixture data's own "Gutter clearing" and "Car MOT — Volvo V60" bodies
 * are the pair #1072's design round measured (~34px centre-to-centre at
 * 390px). Both are ordinary dial bodies (not suggestion markers), so a tap
 * routes straight to the item sheet with a plain title.
 *
 * The point tapped sits 40% of the way from "Gutter clearing" toward
 * "Car MOT — Volvo V60" — nearer to Gutter, but (today) outside both bodies'
 * tiny drawn circles (~7-8px radius), so nothing currently answers it at
 * all. Fixed, the tap must resolve to the nearer body without either body's
 * drawn circle moving or changing size (the fidelity baseline still governs
 * what is drawn — this only asks what answers a tap between them).
 */
const PHONE = { width: 390, height: 844 };

/**
 * @param {import("@playwright/test").Page} page
 * @returns {Promise<{ title: string, x: number, y: number }[]>}
 */
async function dialBodyCenters(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".mdial [data-sheet-title]")].map((el) => {
      const r = el.getBoundingClientRect();
      return { title: /** @type {HTMLElement} */ (el).dataset.sheetTitle ?? "", x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }));
}

test("a tap nearer one dial body than another raises that body's sheet, not the other's", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll(".mdial [data-sheet-title]").length > 0);

  const bodies = await dialBodyCenters(page);
  const found = bodies.find((one) => one.title === "Gutter clearing");
  const other = bodies.find((one) => one.title === "Car MOT — Volvo V60");
  expect(found, "fixture no longer draws \"Gutter clearing\" on the dial").toBeTruthy();
  expect(other, "fixture no longer draws \"Car MOT — Volvo V60\" on the dial").toBeTruthy();
  if (!found || !other) throw new Error("unreachable — the expects above already failed the test");
  const a = found, b = other;

  const gap = Math.hypot(a.x - b.x, a.y - b.y);
  expect(gap, "the fixture pair this test needs no longer sits close enough to matter").toBeLessThan(45);

  /* 40% of the way from a to b: nearer a, but outside both bodies' raw
     drawn radius (~7-8px), so today's native circle hit-testing answers
     neither. */
  const point = { x: a.x + (b.x - a.x) * 0.4, y: a.y + (b.y - a.y) * 0.4 };
  const distToA = Math.hypot(point.x - a.x, point.y - a.y);
  const distToB = Math.hypot(point.x - b.x, point.y - b.y);
  expect(distToA, "test point must be genuinely nearer Gutter clearing").toBeLessThan(distToB);

  await page.mouse.click(point.x, point.y);
  await expect(page.locator("#sheet")).toHaveClass(/open/);
  await expect(page.locator("#sh-title")).toHaveText(a.title);
});
