import { expect, test } from "@playwright/test";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * #1036: on a phone there was no way to add an item.
 *
 * The desk's create handle is the north star above the dial, and the north
 * star lives inside `.desk` — pocket.css hides that whole subtree below
 * 901px/600px. So at 390x844 the north star and the drawer's "open the full
 * form →" link were both in the page and both unreachable, and the only
 * visible control was the account orb, whose sheet offered Inbox, Settings
 * and Administration. A pocket reader could only add an item by typing
 * /create into the address bar.
 *
 * The check is a reader's, not a selector's: walk from what is visible at
 * rest on /home to the create form, using only controls a thumb can reach.
 * Where the handle ends up living is free to move; that it exists is not.
 *
 * Here rather than in the e2e suite because this harness already stands up
 * the app with fixtures and needs no live instance, and because the pocket
 * dialect is a viewport away from the `mobile` screen the gate next door
 * photographs at the same 390-wide sheet.
 */

/*
 * #1120 (proposal §2.1, owner trial 8a) gave the pocket home its own north
 * star, fixed at the bottom right, and made the account menu the kit's hatch
 * (a dialog sheet) rather than `#maccount`. Both roads are walked below.
 */

const PHONE = { width: 390, height: 844 };

/** @param {import("@playwright/test").Page} page */
async function atHome(page) {
  await page.setViewportSize(PHONE);
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  /* The gate's own settle for the pocket: the dial is static chrome, so the
     galaxy having been placed is what says the workspace read has landed. */
  await page.waitForFunction(
    () => Boolean(document.querySelector(".mdial svg")) && document.querySelectorAll(".msys").length > 0,
  );
}

/** @param {import("@playwright/test").Page} page */
async function landedOnCreate(page) {
  await page.waitForURL("**/create");
  /* Landed on the form itself, not merely at the address: the create form is
     what the reader came for. At this width that is the pocket's own form
     (#1120, proposal §2.5); the desk's #card is hidden by the dialect switch. */
  await expect(page.locator("#pocket-entry")).toBeVisible();
}

test("a pocket reader can reach the create form from home by the north star", async ({ page }) => {
  await atHome(page);
  const star = page.locator(".pocket a.p-northstar");
  await expect(star, "the pocket home shows no north star at rest (#1120)").toBeVisible();
  await expect(star).toHaveAttribute("href", /\/create$/);
  await star.click();
  await landedOnCreate(page);
});

test("a pocket reader can reach the create form from home through the hatch", async ({ page }) => {
  await atHome(page);
  await page.locator("#morb").click();
  const hatch = page.getByRole("dialog");
  await expect(hatch).toBeVisible();
  const create = hatch.locator("a[href$='/create']");
  await expect(create, "the hatch offers no way to add an item (#1036)").toHaveCount(1);
  await create.click();
  await landedOnCreate(page);
});
