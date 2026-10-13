import { expect, test, type Page } from "@playwright/test";
import { settleArrival } from "./support/arrival";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { homeIsLive } from "./support/keyboard";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { answerPushWithoutAService } from "./support/webkit-push";

resetDatabaseBetweenSpecFiles();

/**
 * #1316 decision 26a: signing out of a provider session hands the provider
 * the ID token it issued (`id_token_hint`, OpenID Connect RP-Initiated Logout
 * 1.0 section 2) and the provider brings the browser back to Orbit's /logout.
 *
 * tests/oidc/server.mjs plays the provider the way Authentik behaves: its
 * end-session endpoint refuses a request without a hint it signed, and returns
 * the browser only to a /logout address. It also keeps a list of the calls it
 * received, read here through the browser (the suite reaches the provider only
 * the way a browser does, as the sign-in does).
 *
 * Motion is reduced so the descent does not lengthen the run; the hand-off
 * after it is the same. Run on a desktop and a mobile project.
 */

const READER = () => workerAccount("administrator");
const PROVIDER = "https://orbit-oidc:4443";

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
    return JSON.parse((await reader.locator("#records").textContent()) ?? "[]") as EndSessionCall[];
  } finally {
    await reader.close();
  }
}

async function signIn(page: Page) {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: READER() }).click();
  await ensureWorkerAdministrator(page);
  await settleArrival(page);
  await homeIsLive(page);
  const tour = page.locator("#orbit-tour-transport");
  if (await tour.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
    await expect(page.locator("#orbit-tour-veil")).toBeHidden();
  }
}

/** Opens whichever menu this layout draws (desk 901px and up, otherwise the phone's) and returns its sign-out control. */
async function signOutControl(page: Page, mobile: boolean) {
  if (!mobile) {
    await page.locator("button.orb").click();
    const menu = page.locator("#account");
    await expect(menu).toHaveClass(/open/);
    return menu.locator("button.signout");
  }
  await page.locator("#morb").click();
  const menu = page.locator('.p-sheet-layer:has(nav[aria-label="Go to"])');
  await expect(menu).toHaveClass(/open/);
  return menu.getByRole("button", { name: /sign out/ });
}

test("signing out of a provider session returns from the provider's sign-out page to /logout with the session's ID token", async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const mobile = info.project.name.startsWith("mobile");
  await signIn(page);
  const before = (await endSessionCalls(page)).filter((call) => call.sub === `oidc-test-w${process.env.TEST_PARALLEL_INDEX}-administrator`);

  await (await signOutControl(page, mobile)).click();

  /* The provider's page is not a place the reader stays: it answers with a
     redirect, and the journey ends where the goodbye is. */
  await expect(page, "sign-out never came back from the provider to /logout").toHaveURL(/\/logout$/, { timeout: 30_000 });
  expect(new URL(page.url()).origin, "the way back is Orbit's own /logout, not the provider's").not.toBe(PROVIDER);
  await expect(page.getByRole("link", { name: "Sign back in" })).toBeVisible({ timeout: 10_000 });

  const after = (await endSessionCalls(page)).filter((call) => call.sub === `oidc-test-w${process.env.TEST_PARALLEL_INDEX}-administrator`);
  expect(after.length - before.length, "the provider should have been sent exactly one sign-out request").toBe(1);
  const call = after[after.length - 1];
  expect(call.hintPresent, "the sign-out request carried no id_token_hint").toBe(true);
  expect(call.hintValid, "the id_token_hint was not an ID token the provider signed").toBe(true);
  expect(call.clientId).toBe("orbit-browser-tests");
  expect(new URL(call.postLogoutRedirectUri ?? "").pathname).toBe("/logout");

  const session = await page.evaluate(async () => {
    const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
    return (await response.json()) as { authenticated?: boolean };
  });
  expect(session.authenticated, "Orbit's own session should be over").toBeFalsy();
});
