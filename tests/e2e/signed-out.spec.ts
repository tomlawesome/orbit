import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/*
 * The signed-out boundary, after the cut (#735).
 *
 * Two halves, and they are held in different places. The API refuses a
 * signed-out request itself — `web/src/lib/server/api.js` wraps every handler
 * with `requireSession` — while the screens are gated by the `handle` hook in
 * `web/src/hooks.server.js` (#789). Both are asserted here, because losing
 * either one is a boundary failure and only one of them is visible in a
 * browser.
 *
 * The assertions this file used to carry against `/workspace` and `/settings`
 * belonged to Next's AuthenticationGate, which the cut deleted (#787). Their
 * replacements are the gate cases below.
 */

test("signed-out visitors get 401 from every workspace API route", async ({ request }) => {
  const workspaceResponse = await request.get("/api/workspace");
  expect(workspaceResponse.status()).toBe(401);
  const documentId = "00000000-0000-4000-8000-000000000001";
  const householdId = "00000000-0000-4000-8000-000000000002";
  const itemId = "00000000-0000-4000-8000-000000000003";
  const documentListPath = `/api/households/${householdId}/items/${itemId}/documents`;
  for (const response of await Promise.all([
    request.get(documentListPath),
    request.post(documentListPath, { data: "%PDF-1.7" }),
    request.get(`/api/documents/${documentId}/download`),
    request.delete(`/api/documents/${documentId}`),
    request.post(`/api/documents/${documentId}/restore`),
    request.get("/api/admin/documents/health"),
  ])) {
    expect(response.status()).toBe(401);
  }
});

test("the arrival shows the ratified door and nothing of the workspace", async ({ page }) => {
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
  // The mark the cut dropped and #780 restored.
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", /icon\.svg/);
});

test("a gated screen redirects on the server, before any of it is sent", async ({ request }) => {
  // The assertion that tells this gate apart from a browser-side redirect: the
  // screen's HTML is never sent at all. A 200 here is the bug (#789).
  const response = await request.get("/settings", { maxRedirects: 0 });
  expect(response.status()).toBe(303);
  expect(response.headers()["location"]).toBe("/login?returnTo=%2Fsettings");
});

test("a gated screen lands the reader on the door", async ({ page }) => {
  await page.goto("/settings");
  expect(page.url()).toContain("/login?returnTo=%2Fsettings");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.locator(".settings-page, .settings-section-nav, .settings-content")).toHaveCount(0);
});

test("the gate is the default, not a list of remembered screens", async ({ page, request }) => {
  // A second screen, because the point of a `handle` hook is that no screen
  // has to be remembered. If this one needed adding to an allowlist somewhere,
  // the gate is the wrong shape.
  const response = await request.get("/administration", { maxRedirects: 0 });
  expect(response.status()).toBe(303);
  expect(response.headers()["location"]).toBe("/login?returnTo=%2Fadministration");

  await page.goto("/administration");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("the query string survives the trip to the door", async ({ request }) => {
  const response = await request.get("/inbox?filter=due", { maxRedirects: 0 });
  expect(response.status()).toBe(303);
  expect(response.headers()["location"]).toBe("/login?returnTo=%2Finbox%3Ffilter%3Ddue");
});

test("a junk session cookie is refused exactly like no cookie at all", async ({ request }) => {
  // Failure modes must not be distinguishable from outside: an unconfigured
  // provider, an unreachable database and a forged cookie all converge on the
  // door, so a stranger learns nothing about which it was.
  const response = await request.get("/settings", {
    maxRedirects: 0,
    headers: { cookie: "orbit-session=not-a-real-session; __Host-orbit-session=not-a-real-session" },
  });
  expect(response.status()).toBe(303);
  expect(response.headers()["location"]).toBe("/login?returnTo=%2Fsettings");
});

for (const path of ["/", "/login", "/logout"]) {
  test(`${path} stays reachable signed out`, async ({ request }) => {
    // The allowlist. The door and the goodbye are the boundary itself.
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status()).toBe(200);
  });
}

test("/maintenance signed out and outside a window goes home, not to the door", async ({ request }) => {
  // Open too — maintenance has to answer precisely when nothing else can —
  // but with no window open it has nothing to say, so it sends the reader
  // to the arrival rather than the login (#526). Inside a window it is the
  // 503 body itself; tests/e2e/maintenance.spec.ts covers that.
  const response = await request.get("/maintenance", { maxRedirects: 0 });
  expect(response.status()).toBe(303);
  expect(response.headers()["location"]).toBe("/");
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
