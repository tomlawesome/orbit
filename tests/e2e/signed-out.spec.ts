import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("signed-out visitors see only the authentication boundary", async ({ page, request }) => {
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

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to Orbit." })).toBeVisible();
  await expect(page.getByRole("link", { name: /Sign in securely/ })).toHaveAttribute("href", "/api/auth/login");
  await expect(page.getByText("Your household information is private")).toBeVisible();
  // The v19 shell chrome — orb, account panel, drawers — must not exist at
  // all when signed out, and neither must the chrome it replaced.
  await expect(page.locator("button.orb")).toHaveCount(0);
  await expect(page.locator(".account, #createdrawer, #statusdrawer, #keydrawer")).toHaveCount(0);
  await expect(page.locator(".sidebar, header.topbar, button.topbar-profile, .item-list, .household-control")).toHaveCount(0);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", /icon\.svg/);

  // The v19 family surface (design/family/login.html), and only it: one
  // main landmark, one h1, and exactly one action — the way in.
  await expect(page.locator("main.family-stage")).toHaveCount(1);
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator("main.family-stage").getByRole("link")).toHaveCount(1);
  await expect(page.locator(".app-frame")).toHaveCount(0);

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Sign in to Orbit." })).toBeVisible();
  await expect(page.locator(".settings-page, .settings-section-nav, .settings-content")).toHaveCount(0);
});

test("a completed sign-out is confirmed without dropping the boundary", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to Orbit." })).toBeVisible();

  // The goodbye screen is handed over by the document that signed out
  // (src/lib/signed-out-notice.ts). Seeding the notice as an earlier
  // document stands in for the sign-out itself, which needs the disposable
  // OIDC profile the authenticated specs use; online-workspace-policy.spec.ts
  // covers the real round trip.
  await page.evaluate(() => window.sessionStorage.setItem("orbit:signed-out:v1", "an-earlier-document"));
  await page.reload();

  await expect(page.getByRole("heading", { name: "Sign in to Orbit." })).toBeVisible();
  await expect(page.getByText("You are signed out on this device.")).toBeVisible();
  await expect(page.getByRole("link", { name: /Sign back in/ })).toHaveAttribute("href", "/api/auth/login");
  await expect(page.locator(".family-screen")).toHaveAttribute("data-phase", "set");
  await expect(page.locator(".sidebar, .item-list, .household-control")).toHaveCount(0);

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);

  // One-shot: a reload is a plain visit again, not a second goodbye.
  await page.reload();
  await expect(page.getByRole("link", { name: /Sign in securely/ })).toBeVisible();
  await expect(page.getByText("You are signed out on this device.")).toHaveCount(0);
});

test("an unknown address gets the not-found screen, and learns nothing from it", async ({ page }) => {
  const householdId = "00000000-0000-4000-8000-000000000002";
  const response = await page.goto(`/households/${householdId}/private-page`);
  expect(response?.status()).toBe(404);

  await expect(page.getByRole("heading", { name: "This page has drifted off the chart" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Return to your orbit/ })).toHaveAttribute("href", "/");
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.getByText(householdId)).toHaveCount(0);
  await expect(page.locator(".app-frame, .sidebar, .item-list, .settings-page")).toHaveCount(0);

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("an interrupted sign-in explains itself without echoing the provider", async ({ page }) => {
  await page.goto("/auth/error?code=invalid_state");

  await expect(page.getByRole("heading", { name: "We couldn't sign you in." })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("The sign-in request expired or could not be matched to this browser.");
  await expect(page.getByRole("link", { name: "Return home" })).toHaveAttribute("href", "/");

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("the signed-out boundary has no automated WCAG A or AA violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to Orbit." })).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  expect(results.violations).toEqual([]);
});

test("the family screens fit the mobile viewport", async ({ page, isMobile }) => {
  test.skip(!isMobile, "Mobile viewport check");

  async function expectNoSidewaysScroll() {
    const viewport = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(viewport.scrollWidth).toBe(viewport.clientWidth);
  }

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to Orbit." })).toBeVisible();
  await expectNoSidewaysScroll();

  // The not-found screen's giant numerals and drifting derelict are wider
  // than the viewport by design, so they are the sideways-scroll risk.
  await page.goto("/no-such-page");
  await expect(page.getByRole("heading", { name: "This page has drifted off the chart" })).toBeVisible();
  await expectNoSidewaysScroll();
});

test("confirmed degraded readiness shows startup wording and then recovers", async ({ page }) => {
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
  await expect(page.getByRole("heading", { name: "Sign in to Orbit." })).toBeVisible();
  expect(healthChecks).toBeGreaterThanOrEqual(2);
});

test("missing authentication configuration shows fixed administrator guidance", async ({ page }) => {
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
