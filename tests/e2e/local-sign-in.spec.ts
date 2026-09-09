import { expect, test, type Page } from "@playwright/test";
import { claimCodeFromLog, stackLog } from "./support/bootstrap";

/**
 * AN ORBIT WITH NO IDENTITY PROVIDER AT ALL (#916, ADR-0022, ADR-0023 §1).
 *
 * The whole reason M7 exists: an operator who has no OIDC provider, and no
 * intention of running one, installs Orbit and uses it. This is that person's
 * entire first hour, walked end to end -- claim the instance from the code in
 * the container's log, become the first administrator, sign out, and sign
 * back in with the password they just chose.
 *
 * It runs against compose/docker-compose.local-only.yml, where
 * `ORBIT_AUTH_OIDC=false` and no provider sidecar exists at all, so nothing
 * here can be quietly carried by the provider the ordinary acceptance stack
 * has. `scripts/test-e2e-local.sh --profile local-only` and the
 * `smoke_local_only` job in .gitlab-ci.yml are the two callers;
 * tests/e2e/local-only-specs.txt is the list they share.
 *
 * ORDER AND ISOLATION, for the same reason bootstrap-protection.spec.ts has a
 * note about it: the database is not reset between specs and the claim
 * happens once per stack, so the unclaimed state belongs to whichever file
 * runs first. In this profile that is this one -- it sorts ahead of
 * `signed-out`, and the two projects run in declaration order, so the claim
 * is desktop's. Mobile would meet an instance this run had already claimed,
 * which is why the file is desktop-only: nothing in it renders differently on
 * a phone, and the door's own layout is covered where layout is the subject.
 */

const DESKTOP_PROJECT = "desktop-chromium";

/**
 * The first administrator this profile creates. The address is deliberately
 * the same literal tests/e2e/signed-out.spec.ts probes with: that spec's
 * point is that an address which exists and one which does not are answered
 * identically, and it can only make that claim if one of the addresses it
 * tries is real here.
 */
const ADMINISTRATOR = {
  email: "administrator@example.invalid",
  displayName: "Orbit Local Administrator",
  password: "orbit-e2e-local-only-placeholder",
};

test.describe.configure({ mode: "serial", retries: 0 });

test.beforeAll(() => {
  test.skip(
    test.info().project.name !== DESKTOP_PROJECT,
    "the unclaimed state exists once per stack, so this file runs under one project",
  );
});

/**
 * Sign-out, as the product's own control performs it
 * (`signOut` in web/src/lib/data/workspace.js, called by Chrome.svelte's
 * two-tap button): read the CSRF token off the session, then POST it. Driven
 * from the page rather than through the button because Chrome only exists on
 * a screen this administrator cannot reach yet -- they have no household, and
 * hooks.server.js sends a household-less session to the arrival -- and
 * creating one to press a button would be testing the arrival. The button
 * itself is walked in v19-screen-reader.spec.ts.
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

test("the operator claims a provider-less Orbit and becomes its administrator", async ({ page, request }) => {
  test.setTimeout(120_000);

  const before = await (await request.get("/api/auth/availability")).json() as {
    claimed: boolean; methods: { local: boolean; oidc: boolean; localAccounts: boolean };
  };
  expect(
    before.claimed,
    "this instance is already claimed, so the claim journey cannot be walked. This file "
      + "has to run first in the local-only profile -- see tests/e2e/local-only-specs.txt.",
  ).toBe(false);
  /* The profile itself, asserted rather than assumed: no provider, and no
     local account yet either. A stack that had quietly kept OIDC on would
     make everything below prove something else. */
  expect(before.methods.oidc, "this is not a local-only stack: OIDC is configured").toBe(false);
  expect(before.methods.local).toBe(true);
  expect(before.methods.localAccounts).toBe(false);

  /* THE CODE, off the container's own log, which is the only place it is
     (ADR-0022 §1) and exactly where the card tells the operator to look. */
  const code = claimCodeFromLog(stackLog());
  expect(code, "no claim notice in the stack's log: has orbit-app started?").toBeDefined();

  await page.goto("/login");
  await expect(page.locator("#claimcode")).toBeVisible();
  /* No gate: there is no provider to offer, and nobody to sign in as. */
  await expect(page.locator("#gate")).toHaveCount(0);

  await page.fill("#claimcode", code as string);
  await page.locator("#claimbtn").click();

  /* THE CREATE CARD, revealed by the claim: the identity of the first
     administrator. And no provider line under it, because there is no
     provider -- the ruling puts that line there only when there is one. */
  await expect(page.locator("#idname")).toBeVisible();
  await expect(page.locator(".card .quietline")).toHaveCount(0);
  await page.fill("#idemail", ADMINISTRATOR.email);
  await page.fill("#idname", ADMINISTRATOR.displayName);
  await page.fill("#idpassword", ADMINISTRATOR.password);
  await expect(page.locator("#idbtn")).toHaveText("Create");
  await page.locator("#idbtn").click();

  /* Signed in, and landed on the first-run arrival -- the same place an
     identity provider's callback would have put them. */
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  const session = await page.request.get("/api/auth/session");
  expect(session.ok()).toBe(true);
  expect((await session.json()) as { user: { displayName: string } })
    .toMatchObject({ user: { displayName: ADMINISTRATOR.displayName } });

  /* The instance is claimed once and for all, and it now has a password on
     it -- which is the fact the door needs to offer local sign-in at all. */
  const after = await (await request.get("/api/auth/availability")).json() as {
    claimed: boolean; methods: { localAccounts: boolean };
  };
  expect(after.claimed).toBe(true);
  expect(after.methods.localAccounts).toBe(true);
});

test("signing out really ends the session", async ({ page }) => {
  await page.goto("/");
  await signOut(page);

  /* Gone on the server, not just forgotten by the tab: the next request for a
     gated screen is turned away at the hook, before any of it is sent. */
  const gated = await page.request.get("/settings", { maxRedirects: 0 });
  expect(gated.status()).toBe(303);
  expect(gated.headers()["location"]).toBe("/login?returnTo=%2Fsettings");
  const session = await page.request.get("/api/auth/session");
  expect(session.status()).toBe(401);
});

test("and the password signs them back in", async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto("/login");

  /* A CLAIMED LOCAL-ONLY INSTANCE, for real this time. v19-first-run-door
     .spec.ts asserts this face against a stubbed availability answer, because
     the ordinary stack cannot be in this state; here the instance genuinely
     is, and the card in the ring is what it genuinely draws. */
  await expect(page.locator("#idemail")).toBeVisible();
  await expect(page.locator("#idpassword")).toBeVisible();
  await expect(page.locator("#idname")).toHaveCount(0);
  await expect(page.locator("#gate")).toHaveCount(0);
  await expect(page.locator("#idbtn")).toHaveText("Sign in");

  /* The wrong password first, because "it signed me in" is only worth
     something if something else would not have. One sentence back, naming
     neither the field nor the account (ADR-0023 §4). */
  await page.fill("#idemail", ADMINISTRATOR.email);
  await page.fill("#idpassword", `${ADMINISTRATOR.password}-not`);
  await page.locator("#idbtn").click();
  await expect(page.locator(".err.shown")).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/auth/session")).status()).toBe(401);

  /* And then the right one. */
  await page.fill("#idpassword", ADMINISTRATOR.password);
  await page.locator("#idbtn").click();

  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  const session = await page.request.get("/api/auth/session");
  expect(session.ok()).toBe(true);
  expect((await session.json()) as { user: { displayName: string } })
    .toMatchObject({ user: { displayName: ADMINISTRATOR.displayName } });
});
