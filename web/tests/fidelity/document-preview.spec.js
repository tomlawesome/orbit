import { expect, test } from "@playwright/test";

import { APP, SIGNED_IN } from "./pocket-states.js";

/*
 * #1141: with ORBIT_FIXTURES=1, `GET /api/documents/<id>/preview` had no
 * fixture answer (`web/src/lib/server/api.js`'s `fixture` option), so it
 * fell through to the real engine and 500'd. belt.js's
 * `documentPreviewStateOf` only asks the endpoint once a document's own
 * metadata already says "available" (stored, scanned clean, a supported
 * media type) -- the honest states (scanning, removed, refused,
 * undrawable) never call it at all -- so this was the ONE path a fixture
 * document ever reached the endpoint on, and it always came back as
 * "Orbit could not draw a picture of this document", whatever the document
 * actually was.
 *
 * Both fixture documents on i-mot (MOT certificate 2025, Service history)
 * are ready, clean and application/pdf -- the "available" state -- so
 * either proves this; the desk check opens the first, the phone check opens
 * whichever the shared pocket-states.js reach already picks.
 */

const DESK = { width: 1600, height: 1000 };
const PHONE = { width: 390, height: 844 };

/** @param {import("@playwright/test").Page} page */
async function openDeskPaper(page) {
  await page.goto(`${APP}/item/i-mot`, { waitUntil: "load" });
  /* The gate's own settle for this screen (belt-seat-focus-ring.spec.js,
     belt-chrome-viewport.spec.js): the band has its seats and the apex has
     its card, both of which arrive client-side. */
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#seats .seat").length > 0
      && Boolean(document.querySelector(".item-card h2")),
  );
  /* i-mot is the page's own selected item, so its papers are already
     bloomed out and clickable (band.js bloomTargetsOf) -- no need to centre
     it first. A document is never the centred body (owner-decisions.md
     §18), so its own seat carries the full document name in its aria-label
     (belt.behaviour.js buildSeats). */
  /* `force: true`: a document's own mark (the ring + halo, belt.css
     `.halo`/`.ring`) breathes forever by design (§"THE DOCUMENTS' MARK"),
     which keeps the seat's own bounding box gently pulsing too -- nothing
     to wait out, so the stability check a plain click waits for never
     passes. */
  await page.locator('#seats .seat .hit[aria-label^="MOT certificate 2025"]').click({ force: true });
}

test(`a paper's page loads on the fixture item page at desk (${DESK.width}x${DESK.height})`, async ({ page }) => {
  await page.setViewportSize(DESK);
  await openDeskPaper(page);
  /* `.snap` is only added once `previewShowing` is true: the state is
     "available", the image has loaded without erroring, and the reticle's
     beat has finished (+page.svelte). Before the fix the endpoint 500'd, the
     <img> fired `onerror`, and the card was stuck on the "could not draw a
     picture" honest state instead -- `.snap` never arrived. */
  await expect(
    page.locator("#readcard.snap"),
    "the reading card never reached its loaded page -- it is stuck on an honest state (see #readcard .focusline)",
  ).toBeVisible({ timeout: 5000 });
});

test(`a paper's page loads on the fixture item page on a phone (${PHONE.width}x${PHONE.height})`, async ({ page }) => {
  await page.setViewportSize(PHONE);
  /* Same route pocket-review-shots.spec.js's screenshot set walks: open the
     item's documents sheet, then its first row. That reach waits for
     either `.bp-page.shown` (loaded) or `.bp-honest` (an honest state) --
     this test is what actually tells the two apart. */
  const state = SIGNED_IN.find((s) => s.route === "/item/i-mot" && s.state === "document-preview");
  if (!state) throw new Error("pocket-states.js lost the item's document-preview state");
  await state.reach(page);
  await expect(
    page.locator(".bp-page.shown"),
    "the phone sheet never showed the loaded page -- it is stuck on an honest state (see .bp-honest)",
  ).toBeVisible({ timeout: 5000 });
});
