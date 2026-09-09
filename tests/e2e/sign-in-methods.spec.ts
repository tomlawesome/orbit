import { expect, test, type Page } from "@playwright/test";
import { householdRegister, sessionHeaders } from "./support/households";
import { settleArrival } from "./support/arrival";
import { claimInstanceAsAdministrator } from "./support/bootstrap";
import { ensureLocalPassword } from "./support/local-credentials";

/**
 * #915: the two screens M7 gave sign-in methods to, driven the way a reader
 * drives them. The helm's "You" card no longer guesses that everybody arrived
 * through an identity provider — it lists what the account actually has, and
 * changing any of it re-challenges the person in front of the screen inline
 * (ADR-0023 §5, §6). Administration grew the other half: an administrator adds
 * a local user, and Orbit mails them a link that this screen never shows.
 *
 * NO INTERCEPTION. Every step below is the real pipe — the real routes, the
 * real mailer, the real provider sidecar — with one exception the product
 * itself cannot yet do: the FIRST password on an OIDC-only account, which
 * `ensureLocalPassword` sets through the API after walking the real step-up.
 * The signed-out door's local card is slice 12 (#914) and is deliberately not
 * depended on here, so this file never signs in with a password; it signs in
 * through the provider like every other spec and exercises the password as the
 * CHALLENGE, which is what §2.7 composed.
 *
 * THREE ACCOUNTS, THREE ROLES, on purpose. The suite shares one instance and
 * CI retries whole files, so a test that asserts "no password" has to name an
 * account nothing in this file ever gives one to:
 *
 *   Orbit Member         never gains a password — the "not set" reader
 *   Orbit Outsider       the password journeys (set, then changed from the UI)
 *   Orbit Administrator  the administration journeys, which need an
 *                        administrator who can answer the inline challenge
 *
 * Each test signs its own reader in on its own page, `v19-membership.spec.ts`'s
 * shape, and the ones that change a password put it back afterwards so a
 * retried file starts where the first attempt did.
 */

const PASSWORD = `helm-fixture-${Date.now()}`;
const NEW_PASSWORD = `helm-changed-${Date.now()}`;
/* One address per run: the account outlives the test (there is no
   remove-a-user route, and disabling is the strongest thing an administrator
   has), so a fixed address would collide with itself on the second run
   against a kept stack. */
const NEWCOMER = `newcomer-${Date.now()}@example.invalid`;

const households = householdRegister();

/**
 * A reader with no household anywhere never reaches the helm: hooks.server.js
 * sends them to the arrival instead (#840). "Orbit Member" is that reader on
 * a fresh stack, so give them one -- the shape `v19-membership.spec.ts` uses,
 * swept again after the test -- and only when the arrival says so.
 */
async function ensureHousehold(page: Page) {
  const adrift = await page.locator("#gobtn, h1:has-text('where do you belong?')").first().isVisible().catch(() => false);
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
  }, `Sign-in methods ${Date.now()}`);
  households.track(created);
}

test.afterEach(async ({ page }) => {
  await households.sweep(page);
});

async function signInAs(page: Page, account: string) {
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: account }).click();
  await settleArrival(page);
  await ensureHousehold(page);
}

/** The helm, loaded — every card is gated on the screen's own fetch. */
async function openSettings(page: Page) {
  await page.goto("/settings");
  await expect(page.locator(".cards")).toBeVisible({ timeout: 30_000 });
}

/** The password row's value, whatever state it is in. */
const passwordRow = (page: Page) => page.locator(".kv", { hasText: "password" }).first();

test.describe.configure({ mode: "serial" });

test("the helm lists the sign-in methods an account actually has", async ({ page, browser }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the block is asserted on the desk dialect");
  test.setTimeout(90_000);

  /* Somebody has to hold the instance before anyone else can sign in at all
     (ADR-0022); it is not this reader, who is deliberately ordinary. */
  await claimInstanceAsAdministrator(browser);
  await signInAs(page, "Orbit Member");
  await openSettings(page);

  await expect(page.getByRole("heading", { name: "Sign-in methods" })).toBeVisible();

  /* The line this block replaced said one thing about everybody. It is gone,
     and its going is the point of the slice — so it is asserted, not assumed. */
  await expect(page.locator(".helm-page")).not.toContainText("signed in via your identity provider");

  /* This reader arrived through the provider and has never set a password. */
  await expect(passwordRow(page)).toContainText("not set");
  await expect(passwordRow(page).getByRole("button", { name: "set a password" })).toBeVisible();

  /* And the identity they arrived with is listed by its issuer's host and the
     day it was linked — never the provider's opaque subject for them. */
  const identity = page.locator(".kv", { hasText: "identity provider" }).first();
  await expect(identity).toContainText("linked");
  await expect(identity.getByRole("button", { name: /unlink/ })).toBeVisible();
  /* Already linked, so there is no second offer to link. */
  await expect(page.getByRole("button", { name: "link your identity provider" })).toHaveCount(0);
});

