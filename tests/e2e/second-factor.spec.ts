import { expect, test, type Browser, type Page } from "@playwright/test";
import { settleArrival } from "./support/arrival";
import { claimInstanceAsAdministrator } from "./support/bootstrap";
import { FIXTURE_PASSWORD, ensureLocalPassword } from "./support/local-credentials";
import { waitForApprovalLink } from "./support/mail";

/**
 * THE EMAIL SECOND FACTOR, WALKED (#1033, ADR-0027).
 *
 * The one thing no unit test can say: that a password on the real door, on a
 * real instance, with a real relay, does not sign anybody in until a link in a
 * real mailbox is pressed. Every step below is the product's own pipe -- the
 * door, the sign-in route, the mailer, GreenMail, the approval page -- with
 * one exception the product itself still cannot do: the FIRST password on an
 * OIDC-only account, which `ensureLocalPassword` sets after walking the real
 * step-up, exactly as `sign-in-methods.spec.ts` does.
 *
 * WHY THIS FILE IS NOT IN local-only-specs.txt. The factor is on only when the
 * instance has a mail relay configured (ADR-0027 §2), and the local-only
 * profile deliberately has no GreenMail: `compose/docker-compose.local-only.yml`
 * carries no SMTP settings at all. So in that lane the factor is off and
 * `local-sign-in.spec.ts`'s password sign-in is unchanged -- which is itself
 * the ruling working. These journeys need the acceptance stack, which has
 * both the relay and the provider the third test needs.
 *
 * TWO ACCOUNTS, so a retried file cannot confuse itself:
 *
 *   Orbit Outsider   the password journeys; the only account given a password
 *                    here, and it keeps FIXTURE_PASSWORD's one value
 *   Orbit Member     never gains a password, so the "not challenged" test can
 *                    say "no approval mail reached this mailbox" and mean it
 *
 * Each test drives its own page, and the approving reader is always a SEPARATE
 * browser context -- the whole design is that the browser which approves is
 * not the browser which gets in, and sharing a context would quietly prove the
 * opposite of what is claimed.
 */

const DESKTOP_PROJECT = "desktop-chromium";

const OUTSIDER = { name: "Orbit Outsider", email: "outsider@example.test", password: FIXTURE_PASSWORD["Orbit Outsider"] };
const MEMBER = { name: "Orbit Member", email: "member@example.test" };

test.describe.configure({ mode: "serial", retries: 0 });

test.beforeAll(async ({ request }) => {
  test.skip(
    test.info().project.name !== DESKTOP_PROJECT,
    "the journey is the same on both dialects, and it claims a mailbox: one project walks it",
  );
  /* The stack's own answer, not an assumption about which lane this is: no
     relay means no factor, and every assertion below would be proving the
     opposite of what it says. */
  const availability = await (await request.get("/api/auth/availability")).json() as {
    methods: { oidc: boolean; secondFactor: boolean };
  };
  test.skip(!availability.methods.secondFactor, "no mail relay configured: the factor is off in this profile");
  test.skip(!availability.methods.oidc, "no provider configured: this file needs one to seat its two readers");
});

/** Signs a reader in through the provider, the way every other spec does. */
async function signInWithProvider(page: Page, account: string): Promise<void> {
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: account }).click();
  await settleArrival(page);
}

/**
 * Sign-out, as the product's own control performs it: read the CSRF token off
 * the session, then POST it. `local-sign-in.spec.ts`'s own helper, for the
 * same reason -- the button lives on a screen these readers may not have.
 */
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
  expect(status).toBe(200);
}

/** Types a password on the real door and leaves the tab where it lands. */
async function typeThePassword(page: Page): Promise<void> {
  await page.goto("/login");
  /* Mixed mode: the ratified gate is unchanged and the quiet line under it
     opens the local card (§2.7). On a local-only door the card is already up,
     so the line is optional rather than asserted. */
  const localLine = page.locator("#localopen");
  if (await localLine.count() > 0) await localLine.click();
  await expect(page.locator("#idemail")).toBeVisible({ timeout: 30_000 });
  await page.fill("#idemail", OUTSIDER.email);
  await page.fill("#idpassword", OUTSIDER.password);
  await page.locator("#idbtn").click();
}

/**
 * Opens the mailed link in a browser that has never signed in, presses one of
 * the two buttons, and proves the press left that browser signed out.
 */
