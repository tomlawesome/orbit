import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { APP, door, onPhone } from "./a11y-support.js";

/*
 * THE SIGNED-OUT BOUNDARY, as the door draws it (#735, #410), moved to the rig
 * (ADR-0039, #1611) from tests/e2e/signed-out.spec.ts.
 *
 * What a browser shows a reader with no session: the ratified door and nothing
 * of the workspace, its marks, its accessibility and its phone fit. The door is
 * the fixture's `door` / `rest` state (the same health, availability and
 * session answers the gate gives a stranger).
 *
 * Gone from here: "a gated screen lands the reader on the door" is the server
 * hook's gate, tests/unit/hooks-server-signed-out.test.mjs:86 (303 to
 * /login?returnTo=%2Fsettings) and :95 (the query carried); under fixtures the
 * gate is bypassed, so a rig test could not show it. Staying on the stack, in
 * tests/e2e/signed-out.spec.ts: SvelteKit's same-origin check, the served
 * markup saying nothing of the provider, and the two skipped #788 cases.
 */
test.use({ baseURL: APP });

test("the arrival shows the ratified door and nothing of the workspace", async ({ page, request }) => {
  await door("door", "rest")(page);
  // The gate reads "Sign in" since the 2026-08-17 reconciliation: the flight's
  // login screen went back to the ratified 2026-08-14 one, whose pill sits
  // inside the ring and carries that word (§15).
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.locator("#dawn .lockup .name")).toHaveText("orbit");
  // No ribbon and no footer on the login — owner, verbatim: "there shouldnt be
  // a footer" (§15, 2026-08-17). This is the assertion that keeps it gone.
  await expect(page.locator("#dawn .below")).toHaveCount(0);
  await expect(page.locator("button.topbar-profile")).toHaveCount(0);
  await expect(page.locator(".sidebar, .item-list, .household-control")).toHaveCount(0);
  // The mark the cut dropped, #780 restored and #1009 redrew: the SVG for
  // browsers that take one, a PNG for the rest, and the manifest naming the
  // same file — a tab and an installed app must never show two marks again.
  // Anchored on the file, not on the whole value: app.html writes a
  // root-relative href and the DOM hands back the absolute URL it resolves to.
  await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute("href", /\/icon\.svg$/);
  await expect(page.locator('link[rel="icon"][type="image/png"]')).toHaveAttribute("href", /\/icon-32\.png$/);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", /\/apple-touch-icon\.png$/);
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest.icons.map((/** @type {{ src: string }} */ icon) => icon.src)).toEqual(["/icon.svg", "/icon-192.png", "/icon-512.png"]);
});

test("the signed-out boundary has no automated WCAG A or AA violations", async ({ page }) => {
  await door("door", "rest")(page);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  expect(results.violations).toEqual([]);
});

test("the signed-out boundary fits the mobile viewport", async ({ page }, testInfo) => {
  test.skip(!onPhone(testInfo), "Mobile viewport check");
  await door("door", "rest")(page);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(viewport.scrollWidth).toBe(viewport.clientWidth);
});
