import { expect, test } from "@playwright/test";

import { APP, onPhone, RIG_EXPECT_MS, signedIn } from "./a11y-support.js";
import { completeLikeTheEngine, ownWorkspace, upsertCheckingTheVersion } from "./workspace-writes.js";

/** @typedef {import("@playwright/test").Page} Page */

/*
 * #455, moved to the rig (ADR-0039, #1611) from tests/e2e/v19-item-actions.spec.ts:
 * the item view's writes, completed through the home drawer, with the new orbit
 * visible back on home.
 *
 * #1319 (owner-decisions section 34): the belt that was "the v19 view" retired;
 * these act through the item's home drawer, which `/home?item=<id>` opens.
 *
 * The stack suite seeded a household and an item through the command API; here
 * the item is the fixture's Boiler service (Harlow Home, due 2026-09-04, today
 * being 2026-08-13, yearly), and the writes are the test's own (ownWorkspace):
 * the command that was sent is what is asserted of the engine, and the screen is
 * judged on what it makes of the answer. Reduced motion, as v19-home-drawer
 * does for the same drawer.
 */
test.use({ reducedMotion: "reduce", baseURL: APP });

const HOUSEHOLD = "hh-harlow-1";
const ITEM = { id: "i-boiler", title: "Boiler service" };

/** The item's home drawer, which its address opens: the desk's view under the row, the phone's open row.
 * @param {Page} page @param {string} id */
const drawerOf = (page, id) => (onPhone(test.info()) ? page.locator(`.pocket .pk-below [data-row-key="${id}"]`) : page.locator(`[id="${id}-view"]`));

/** @param {Page} page @param {string} id */
async function openDrawer(page, id) {
  await signedIn("/home", "rest")(page);
  await page.goto(`${APP}/home?item=${id}`, { waitUntil: "load" });
  await expect(page.locator("body[data-home-ready]")).toBeAttached();
  const drawer = drawerOf(page, id);
  if (onPhone(test.info())) await expect(drawer).toHaveAttribute("data-open", "", { timeout: RIG_EXPECT_MS });
  else await expect(drawer).toBeVisible({ timeout: RIG_EXPECT_MS });
  return drawer;
}

/* #1319: the belt's complete moved to the drawer's foot row, on the desk and
   the phone alike: complete asks for the date (today), the cost and the notes
   in the rows, record sends it at once (no held undo), and the next orbit is
   the engine's. */
test("completing an item from its home drawer moves its orbit", async ({ page }) => {
  const writes = await ownWorkspace(page, { "item.complete": completeLikeTheEngine });
  /* The stack's household held this one item. The fixture's Harlow Home holds
     others that need attention, which would keep the pocket's "nothing needs
     you" line from showing, so this test's own copy of the workspace keeps the
     Boiler service alone in the household. */
  const harlow = (await writes.workspace()).households.find((/** @type {{ id: string }} */ one) => one.id === HOUSEHOLD);
  harlow.items = harlow.items.filter((/** @type {{ id: string }} */ one) => one.id === ITEM.id);
  const pocket = onPhone(test.info());
  const drawer = await openDrawer(page, ITEM.id);
  // Due in 22 days: needs attention.
  await expect(pocket ? drawer : page.locator(`[id="${ITEM.id}"]`)).toContainText("T−22d");

  await drawer.getByRole("group", { name: `Actions for ${ITEM.title}` })
    .getByRole("button", { name: `Complete ${ITEM.title}` }).click();
  const completing = drawer.getByRole("group", { name: `Completing ${ITEM.title}` });
  await expect(completing.getByRole("button")).toHaveText(["record", "cancel"]);
  await completing.getByRole("button", { name: "record" }).click();
  await expect(page.getByText(new RegExp(`^Completed · next due .+ · ${ITEM.title}$`)).first()).toBeAttached();
  expect(writes.sent("item.complete").map((one) => [one.householdId, one.itemId])).toEqual([[HOUSEHOLD, ITEM.id]]);

  // A year of lead time now (allow the ±1 day of month arithmetic): the engine
  // counts the period from the day it was done, today, not from the old due date.
  // On a desk the row sits in the wide orbit; in the pocket dialect only
  // attention rows are listed, so the item is no longer among them, and the
  // line that says nothing needs you names it as next up.
  await page.goto(`${APP}/home`);
  if (pocket) {
    await expect(page.locator(".mdial svg")).toBeVisible();
    const below = page.locator(".pocket .pk-below");
    await expect(below.locator(".p-row .title", { hasText: new RegExp(`^${ITEM.title}$`) })).toHaveCount(0);
    await expect(below.locator(".p-row", { hasText: "nothing needs you" }))
      .toContainText(new RegExp(`next up ${ITEM.title}, T−36[456]d`), { timeout: RIG_EXPECT_MS });
  } else {
    await expect(page.locator(`[id="${ITEM.id}"]`)).toContainText(/T−36[456]d/, { timeout: RIG_EXPECT_MS });
  }
});

/* The belt's reschedule became the pencil's due date in the drawer's rows; any
   edit sends the item at the version the drawer read. A rival's change makes
   that stale, and the engine refuses it in its own words (409, "changed on
   another device"): said under the rows, and never written over the rival's
   change. */
test("a stale version is refused and the drawer says so", async ({ page }) => {
  const writes = await ownWorkspace(page, { "item.upsert": upsertCheckingTheVersion });
  const drawer = await openDrawer(page, ITEM.id);

  // Someone else reschedules while our drawer is open (the workspace this test
  // answers from moves on, at a fresh version) -- our copy is now stale.
  const held = (await writes.itemOf(ITEM.id))?.item;
  expect(held, "the fixture's Boiler service").toBeTruthy();
  held.dueDate = "2027-03-03";
  held.version += 1;

  await drawer.getByRole("button", { name: "Edit this item" }).click();
  await drawer.getByRole("textbox", { name: "provider" }).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Stale Services");
  const save = drawer.getByRole("group", { name: `Editing ${ITEM.title}` }).getByRole("button", { name: "save" });
  if (await save.isEnabled()) await save.click();

  // Refused in the engine's own words, and nothing written over the rival.
  await expect(drawer.getByRole("alert")).toContainText("changed on another device", { timeout: RIG_EXPECT_MS });
  const after = (await writes.itemOf(ITEM.id))?.item;
  expect(after.dueDate).toBe("2027-03-03");
  expect(after.provider).toBe("British Gas");

  // Refreshed, as the refusal asks, the drawer reads the truth.
  const reread = await openDrawer(page, ITEM.id);
  await expect(reread).toContainText("03 March 2027");
});
