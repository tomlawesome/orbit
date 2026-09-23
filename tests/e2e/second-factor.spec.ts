import { expect, test, type Browser, type Page } from "@playwright/test";
import { settleArrival } from "./support/arrival";
import { claimInstanceAsAdministrator } from "./support/bootstrap";
import { householdRegister } from "./support/households";
import { ensureLocalPassword } from "./support/local-credentials";
import { workerAccount, workerEmail, workerFixturePassword } from "./support/worker-identity";
import { newestApprovalUid, waitForApprovalLink } from "./support/mail";
import { resetDatabaseBetweenSpecFiles } from "./support/database";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   lists these specs walk carry nothing an earlier spec left behind. */
resetDatabaseBetweenSpecFiles();

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
 * THREE SENDS OF THE OUTSIDER'S FIVE. ADR-0027 §8 allows five approval mails
 * per account per hour, and this file spends three of them (one, then two).
 * That is comfortable on a fresh stack and is the whole allowance on a stack
 * run twice within the hour: a second run against a kept stack (--reuse) gets
 * "check the mail we already sent" and no new mail, which is the limit
 * working rather than anything here failing.
 *
 * Each test drives its own page, and the approving reader is always a SEPARATE
 * browser context -- the whole design is that the browser which approves is
 * not the browser which gets in, and sharing a context would quietly prove the
 * opposite of what is claimed.
 */

const DESKTOP_PROJECT = "desktop-chromium";

/* #1080: this worker's own identities, resolved lazily (worker env only) —
   the approval-mail mailbox is the identity's own address, and ADR-0027 §8's
   five-sends-per-account-per-hour budget is spent per worker identity. */
const OUTSIDER = () => ({
  name: workerAccount("outsider"),
  email: workerEmail("outsider"),
  password: workerFixturePassword(workerAccount("outsider")),
});
const MEMBER = () => ({ name: workerAccount("member"), email: workerEmail("member") });

const households = householdRegister();
/** Whether this run made a household, so a skipped project sweeps nothing. */
let seated = false;

/**
 * SOMEWHERE FOR THE OUTSIDER TO BELONG, because two screens this journey ends
 * on are gated ones, and hooks.server.js sends a reader who belongs to no
 * household anywhere to the arrival instead (#840).
 *
 * That bounce is what broke this file first time out: the step-up inside
 * `ensureLocalPassword` comes back to /settings, the hook sent it to `/`, and
 * the helper waited twenty seconds for a URL that was never coming. The
 * refusal line the second test reads is drawn on /home, which is gated the
 * same way, so the same seat is what lets that assertion be made at all.
 *
 * The shape sign-in-methods.spec.ts uses for the same reason, swept the same
 * way (#730), and only when the arrival says this reader is adrift -- on a
 * kept stack (--reuse) they already have one.
 */
async function ensureHousehold(page: Page) {
  const adrift = await page.locator("#gobtn").or(page.getByRole("heading", { name: "where do you belong?" }))
    .first().isVisible().catch(() => false);
  if (!adrift) return;
  const created = await page.evaluate(async (householdName) => {
    const session = (await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { csrfToken: string };
    const householdId = crypto.randomUUID();
    const response = await fetch("/api/workspace/commands", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({
        type: "household.create",
        household: {
          id: householdId, name: householdName, timezone: "Europe/London", currency: "GBP",
          memberCount: 1, canManage: true, onboardingComplete: true,
          sections: [{ id: crypto.randomUUID(), name: "Home", icon: "home", accent: "sage", visible: true }],
          items: [],
        },
      }),
    });
    if (!response.ok) throw new Error(`household.create failed: ${response.status}`);
    return { id: householdId, name: householdName };
  }, `Second factor ${Date.now()}`);
  households.track(created);
  seated = true;
}

/* #730: swept from the administrator's own session when the file is done -- a
   hard delete is an instance-admin power and this reader is deliberately
   ordinary. A project that skipped the file made nothing to sweep. */
test.afterAll(async ({ browser }) => {
  if (!seated) return;
  await claimInstanceAsAdministrator(browser, { afterSignIn: (page) => households.sweep(page) });
});

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

/**
 * Types a password on the real door and leaves the tab where it lands.
 *
 * Returns the mailbox mark taken just before the door was knocked on, which
 * is what tells the approval THIS sign-in causes from the ones already in the
 * outsider's inbox -- see `waitForApprovalLink`.
 */
