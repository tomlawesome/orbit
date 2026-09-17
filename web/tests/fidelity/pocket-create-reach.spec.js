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

const PHONE = { width: 390, height: 844 };

test("a pocket reader can reach the create form from home", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  /* The gate's own settle for the pocket: the dial is static chrome, so the
     galaxy having been placed is what says the workspace read has landed. */
  await page.waitForFunction(
    () => Boolean(document.querySelector(".mdial svg")) && document.querySelectorAll(".msys").length > 0,
  );

  /* What a thumb can actually see and press, before anything is opened. */
  const atRest = await page.evaluate(() =>
    [...document.querySelectorAll(".pocket a, .pocket button, .pocket input")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
      })
      .map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}`));
  expect(atRest, "the account orb is the pocket's only way into the chrome").toContain("button#morb");

  await page.locator("#morb").click();
  await expect(page.locator("#maccount")).toHaveClass(/open/);

  const create = page.locator("#maccount a[href$='/create']");
  await expect(create, "the pocket's account sheet offers no way to add an item (#1036)").toHaveCount(1);
  await create.click();
  await page.waitForURL("**/create");
  /* Landed on the form itself, not merely at the address: the create card is
     what the reader came for. */
  await expect(page.locator("#card")).toBeVisible();
});
