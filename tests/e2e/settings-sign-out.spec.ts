import { expect, test, type Locator, type Page } from "@playwright/test";
import { cleanupHousehold, sessionHeaders } from "./support/households";
import { seedHousehold, signIn, type Household } from "./support/signed-in";
import { resetDatabaseBetweenSpecFiles } from "./support/database";

resetDatabaseBetweenSpecFiles();

/**
 * #1439: settings' own sign-outs -- the "this device" row and "sign out of
 * every device" -- play the same goodbye as the menu's sign-out and leave
 * through the identity provider (#1316 9a), as sign-out-descent.spec.ts
 * (from /settings) and sign-out-provider-return.spec.ts check for the menu:
 * the dusk arrives, the address becomes /logout, the provider is sent one
 * end-session request carrying a hint it signed, and the browser comes back
 * to /logout with "Sign back in". Nothing on the way asks for /login, which
 * would walk straight back in through the provider's single sign-on.
 *
 * Revoking ANOTHER device's row only drops that row: the page stays at
 * /settings, usable, with no dusk, and the provider is asked nothing.
 *
 * Desk (desktop-chromium): the row's `button[aria-label^="sign out of"]` and
 * the "sign out of every device" button, each pressed twice (armed, then
 * confirmed). Phone (mobile-chromium): the row's act, "Sign out of ...
 * (this device)", and the every-device ArmButton.
 */

const PROVIDER = "https://orbit-oidc:4443";
const SUBJECT = () => `oidc-test-w${process.env.TEST_PARALLEL_INDEX}-administrator`;

interface EndSessionCall {
  clientId: string | null;
  hintPresent: boolean;
  hintValid: boolean;
  sub: string | null;
  postLogoutRedirectUri: string | null;
}

async function endSessionCalls(page: Page): Promise<EndSessionCall[]> {
  const reader = await page.context().newPage();
  try {
    await reader.goto(`${PROVIDER}/test/end-sessions`);
    const all = JSON.parse((await reader.locator("#records").textContent()) ?? "[]") as EndSessionCall[];
    return all.filter((call) => call.sub === SUBJECT());
  } finally {
    await reader.close();
  }
}

async function openSettings(page: Page): Promise<Household> {
  await signIn(page, "/home");
  const household = await seedHousehold(page, "settings-sign-out");
  await page.goto("/settings");
  await page.waitForLoadState("load");
  return household;
}

async function signedIn(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const r = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
    return ((await r.json()) as { authenticated?: boolean }).authenticated === true;
  }).catch(() => false);
}

/**
 * The sign-out control on a session row, this device's or another's. The
 * row is found from the control upward: the widest ancestor holding only
 * this one row control, and whether it says "this device".
 */
async function rowControl(page: Page, mobile: boolean, current: boolean): Promise<Locator> {
  const marked = await page.evaluate(({ mobile, current }) => {
    const nameOf = (el: Element) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
    const all = mobile
      ? [...document.querySelectorAll("button, [role=button], a")]
        .filter((el) => /^sign out of/iu.test(nameOf(el)) && !/every device/iu.test(nameOf(el)))
      : [...document.querySelectorAll('button[aria-label^="sign out of"]')];
    const controls = all.filter((el) => el.getClientRects().length > 0);
    for (const control of controls) control.removeAttribute("data-e2e-row");
    let found = 0;
    for (const control of controls) {
      let row: Element = control;
      while (row.parentElement && controls.filter((c) => row.parentElement!.contains(c)).length === 1) row = row.parentElement;
      const says = /this device/iu.test(`${row.textContent ?? ""} ${nameOf(control)}`);
      if (says === current) {
        control.setAttribute("data-e2e-row", "target");
        found += 1;
      }
    }
    return found;
  }, { mobile, current });
  expect(marked, `exactly one ${current ? "this-device" : "other-device"} row control`).toBe(1);
  return page.locator('[data-e2e-row="target"]');
}

function everyDeviceControl(page: Page): Locator {
  return page.getByRole("button", { name: /sign out of every device/iu }).filter({ visible: true }).first();
}

/** An armed control: the first press arms it, the second confirms. A one-press control has gone by the second. */
async function pressArmed(control: Locator) {
  await control.click();
  if (await control.isVisible().catch(() => false)) {
    await control.click({ timeout: 5_000 }).catch(() => {});
  }
}

