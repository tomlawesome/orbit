import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { APP, door } from "./a11y-support.js";

/** @typedef {import("@playwright/test").Page} Page */

/*
 * THE DOOR IS MODE-AWARE (#914, plan §2.7), moved to the rig (ADR-0039,
 * #1610) from tests/e2e/v19-first-run-door.spec.ts.
 *
 * The owner ruled the composition on 2026-09-09 (design/owner-decisions.md
 * §17); these are its cards and the setup screen, walked in a browser. Which
 * face the door wears is decided from one public body, and the faces need
 * different instances to arise naturally, so each test starts from the
 * fixture state that answers that body (pocket-states.js, the door family):
 * `login` / `claim-code`, `first-administrator`, `local-card`, `mixed`, the
 * ordinary `door` / `rest`, and `setup` / `rest`. The decision itself is
 * pinned without a browser in tests/unit/door-state.test.mjs (`doorModeOf`);
 * what only a browser shows is what these assert: the card stands in the
 * ring with the ratified chrome off it, the gate is absent where the owner
 * said it is, the fragment leaves the address bar before anything is
 * sent, and every one survives the WCAG sweep.
 *
 * What stays on the stack, in tests/e2e/v19-first-run-door.spec.ts, because
 * it needs a real instance: the local first run (the claim from the
 * container's log, one flight, the drawer, then home) and a fresh sign-in
 * returned to /home meeting the arrival (hooks.server.js sends a reader with
 * no household on to `/`, after a real sign-in through the provider).
 */
test.use({ baseURL: APP });

/**
 * The WCAG sweep every card has to pass.
 * @param {Page} page
 */
async function sweep(page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
}

test("unclaimed shows the claim card in the ring, and no gate at all", async ({ page }) => {
  await door("login", "claim-code")(page);

  await expect(page.locator("#claimcode")).toBeVisible();
  /* The whole of the ruling's first line: no Sign in gate. Not hidden --
     absent, so it is not reachable by keyboard or screen reader either. */
  await expect(page.locator("#gate")).toHaveCount(0);
  /* The card stands in the ring, and the login chrome is off the screen. */
  await expect(page.locator(".bigring .ringglass")).toBeAttached();
  await expect(page.locator(".loginchrome")).toBeHidden();
  /* The one sentence that says where the code is. */
  await expect(page.locator(".card .note")).toContainText("docker compose logs orbit-app");

  await sweep(page);
});

test("arriving by the notice's link fills the code, sends it, and clears the fragment", async ({ page }) => {
  /* The claim the operator's code would have earned is answered by the state;
     what is recorded here is the request it was in, so the body can be
     inspected: the point of ADR-0022 §1 is that the code travels in the POST
     and never in an address a proxy or a log would see. */
  const claim = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/auth/bootstrap/claim");
  await door("login", "first-administrator")(page);
  const presented = /** @type {{ claim?: string }} */ ((await claim).postDataJSON() ?? {}).claim ?? null;

  /* CREATE MODE: the identity of the first administrator, three fields. */
  await expect(page.locator("#idname")).toBeVisible();
  await expect(page.locator("#idemail")).toBeVisible();
  await expect(page.locator("#idpassword")).toBeVisible();
  expect(presented).toBe("ABCD-EFGH-2345");

  /* AND THE ADDRESS BAR IS CLEAN. `history.replaceState`, so there is no
     history entry holding it either -- a back press cannot bring it back. */
  expect(new URL(page.url()).hash).toBe("");
  await expect(page).toHaveURL(/\/login$/);

  /* With a provider configured, ONE line under the fields and no gate. */
  await expect(page.locator("#gate")).toHaveCount(0);
  await expect(page.locator(".card .quietline"))
    .toHaveText("continue with your identity provider");

  await sweep(page);
});

