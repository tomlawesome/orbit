import { expect, test } from "@playwright/test";
import { settle } from "./pocket-states.js";

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
 * answers for that item alone.
 *
 * The point tapped sits 40% of the way from "Gutter clearing" toward
 * "Car MOT — Volvo V60" — nearer to Gutter, but (today) outside both bodies'
 * tiny drawn circles (~7-8px radius), so nothing currently answers it at
 * all. Fixed, the tap must resolve to the nearer body without either body's
 * drawn circle moving or changing size (the fidelity baseline still governs
 * what is drawn — this only asks what answers a tap between them).
 */
/*
 * #1120 (proposal §1.7) settles the pair the other way. Shrinking a crowded
 * body's hit circle (#1129's first answer) kept both bodies but left targets
 * under 44px; the spacing law instead keeps the one due sooner on the dial
 * and leaves the other in the manifest, so every body keeps a full 44px
 * target and no two targets touch. Gutter clearing (overdue) stays; Car MOT
 * lives in NEEDS ATTENTION only. What #1129 asked stays asked: a tap near a
 * body, outside its small drawn circle, answers for that body -- which,
 * since the owner's answer 6a, opens its row in the manifest.
 */
const PHONES = [{ width: 390, height: 844 }, { width: 360, height: 780 }];

/**
 * @param {import("@playwright/test").Page} page
 * @returns {Promise<{ title: string, x: number, y: number, w: number, h: number }[]>}
 */
async function dialBodies(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".mdial [data-body]")].map((el) => {
      const r = el.getBoundingClientRect();
      return { title: el.getAttribute("aria-label") ?? "", x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    }));
}

for (const phone of PHONES) {
  test(`at ${phone.width}, every dial body has a 44px target clear of its neighbours`, async ({ page }) => {
    await page.setViewportSize(phone);
    await page.goto(`${APP}/home`, { waitUntil: "load" });
    await page.waitForFunction(() => document.body.dataset.homeReady === "true"
      && document.querySelectorAll(".mdial [data-body]:not([data-body-sugg])").length > 0);
    /* The dial arrives from a sixth of its size (review round §1.4): measure
       it once it has. */
    await settle(page);

    const bodies = await dialBodies(page);
    for (const body of bodies) {
      expect(body.w, `${body.title}'s target is narrower than 44px`).toBeGreaterThanOrEqual(44);
      expect(body.h, `${body.title}'s target is shorter than 44px`).toBeGreaterThanOrEqual(44);
    }
    for (const [i, a] of bodies.entries()) {
      for (const b of bodies.slice(i + 1)) {
        expect(Math.hypot(a.x - b.x, a.y - b.y), `${a.title} and ${b.title} sit closer than 48px`)
          .toBeGreaterThanOrEqual(48);
      }
    }

    const titles = bodies.map((one) => one.title);
    expect(titles, "the overdue body lost its place on the dial").toContain("Gutter clearing");
    expect(titles, "the later of the close pair is still drawn on the dial").not.toContain("Car MOT — Volvo V60");
    await expect(page.locator(".pocket .pk-list", { hasText: "Car MOT — Volvo V60" }),
      "the body the dial gave up is missing from the manifest").toHaveCount(1);

    /* 18px off the centre: outside the 7-8px drawn body, inside its target. */
    const gutter = /** @type {{ x: number, y: number }} */ (bodies.find((one) => one.title === "Gutter clearing"));
    await page.mouse.click(gutter.x + 18, gutter.y);
    await expect(page.locator(".pocket .pk-below [data-row]", { hasText: "Gutter clearing" }).first())
      .toHaveAttribute("data-open", "");
  });
}
