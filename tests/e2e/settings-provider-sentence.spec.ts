import { expect, test, type Browser, type Page } from "@playwright/test";
import { settleArrival } from "./support/arrival";
import { cleanupHousehold, sessionHeaders } from "./support/households";
import { ensureLocalPassword } from "./support/local-credentials";
import { newestApprovalUid, waitForApprovalLink } from "./support/mail";
import { seedHousehold, signIn, type Household } from "./support/signed-in";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { workerAccount, workerEmail, workerFixturePassword } from "./support/worker-identity";

resetDatabaseBetweenSpecFiles();

/**
 * #1444: under "sign out of every device", settings adds that it "signs you
 * out of your sign-in provider in this browser only" -- true only when THIS
 * session came through the provider. A reader who signed in with a password
 * on an instance that also offers a provider has no provider token, nothing
 * goes to the provider, and the sentence is wrong for them.
 *
 *   · password session on a provider-enabled instance: the base sentence
 *     ("... signs Orbit out everywhere ...") is there, the provider part is not;
 *   · provider session on the same instance: the provider part is shown.
 *
 * The "not shown" check is paired with the base sentence being visible, so it
 * cannot pass on a page that has not drawn. Run on desk (desktop-chromium)
 * and phone (mobile-chromium); both need the acceptance stack, which has the
 * disposable OIDC provider (`scripts/test-e2e-local.sh`, and the `smoke` jobs
 * in CI) -- not the local-only profile, which has no provider to be offered.
 *
 * HOW A PASSWORD SESSION IS MADE ON THAT STACK: the administrator signs in
 * through the provider, is given a password through the real step-up
 * (`ensureLocalPassword`), signs out, then types the password on the door.
 * The acceptance stack has a mail relay, so the password alone buys a wait and
 * the emailed approval, pressed in another browser, opens the door
 * (second-factor.spec.ts walks the same path). That approval is one of the
 * five an account may have per hour (ADR-0027 section 8); this file spends one
 * per project.
 */

const READER = () => workerAccount("administrator");
const READER_EMAIL = () => workerEmail("administrator");
const READER_PASSWORD = () => workerFixturePassword(READER());

const BASE_SENTENCE = /signs Orbit out everywhere/iu;
const PROVIDER_SENTENCE = /sign-in provider in this browser only/iu;

/** Sign-out as the product's own control performs it: the session's CSRF token, then POST. */
async function signOut(page: Page): Promise<void> {
  const status = await page.evaluate(async () => {
    const session = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
    const { csrfToken } = (await session.json()) as { csrfToken: string };
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "x-csrf-token": csrfToken },
    });
    return response.status;
  });
  expect(status, "sign-out was refused").toBe(200);
}

/** Opens the mailed link in a browser that has never signed in and approves the sign-in. */
async function approveOnAnotherDevice(browser: Browser, link: string): Promise<void> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const other = await context.newPage();
    await other.goto(link);
    await expect(other.locator(".approve-facts")).toBeVisible({ timeout: 30_000 });
    await other.locator("#approveyes").click();
    await expect(other.locator(".approve-yes")).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await context.close();
  }
}

/** Types the password on the real door and, where the instance asks for it, has the emailed approval pressed elsewhere. */
async function signInWithPassword(page: Page, browser: Browser): Promise<void> {
  const mark = await newestApprovalUid(READER_EMAIL());
  await page.goto("/login");
  const localLine = page.locator("#localopen");
  const email = page.locator("#idemail");
  await expect(localLine.or(email).first()).toBeVisible({ timeout: 30_000 });
  if (await localLine.isVisible()) await localLine.click();
  await expect(email).toBeVisible({ timeout: 30_000 });
  await page.fill("#idemail", READER_EMAIL());
  await page.fill("#idpassword", READER_PASSWORD());
  await page.locator("#idbtn").click();

  await expect(page.locator(".card.waiting")).toBeVisible({ timeout: 30_000 });
  const link = await waitForApprovalLink(READER_EMAIL(), 60_000, mark);
  await approveOnAnotherDevice(browser, link);
  await settleArrival(page);
  const session = await page.request.get("/api/auth/session");
  expect(session.ok(), "the password sign-in did not open a session").toBe(true);
}

async function requireProviderInstance(page: Page): Promise<void> {
  const availability = await (await page.request.get("/api/auth/availability")).json() as {
    methods: { oidc: boolean; secondFactor: boolean };
  };
  test.skip(!availability.methods.oidc, "no provider configured: this file is about an instance that offers one");
  test.skip(!availability.methods.secondFactor, "no mail relay: a password session cannot be made the way this file makes it");
}

async function openSettings(page: Page): Promise<void> {
  await page.goto("/settings");
  await page.waitForLoadState("load");
  await expect(page.getByRole("button", { name: /sign out of every device/iu }).filter({ visible: true }).first())
    .toBeVisible({ timeout: 30_000 });
}

/** The visible sentence matching a pattern, wherever the layout draws it. */
const sentence = (page: Page, pattern: RegExp) => page.getByText(pattern).filter({ visible: true });

test("settings: a password session on a provider-enabled instance is not told the provider signs it out (#1444)", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await signIn(page, "/home");
  await requireProviderInstance(page);
  const household: Household = await seedHousehold(page, "provider-sentence-pw");
  let cleanedBy = "provider";
  try {
    await page.goto("/settings");
    await ensureLocalPassword(page, READER(), READER_PASSWORD());
    await signOut(page);
    await signInWithPassword(page, browser);
    cleanedBy = "password";

    await openSettings(page);
    /* The positive half: the page has drawn, and says what the button does. */
    await expect(sentence(page, BASE_SENTENCE).first(), "#1444: the base sentence is missing").toBeVisible({ timeout: 30_000 });
    /* The negative half: this session never came through the provider. */
    await expect(sentence(page, PROVIDER_SENTENCE), "#1444: a password session is told the provider will sign it out").toHaveCount(0);
  } finally {
    if (cleanedBy === "password") {
      await cleanupHousehold(page, await sessionHeaders(page), household.id, household.name);
    }
  }
});

test("settings: a provider session is told the provider signs it out too (#1444)", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "/home");
  await requireProviderInstance(page);
  const household = await seedHousehold(page, "provider-sentence-oidc");
  try {
    await openSettings(page);
    await expect(sentence(page, BASE_SENTENCE).first(), "#1444: the base sentence is missing").toBeVisible({ timeout: 30_000 });
    await expect(sentence(page, PROVIDER_SENTENCE).first(), "#1444: a provider session is not told the provider signs it out").toBeVisible();
  } finally {
    await cleanupHousehold(page, await sessionHeaders(page), household.id, household.name);
  }
});
