import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { resetDatabaseBetweenSpecFiles } from "./support/database";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   lists these specs walk carry nothing an earlier spec left behind. */
resetDatabaseBetweenSpecFiles();

/*
 * #1056: `/auth/error?code=…`, where `web/src/routes/api/auth/callback/
 * +server.js`'s `callbackFailure` sends a failed OIDC callback. Before this
 * route existed the redirect 404'd to the gravity well (#1056's own
 * comments, checked live 2026-09-25 and 2026-09-27); this proves the route
 * itself, live, the way v19-first-run-door.spec.ts proves the door's own
 * three held-dawn states.
 *
 * NO SESSION, NO DATABASE, NO PROVIDER ROUND TRIP. This screen reads nothing
 * but its own `code` query parameter (+page.svelte, +page.js's own note),
 * so — unlike a genuine callback failure, which would need a real identity
 * provider sidecar to refuse a real transaction — driving it directly at its
 * own address is the honest test of what the route does with whatever code
 * a callback redirect handed it, exactly the contract
 * `web/src/lib/auth/errors.ts`'s `AuthErrorCode` and `callbackFailure`
 * establish between them.
 *
 * `reducedMotion: "reduce"` file-wide, the pattern `v19-document-preview.
 * spec.ts` and `v19-tour.spec.ts` already use: the "Try again" pill's
 * navigation is instant by design under it (`+page.svelte`'s own
 * `rm ? 200 : 900`), so these tests do not wait out the ratified 900ms beat
 * for something the beat itself does not assert.
 */
test.use({ reducedMotion: "reduce" });

test.describe.configure({ mode: "parallel" });

/** The WCAG sweep every held-dawn face has to pass (v19-first-run-door.spec.ts's own). */
async function sweep(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
}

test("didn't complete: the pill stays, and it is the one that plays the door's own recovery", async ({ page }) => {
  /* Every code but one (auth-error-state.js): this is the ordinary case a
     provider refusal, a bad state parameter or an expired token exchange
     all land on. */
  await page.goto("/auth/error?code=invalid_state");

  await expect(page.locator("body")).toHaveAttribute("data-state", "incomplete");
  await expect(page.getByText("Sign-in didn’t complete.")).toBeVisible();
  await expect(page.getByText("Nothing was changed.")).toBeVisible();
  /* Never the code, never a provider's own words, never an address. */
  await expect(page.locator(".state")).not.toContainText("invalid_state");
  await expect(page.locator(".state")).not.toContainText("@");

  const gate = page.locator("#gate");
  await expect(gate).toBeVisible();
  await expect(gate).toHaveText("Try again");

  await sweep(page);

  /* The one action: back to the door, not straight to the provider (unlike
     the ratified "Sign in" gate's own `press`, which leaves for
     /api/auth/login directly) -- round-1's own build note. */
  await gate.click();
  await expect(page).toHaveURL(/\/login$/);
});

test("account disabled: refused, no pill, the administrator named plainly", async ({ page }) => {
  await page.goto("/auth/error?code=account_disabled");

  await expect(page.locator("body")).toHaveAttribute("data-state", "refused");
  await expect(page.getByText("Sign-in was refused.")).toBeVisible();
  await expect(page.getByText("The administrator has disabled this account.")).toBeVisible();
  await expect(page.locator(".state")).not.toContainText("@");

  /* A retry is a lie here (round-1 README): not hidden, absent -- the same
     accessibility bar the three older held-dawn states hold. */
  await expect(page.locator("#gate")).toHaveCount(0);

  await sweep(page);
});

test("an unrecognised or missing code fails open to the recoverable face, never to refused", async ({ page }) => {
  /* asAuthError folds an unrecognised server-side error to provider_error,
     but a stranger can land on this address with any string, or none at all
     -- and the one face that must never be reached by a guess is the one
     that tells a genuine account holder they are switched off. */
  await page.goto("/auth/error?code=something-nobody-sent");
  await expect(page.locator("body")).toHaveAttribute("data-state", "incomplete");
  await expect(page.locator("#gate")).toBeVisible();

  await page.goto("/auth/error");
  await expect(page.locator("body")).toHaveAttribute("data-state", "incomplete");
  await expect(page.locator("#gate")).toBeVisible();
});
