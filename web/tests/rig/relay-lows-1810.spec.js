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

/*
 * W-R1 (note 57316): a relay read that failed says so, and carries its own
 * `try again`, which re-reads the relay only. Not "no address yet", not an
 * address pill, not the status row, not the Sending addresses half.
 */
const NOT_READ = "not shown — Orbit could not reach your relay";
const ADD_BOX = "another address you send from";

/**
 * @param {Page} page
 * @param {{ failing: boolean }} state  the relay read answers 503 while `failing`
 */
async function openWithRelayState(page, state) {
  await page.route("**/api/settings/mail-relay**", (route) => {
    if (route.request().method() === "GET" && state.failing) {
      return route.fulfill({ status: 503, json: { error: { code: "relay_unavailable", message: "unavailable" } } });
    }
    return route.fulfill({ json: { relay: relayOf(OLD) } });
  });
  await page.goto(`${APP}/settings#mail`, { waitUntil: "load" });
  await settle(page);
}

/** @param {import("@playwright/test").Locator} card */
const readAlert = (card) => card.getByRole("alert").filter({ hasText: NOT_READ });
/** @param {import("@playwright/test").Locator} card */
const tryAgain = (card) => card.getByRole("button", { name: "try again", exact: true });

test.describe("W-R1: a failed relay read says so and retries by itself", () => {
  test("shows the alert line and a try again button, and none of the relay's own parts; the rest of Settings is drawn", async ({ page }, testInfo) => {
    await openWithRelayState(page, { failing: true });
    const card = mailCard(page, testInfo);
    await expect(readAlert(card)).toBeVisible();
    await expect(tryAgain(card)).toBeVisible();
    await expect(card.getByText(/no address yet/iu)).toHaveCount(0);
    await expect(card.getByText(OLD)).toHaveCount(0);
    await expect(card.getByText("status", { exact: true })).toHaveCount(0);
    await expect(card.getByText("Sending addresses", { exact: true })).toHaveCount(0);
    await expect(card.getByPlaceholder(ADD_BOX)).toHaveCount(0);
    await expect(card.getByRole("tab", { name: "reminders", exact: true }), "the rest of Settings is drawn").toBeVisible();
  });

  test("try again, once the relay answers, draws the address, the status row and Sending addresses, and the alert goes", async ({ page }, testInfo) => {
    const state = { failing: true };
    await openWithRelayState(page, state);
    const card = mailCard(page, testInfo);
    await expect(readAlert(card)).toBeVisible();
    state.failing = false;
    await tryAgain(card).click();
    await expect(card.getByText(OLD).first()).toBeVisible();
    await expect(card.getByText("status", { exact: true }).first()).toBeVisible();
    await expect(card.getByText("Sending addresses", { exact: true })).toBeVisible();
    await expect(card.getByPlaceholder(ADD_BOX)).toBeVisible();
    await expect(card.getByText(NOT_READ)).toHaveCount(0);
    /* The button went with the line, so focus moves to the status row, not the page body. */
    const focused = page.locator(":focus");
    await expect(focused).toContainText("status");
    await expect(focused).toContainText("connected · listening");
    await expect(focused).not.toContainText("Sending addresses");
  });

  test("when the retry fails again the alert line stays and has focus", async ({ page }, testInfo) => {
    await openWithRelayState(page, { failing: true });
    const card = mailCard(page, testInfo);
    await tryAgain(card).click();
    await expect(readAlert(card)).toBeVisible();
    await expect(readAlert(card)).toBeFocused();
  });

  test("on the phone the try again pill is at least 44px tall", async ({ page }, testInfo) => {
    test.skip(!onPhone(testInfo), "the phone's floor");
    await openWithRelayState(page, { failing: true });
    const box = await tryAgain(mailCard(page, testInfo)).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });
});

/*
 * W-S1/S2/S3 (note 57316): remove is arm, then tap again, as rotate is on the
 * same tab. The armed line says what is lost and how to come back.
 */
const WORK = "mira.h@work.example";
const ROW_ID = "row-work";
const COME_BACK = "to use it again, add it back and open a new check email";

/**
 * @param {Page} page
 * @param {{ heldMail?: number }} [options]
 * @returns {Promise<{ deletes: string[] }>}
 */
async function openWithExtraRow(page, { heldMail = 0 } = {}) {
  const seeded = relayOf(OLD).senders[0];
  const extra = { id: ROW_ID, address: WORK, source: "manual", verified: false, verificationPending: false, expiresAt: null, daysLeft: 9, heldMail };
  const served = { deletes: /** @type {string[]} */ ([]) };
  await page.route("**/api/settings/mail-relay**", (route) => {
    const request = route.request();
    if (request.method() === "DELETE") {
      served.deletes.push(new URL(request.url()).pathname);
      return route.fulfill({ json: { senders: [seeded] } });
    }
    return route.fulfill({ json: { relay: { ...relayOf(OLD), senders: [seeded, extra] } } });
  });
  await page.goto(`${APP}/settings#mail`, { waitUntil: "load" });
  await settle(page);
  return served;
}

