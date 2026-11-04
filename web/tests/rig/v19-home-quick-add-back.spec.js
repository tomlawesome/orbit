import { expect, test } from "@playwright/test";

import { signedIn } from "./a11y-support.js";

/*
 * #1467, going Back from Add. A type pressed in the quick-add drawer is
 * carried to Add; leaving Add untouched must not ask "Discard this entry?" (the
 * carried type is not typing), and a type held from an earlier press must not
 * carry over to the next Add opened from "Something else".
 *
 * Desk only, as v19-home-quick-add-types.spec.js: the north star's drawer is
 * the desk's. Moved from tests/e2e (ADR-0039, #1611); the reader is
 * `/home rest`, nothing is seeded.
 */
test.skip(({ isMobile }) => isMobile, "the north star's drawer is the desk's; the pocket creates from its own sheet");

const SETTLE = 20_000;

/** On home as it stands (no reload): the drawer opened from the north star. @param {import("@playwright/test").Page} page */
async function openDrawerHere(page) {
  await page.locator("#nstar").click();
  await expect(page.locator("#createdrawer")).toHaveClass(/\bopen\b/);
}

/** A control in the drawer by its label (close, renewal, service, inspection, something else, the drop box and "open the full form").
 * @param {import("@playwright/test").Page} page @param {RegExp} label */
function drawerControl(page, label) {
  return page.locator("#createdrawer").locator(":is(button, a[href], [role=button])").filter({ hasText: label });
}

/** @param {import("@playwright/test").Page} page @param {string} why */
async function addIsOpen(page, why) {
  await expect(page, why).toHaveURL(/\/create(\?.*)?$/);
  await page.locator("#card[data-ready]").waitFor({ state: "attached", timeout: SETTLE });
}

/** Any "Discard this entry?" asking, native or drawn in the page. @param {import("@playwright/test").Page} page */
function watchForDiscardQuestion(page) {
  /** @type {string[]} */
  const asked = [];
  page.on("dialog", (dialog) => {
    asked.push(`native ${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss().catch(() => {});
  });
  return asked;
}

/** @param {import("@playwright/test").Page} page @param {string[]} asked */
async function expectNoDiscardQuestion(page, asked) {
  /* The question, if there is one, comes on the Back itself, before it
     completes. Back has landed on home (the callers wait for its address);
     wait for home to be live and the page to draw its frames, so the absence is
     judged after the Back was handled, not after a guess at how long that takes. */
  await page.waitForSelector("body[data-home-ready]", { timeout: SETTLE });
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  expect(asked, "Back from an untouched Add asked a question").toEqual([]);
  await expect(page.getByText(/discard this entry/i), "Back from an untouched Add drew a discard question").toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
}

test("a type pressed in the drawer, nothing typed on Add, then Back: home, and no \"Discard this entry?\"", async ({ page }) => {
  const asked = watchForDiscardQuestion(page);
  await signedIn("/home", "rest")(page);
  await openDrawerHere(page);

  await drawerControl(page, /^[^a-z]*renewal\b/i).click();
  await addIsOpen(page, 'pressing "renewal" in the drawer did not open Add');
  await expect(page.locator('#types button[data-type="renewal"]')).toHaveAttribute("aria-pressed", "true");

  await page.goBack();
  await expect(page, "Back from Add did not return to home").toHaveURL(/\/home$/);
  await expectNoDiscardQuestion(page, asked);
});

test("a type held from an earlier press does not carry over to Add opened from \"Something else\"", async ({ page }) => {
  const asked = watchForDiscardQuestion(page);
  await signedIn("/home", "rest")(page);
  await openDrawerHere(page);

  await drawerControl(page, /^[^a-z]*service\b/i).click();
  await addIsOpen(page, 'pressing "service" in the drawer did not open Add');
  await expect(page.locator('#types button[data-type="service"]')).toHaveAttribute("aria-pressed", "true");

  await page.goBack();
  await expect(page, "Back from Add did not return to home").toHaveURL(/\/home$/);
  await expectNoDiscardQuestion(page, asked);

  await openDrawerHere(page);
  await drawerControl(page, /something else/i).click();
  await addIsOpen(page, 'pressing "Something else" in the drawer did not open Add');
  await expect(page.locator("#types button")).not.toHaveCount(0);
  await expect(
    page.locator('#types button[aria-pressed="true"]'),
    "the earlier press's type carried over to Add opened from Something else",
  ).toHaveCount(0);
});
