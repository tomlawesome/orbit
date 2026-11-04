import { expect, test } from "@playwright/test";

import { signedIn } from "./a11y-support.js";

/*
 * #1467 (quick-add drawer: the type buttons under the north star do nothing).
 *
 * The north star opens the quick-add drawer on the desk's home. Its controls
 * are close, renewal, service, inspection, "something else", the document drop
 * box and "open the full form", so the issue's "four buttons" are three types
 * plus "Something else". Choosing a type must open Add (`/create`) with that
 * type already chosen; "Something else" opens Add with no type chosen.
 *
 * "Chosen" is read as v19-create.spec.js reads it on the Add form:
 * `#types button[data-type="<type>"]` carries `aria-pressed="true"`.
 *
 * Desk only: the north star's drawer is the desk's; the pocket creates from
 * its own sheet and has no drawer to choose a type in. Moved from tests/e2e
 * (ADR-0039, #1611); the reader is `/home rest`, nothing is seeded.
 */
test.skip(({ isMobile }) => isMobile, "the north star's drawer is the desk's; the pocket creates from its own sheet");

const SETTLE = 20_000;

/* One test opens home three times, and each opening waits for the sky's motion
   to settle by a counted number of frames (settle, finiteMotionSettled). The
   sky draws about 5 frames a second on WebKit's software renderer, so the
   third opening ran past the 30 s default (job 44851, #1615, #1611). */
test.describe.configure({ timeout: 120_000 });

/** The types the drawer offers, beside "Something else" (Add carries more chips; the drawer holds these three). */
const ADD_TYPES = /** @type {const} */ (["service", "renewal", "inspection"]);

/** Home, live, with the quick-add drawer open from the north star. @param {import("@playwright/test").Page} page */
async function openQuickAdd(page) {
  await signedIn("/home", "rest")(page);
  await page.locator("#nstar").click();
  await expect(page.locator("#createdrawer")).toHaveClass(/\bopen\b/);
  await expect(page.locator("#nstar")).toHaveAttribute("aria-expanded", "true");
}

/** What the drawer offers for a type: a control inside the drawer (other than the document drop box) whose label starts with the type's word, or that is marked `data-type`.
 * @param {import("@playwright/test").Page} page @param {string} type */
function drawerTypeControl(page, type) {
  const drawer = page.locator("#createdrawer");
  const label = new RegExp(`^[^a-z]*(?:an?\\s+)?${type}\\b`, "i");
  return drawer
    .locator(":is(button, a[href], [role=button]):not(#cdrop)")
    .filter({ hasText: label })
    .or(drawer.locator(`[data-type="${type}"]`));
}

/** The names of every control the drawer holds, for a failure message. @param {import("@playwright/test").Page} page */
async function drawerControlNames(page) {
  return page.locator("#createdrawer :is(button, a[href], [role=button])").evaluateAll((els) =>
    els.map((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim()));
}

/** Add is open: its path is /create and its form is live. @param {import("@playwright/test").Page} page @param {string} why */
async function expectAddOpen(page, why) {
  await expect(page, why).toHaveURL(/\/create(\?.*)?$/);
  await page.locator("#card[data-ready]").waitFor({ state: "attached", timeout: SETTLE });
}

test("each of the drawer's type buttons (service, renewal, inspection) opens Add with that type chosen", async ({ page }) => {
  for (const type of ADD_TYPES) {
    await test.step(`the drawer's "${type}" button`, async () => {
      await openQuickAdd(page);
      const control = drawerTypeControl(page, type);
      await expect(control).toHaveCount(1);
      await control.click();

      /* Add opens (the bug: nothing happens, home stays) ... */
      await expect.soft(page, `clicking "${type}" in the drawer did not open Add`).toHaveURL(/\/create(\?.*)?$/);
      await page.locator("#card[data-ready]").waitFor({ state: "attached", timeout: SETTLE }).catch(() => {});
      /* ... with that type, and only that type, chosen */
      await expect.soft(page.locator(`#types button[data-type="${type}"]`)).toHaveAttribute("aria-pressed", "true");
      await expect.soft(page.locator('#types button[aria-pressed="true"]')).toHaveCount(1);
    });
  }
});

test("the drawer's \"Something else\" opens Add with no type chosen", async ({ page }) => {
  await openQuickAdd(page);

  const somethingElse = page
    .locator("#createdrawer")
    .locator(":is(button, a[href], [role=button])")
    .filter({ hasText: /something else/i });
  await expect(somethingElse, `no "Something else" in the drawer; it holds ${JSON.stringify(await drawerControlNames(page))}`)
    .toHaveCount(1);
  await somethingElse.click();

  await expectAddOpen(page, 'clicking "Something else" in the drawer did not open Add');
  /* five chips, none chosen */
  await expect(page.locator("#types button")).not.toHaveCount(0);
  await expect(page.locator('#types button[aria-pressed="true"]')).toHaveCount(0);
});
