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
 * Gone from here: the importer is not shut out, and the household opens again
 * when the start record closes -- the gate's own answers, in
 * tests/integration/household-access-gate.test.ts:208 (the importer's view is
 * unchanged), :235 and :272 (open again once the record is finished). The 409
 * moved earlier (#1612).
 */
test.use({ baseURL: APP });

const CLOSED = "Harlow Home is closed for a moment";

test("a. the member's home says the household is closed for a moment and shows none of it", async ({ page }) => {
  await signedIn("/home", "import-closed")(page);

  await expect(page.getByRole("heading", { name: CLOSED })).toBeVisible();
  /* Home draws both layouts and CSS shows one, so the notice is in the page twice. */
  await expect(page.getByText("Its owner is bringing an archive in.").filter({ visible: true })).toBeVisible();
  await expect(page.getByText("Car MOT — Volvo V60")).toHaveCount(0);
  /* The fixture reader belongs to other households besides, and they are open. */
  await expect(page.getByText("Your other households are open as usual.").filter({ visible: true })).toBeVisible();
});

test("c. the household's own screen shows the same heading and a back-to-home link that fits the phone", async ({ page }, testInfo) => {
  await signedIn("/household/hh-harlow-1", "import-closed")(page);

  await expect(page.getByRole("heading", { name: CLOSED })).toBeVisible();
  const back = page.getByRole("link", { name: /back to home/i });
  await expect(back).toBeVisible();
  await expect(page.getByText("Car MOT — Volvo V60")).toHaveCount(0);

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
