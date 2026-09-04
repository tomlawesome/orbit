import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { cleanupHousehold, sessionHeaders } from "./support/households";

// #450, re-solved by #735: there is no longer anything to compose. The v19
// front end and the API are one SvelteKit server on one origin, so the path
// dispatch this spec was written to prove is gone. What it proves still
// matters and is unchanged: a real login whose returnTo lands on a v19 screen,
// with the session issued and honoured on that same origin, and the client
// assets served from it.
/* #730: both tests below assert the home dial is drawn, and the dial needs a
   household to draw. Neither created one -- they were reading a household some
   other spec had leaked, and once the leaks were swept this file failed. So it
   makes its own and removes it again. */
async function seedHousehold(page: Page) {
  const household = { id: randomUUID(), name: `Composite entry ${randomUUID().slice(0, 8)}` };
  const created = await page.request.post("/api/workspace/commands", {
    headers: { ...(await sessionHeaders(page)), "content-type": "application/json" },
    data: {
      type: "household.create",
      household: { ...household, timezone: "Europe/London", currency: "GBP", onboardingComplete: true },
    },
  });
  if (!created.ok()) throw new Error(`Could not seed the composite-entry household (${created.status()})`);
  return household;
}

test.describe("the application entry", () => {
  test("signing in with returnTo=/home lands on the v19 home", async ({ page }) => {
    await page.goto("/api/auth/login?returnTo=/home");
    await page.getByRole("link", { name: "Orbit Administrator" }).click();
    await expect(page).toHaveURL(/\/home$/);
    const household = await seedHousehold(page);
    try {
    await page.reload();
    // Both v19 home dialects are server-rendered and CSS chooses (CON-10):
    // the gravity-well dial on desktop, the pocket dial on mobile. Exactly
    // one hero may be visible — and neither exists in the Next markup.
    await expect(page.locator(".dialwrap, .mdial").filter({ visible: true })).toHaveCount(1);
    const session = await page.evaluate(async () => {
      const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
      return (await response.json()) as { authenticated?: boolean };
    });
    expect(session.authenticated).toBe(true);
    } finally {
      await cleanupHousehold(page, await sessionHeaders(page), household.id, household.name);
    }
  });

  // #451: signed out, a v19 screen is a journey into login and back to the
  // exact page — and once back, the client assets all arrive from this origin.
  //
  // #789 put the ratified dawn in the middle of that journey. Before the gate,
  // /home rendered and its own client-side check threw the reader at the
  // identity provider, so the door they never saw was the provider's. Now the
  // server redirects first and they meet Orbit's own door, which is what §15
  // asks for: the dawn ships as THE login screen for every user, every time.
  // The screen they asked for rides along on returnTo and they still land on
  // it, which is the part this test has always been about (owner, 2026-09-04).
  test("a signed-out visit lands in login and returns to the page it wanted", async ({ page }) => {
    const scriptResponses: number[] = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith("/_app/")) scriptResponses.push(response.status());
    });
    await page.goto("/home");
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fhome$/);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("link", { name: "Orbit Administrator" }).click();
    await expect(page).toHaveURL(/\/home$/);
    const household = await seedHousehold(page);
    try {
      await page.reload();
      await expect(page.locator(".dialwrap, .mdial").filter({ visible: true })).toHaveCount(1);
      expect(scriptResponses.length).toBeGreaterThan(0);
      expect(scriptResponses.every((status) => status === 200)).toBe(true);
    } finally {
      await cleanupHousehold(page, await sessionHeaders(page), household.id, household.name);
    }
  });
});
