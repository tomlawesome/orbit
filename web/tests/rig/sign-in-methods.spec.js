import { expect, test } from "@playwright/test";

import { APP, onPhone, signedIn } from "./a11y-support.js";

/** @typedef {import("@playwright/test").Page} Page */

/*
 * SIGN-IN METHODS (#915), moved to the rig (ADR-0039, #1611) from
 * tests/e2e/sign-in-methods.spec.ts.
 *
 * The two screens M7 gave sign-in methods to, driven the way a reader drives
 * them. The helm's "You" card lists what the account actually has, and changing
 * any of it re-challenges the person in front of the screen inline (ADR-0023
 * §5, §6). Administration grew the other half: an administrator adds a local
 * user, and Orbit mails them a link that this screen never shows.
 *
 * The stack version signed in through the real provider, set real passwords and
 * read the real mailer. Here each reader starts from a fixture state --
 * `signin-nopassword` (a provider identity and no password), `any-dialect`
 * (both), and administration's `any-dialect` -- and each write is the test's
 * own page.route: the password change, the user create and the setup-link
 * send. What is asserted is the screen: the rows, the inline challenge, the
 * wording of the notices, and that the link itself is never drawn.
 *
 * Gone from here, because they are the engine's and have their own tests:
 * that the new password is hashed and replaces the old, and that the caller's
 * own session survives a password change (tests/integration/local-sign-in.test.ts).
 *
 * Desk only, as the stack version was.
 */
test.use({ baseURL: APP });
test.beforeEach(async ({}, testInfo) => {
  test.skip(onPhone(testInfo), "the block is asserted on the desk dialect");
});

const NEW_PASSWORD = "helm-changed-1";
const NEWCOMER = "newcomer@harlow.example";

/** The password row's value, whatever state it is in. @param {Page} page */
const passwordRow = (page) => page.locator(".kv", { hasText: "password" }).first();

test("the helm lists the sign-in methods an account actually has", async ({ page }) => {
  await signedIn("/settings", "signin-nopassword")(page);

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
  await signedIn("/settings", "any-dialect")(page);
  await expect(passwordRow(page)).toContainText("set");

  /* The write is this test's own: first refused, as the engine refuses a wrong
     current password, then accepted. */
  const sent = /** @type {{ password: string, currentPassword?: string }[]} */ ([]);
  await page.route("**/api/auth/local/password", async (route) => {
    const body = route.request().postDataJSON();
    sent.push(body);
    if (sent.length === 1) {
      return route.fulfill({ status: 403, json: { error: { code: "invalid_credentials", message: "That is not your current password" } } });
    }
    return route.fulfill({ json: { changed: true, sessionsRevoked: 1 } });
  });
  /* The screen reads the methods again once the change lands. The fixture
     server has no database, so left alone that read fails (a DrizzleQueryError
     in its log) and its "done, but could not refresh" line replaces "password
     changed" the moment it arrives: a test that polls for the note passes only
     if it looks first, and lost that race on Firefox in CI (#1615). The read
     is the engine's: a password, changed now. */
  let reads = 0;
  await page.route("**/api/auth/methods", (route) => route.request().method() === "GET"
    ? (reads += 1, route.fulfill({ json: { local: { set: true, changedAt: new Date().toISOString() }, oidc: [] }, headers: { "cache-control": "no-store" } }))
    : route.fallback());

  /* First tap ARMS: the field appears under the row it belongs to, and
     nothing has changed yet. */
  await passwordRow(page).getByRole("button", { name: "change" }).click();
  const challenge = page.locator(".challenge");
  await expect(challenge).toBeVisible();
  await expect(challenge.getByLabel("current password")).toBeVisible();
  expect(sent, "nothing is sent by arming").toEqual([]);

  /* A wrong current password is refused, and says so without saying which
     part was wrong. */
  await challenge.getByLabel("current password").fill("not-the-password");
  await challenge.getByLabel("new password").fill(NEW_PASSWORD);
  await challenge.getByRole("button", { name: "save it" }).click();
  await expect(challenge.locator(".note")).toContainText("current password");
  expect(sent).toEqual([{ password: NEW_PASSWORD, currentPassword: "not-the-password" }]);

  /* The right one goes through, and the screen says so. */
  /* The answer above is only seen if the screen asks again after the change. */
  expect(reads, "no re-read before the change lands").toBe(0);
  await challenge.getByLabel("current password").fill("the-right-one");
  await challenge.getByRole("button", { name: "save it" }).click();
  await expect(page.locator(".note.ok")).toContainText("password changed");
  await expect(page.locator(".challenge")).toHaveCount(0);
  await expect(passwordRow(page)).toContainText("changed");
  expect(reads, "the screen read the methods again after the change").toBeGreaterThan(0);
  expect(sent[1]).toEqual({ password: NEW_PASSWORD, currentPassword: "the-right-one" });
});

