import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { resetDatabaseBetweenSpecFiles } from "./support/database";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   lists these specs walk carry nothing an earlier spec left behind. */
resetDatabaseBetweenSpecFiles();

/*
 * The signed-out boundary, after the cut (#735).
 *
 * What stays here is what needs a browser: the door as drawn, where a gated
 * screen lands the reader, and the door's accessibility and phone fit. The
 * boundary's status codes moved lower (#1612, ADR-0039): the API's 401s are in
 * tests/integration/authorization-matrix.test.ts, and the `handle` hook's gate
 * (303 to the door, the query carried, a junk cookie, the open paths) in
 * tests/unit/hooks-server-signed-out.test.mjs (#789). One case stays as an API
 * case: SvelteKit 3's same-origin check (#1565) runs in the framework, before
 * any handler, so only a real server can show it.
 */

test("with no Origin header, a bodyless or form-typed write is refused 403 by the same-origin check, and a non-form write reaches the sign-in check and gets 401", async ({ request }) => {
  /* #1565: the other half of the case above. SvelteKit 3 refuses a write
     without a matching `Origin` only when it is bodyless or carries a form
     content type (application/x-www-form-urlencoded, multipart/form-data,
     text/plain), which is what a browser can send cross-site without a CORS
     preflight. Those are refused 403 before `requireSession` is reached. Any
     other body type needs a preflight, so the check lets it through and it
     meets the sign-in check: 401. Headers are set explicitly so the case does
     not lean on Playwright's default content type. */
  const documentId = "00000000-0000-4000-8000-000000000001";
  const householdId = "00000000-0000-4000-8000-000000000002";
  const itemId = "00000000-0000-4000-8000-000000000003";
  const documentListPath = `/api/households/${householdId}/items/${itemId}/documents`;
  const [bodylessDelete, formTypedPost, nonFormPost] = await Promise.all([
    request.delete(`/api/documents/${documentId}`),
    request.post(documentListPath, { data: "%PDF-1.7", headers: { "content-type": "text/plain" } }),
    request.post(documentListPath, { data: "%PDF-1.7", headers: { "content-type": "application/pdf" } }),
  ]);
  expect(bodylessDelete.status()).toBe(403);
  expect(formTypedPost.status()).toBe(403);
  expect(nonFormPost.status()).toBe(401);
});

test("the arrival shows the ratified door and nothing of the workspace", async ({ page, request }) => {
  // #410/§15: "/" is the ratified v19 sign-in now — the door every reader
  // meets.
  await page.goto("/");
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
  // root-relative href and the DOM hands back the absolute URL it resolves to,
  // so an exact "/icon.svg" can never match. Each `type` selector is what
  // pins the right link to the right file.
  await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute("href", /\/icon\.svg$/);
  await expect(page.locator('link[rel="icon"][type="image/png"]')).toHaveAttribute("href", /\/icon-32\.png$/);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", /\/apple-touch-icon\.png$/);
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest.icons.map((icon: { src: string }) => icon.src)).toEqual(["/icon.svg", "/icon-192.png", "/icon-512.png"]);
});

test("a gated screen lands the reader on the door", async ({ page }) => {
  await page.goto("/settings");
  expect(page.url()).toContain("/login?returnTo=%2Fsettings");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.locator(".settings-page, .settings-section-nav, .settings-content")).toHaveCount(0);
});

test("the signed-out boundary has no automated WCAG A or AA violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  expect(results.violations).toEqual([]);
});

test("the signed-out boundary fits the mobile viewport", async ({ page, isMobile }) => {
  test.skip(!isMobile, "Mobile viewport check");
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(viewport.scrollWidth).toBe(viewport.clientWidth);
});

/*
 * WHAT A STRANGER LEARNS BY ASKING (#916, ADR-0023 §1): which identity
 * provider this instance trusts is reconnaissance, and nothing a visitor is
 * owed. The availability answer's bounded shape is pinned in
 * tests/unit/availability-route.test.mjs, and the identical answers for a
 * known and an unknown address in tests/integration/local-sign-in.test.ts
 * (#1612); what is left here is the served markup, which needs the built app.
 */
test("the door's own markup says nothing of which identity provider this instance trusts", async ({ request }) => {
  /* The provider's identity reaches the browser exactly once -- in the
     redirect a reader gets after pressing Sign in -- and never before. */
  for (const path of ["/", "/login"]) {
    const screen = await request.get(path);
    const markup = await screen.text();
    for (const leak of ["openid-configuration", ".well-known", "client_id", "OIDC_ISSUER"]) {
      expect(markup, `${path} names ${leak}`).not.toContain(leak);
    }
  }
});

/*
 * The three states below have no v19 home yet (#788). `SignIn.svelte` is the
 * door and only the door: it carries no wording for an instance that is still
 * starting, and none for one whose authentication is misconfigured.
 *
 * Skipped rather than deleted, and kept in full rather than trimmed, because
 * one of them asserts a security property — that provider-supplied text never
 * reaches the page — and a deleted test is indistinguishable from a property
 * nobody wanted. They fail against v19 today; they are the acceptance evidence
 * for #788 when it lands.
 */
test.skip("confirmed degraded readiness shows startup wording and then recovers (#788)", async ({ page }) => {
  let healthChecks = 0;
  await page.route("**/api/health", async (route) => {
    healthChecks += 1;
    const ready = healthChecks > 1;
    await route.fulfill({
      status: ready ? 200 : 503,
      contentType: "application/json",
      body: JSON.stringify({ status: ready ? "ready" : "degraded", service: "orbit" }),
    });
  });
  await page.route("**/api/auth/session", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "session_required", message: "Authentication is required" } }),
  }));

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Orbit is starting…" })).toBeVisible();
  await expect(page.getByText("Orbit is starting. Please wait while the service becomes ready.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  expect(healthChecks).toBeGreaterThanOrEqual(2);
});

test.skip("missing authentication configuration shows fixed administrator guidance (#788)", async ({ page }) => {
  const hostileProviderDetail = "provider-secret-sentinel.invalid/private-tenant";
  await page.route("**/api/health", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ status: "ready", service: "orbit" }),
  }));
  await page.route("**/api/auth/session", (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({
      error: { code: "auth_not_configured", message: hostileProviderDetail },
    }),
  }));

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Orbit could not open safely." })).toBeVisible();
  await expect(page.getByText("Orbit sign-in is not configured. Ask your administrator to configure authentication, then try again.")).toBeVisible();
  await expect(page.getByText(hostileProviderDetail)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Try again/ })).toBeVisible();
});
