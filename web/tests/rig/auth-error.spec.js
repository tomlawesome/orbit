import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { APP } from "./a11y-support.js";

/** @typedef {import("@playwright/test").Page} Page */

/*
 * #1056, moved to the rig (ADR-0039, #1610): `/auth/error?code=…`, where a
 * failed OIDC callback sends the browser. The screen reads nothing but its own
 * `code` query parameter (+page.svelte, +page.js), so the fixture route's own
 * address is the whole of its state: no session, no database, no provider.
 *
 * What a browser is still needed for here, and so stays: the screen's own
 * `data-state` face for a code, that the page draws the words and never the
 * code, that "Try again" is the one way back to the door, that the refused
 * face has no pill at all, the pocket's width, and axe.
 *
 * What does not: which face a code wears and the fixed words of each are
 * pinned without a browser in tests/unit/auth-error-state.test.mjs, so the
 * stack suite's "an unrecognised or missing code fails open to the recoverable
 * face" went there (see the commit for the lines).
 *
 * `reducedMotion: "reduce"` file-wide, as the stack version had it: the "Try
 * again" pill's navigation is instant by design under it (`rm ? 200 : 900` in
 * +page.svelte), so these tests do not wait out the ratified 900ms beat for
 * something the beat itself does not assert.
 */
test.use({ baseURL: APP, reducedMotion: "reduce" });

/**
 * The WCAG sweep every held-dawn face has to pass.
 * @param {Page} page
 */
async function sweep(page) {
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

/* #1457: ADR-0023 §3's `link_required` refusal carries its remedy. The words
   themselves are pinned in tests/unit/auth-error-state.test.mjs; what is
   asserted here is that the page passes the code through (the ordinary words
   never mention Settings), keeps the way back, and fits the pocket's width. */
test("link required: says to link from Settings, keeps the way back, fits the width", async ({ page }) => {
  await page.goto("/auth/error?code=link_required");

  await expect(page.locator("body")).toHaveAttribute("data-state", "incomplete");
  const state = page.locator(".state");
  await expect(state).toBeVisible();
  await expect(state).toContainText(/settings/i);
  await expect(state).not.toContainText("link_required");

  /* The way back to the door stays. */
  await expect(page.locator("#gate")).toBeVisible();

  /* Longer words must still fit the pocket's width. */
  const box = await state.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(/** @type {NonNullable<typeof box>} */ (box).x).toBeGreaterThanOrEqual(0);
  expect(/** @type {NonNullable<typeof box>} */ (box).x + /** @type {NonNullable<typeof box>} */ (box).width)
    .toBeLessThanOrEqual(/** @type {NonNullable<typeof viewport>} */ (viewport).width);

  await sweep(page);
});