async function typeThePassword(page: Page): Promise<number> {
  const mark = await newestApprovalUid(OUTSIDER().email);
  await page.goto("/login");
  /* THE DOOR DECIDES ITS OWN FACE, and it does it client-side: /login is
     prerendered and asks /api/auth/availability in onMount (SignIn.svelte's
     run()), so for a moment after the page loads it is showing neither. A
     `count()` taken in that moment reads zero and means nothing -- which is
     how this file first went red on the quiet line's absence rather than on
     anything it claims.
     Mixed mode: the ratified gate is unchanged and the quiet line under it
     opens the local card (§2.7). On a local-only door that card is already
     up, so whichever of the two arrives first is the one to follow. */
  const localLine = page.locator("#localopen");
  const email = page.locator("#idemail");
  await expect(localLine.or(email).first()).toBeVisible({ timeout: 30_000 });
  if (await localLine.isVisible()) await localLine.click();
  await expect(email).toBeVisible({ timeout: 30_000 });
  await page.fill("#idemail", OUTSIDER().email);
  await page.fill("#idpassword", OUTSIDER().password);
  await page.locator("#idbtn").click();
  return mark;
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
  await signInWithProvider(page, OUTSIDER().name);
  /* Before any gated screen is asked for -- see ensureHousehold. */
  await ensureHousehold(page);
  await page.goto("/settings");
  /* The one thing the product cannot do for itself yet -- see the helper. */
  await ensureLocalPassword(page, OUTSIDER().name, OUTSIDER().password);
  await signOut(page);

  const knocked = await typeThePassword(page);

  /* THE SECOND SCREEN. The password was right, and it bought a wait rather
     than a session -- asserted on the server too, so this cannot pass on a
     card that is merely drawn over a browser already signed in. */
  await expect(page.locator(".card.waiting")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".card.waiting")).toContainText("Check your email");
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/auth/session")).status()).toBe(401);

  const link = await waitForApprovalLink(OUTSIDER().email, 60_000, knocked);
  await decideOnAnotherDevice(browser, link, "#approveyes");

  /* The waiting tab lets itself in, on its own, with no further typing. */
  await settleArrival(page);
  const session = await page.request.get("/api/auth/session");
  expect(session.ok(), "the approved tab was not let in").toBe(true);
  expect((await session.json()) as { user: { displayName: string } })
    .toMatchObject({ user: { displayName: OUTSIDER().name } });
});

test("\"this wasn't me\" turns the sign-in away, and the account holder is told next time", async ({ page, browser }) => {
  test.setTimeout(240_000);

  const knocked = await typeThePassword(page);
  await expect(page.locator(".card.waiting")).toBeVisible({ timeout: 30_000 });

  const refused = await waitForApprovalLink(OUTSIDER().email, 60_000, knocked);
  await decideOnAnotherDevice(browser, refused, "#approveno");

  /* The tab is told, and stays out. */
  await expect(page.locator(".card.waiting")).toContainText("This sign-in was refused", { timeout: 30_000 });
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/auth/session")).status()).toBe(401);

  /* AND THE OTHER HALF OF A REFUSAL: somebody knew that password, so the next
     sign-in that DOES work carries one line about it. */
  const knockedAgain = await typeThePassword(page);
  await expect(page.locator(".card.waiting")).toBeVisible({ timeout: 30_000 });
  const approved = await waitForApprovalLink(OUTSIDER().email, 60_000, knockedAgain);
  await decideOnAnotherDevice(browser, approved, "#approveyes");

  /* THE SKY THEY LAND ON, and not a second visit to it. Asking for the notice
     is what spends it -- /api/auth/sign-in-notice takes it in the statement
     that answers -- so the first /home this tab draws is the only one that can
     carry the line. The approved tab goes there on its own, because this
     reader has a household; navigating again afterwards would be reading a sky
     whose notice the landing had already taken. */
  await settleArrival(page);
  await expect(page).toHaveURL(/\/home$/, { timeout: 30_000 });
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

  await signInWithProvider(page, MEMBER().name);

  /* Straight in, with no waiting card anywhere in the journey. */
  expect((await page.request.get("/api/auth/session")).ok()).toBe(true);
  await expect(page.locator(".card.waiting")).toHaveCount(0);

  /* And nothing was posted to ask. This reader never gains a password in any
     spec, so their mailbox is the one place that claim can be made without
     racing another file's approval mail. A short wait on purpose: the
     assertion is "nothing arrives", and a long one only makes the suite slow
     to say so. */
  await expect(waitForApprovalLink(MEMBER().email, 8_000))
    .rejects.toThrow(/no sign-in approval mail/u);
});
