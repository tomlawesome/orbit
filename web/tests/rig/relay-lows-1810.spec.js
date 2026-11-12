import { expect, test } from "@playwright/test";

import { APP, onPhone, settle } from "./a11y-support.js";

/** @typedef {import("@playwright/test").Page} Page */

/*
 * #1810 Lows, the two that need a browser (spec: note 57315).
 *
 * W-F7: the check email's landing ("address checked", or the refusal) is said
 * once, when the member arrives. Leaving the `your relay` tab and coming back
 * is not a new arrival, so it must not be said again.
 *
 * W-R2: a rotate whose response is lost, but which the server applied, must
 * not tell the member "your address is unchanged". Whatever the mechanism, the
 * screen ends up showing the address the server now holds.
 */
test.use({ baseURL: APP, serviceWorkers: "block" });

const OLD = "orbit+k7q2@harlow.example";
const NEW = "orbit+n3w9@harlow.example";
const MIRA = "mira.harlow@mailbox.example";

const relayOf = (/** @type {string} */ address) => ({
  address, listening: "connected · listening", lastReceivedLabel: "2 hours ago", ingest: "enabled",
  sender: { id: "row-seeded", address: MIRA, source: "account", verified: true, verificationPending: false, expiresAt: null, daysLeft: null },
  senders: [{ id: "row-seeded", address: MIRA, source: "account", verified: true, verificationPending: false, expiresAt: null, daysLeft: null }],
});

/**
 * @param {Page} page
 * @param {string} at
 * @param {{ loseRotateResponse?: boolean }} [options] the PUT is applied on the server, then the connection drops
 */
async function openSettings(page, at, { loseRotateResponse = false } = {}) {
  const server = { address: OLD };
  await page.route("**/api/settings/mail-relay**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/settings/mail-relay") {
      return route.fulfill({ json: { relay: relayOf(server.address) } });
    }
    if (request.method() === "PUT" && loseRotateResponse) {
      server.address = NEW;
      return route.abort("connectionreset");
    }
    return route.fulfill({ json: { relay: relayOf(server.address) } });
  });
  await page.goto(`${APP}${at}`, { waitUntil: "load" });
  await settle(page);
}

/** @param {Page} page @param {import("@playwright/test").TestInfo} testInfo */
const mailCard = (page, testInfo) => page.locator(onPhone(testInfo) ? "#p-mail" : "#mail");

/** @param {import("@playwright/test").Locator} card */
async function awayAndBack(card) {
  await card.getByRole("tab", { name: "reminders", exact: true }).click();
  await card.getByRole("tab", { name: "your relay", exact: true }).click();
}

test.describe("W-F7: the check email's landing is said once", () => {
  test("`address checked` is not said again after leaving the tab and coming back", async ({ page }, testInfo) => {
    await openSettings(page, "/settings?sender=verified");
    const card = mailCard(page, testInfo);
    await expect(card.getByText("address checked · your relay is listening")).toBeVisible();
    await awayAndBack(card);
    await expect(card.getByRole("tab", { name: "your relay", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(card.getByText("address checked · your relay is listening")).toHaveCount(0);
  });

  test("the refusal is not raised again after leaving the tab and coming back", async ({ page }, testInfo) => {
    await openSettings(page, "/settings?sender=unverified");
    const card = mailCard(page, testInfo);
    await expect(card.getByRole("alert")).toContainText("that link didn't work");
    await awayAndBack(card);
    await expect(card.getByRole("tab", { name: "your relay", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(card.getByText("that link didn't work")).toHaveCount(0);
  });
});

test.describe("W-R2: a rotate whose answer was lost but which applied", () => {
  test("shows the new address and never says the address is unchanged", async ({ page }, testInfo) => {
    await openSettings(page, "/settings#mail", { loseRotateResponse: true });
    const card = mailCard(page, testInfo);
    await card.getByRole("button", { name: /^rotate (your relay )?address$/iu }).click();
    await card.getByRole("button", { name: /^tap again to rotate( your relay address)?$/iu }).click();
    await expect(card.getByText(NEW).first(), "the address the server now holds is shown").toBeVisible();
    await expect(card.getByText(/your address is unchanged/u)).toHaveCount(0);
    await expect(page.getByText(/your address is unchanged/u)).toHaveCount(0);
  });
});
