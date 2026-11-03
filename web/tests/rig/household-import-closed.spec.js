import { expect, test } from "@playwright/test";

import { APP, onPhone, signedIn } from "./a11y-support.js";

/*
 * WHILE A HOUSEHOLD IMPORT RUNS ONLY THAT HOUSEHOLD IS CLOSED (#1316), moved to
 * the rig (ADR-0039, #1611) from tests/e2e/household-import-closed.spec.ts.
 *
 * Its owner is bringing an archive in; the household's other members see a
 * plain "closed for a moment" screen and the households they belong to besides
 * stay open. The fixture's `import-closed` scene closes Harlow Home for this
 * browser, so the screens are read without a database or a start record.
 *
 * The closed household CARRIES the sample's items (the real server sends none,
 * tests/integration/household-access-gate.test.ts), so "shows none of it" fails
 * if the screen draws what it was handed. The importer's view (d) and the
 * household opening again once the start record closes (e) are read here in a
 * browser too; the gate's own answers for both stay in that integration file.
 * The 409 moved earlier (#1612).
 */
test.use({ baseURL: APP });

const CLOSED = "Harlow Home is closed for a moment";
const MOT = "Car MOT — Volvo V60";

/** The Car MOT's row on home, desk or pocket: what an open household lists and a closed one withholds.
 * @param {import("@playwright/test").Page} page */
const motRow = (page) => page.locator('[id="i-mot"], [data-row-key="i-mot"]');

test("a. the member's home says the household is closed for a moment and shows none of it", async ({ page }) => {
  await signedIn("/home", "import-closed")(page);

  await expect(page.getByRole("heading", { name: CLOSED })).toBeVisible();
  /* Home draws both layouts and CSS shows one, so the notice is in the page twice. */
  await expect(page.getByText("Its owner is bringing an archive in.").filter({ visible: true })).toBeVisible();
  /* The fixture hands this closed household its items (the real server sends
     none), so the screen is what withholds them. Home's chart and strip draw
     from the workspace whatever they are told; the list the notice stands in
     place of is what is asked. */
  await expect(motRow(page)).toHaveCount(0);
  /* The fixture reader belongs to other households besides, and they are open. */
  await expect(page.getByText("Your other households are open as usual.").filter({ visible: true })).toBeVisible();
});

test("c. the household's own screen shows the same heading and a back-to-home link that fits the phone", async ({ page }, testInfo) => {
  await signedIn("/household/hh-harlow-1", "import-closed")(page);

  await expect(page.getByRole("heading", { name: CLOSED })).toBeVisible();
  const back = page.getByRole("link", { name: /back to home/i });
  await expect(back).toBeVisible();
  /* The household's own screen: its sections and their items are not drawn. */
  await expect(page.locator("main")).not.toContainText(MOT);
  await expect(page.locator("main")).not.toContainText("Vehicles");

  if (onPhone(testInfo)) {
    const box = await back.boundingBox();
    expect(box?.height ?? 0, "the back-to-home link is at least 44px tall on the phone").toBeGreaterThanOrEqual(44);
    const viewport = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(viewport.scrollWidth).toBe(viewport.clientWidth);
  }
});

test("d. the importer is not shut out: their home still shows the item", async ({ page }) => {
  /* The importer's workspace is the household as it is: no scene closes it. */
  await signedIn("/home", "rest")(page);

  await expect(motRow(page).first()).toBeAttached();
  await expect(page.getByRole("heading", { name: CLOSED })).toHaveCount(0);
});

test("e. when the start record is closed the household opens again for the member", async ({ page }) => {
  await signedIn("/home", "import-closed")(page);
  await expect(page.getByRole("heading", { name: CLOSED })).toBeVisible();
  await expect(motRow(page)).toHaveCount(0);

  /* The record closes: the server stops sending the household as closed, which
     here is the browser no longer asking for the scene. */
  await page.context().clearCookies({ name: "orbit-fixture-scenes" });
  await page.reload({ waitUntil: "load" });

  await expect(motRow(page).first()).toBeAttached();
  await expect(page.getByRole("heading", { name: CLOSED })).toHaveCount(0);
});