async function expectGoodbyeThroughProvider(page: Page, before: number, logins: string[]) {
  await expect.poll(() => page.evaluate(() => {
    const d = document.getElementById("dusk");
    return d ? getComputedStyle(d).opacity : "absent";
  }).catch(() => "navigating"), { message: "#1439: the dusk never arrived", timeout: 30_000 }).toBe("1");
  await expect(page, "#1439: the sign-out never came back from the provider to /logout").toHaveURL(/\/logout$/u, { timeout: 30_000 });
  expect(new URL(page.url()).origin, "the way back is Orbit's own /logout, not the provider's").not.toBe(PROVIDER);
  await expect(page.getByRole("link", { name: "Sign back in" })).toBeVisible({ timeout: 10_000 });

  const after = await endSessionCalls(page);
  expect(after.length - before, "#1439: the provider should have been sent exactly one sign-out request").toBe(1);
  const call = after[after.length - 1];
  expect(call.hintPresent, "the sign-out request carried no id_token_hint").toBe(true);
  expect(call.hintValid, "the id_token_hint was not an ID token the provider signed").toBe(true);
  expect(new URL(call.postLogoutRedirectUri ?? "").pathname).toBe("/logout");

  expect(await signedIn(page), "Orbit's own session should be over").toBe(false);
  expect(logins, "#1439: the sign-out asked for /login, which signs straight back in").toEqual([]);
}

function watchLogins(page: Page): string[] {
  const logins: string[] = [];
  page.on("request", (request) => {
    const address = new URL(request.url());
    if (/\/login$/u.test(address.pathname)) logins.push(request.url());
  });
  return logins;
}

const LEAVING = [
  { label: "this device's row", press: async (page: Page, mobile: boolean) => pressArmed(await rowControl(page, mobile, true)) },
  { label: "sign out of every device", press: async (page: Page) => pressArmed(everyDeviceControl(page)) },
];

for (const leaving of LEAVING) {
  test(`settings: ${leaving.label} plays the goodbye and leaves through the provider`, async ({ page }, info) => {
    test.setTimeout(180_000);
    const mobile = info.project.name.startsWith("mobile");
    const household = await openSettings(page);
    try {
      const before = (await endSessionCalls(page)).length;
      const logins = watchLogins(page);

      await leaving.press(page, mobile);

      await expectGoodbyeThroughProvider(page, before, logins);
    } finally {
      if (!(await signedIn(page))) await signIn(page, "/home");
      await cleanupHousehold(page, await sessionHeaders(page), household.id, household.name);
    }
  });
}

test("settings: signing out another device drops its row and stays on /settings", async ({ page, browser }, info) => {
  test.setTimeout(180_000);
  const mobile = info.project.name.startsWith("mobile");
  const household = await openSettings(page);
  const elsewhere = await browser.newContext();
  try {
    // A second device: the same reader, signed in from another browser.
    const other = await elsewhere.newPage();
    await signIn(other, "/home");
    await page.reload();
    await page.waitForLoadState("load");

    const before = (await endSessionCalls(page)).length;
    const logins = watchLogins(page);
    const control = await rowControl(page, mobile, false);
    await pressArmed(control);

    await expect(control, "#1439: the other device's row is still listed").toHaveCount(0, { timeout: 10_000 });
    await expect.poll(async () => {
      return page.evaluate(() => {
        const nameOf = (el: Element) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
        return [...document.querySelectorAll("button, [role=button], a")]
          .filter((el) => el.getClientRects().length > 0)
          .filter((el) => /^sign out of/iu.test(nameOf(el)) && !/every device/iu.test(nameOf(el))).length;
      });
    }, { message: "#1439: only this device's row should remain", timeout: 10_000 }).toBe(1);
    await expect(page).toHaveURL(/\/settings$/u);
    await expect(page.locator("#dusk")).toHaveCount(0);
    expect(await signedIn(page), "this device must still be signed in").toBe(true);
    expect(await signedIn(other), "the other device's session should be over").toBe(false);
    expect((await endSessionCalls(page)).length - before, "#1439: the provider was asked to end a session").toBe(0);
    expect(logins).toEqual([]);
    // The page is still usable: everything on it is still there to press.
    await expect(everyDeviceControl(page)).toBeEnabled();
  } finally {
    await elsewhere.close();
    if (!(await signedIn(page))) await signIn(page, "/home");
    await cleanupHousehold(page, await sessionHeaders(page), household.id, household.name);
  }
});