/**
 * The roster as the engine would read it once the test's own create has run:
 * the fixture's, plus the one person.
 * @param {Page} page @param {() => ({ id: string, displayName: string, email: string } | null)} added
 */
async function rosterWith(page, added) {
  await page.route("**/api/admin/users", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const body = await response.json();
    const person = added();
    return route.fulfill({ response, json: person ? { ...body, users: [...body.users, person] } : body });
  });
}

test("an administrator adds a local user and is told where the link went", async ({ page }) => {
  await signedIn("/administration", "any-dialect")(page);

  const person = { id: "u-newcomer", displayName: "Newcomer Harlow", email: NEWCOMER };
  let created = false;
  await rosterWith(page, () => (created ? person : null));
  /** @type {any[]} */
  const sent = [];
  await page.route("**/api/admin/users", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    sent.push(route.request().postDataJSON());
    created = true;
    return route.fulfill({ json: { sentTo: NEWCOMER, expiresAt: "2026-09-16T11:00:00.000Z", sendError: null, user: person } });
  });

  const row = page.locator("form.localuser").first();
  await row.getByLabel("email").fill(NEWCOMER);
  await row.getByLabel("display name").fill("Newcomer Harlow");
  /* The administrator's call, up to a fortnight (ADR-0023 §3). */
  await row.getByLabel("link valid for").fill("3");

  /* Create arms the challenge rather than creating anything. */
  await row.getByRole("button", { name: "create", exact: true }).click();
  await expect(row.getByLabel("your current password")).toBeVisible();
  expect(sent, "arming sends nothing").toEqual([]);
  await row.getByLabel("your current password").fill("the-administrators-own");
  await row.getByRole("button", { name: "create and send the link" }).click();

  /* WHERE IT WENT AND WHEN IT LAPSES — never the link itself (owner ruling,
     2026-09-09). The absence is asserted as hard as the presence: a Copy
     control or a /setup/ URL on this screen would be the defect. */
  const outcome = page.locator(".adminproblem.ok");
  await expect(outcome).toContainText(`Setup link sent to ${NEWCOMER}, valid until`);
  await expect(page.locator(".mission-page")).not.toContainText("/setup/");
  await expect(page.getByRole("button", { name: /copy/i })).toHaveCount(0);
  expect(sent).toEqual([expect.objectContaining({ email: NEWCOMER, displayName: "Newcomer Harlow", expiresInDays: 3, currentPassword: "the-administrators-own" })]);

  /* And the person is in the roster the moment they exist. */
  await expect(page.locator(".person", { hasText: NEWCOMER })).toBeVisible();
});

test("an administrator sends a new setup link from somebody's row", async ({ page }) => {
  await signedIn("/administration", "any-dialect")(page);

  /** @type {{ url: string, body: any }[]} */
  const sent = [];
  await page.route("**/api/admin/users/*/setup-link", async (route) => {
    sent.push({ url: route.request().url(), body: route.request().postDataJSON() });
    return route.fulfill({ json: { sentTo: NEWCOMER, expiresAt: "2026-09-16T11:00:00.000Z", sendError: null } });
  });

  const person = page.locator(".person", { hasText: "Emma Harlow" }).first();
  await expect(person).toBeVisible();

  await person.getByRole("button", { name: /send a new setup link/ }).click();
  const resend = page.locator("form.localuser.resend");
  await expect(resend).toBeVisible();
  await resend.getByLabel("link valid for").fill("14");
  await resend.getByLabel("your current password").fill("the-administrators-own");
  await resend.getByRole("button", { name: "send it" }).click();

  await expect(page.locator(".adminproblem.ok")).toContainText("Setup link sent to");
  await expect(page.locator(".adminproblem.ok")).toContainText("valid until");
  /* The form closes on success, so the roster reads as a roster again. */
  await expect(page.locator("form.localuser.resend")).toHaveCount(0);
  expect(sent).toHaveLength(1);
  expect(sent[0].body).toEqual({ expiresInDays: 14, currentPassword: "the-administrators-own" });
});