test("a reader changes their password from the helm, inline", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the block is asserted on the desk dialect");
  test.setTimeout(120_000);

  await signInAs(page, "Orbit Outsider");
  await openSettings(page);
  /* The one thing the product cannot do for itself yet — see the helper. */
  await ensureLocalPassword(page, "Orbit Outsider", PASSWORD);

  try {
    await openSettings(page);
    await expect(passwordRow(page)).toContainText("set");

    /* First tap ARMS: the field appears under the row it belongs to, and
       nothing has changed yet. */
    await passwordRow(page).getByRole("button", { name: "change" }).click();
    const challenge = page.locator(".challenge");
    await expect(challenge).toBeVisible();
    await expect(challenge.getByLabel("current password")).toBeVisible();

    /* A wrong current password is refused, and says so without saying which
       part was wrong. */
    await challenge.getByLabel("current password").fill("not-the-password");
    await challenge.getByLabel("new password").fill(NEW_PASSWORD);
    await challenge.getByRole("button", { name: "save it" }).click();
    await expect(challenge.locator(".note")).toContainText("current password");

    /* The real one goes through, and the screen says what it cost: a changed
       password ends every other session (ADR-0023 §7). */
    await challenge.getByLabel("current password").fill(PASSWORD);
    await challenge.getByLabel("new password").fill(NEW_PASSWORD);
    await challenge.getByRole("button", { name: "save it" }).click();
    await expect(page.locator(".note.ok")).toContainText("password changed");
    await expect(page.locator(".challenge")).toHaveCount(0);
    await expect(passwordRow(page)).toContainText("changed");

    /* This browser was NOT signed out with the others: the route re-issues
       the caller's own session in the same answer. */
    const session = await page.request.get("/api/auth/session");
    expect((await session.json()).authenticated, "the caller's own session did not survive the change").toBeTruthy();
  } finally {
    /* Put it back, so a retried file meets the state the first attempt did. */
    await page.request.post("/api/auth/local/password", {
      headers: await sessionHeaders(page),
      data: { password: PASSWORD, currentPassword: NEW_PASSWORD },
    });
  }
});

test("an administrator adds a local user and is told where the link went", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the row is asserted on the desk dialect");
  test.setTimeout(120_000);

  await signInAs(page, "Orbit Administrator");
  await openSettings(page);
  /* An administrator who can answer the inline challenge. Without a password
     of their own the challenge is a step-up, which is a journey of its own. */
  await ensureLocalPassword(page, "Orbit Administrator", PASSWORD);

  await page.goto("/administration");
  await expect(page.locator(".card").first()).toBeVisible({ timeout: 30_000 });

  const row = page.locator("form.localuser").first();
  await row.getByLabel("email").fill(NEWCOMER);
  await row.getByLabel("display name").fill("Newcomer Lawson");
  /* The administrator's call, up to a fortnight (ADR-0023 §3). */
  await row.getByLabel("link valid for").fill("3");

  /* Create arms the challenge rather than creating anything. */
  await row.getByRole("button", { name: "create", exact: true }).click();
  await expect(row.getByLabel("your current password")).toBeVisible();
  await row.getByLabel("your current password").fill(PASSWORD);
  await row.getByRole("button", { name: "create and send the link" }).click();

  /* WHERE IT WENT AND WHEN IT LAPSES — never the link itself (owner ruling,
     2026-09-09). The absence is asserted as hard as the presence: a Copy
     control or a /setup/ URL on this screen would be the defect. */
  const outcome = page.locator(".adminproblem.ok");
  await expect(outcome).toContainText(`Setup link sent to ${NEWCOMER}, valid until`);
  await expect(page.locator(".mission-page")).not.toContainText("/setup/");
  await expect(page.getByRole("button", { name: /copy/i })).toHaveCount(0);

  /* And the person is in the roster the moment they exist. */
  await expect(page.locator(".person", { hasText: "Newcomer Lawson" })).toBeVisible();
});

test("an administrator sends a new setup link from somebody's row", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the row is asserted on the desk dialect");
  test.setTimeout(120_000);

  await signInAs(page, "Orbit Administrator");
  await openSettings(page);
  await ensureLocalPassword(page, "Orbit Administrator", PASSWORD);

  await page.goto("/administration");
  const person = page.locator(".person", { hasText: "Orbit Member" }).first();
  await expect(person).toBeVisible({ timeout: 30_000 });

  await person.getByRole("button", { name: /send a new setup link/ }).click();
  const resend = page.locator("form.localuser.resend");
  await expect(resend).toBeVisible();
  await resend.getByLabel("link valid for").fill("14");
  await resend.getByLabel("your current password").fill(PASSWORD);
  await resend.getByRole("button", { name: "send it" }).click();

  await expect(page.locator(".adminproblem.ok")).toContainText("Setup link sent to");
  await expect(page.locator(".adminproblem.ok")).toContainText("valid until");
  /* The form closes on success, so the roster reads as a roster again. */
  await expect(page.locator("form.localuser.resend")).toHaveCount(0);
});
