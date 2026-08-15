import { expect, test } from "@playwright/test";

// #450: the composite container entry serves the Next.js application and the
// v19 front end from ONE process on ONE origin, dispatched by path. This spec
// is the slice's definition of done: a real login whose returnTo lands on a
// v19 screen, with the session issued and honoured on that same origin.
test.describe("composite entry", () => {
  test("signing in with returnTo=/home lands on the v19 home", async ({ page }) => {
    await page.goto("/api/auth/login?returnTo=/home");
    await page.getByRole("link", { name: "Orbit Administrator" }).click();
    await expect(page).toHaveURL(/\/home$/);
    // The gravity-well dial only exists in the v19 markup.
    await expect(page.locator(".dialwrap")).toBeVisible();
    const session = await page.evaluate(async () => {
      const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
      return (await response.json()) as { authenticated?: boolean };
    });
    expect(session.authenticated).toBe(true);
  });

  test("the v19 client assets come from the one origin", async ({ page }) => {
    const scriptResponses: number[] = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith("/_app/")) scriptResponses.push(response.status());
    });
    const response = await page.goto("/home");
    expect(response?.status()).toBe(200);
    await expect(page.locator(".dialwrap")).toBeVisible();
    expect(scriptResponses.length).toBeGreaterThan(0);
    expect(scriptResponses.every((status) => status === 200)).toBe(true);
  });
});
