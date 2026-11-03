import { expect, test } from "@playwright/test";

import { APP, onPhone, signedIn } from "./a11y-support.js";

/** @typedef {import("@playwright/test").Page} Page */
/** @typedef {import("@playwright/test").Locator} Locator */

/*
 * SETTINGS' OWN SIGN-OUTS (#1439), moved to the rig (ADR-0039, #1611) from
 * tests/e2e/settings-sign-out.spec.ts.
 *
 * The "this device" row and "sign out of every device" play the same goodbye as
 * the menu's sign-out and leave through the identity provider (#1316 9a): the
 * dusk arrives, the address becomes /logout, the browser is handed to the
 * provider's end-session address once and comes back to Orbit's own /logout
 * with "Sign back in". Nothing on the way asks for /login, which would walk
 * straight back in through the provider's single sign-on.
 *
 * The fixture app has no session and no provider. Each test answers the one
 * write it owns, the session revoke, with a provider end-session address on
 * a host that does not exist, and answers that address itself with the redirect
 * a provider sends back to /logout; what the page does with it is the product's.
 *
 * Not here, because they are not a browser's: that the provider is sent a
 * sign-out request carrying an id_token_hint it signed, and the post-logout
 * address it is given (tests/integration/auth-session-contracts.test.ts,
 * "answers a JSON sign-out with the provider's end-session address"), and that
 * Orbit's own session is over after it. Revoking ANOTHER device's row stays on
 * the stack, in tests/e2e/settings-sign-out.spec.ts, because "the other device's
 * session is over" needs a second real session.
 */
test.use({ baseURL: APP });

/** This device's row and "every device" end the session at these two (workspace.js revokeSession, signOutEverywhere). */
const REVOKES = /\/api\/auth\/sessions(\/[^/]+)?\/revoke$/u;
const PROVIDER_END_SESSION = "https://provider.example.test/end-session";

/**
 * The sign-out control on this device's row.
 * @param {Page} page @param {boolean} phone
 * @returns {Promise<Locator>}
 */
async function thisDeviceControl(page, phone) {
  if (phone) {
    const face = page.locator("section.st-sessions [data-row-face]").filter({ hasText: "this device" });
    await expect(face, "exactly one this-device row").toHaveCount(1);
    await face.click();
    const panel = page.locator(`[id="${await face.getAttribute("aria-controls")}"]`);
    const act = panel.locator("[data-row-acts] button").first();
    await expect(act).toBeVisible();
    await act.evaluate((el) => el.setAttribute("data-e2e-row", "target"));
    return page.locator('[data-e2e-row="target"]');
  }
  const control = page.locator('button[aria-label^="sign out of"]').filter({ visible: true });
  const marked = await control.evaluateAll((all) => {
    for (const one of all) one.removeAttribute("data-e2e-row");
    const here = all.filter((one) => {
      let row = one;
      while (row.parentElement && all.filter((c) => row.parentElement.contains(c)).length === 1) row = row.parentElement;
      return /this device/iu.test(row.textContent ?? "");
    });
    here.forEach((one) => one.setAttribute("data-e2e-row", "target"));
    return here.length;
  });
  expect(marked, "exactly one this-device row control").toBe(1);
  return page.locator('[data-e2e-row="target"]');
}

/**
 * The every-device button, pinned by an attribute: once armed its name changes
 * ("tap again to sign out everywhere"), so a locator by name would lose it
 * before the confirming press.
 * @param {Page} page
 */
async function everyDeviceControl(page) {
  const named = page.getByRole("button", { name: /sign out of every device/iu }).filter({ visible: true }).first();
  await named.evaluate((el) => el.setAttribute("data-e2e-every", "target"));
  return page.locator('[data-e2e-every="target"]');
}

/**
 * An armed control: the first press arms it, the second confirms (lib/arm.js,
 * every sign-out here). The second press waits for the control to show it is
 * armed -- the desk's buttons then read "tap again to ...", the phone's pills
 * take the `armed` class.
 * @param {Locator} control
 */
async function pressArmed(control) {
  await control.click();
  await expect.poll(
    () => control.evaluate((el) => el.classList.contains("armed") || /^\s*tap again/iu.test(el.textContent ?? "")),
    { message: "the first press armed the control" },
  ).toBe(true);
  await control.click();
}

const LEAVING = [
  { label: "this device's row", press: async (/** @type {Page} */ page, /** @type {boolean} */ phone) => pressArmed(await thisDeviceControl(page, phone)) },
  { label: "sign out of every device", press: async (/** @type {Page} */ page) => pressArmed(await everyDeviceControl(page)) },
];

for (const leaving of LEAVING) {
  test(`settings: ${leaving.label} plays the goodbye and leaves through the provider`, async ({ page }, info) => {
    const phone = onPhone(info);
    const logins = /** @type {string[]} */ ([]);
    page.on("request", (request) => {
      if (/\/login$/u.test(new URL(request.url()).pathname)) logins.push(request.url());
    });
    const signOuts = /** @type {string[]} */ ([]);
    let ended = false;
    /* A revoked session reads as none: the goodbye at /logout hands a live one on to home. */
    await page.route("**/api/auth/session", (route) => ended
      ? route.fulfill({ status: 401, json: { error: "unauthenticated" } })
      : route.fallback());
    await page.route(REVOKES, (route) => {
      signOuts.push(route.request().method());
      ended = true;
      return route.fulfill({ json: { redirectTo: PROVIDER_END_SESSION }, headers: { "cache-control": "no-store" } });
    });
    /* The provider's end-session address: it sends the browser back to Orbit's /logout. */
    const providerAsked = /** @type {string[]} */ ([]);
    await page.route(`${PROVIDER_END_SESSION}*`, (route) => {
      providerAsked.push(route.request().url());
      return route.fulfill({ status: 302, headers: { location: `${APP}/logout` } });
    });

    await signedIn("/settings", "any-dialect")(page);
    await leaving.press(page, phone);

    await expect.poll(() => page.evaluate(() => {
      const d = document.getElementById("dusk");
      return d ? getComputedStyle(d).opacity : "absent";
    }).catch(() => "navigating"), { message: "#1439: the dusk never arrived", timeout: 30_000 }).toBe("1");
    await expect(page, "#1439: the sign-out never came back from the provider to /logout").toHaveURL(/\/logout$/u, { timeout: 30_000 });
    expect(new URL(page.url()).origin, "the way back is Orbit's own /logout, not the provider's").toBe(new URL(APP).origin);
    await expect(page.getByRole("link", { name: "Sign back in" })).toBeVisible();

    expect(signOuts, "one sign-out was sent").toEqual(["POST"]);
    expect(providerAsked.length, "#1439: the browser should have been handed to the provider exactly once").toBe(1);
    expect(logins, "#1439: the sign-out asked for /login, which signs straight back in").toEqual([]);
  });
}
