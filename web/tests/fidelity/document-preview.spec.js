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
 *
 * #1319 (owner-decisions §34): the belt that first showed these papers
 * retired; a paper is opened from its item's drawer on home, the preview
 * card beside it on a desk (lib/reading/PreviewCard.svelte) and the bottom
 * sheet on a phone. The checks are the same checks, on the drawer.
 */

const DESK = { width: 1600, height: 1000 };
const PHONE = { width: 390, height: 844 };

/** @param {import("@playwright/test").Page} page */
async function openDeskPaper(page) {
  /* The item's own address: the drawer opens on arrival, its papers listed
     once they have arrived client-side. */
  await page.goto(`${APP}/home?item=i-mot`, { waitUntil: "load" });
  const drawer = page.locator('[id="i-mot-view"]');
  const paper = drawer.getByRole("button", { name: "Open MOT certificate 2025" });
  await expect(paper).toBeVisible();
  /* Level the row a little below the page's 84px gutter, as the drawer's
     own e2e proof does, so the card's top has the row's top to sit level
     with rather than the gutter it is sticky at. */
  await page.locator('a.item[id="i-mot"]').evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 120));
  await paper.click();
  return { drawer, paper };
}

test(`a paper's page loads on the fixture item's drawer at desk (${DESK.width}x${DESK.height})`, async ({ page }) => {
  await page.setViewportSize(DESK);
  await openDeskPaper(page);
  /* `.snap` is only added once the page is showing: the state is
     "available", the image has loaded without erroring, and the reticle's
     beat has finished (PreviewCard.svelte). Before the fix the endpoint
     500'd, the <img> fired `onerror`, and the card was stuck on the "could
     not draw a picture" honest state instead -- `.snap` never arrived. */
  await expect(
    page.locator("[data-preview-card].snap"),
    "the preview card never reached its loaded page -- it is stuck on an honest state",
  ).toBeVisible({ timeout: 5000 });
  await expect(page.locator("[data-preview-card] .sheet img")).toHaveAttribute("alt", "Page one of MOT certificate 2025");
});

test.describe("on a phone", () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });
  test(`a paper's page loads on the fixture item's drawer on a phone (${PHONE.width}x${PHONE.height})`, async ({ page }) => {
    /* Same route pocket-review-shots.spec.js's screenshot set walks: open the
       MOT's row on home, then its first paper. That reach waits for the
       sheet to be up, loaded or not -- this test is what
       actually tells a loaded page from an honest state. */
    const state = SIGNED_IN.find((s) => s.route === "/home" && s.state === "document-preview");
    if (!state) throw new Error("pocket-states.js lost home's document-preview state");
    await state.reach(page);
    await expect(
      page.locator("[data-preview-card].snap"),
      "the phone sheet never showed the loaded page -- it is stuck on an honest state",
    ).toBeVisible({ timeout: 5000 });
  });
});

/*
 * Round 3's F (design/v19/belt-purpose/round-3/f-preview-beside-tracked.html,
 * LEVEL), which replaced the belt's levelling (4a314ac6, the reading card
 * centred on the item card): on a wide screen the preview is laid out as
 * the open item card's sibling, beside the drawer, its top level with the
 * item card's top.
 */
test(`the desk preview stands beside the drawer, its top level with the item card's (${DESK.width}x${DESK.height})`, async ({ page }) => {
  await page.setViewportSize(DESK);
  const { drawer, paper } = await openDeskPaper(page);
  const card = page.locator("[data-preview-card]");
  await expect(card).toHaveClass(/snap/, { timeout: 5000 });
  await expect(paper).toHaveAttribute("aria-current", "true");
  /* The card's own entrance has to finish before its box is the one it
     lands on. */
  await page.waitForFunction(
    () => document.getAnimations().every((a) => a.playState !== "running"
      || !Number.isFinite(Number(a.effect?.getComputedTiming().endTime))),
    null,
    { timeout: 3000 },
  ).catch(() => {});
  const [rowBox, cardBox, drawerBox] = await Promise.all([
    page.locator('a.item[id="i-mot"]').boundingBox(), card.boundingBox(), drawer.boundingBox(),
  ]);
  expect(Math.abs((cardBox?.y ?? 0) - (rowBox?.y ?? 0)), "the card's top is not level with the item card's").toBeLessThan(2);
  expect(cardBox?.x ?? 0, "the card is not beside the drawer").toBeGreaterThanOrEqual((drawerBox?.x ?? 0) + (drawerBox?.width ?? 0) - 1);
});
