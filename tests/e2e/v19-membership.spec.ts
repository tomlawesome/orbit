import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * #453: membership and the empty sky (§11). A newcomer with no household
 * sees the labelled sky, asks to join, an owner approves on administration,
 * and the newcomer's next visit is a member's home. No interception — every
 * step is the real pipe.
 */

const HOUSEHOLD = `Harbour House ${Date.now()}`;

async function signInAs(page: Page, account: string) {
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: account }).click();
  await expect(page).toHaveURL(/\/home$/);
}

/* A fresh instance promotes its first sign-in to instance admin — and an
 * admin never sees the empty sky (they see everything, §11). Claim the
 * promotion for the administrator so everyone below is ordinary. */
async function establishInstanceAdmin(browser: Browser) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await signInAs(page, "Orbit Administrator");
  await context.close();
}

async function createHousehold(page: Page, name: string) {
  await page.evaluate(async (householdName) => {
    const session = (await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { csrfToken: string };
    const response = await fetch("/api/workspace/commands", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({
        type: "household.create",
        household: {
          id: crypto.randomUUID(), name: householdName, timezone: "Europe/London", currency: "GBP",
          memberCount: 1, canManage: true, onboardingComplete: true,
          sections: [{ id: crypto.randomUUID(), name: "Home", icon: "home", accent: "sage", visible: true }],
          items: [],
        },
      }),
    });
    if (!response.ok) throw new Error(`household.create failed: ${response.status}`);
  }, name);
}

test.describe.configure({ mode: "serial" });

test("a newcomer sees the labelled sky, asks, is approved, and enters the system", async ({ page, browser }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the journey is asserted on the desk dialect");
  test.setTimeout(120_000);

  await establishInstanceAdmin(browser);

  /* The member owns a household for the newcomer to ask into. */
  const ownerContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const ownerPage = await ownerContext.newPage();
  await signInAs(ownerPage, "Orbit Member");
  await createHousehold(ownerPage, HOUSEHOLD);

  /* The newcomer: no membership, so the sky is labels — no dial, no manifest. */
  await signInAs(page, "Orbit Outsider");
  await expect(page.getByRole("heading", { name: "you’re adrift" })).toBeVisible();
  await expect(page.locator(".dialwrap")).toHaveCount(0);
  const target = page.locator(".minisys", { hasText: HOUSEHOLD.toUpperCase() });
  await expect(target).toBeVisible();

  /* The label is the surface; the question is the dialogue. */
  await target.click();
  await expect(page.getByRole("heading", { name: `Request to join ${HOUSEHOLD} system?` })).toBeVisible();
  await page.locator(".askcard").getByRole("button", { name: "request to join" }).click();
  await expect(target.locator("text=ASKED TO JOIN · WAITING")).toBeVisible();

  /* Asking again does nothing — the pending state absorbs the tap. */
  await target.click();
  await expect(page.getByRole("heading", { name: /Request to join/ })).toHaveCount(0);

  /* The owner sees the request on administration and approves it. */
  await ownerPage.goto("/administration");
  const request = ownerPage.locator(".joinreq", { hasText: "Orbit Outsider" });
  await expect(request).toBeVisible();
  await expect(request).toContainText(HOUSEHOLD);
  await request.getByRole("button", { name: "approve" }).click();
  await expect(ownerPage.locator(".joinreq", { hasText: "Orbit Outsider" })).toHaveCount(0);

  /* The newcomer's next visit is a member's home: the dial exists now. */
  await page.goto("/home");
  await expect(page.locator(".dialwrap")).toBeVisible();
  await expect(page.getByRole("heading", { name: "you’re adrift" })).toHaveCount(0);
  await expect(page.locator("#dial-name")).toHaveText(HOUSEHOLD);

  await ownerContext.close();
});