test("a claimed local-only instance shows the sign-in card in the ring", async ({ page }) => {
  await door("login", "local-card")(page);

  await expect(page.locator("#idemail")).toBeVisible();
  await expect(page.locator("#idpassword")).toBeVisible();
  /* Sign-in, not create: no display name is asked for, and no gate stands
     in front of a provider this instance does not have. */
  await expect(page.locator("#idname")).toHaveCount(0);
  await expect(page.locator("#gate")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "continue with your identity provider" })).toHaveCount(0);
  await expect(page.locator("#idbtn")).toHaveText("Sign in");
  await expect(page.locator(".bigring .ringglass")).toBeAttached();

  await sweep(page);
});

test("mixed mode is the ratified door plus one line, which opens the same card", async ({ page }) => {
  await door("login", "mixed")(page);

  /* THE RATIFIED DOOR, UNCHANGED: the gate, the lockup, no card. */
  await expect(page.locator("#gate")).toBeVisible();
  await expect(page.locator(".loginchrome")).toBeVisible();
  await expect(page.locator(".card")).toHaveCount(0);

  await expect(page.locator("#localopen")).toBeVisible();
  await page.locator("#localopen").click();

  /* The same card, opened rather than offered -- and the chrome goes with
     it, exactly as it does for the create-system card. */
  await expect(page.locator("#idemail")).toBeVisible();
  await expect(page.locator("#idpassword")).toBeVisible();
  await expect(page.locator("#gate")).toHaveCount(0);
  /* ...with the provider still in reach: §2.7's one line under the fields
     (#1278; the owner was left with no way to it after a wrong password) */
  const provider = page.getByRole("button", { name: "continue with your identity provider" });
  await expect(provider).toBeVisible();

  await sweep(page);

  const toProvider = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/auth/login");
  await provider.click();
  await toProvider;
});

test("the local login line stays off when no local credential exists", async ({ page }) => {
  /* §2.7, verbatim: "the line appears only when a local credential
     exists". An instance with a provider and no local account is the
     ordinary state of every deployment that never used local sign-in, and
     offering it a way in that cannot work would be worse than silence. The
     ordinary door's availability answer carries no `methods` at all, which
     the door reads as exactly that (doorModeOf's fallback,
     tests/unit/door-state.test.mjs). */
  await door("door", "rest")(page);

  await expect(page.locator("#gate")).toBeVisible();
  await expect(page.locator("#localopen")).toHaveCount(0);
});

test("the setup screen asks for the password twice and refuses a spent link", async ({ page }) => {
  /* An obviously fake token: an unknown, spent and expired token are one
     generic answer, so a token that never existed exercises exactly the path
     a spent one takes. */
  await door("setup", "rest")(page);

  await expect(page.locator("#idpassword")).toBeVisible();
  await expect(page.locator("#idagain")).toBeVisible();
  await expect(page.locator(".bigring .ringglass")).toBeAttached();
  await sweep(page);

  /* The one refusal the card decides for itself, because the server cannot
     see it: two passwords that do not match. */
  await page.fill("#idpassword", "orbit-e2e-placeholder-secret");
  await page.fill("#idagain", "orbit-e2e-placeholder-secre");
  await expect(page.locator(".err.shown")).toHaveText("Those two passwords are not the same.");
  await expect(page.locator("#idbtn")).toBeDisabled();

  await page.fill("#idagain", "orbit-e2e-placeholder-secret");
  await expect(page.locator("#idbtn")).toBeEnabled();
  /* This test's own write, refused as the server refuses a token it cannot
     use. */
  await page.route("**/api/auth/local/setup", (route) =>
    route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { code: "setup_token_invalid" } }) }));
  await page.locator("#idbtn").click();

  /* Orbit's own words, and the same ones for all three ways a token can be
     no good: nothing here tells whoever is holding it which it was. */
  await expect(page.locator(".err.shown"))
    .toHaveText("This link has been used already, or it has expired.");
  await expect(page).toHaveURL(/\/setup\//);
});
