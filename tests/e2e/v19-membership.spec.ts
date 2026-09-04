import { expect, test, type Browser, type Page } from "@playwright/test";
import { householdRegister } from "./support/households";

/**
 * #453: membership and the empty sky (§11). A newcomer with no household
 * sees the labelled sky, asks to join, an owner approves, and the newcomer's
 * next visit is a member's home. No interception — every step is the real
 * pipe.
 *
 * §15-2g moved the owner's decision OFF the administration screen: join
 * requests live in household management only, and administration no longer
 * draws them. Household management is not built yet, so there is currently
 * no v19 screen on which this approval can be clicked. Rather than delete
 * the arc — sky → ask → approved → member's home is the thing worth
 * guarding — the approval step drives the real API the way the screen will
 * (GET /api/join-requests, POST /api/join-requests/{id}) from the owner's
 * own signed-in browser. Put it back on the UI when household-manage lands.
 */

const HOUSEHOLD = `Harbour House ${Date.now()}`;

/* #730: the member's system is removed when the file is done, from the
   administrator's own session — a hard delete is an instance-admin power, and
   the owner here is an ordinary member. */
const households = householdRegister();
let seeded = false;

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
  const created = await page.evaluate(async (householdName) => {
    const session = (await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { csrfToken: string };
    const householdId = crypto.randomUUID();
    const response = await fetch("/api/workspace/commands", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({
        type: "household.create",
        household: {
          id: householdId, name: householdName, timezone: "Europe/London", currency: "GBP",
          memberCount: 1, canManage: true, onboardingComplete: true,
          sections: [{ id: crypto.randomUUID(), name: "Home", icon: "home", accent: "sage", visible: true }],
          items: [],
        },
      }),
    });
    if (!response.ok) throw new Error(`household.create failed: ${response.status}`);
    return { id: householdId, name: householdName };
  }, name);
  households.track(created);
  seeded = true;
}

/* The owner's decision, as household management will make it (§15-2g): the
 * real listing, then the real decision route, from the owner's own session.
 * Returns the request the server decided so the caller can assert on it. */
async function approveJoinRequest(page: Page, householdName: string, applicant: string) {
  return page.evaluate(async ([household, who]) => {
    const session = (await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { csrfToken: string };
    const listing = await fetch("/api/join-requests", { credentials: "same-origin", cache: "no-store" });
    if (!listing.ok) throw new Error(`join-requests listing failed: ${listing.status}`);
    const { requests } = (await listing.json()) as {
      requests: { id: string; householdName: string; displayName: string }[];
    };
    const pending = requests.find((one) => one.householdName === household && one.displayName === who);
    if (!pending) {
      throw new Error(`no pending request from ${who} for ${household}; saw ${JSON.stringify(requests)}`);
    }
    const decision = await fetch(`/api/join-requests/${pending.id}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({ action: "approve" }),
    });
    if (!decision.ok) throw new Error(`approve failed: ${decision.status}`);
    return (await decision.json()) as { request: { status: string; householdId: string } };
  }, [householdName, applicant] as const);
}

test.describe.configure({ mode: "serial" });

test.afterAll(async ({ browser }) => {
  if (!seeded) return;
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await signInAs(page, "Orbit Administrator");
    await households.sweep(page);
  } finally {
    await context.close();
  }
});

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

  /* The owner approves. §15-2g: this no longer happens on administration —
     that screen dropped its join-request block, and household management,
     the one place the decision now lives, is not built yet. Until it is, the
     journey exercises the same routes the screen will call, from the owner's
     signed-in session. */
  const decided = await approveJoinRequest(ownerPage, HOUSEHOLD, "Orbit Outsider");
  expect(decided.request.status).toBe("approved");

  /* And administration honours the ruling: no join-request UI on it at all. */
  await ownerPage.goto("/administration");
  await expect(ownerPage.getByRole("heading", { name: "Administration" })).toBeVisible();
  /* the panels have rendered, so their absence below is a real absence */
  await expect(ownerPage.locator(".card").first()).toBeVisible();
  await expect(ownerPage.locator(".joinreq")).toHaveCount(0);
  await expect(ownerPage.locator(".joinbadge")).toHaveCount(0);

  /* The newcomer's next visit is a member's home: the dial exists now. */
  await page.goto("/home");
  await expect(page.locator(".dialwrap")).toBeVisible();
  await expect(page.getByRole("heading", { name: "you’re adrift" })).toHaveCount(0);
  await expect(page.locator("#dial-name")).toHaveText(HOUSEHOLD);

  await ownerContext.close();
});