async function decideOnAnotherDevice(browser: Browser, link: string, press: "#approveyes" | "#approveno"): Promise<void> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const phone = await context.newPage();
  try {
    await phone.goto(link);

    /* WHAT IS BEING APPROVED, before anything can be pressed (ADR-0027 §4):
       the instance, the browser, where from, and when. */
    const facts = phone.locator(".approve-facts");
    await expect(facts).toBeVisible({ timeout: 30_000 });
    await expect(facts).toContainText("Orbit at");
    await expect(facts).toContainText("From ");

    /* Nobody is signed in here, and opening the link decided nothing -- which
       is what keeps a mail scanner from being a second factor. */
    expect((await phone.request.get("/api/auth/session")).status()).toBe(401);

    await phone.locator(press).click();
    await expect(phone.locator(".approve-yes")).toHaveCount(0, { timeout: 30_000 });
    /* And still not signed in, having answered. */
    expect((await phone.request.get("/api/auth/session")).status()).toBe(401);
  } finally {
    await context.close();
  }
}

test("a password alone signs nobody in: the emailed approval is what opens the door", async ({ page, browser }) => {
  test.setTimeout(240_000);

  await claimInstanceAsAdministrator(browser);
  await signInWithProvider(page, OUTSIDER.name);
  await page.goto("/settings");
  /* The one thing the product cannot do for itself yet -- see the helper. */
  await ensureLocalPassword(page, OUTSIDER.name, OUTSIDER.password);
  await signOut(page);

  await typeThePassword(page);

  /* THE SECOND SCREEN. The password was right, and it bought a wait rather
     than a session -- asserted on the server too, so this cannot pass on a
     card that is merely drawn over a browser already signed in. */
  await expect(page.locator(".card.waiting")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".card.waiting")).toContainText("Check your email");
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/auth/session")).status()).toBe(401);

  const link = await waitForApprovalLink(OUTSIDER.email);
  await decideOnAnotherDevice(browser, link, "#approveyes");

  /* The waiting tab lets itself in, on its own, with no further typing. */
  await settleArrival(page);
  const session = await page.request.get("/api/auth/session");
  expect(session.ok(), "the approved tab was not let in").toBe(true);
  expect((await session.json()) as { user: { displayName: string } })
    .toMatchObject({ user: { displayName: OUTSIDER.name } });
});

test("\"this wasn't me\" turns the sign-in away, and the account holder is told next time", async ({ page, browser }) => {
  test.setTimeout(240_000);

  await typeThePassword(page);
  await expect(page.locator(".card.waiting")).toBeVisible({ timeout: 30_000 });

  const refused = await waitForApprovalLink(OUTSIDER.email);
  await decideOnAnotherDevice(browser, refused, "#approveno");

  /* The tab is told, and stays out. */
  await expect(page.locator(".card.waiting")).toContainText("This sign-in was refused", { timeout: 30_000 });
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/auth/session")).status()).toBe(401);

  /* AND THE OTHER HALF OF A REFUSAL: somebody knew that password, so the next
     sign-in that DOES work carries one line about it. */
  await typeThePassword(page);
  await expect(page.locator(".card.waiting")).toBeVisible({ timeout: 30_000 });
  const approved = await waitForApprovalLink(OUTSIDER.email);
  await decideOnAnotherDevice(browser, approved, "#approveyes");
  await settleArrival(page);

  await page.goto("/home");
  const notice = page.locator(".refused");
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toContainText("refused");
  await expect(notice.getByRole("link", { name: "change your password" })).toBeVisible();

  /* Said once: asking for it spent it, so a reload is a clean sky. */
  await page.reload();
  await expect(page.locator(".refused")).toHaveCount(0, { timeout: 30_000 });
});

test("an identity-provider sign-in is never challenged (ADR-0027 §3)", async ({ page }) => {
  test.setTimeout(120_000);

  await signInWithProvider(page, MEMBER.name);

  /* Straight in, with no waiting card anywhere in the journey. */
  expect((await page.request.get("/api/auth/session")).ok()).toBe(true);
  await expect(page.locator(".card.waiting")).toHaveCount(0);

  /* And nothing was posted to ask. This reader never gains a password in any
     spec, so their mailbox is the one place that claim can be made without
     racing another file's approval mail. A short wait on purpose: the
     assertion is "nothing arrives", and a long one only makes the suite slow
     to say so. */
  await expect(waitForApprovalLink(MEMBER.email, 8_000))
    .rejects.toThrow(/no sign-in approval mail/u);
});
