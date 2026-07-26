import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("signed-out visitors see only the authentication boundary", async ({ page, request }) => {
  const workspaceResponse = await request.get("/api/workspace");
  expect(workspaceResponse.status()).toBe(401);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to Orbit." })).toBeVisible();
  await expect(page.getByRole("link", { name: /Sign in securely/ })).toHaveAttribute("href", "/api/auth/login");
  await expect(page.locator(".sidebar, .item-list, .household-control")).toHaveCount(0);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", /icon\.svg/);
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
