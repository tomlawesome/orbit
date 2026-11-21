import { expect, test } from "@playwright/test";

import { APP, onPhone, settle } from "./a11y-support.js";
import { guardedRoute } from "./workspace-writes.js";

/*
 * #1727 W-S1 (owner answer 116a, note 53804), desk and phone: Settings > mail (the relay tab),
 * the sender check row of a verified sender whose last forward was unsigned
 * reads "checked · your last forward wasn't signed, so it wasn't kept · see why",
 * and "see why" leads to the inbox showing the unsigned failure row.
 *
 * The fixture's relay has a checked sender but no unsigned forward, and its
 * inbox has no `sender_unsigned` row, so this test answers both reads itself
 * (the relay read with `lastForwardSigned: false`, the inbox read with the
 * failed receipt the engine gives for that code, review-state.ts). The inbox
 * has no way to point at one row, so the link is only asked to land on the
 * inbox, where the row is shown. End states only.
 */
test.use({ baseURL: APP, serviceWorkers: "block" });

const WORDS = "checked · your last forward wasn't signed, so it wasn't kept · see why";
const FAILURE_START = "Orbit could not confirm this came from you";
const UNSIGNED_RECEIPT = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "failed",
  householdId: null,
  draftVersion: 1,
  receivedAt: "2026-08-12T09:30:00.000Z",
  expiresAt: "2026-09-26T12:00:00.000Z",
  attachmentCount: 0,
  classification: "unavailable",
  canApprove: false,
  canDiscard: true,
  message: "Orbit could not confirm this came from you, so it was not kept. Your mail service did not sign it (DKIM). Send it again from a service that signs, or ask whoever runs your mail domain to turn signing on.",
  reason: "not_kept",
  metadataStatus: null,
  proposal: {},
  fieldEvidence: {},
};

test("settings mail: the unsigned-forward row reads the new words and `see why` leads to the unsigned failure row", async ({ page }, testInfo) => {
  await page.route("**/api/settings/mail-relay", guardedRoute(async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const body = await response.json();
    body.relay = {
      ...body.relay,
      listening: "connected · listening",
      sender: { address: "ned.harlow@example.test", verified: true, verificationPending: false, expiresAt: null, lastForwardSigned: false },
    };
    return route.fulfill({ response, json: body });
  }));
  await page.route("**/api/imap-inbox", guardedRoute(async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const body = await response.json();
    body.receipts = [...body.receipts, UNSIGNED_RECEIPT];
    return route.fulfill({ response, json: body });
  }));

  /* The relay lives in Settings now (#1509): #mail opens the relay tab on desk and
     phone, and it draws the relay's own sender, the one answered above. */
  await page.goto("/settings#mail");
  await settle(page);

  const row = page.locator(".kv, .rl-field").filter({ hasText: "sender check" }).filter({ visible: true }).first();
  await expect(row).toBeVisible();
  await expect(row).toHaveText(new RegExp(WORDS.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/ /gu, "\\s+")));

  const link = row.getByRole("link", { name: "see why" });
  await expect(link).toBeVisible();
  /* Keyboard reachable, as the row's other links are. */
  await link.focus();
  await expect(link).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/inbox(\?|#|$)/u);
  /* The desk draws the failed card with its words; the phone folds the same row (words
     on opening) under its receipt id. */
  const failureRow = onPhone(testInfo)
    ? page.locator(`.pk-inbox [data-row-key="${UNSIGNED_RECEIPT.id}"]`)
    : page.locator(".inbox-page .failed").filter({ hasText: FAILURE_START });
  await expect(failureRow.filter({ visible: true })).toHaveCount(1);
});
