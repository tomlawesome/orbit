import { expect, test } from "@playwright/test";

import { APP, onPhone, signedIn } from "./a11y-support.js";

/*
 * THE REMINDERS CARD'S SECOND TAB (#1003), moved to the rig (ADR-0039, #1611)
 * from tests/e2e/settings-notification-history.spec.ts.
 *
 * A member sees their own last five attempted deliveries, plainly, on both
 * dialects: newest first, a failed send says it "couldn't send" with the plain
 * reason, a clean one does not. The fixture answers /api/settings/sent
 * with five rows (SENT_LATELY_FIXTURE), so no deliveries are seeded.
 *
 * Not here: that a stored category code (`smtp_unconfigured`) never reaches the
 * screen. The fixture's rows already carry the plain sentence, so the mapping is
 * not in the page; it is the notification-history module's own, in
 * src/server/notification-history.ts and its tests.
 */
test.use({ baseURL: APP });

test("a member sees their own last sent reminders, plainly, on both dialects", async ({ page }, testInfo) => {
  const phone = onPhone(testInfo);
  await signedIn("/settings", "any-dialect")(page);

  const scope = phone ? page.locator(".st-pocket") : page.locator(".helm-page");
  await scope.getByRole("tab", { name: "sent to you lately" }).click();
  const panel = scope.getByRole("tabpanel", { name: "sent to you lately" });
  await expect(panel).toBeVisible();

  /* Newest first: the push that is being retried, then a clean send, then the
     failed email. Five rows, the card's whole list. */
  const rows = panel.locator("a", { hasText: /Smoke alarm batteries|Car MOT|Boiler service|Gutter clearing/ });
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toContainText("Smoke alarm batteries");
  await expect(rows.nth(4)).toContainText("Gutter clearing");

  /* Where a row says how its send went: inside the row's link on the desk; on
     the pocket dialect, in the line the kit draws under the row (Row.svelte's
     `below`), which is the next sibling of the row, not part of its link. */
  const outcome = (/** @type {number} */ index) => phone
    ? panel.locator(".p-row").nth(index)
      .locator("xpath=following-sibling::*[1][contains(concat(' ', normalize-space(@class), ' '), ' p-row-below ')]")
    : rows.nth(index);
  await expect(outcome(0)).toContainText("your phone was offline");
  await expect(outcome(2)).toContainText("couldn’t send");
  await expect(outcome(2)).toContainText("mail isn’t set up on this Orbit");
  await expect(outcome(1)).not.toContainText("couldn’t send");
  await expect(outcome(3)).not.toContainText("couldn’t send");
  await expect(rows.nth(2)).not.toContainText("smtp_unconfigured");

  /* The row leads to the item's drawer on home (#1319). */
  const href = await rows.nth(1).getAttribute("href");
  expect(href).toMatch(/^\/home\?item=/);
  if (href === null) throw new Error("the first row has no link");
  await rows.nth(1).click();
  await expect(page).toHaveURL(new RegExp(`${href.replace("?", "\\?")}$`));
  const itemId = href.split("item=")[1];
  if (phone) {
    await expect(page.locator(`.pocket .pk-below [data-row-key="${itemId}"]`)).toHaveAttribute("data-open", "");
  } else {
    await expect(page.locator(`[id="${itemId}-view"]`)).toBeVisible();
  }
});