/** The row's remove button before its first tap (the phone's name carries the address).  @param {import("@playwright/test").Locator} card @param {import("@playwright/test").TestInfo} testInfo */
const removeButton = (card, testInfo) => card.getByRole("button", { name: onPhone(testInfo) ? /^remove( mira\.h@work\.example)?$/iu : "remove", exact: !onPhone(testInfo) });
/** @param {import("@playwright/test").Locator} card @param {import("@playwright/test").TestInfo} testInfo */
const armedRemove = (card, testInfo) => card.getByRole("button", { name: onPhone(testInfo) ? `tap again to remove ${WORK}` : "tap again to remove", exact: true });
/** @param {import("@playwright/test").Locator} card */
const armedLine = (card) => card.getByRole("status").filter({ hasText: COME_BACK });

test.describe("W-S: remove is arm, then tap again", () => {
  test("one tap sends no DELETE, arms the button, and says how to come back", async ({ page }, testInfo) => {
    const served = await openWithExtraRow(page);
    const card = mailCard(page, testInfo);
    await removeButton(card, testInfo).click();
    await expect(armedRemove(card, testInfo)).toBeVisible();
    await expect(armedLine(card)).toBeVisible();
    expect(served.deletes).toEqual([]);
  });

  test("a second tap within 4 seconds sends the DELETE and the row leaves", async ({ page }, testInfo) => {
    const served = await openWithExtraRow(page);
    const card = mailCard(page, testInfo);
    await removeButton(card, testInfo).click();
    await armedRemove(card, testInfo).click();
    await expect(card.getByText(WORK)).toHaveCount(0);
    expect(served.deletes).toEqual([`/api/settings/mail-relay/senders/${ROW_ID}`]);
  });

  test("a tap elsewhere relaxes it, and no DELETE is sent", async ({ page }, testInfo) => {
    const served = await openWithExtraRow(page);
    const card = mailCard(page, testInfo);
    await removeButton(card, testInfo).click();
    await expect(armedRemove(card, testInfo)).toBeVisible();
    await card.getByText("Sending addresses", { exact: true }).click();
    await expect(removeButton(card, testInfo)).toBeVisible();
    await expect(armedLine(card)).toHaveCount(0);
    expect(served.deletes).toEqual([]);
  });

  test("Escape relaxes it, and no DELETE is sent", async ({ page }, testInfo) => {
    const served = await openWithExtraRow(page);
    const card = mailCard(page, testInfo);
    await removeButton(card, testInfo).click();
    await expect(armedRemove(card, testInfo)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(removeButton(card, testInfo)).toBeVisible();
    await expect(armedLine(card)).toHaveCount(0);
    expect(served.deletes).toEqual([]);
  });

  test("4 seconds relax it, and no DELETE is sent", async ({ page }, testInfo) => {
    const served = await openWithExtraRow(page);
    const card = mailCard(page, testInfo);
    await removeButton(card, testInfo).click();
    await expect(armedRemove(card, testInfo)).toBeVisible();
    await expect(removeButton(card, testInfo)).toBeVisible({ timeout: 7000 });
    await expect(armedLine(card)).toHaveCount(0);
    expect(served.deletes).toEqual([]);
  });

  test("a row carrying 2 held arrivals says they are lost for good", async ({ page }, testInfo) => {
    await openWithExtraRow(page, { heldMail: 2 });
    const card = mailCard(page, testInfo);
    await removeButton(card, testInfo).click();
    await expect(card.getByRole("status").filter({ hasText: `2 arrivals held for this address are lost for good · ${COME_BACK}` })).toBeVisible();
  });

  test("on the phone the remove pill is at least 44px tall", async ({ page }, testInfo) => {
    test.skip(!onPhone(testInfo), "the phone's floor");
    await openWithExtraRow(page);
    const box = await removeButton(mailCard(page, testInfo), testInfo).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });

  /* The one test on the phone's armed pill label. The owner may choose the
     longer "tap again to remove" (note 57316, open point 2); change this
     test alone if so. Default: the short label, as rotate's on this tab. */
  test("phone armed label: the pill reads 'tap again'", async ({ page }, testInfo) => {
    test.skip(!onPhone(testInfo), "the phone's pill label");
    await openWithExtraRow(page);
    const card = mailCard(page, testInfo);
    await removeButton(card, testInfo).click();
    /* ArmButton keeps both labels in the pill and crossfades them, so read the armed one. */
    await expect(armedRemove(card, testInfo).locator(".set")).toHaveText("tap again");
  });
});
