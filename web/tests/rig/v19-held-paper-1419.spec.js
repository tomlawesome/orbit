import { expect, test } from "@playwright/test";

import { SETTLE } from "../../../tests/e2e/support/settle";
import { APP, onPhone } from "./a11y-support.js";

/*
 * #1419, the member's held view, desk and phone (direction P,
 * design/v19/held-paper/round-1). A paper held while the virus scanner is
 * down is pressed in its item's drawer (the open row on a phone). Its card
 * shows the held plate (`waiting`, the scan line parked, no sweep running),
 * the one line, and an empty foot.
 *
 * Fixture state this file uses, which the build adds beside REMOVED_PAPER
 * (PROVING_DOCUMENTS_FIXTURE, web/src/lib/data/fixtures/workspace.js):
 *   HELD_PAPER  a fifth document on item i-svc, "held-proving.pdf",
 *               lifecycle scanning, ready false, scanHeld true.
 */
test.use({ baseURL: APP });

const HELD_PAPER = { item: "i-svc", file: "held-proving.pdf" };
const HELD_LINE = "The scanner couldn't be reached, Admin have been notified";

test("a held paper's card shows the held plate and the line, and its foot is empty", async ({ page }, testInfo) => {
  await page.goto(`/home?item=${HELD_PAPER.item}`);
  const drawer = onPhone(testInfo)
    ? page.locator(`.pocket .pk-below [data-row-key="${HELD_PAPER.item}"]`)
    : page.locator(`[id="${HELD_PAPER.item}-view"]`);
  await expect(drawer).toBeVisible({ timeout: SETTLE });

  /* The row says `waiting`, not `scanning`. */
  const row = drawer.getByRole("button", { name: `Open ${HELD_PAPER.file}` });
  await expect(row).toBeVisible({ timeout: SETTLE });
  await expect(row).toContainText("waiting");
  await expect(row).not.toContainText("scanning");
  await row.click();

  const card = page.getByRole("dialog", { name: HELD_PAPER.file });
  await expect(card).toBeVisible();
  await expect(card.locator(".focusline")).toHaveText(HELD_LINE);

  /* The held plate: `waiting`, and nothing sweeping. */
  const plate = card.locator(".plate");
  await expect(plate).toHaveText("waiting");
  await expect(card.locator(".plate.scanning")).toHaveCount(0);
  const animations = await plate.evaluate((el) => ({
    plate: getComputedStyle(el).animationName,
    line: getComputedStyle(el, "::after").animationName,
  }));
  expect(animations, "no sweep runs on a held plate").toEqual({ plate: "none", line: "none" });

  /* Nothing to do with it: no page, no buttons, the foot says nothing. */
  await expect(card.locator(".sheet")).toHaveCount(0);
  await expect(card.locator(".rcfoot button")).toHaveCount(0);
  await expect(card.locator(".rcfoot")).toHaveText("");
});
