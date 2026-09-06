import { expect, test, type Page } from "@playwright/test";
import { householdRegister } from "./support/households";

/**
 * THE FIRST-RUN DOOR, EVERYWHERE (#840).
 *
 * `/` is the only screen that ever reads GET /api/workspace and decides
 * create vs. newcomer vs. onward (web/src/lib/arrival/stage.js's
 * arrivalStageOf) -- but a signed-out reader who first tried to open /home
 * (every "start your own system" pointer on it used to lead straight to the
 * item form) was bounced by hooks.server.js to
 * `/login?returnTo=/home`, and the OIDC callback returned them to exactly
 * that path afterwards. Nothing then sent them on to the arrival: they landed
 * on /home itself, having never met the create card at all.
 *
 * This spec is the one journey v19-arrival.spec.ts cannot be: every other
 * arrival test signs in AT `/` (through its own gate, or straight at the
 * login route with no returnTo). This one signs in with `returnTo=/home`,
 * the road #840 exists to fix, and asserts the browser ends up at `/` anyway
 * before it ever gets a household.
 *
 * ITS OWN IDENTITY, for the reason "newcomer" needed a fourth: the database
 * is not reset between specs, and this journey's precondition is a reader who
 * belongs to NOTHING. "Doorstep" is signed in nowhere else.
 */

const OWN_SYSTEM = `Doorstep's Own ${Date.now()}`;
const households = householdRegister();
let seeded = false;

/** The way every other spec signs in, with an explicit returnTo. */
async function signInAs(page: Page, account: string, returnTo = "/") {
  await page.goto(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole("link", { name: account }).click();
}

test.describe.configure({ mode: "serial" });

test.afterAll(async ({ browser }) => {
  if (!seeded) return;
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await signInAs(page, "Orbit Administrator", "/home");
    await expect(page).toHaveURL(/\/home$/);
    await households.sweep(page);
  } finally {
    await context.close();
  }
});

test("a fresh sign-in returned to /home meets the arrival, not the item form", async ({ page }) => {
  test.setTimeout(120_000);

  /* THE WHOLE POINT: a signed-out visit to /home is exactly what carries this
     returnTo (hooks.server.js's OPEN_ROUTES gate, then the login route's own
     redirect), and the OIDC callback returns the browser to it verbatim
     (web/src/routes/api/auth/callback/+server.js). A session with no active
     household is sent to `/` regardless of the URL it was returned to -- that
     is the server hook this spec exists to prove, not the arrival's own
     client-side decision, which every other arrival spec already covers by
     visiting `/` directly. */
  await signInAs(page, "Orbit Doorstep", "/home");
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });

  /* Whichever stage answers. A genuinely empty instance answers with the
     create card directly (arrivalStageOf's CREATE); the likelier case, since
     the database survives every spec in a run, is the newcomer's arrival,
     whose own "or name your own system" reaches the identical card
     (v19-arrival.spec.ts's "THE GAP" note explains why this suite cannot
     promise CREATE outright). Either way the card, the command and the
     landing under test are the same one. */
  const newcomerQuestion = page.getByRole("heading", { name: "where do you belong?" });
  const createCard = page.locator(".card");
  await expect(newcomerQuestion.or(createCard)).toBeVisible({ timeout: 30_000 });
  if (await newcomerQuestion.isVisible()) {
    await page.getByRole("button", { name: "or name your own system" }).click();
  }
  await expect(createCard).toBeVisible({ timeout: 30_000 });
  /* the login chrome is gone while the card shows (§15, fourth pass) */
  await expect(page.locator("#gate")).toHaveCount(0);

  /* THE CREATE, through the card itself -- not the seam -- because the point
     of this spec is that a first-timer returned to /home reaches this UI at
     all. */
  await page.fill("#hhname", OWN_SYSTEM);
  /* #862 round 3: the act reads `Create`, one word, and no longer grows with
     the typed name — the owner's ratified rule, so what is asserted is that
     the button is armed by a name, not that it repeats one. */
  await expect(page.locator("#gobtn")).toHaveText("Create");
  await expect(page.locator("#gobtn")).toBeEnabled();
  const zone = await page.locator("#tz").inputValue();
  const money = await page.locator("#cur").inputValue();
  await page.locator("#gobtn").click();

  /* THE LANDING: the reclaim plays and the browser actually reaches /home --
     the door handed a first-timer on, the same promise its own returnTo made
     and, before #840, never kept. */
  await expect(page).toHaveURL(/\/home$/, { timeout: 30_000 });
  await expect(page.locator("#dial-name")).toHaveText(OWN_SYSTEM);

  /* The server's own account of it: one system, theirs, with the answers the
     card asked for. */
  const workspace = await page.evaluate(async () => {
    const response = await fetch("/api/workspace", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error(`workspace read failed: ${response.status}`);
    const { workspace } = (await response.json()) as {
      workspace: { households: { id: string; name: string; canManage: boolean; onboardingComplete: boolean; timezone: string; currency: string }[] };
    };
    return workspace;
  });
  expect(workspace.households).toHaveLength(1);
  expect(workspace.households[0]).toMatchObject({
    name: OWN_SYSTEM,
    canManage: true,
    onboardingComplete: true,
    timezone: zone,
    currency: money,
  });
  households.track(workspace.households[0]);
  seeded = true;

  /* And the door hands them straight on now: household.create set this
     reader's own session onto the household it made, in the same
     transaction, so hooks.server.js never has anything left to ask. */
  await page.goto("/");
  await expect(page).toHaveURL(/\/home$/, { timeout: 30_000 });
});
