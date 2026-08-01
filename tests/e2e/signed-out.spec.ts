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
  await expect(page.locator(".sidebar, .item-list, .household-control")).toHaveCount(0);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", /icon\.svg/);

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Sign in to Orbit." })).toBeVisible();
  await expect(page.locator(".settings-page, .settings-tabs, .settings-content")).toHaveCount(0);
});

test("the signed-out boundary has no automated WCAG A or AA violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to Orbit." })).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  expect(results.violations).toEqual([]);
});

test("the authentication boundary fits the mobile viewport", async ({ page, isMobile }) => {
  test.skip(!isMobile, "Mobile viewport check");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to Orbit." })).toBeVisible();
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(viewport.scrollWidth).toBe(viewport.clientWidth);
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
