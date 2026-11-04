import { expect, test } from "@playwright/test";
import { settle } from "./pocket-states.js";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * #1659: on the household page a member's display name and the OWNER badge
 * never overlap, at any width. A long two-word owner name wraps (or truncates)
 * in its own space, and the badge sits beside or below it. A layout fact, so
 * measured in a real browser: the line boxes of the name against the badge.
 */

const HOUSEHOLD = "/household/hh-harlow-1";
const OWNER_NAME = "Bartholomew Featherstonehaugh-Administrator";

const WIDTHS = [
  { label: "desktop 1280", viewport: { width: 1280, height: 800 } },
  { label: "narrow desktop 900", viewport: { width: 900, height: 800 } },
  { label: "phone 390", viewport: { width: 390, height: 844 } },
];

for (const { label, viewport } of WIDTHS) {
  test(`the owner's name and OWNER badge do not overlap at ${label}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route("**/api/households/*/members", (route) => route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        members: [
          { id: "u-fixture", displayName: OWNER_NAME, avatarUrl: null, role: "owner" },
          { id: "u-emma", displayName: "Emma Harlow", avatarUrl: null, role: "member" },
        ],
        candidates: [],
      }),
    }));
    await page.goto(`${APP}${HOUSEHOLD}`, { waitUntil: "load" });
    await settle(page);

    /* The desk page draws `.roster .memb` (b + .role); at 880px and under the
       pocket draws `.hh-members` rows (.title + .trail). Whichever is on
       screen is measured, by the line boxes the name's text really occupies. */
    const rects = await page.evaluate((name) => {
      const box = (/** @type {DOMRect} */ r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
      const kinds = [
        { row: ".roster .memb", name: "b", badge: ".role" },
        { row: ".hh-members [data-row]", name: ".title", badge: ".trail" },
      ];
      for (const k of kinds) {
        for (const row of document.querySelectorAll(k.row)) {
          const nameEl = row.querySelector(k.name);
          const badge = row.querySelector(k.badge);
          if (!nameEl || !badge || !nameEl.textContent?.includes(name)) continue;
          if (badge.getBoundingClientRect().width === 0) continue;
          const range = document.createRange();
          range.selectNodeContents(nameEl);
          return { lines: [...range.getClientRects()].filter((r) => r.width > 0).map(box),
            badge: box(badge.getBoundingClientRect()) };
        }
      }
      return null;
    }, OWNER_NAME);

    expect(rects, "the owner's member row, name and badge were not found").not.toBeNull();
    if (!rects) return;
    expect(rects.lines.length, "the name has no box").toBeGreaterThan(0);
    for (const line of rects.lines) {
      const overlaps = line.left < rects.badge.right && line.right > rects.badge.left
        && line.top < rects.badge.bottom && line.bottom > rects.badge.top;
      expect(overlaps, `the name's line ${JSON.stringify(line)} overlaps the OWNER badge ${JSON.stringify(rects.badge)}`).toBe(false);
    }
  });
}
