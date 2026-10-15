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
 * this one row control, and whether it says "this device". The list is read
 * after the page loads, so this waits for the row to be drawn. Sessions from
 * earlier tests in this file are still listed, so "another device" is the
 * first such row; "this device" must be exactly one.
 */
async function rowControl(page: Page, mobile: boolean, current: boolean): Promise<Locator> {
  if (mobile) return pocketRowControl(page, current);
  const mark = () => page.evaluate(({ mobile, current }) => {
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
        if (found === 0 || current) control.setAttribute("data-e2e-row", "target");
        found += 1;
      }
    }
    return found;
  }, { mobile, current });
  await expect.poll(mark, { message: `a ${current ? "this-device" : "other-device"} row is listed`, timeout: 30_000 }).toBeGreaterThan(0);
  if (current) expect(await mark(), "exactly one this-device row control").toBe(1);
  return page.locator('[data-e2e-row="target"]');
}

/**
 * The phone's version: each session is a row whose sign-out is an act in a
 * panel the row opens when tapped. The rows come current first, then most
 * recently seen, so "another device" is the newest other session.
 */
async function pocketRowControl(page: Page, current: boolean): Promise<Locator> {
  const faces = page.locator("section.st-sessions [data-row-face]");
  const wanted = current ? faces.filter({ hasText: "this device" }) : faces.filter({ hasNotText: "this device" });
  await expect(wanted.first(), `a ${current ? "this-device" : "other-device"} row is listed`).toBeVisible({ timeout: 30_000 });
  if (current) await expect(wanted, "exactly one this-device row").toHaveCount(1);
  const face = wanted.first();
  await face.click();
  const panel = page.locator(`[id="${await face.getAttribute("aria-controls")}"]`);
  const act = panel.locator("[data-row-acts] button").first();
  await expect(act).toBeVisible({ timeout: 10_000 });
  await act.evaluate((el) => el.setAttribute("data-e2e-row", "target"));
  return page.locator('[data-e2e-row="target"]');
}

/** How many sessions the page lists: the desk's row buttons, or the phone's rows. */
async function listedSessions(page: Page, mobile: boolean): Promise<number> {
  if (mobile) return page.locator("section.st-sessions [data-row-face]").count();
  return page.locator('button[aria-label^="sign out of"]').filter({ visible: true }).count();
}

/**
 * The every-device button, pinned by an attribute: once armed its name
 * changes ("tap again to sign out everywhere"), so a locator by name would
 * lose it before the confirming press.
 */
async function everyDeviceControl(page: Page): Promise<Locator> {
  const named = page.getByRole("button", { name: /sign out of every device/iu }).filter({ visible: true }).first();
  await named.evaluate((el) => el.setAttribute("data-e2e-every", "target"));
  return page.locator('[data-e2e-every="target"]');
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
  { label: "sign out of every device", press: async (page: Page) => pressArmed(await everyDeviceControl(page)) },
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
    /* Earlier tests here leave sessions behind, so the check is one row fewer, not one row left. */
    const listed = await listedSessions(page, mobile);
    await pressArmed(control);

    await expect(control, "#1439: the other device's row is still listed").toHaveCount(0, { timeout: 10_000 });
    await expect.poll(() => listedSessions(page, mobile), { message: "#1439: exactly that one row went", timeout: 10_000 }).toBe(listed - 1);
    await expect(page).toHaveURL(/\/settings$/u);
    await expect(page.locator("#dusk")).toHaveCount(0);
    expect(await signedIn(page), "this device must still be signed in").toBe(true);
    expect(await signedIn(other), "the other device's session should be over").toBe(false);
    expect((await endSessionCalls(page)).length - before, "#1439: the provider was asked to end a session").toBe(0);
    expect(logins).toEqual([]);
    // The page is still usable: everything on it is still there to press.
    await expect(await everyDeviceControl(page)).toBeEnabled();
  } finally {
    await elsewhere.close();
    if (!(await signedIn(page))) await signIn(page, "/home");
    await cleanupHousehold(page, await sessionHeaders(page), household.id, household.name);
  }
});
