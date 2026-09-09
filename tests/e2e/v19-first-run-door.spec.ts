import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { claimInstanceAsAdministrator } from "./support/bootstrap";
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

/*
 * The instance has to be claimed before anybody can sign in at all (#908,
 * ADR-0022): `GET /api/auth/login` answers `bootstrap_required` on an
 * unclaimed one. Every spec in a full run used to leave this to whichever
 * ran first; slice 5 shipped the helper that does it deterministically, from
 * the container's own log, so this file no longer depends on running after
 * somebody else. Idempotent -- an already-claimed instance just signs in.
 */
test.beforeAll(async ({ browser }) => {
  await claimInstanceAsAdministrator(browser);
});

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

/*
 * ══ THE DOOR IS MODE-AWARE (#914, plan §2.7) ═════════════════════════════
 *
 * The owner ruled the composition on 2026-09-09 (design/owner-decisions.md
 * §17); these are its four cards and the setup screen, walked.
 *
 * WHY THE AVAILABILITY ANSWER IS STUBBED IN THE BROWSER. Which face the door
 * wears is decided from one public, unauthenticated body, and the four faces
 * need four DIFFERENT INSTANCES to arise naturally: an unclaimed one, a
 * local-only one, a mixed one, and one mid-claim. The acceptance stack is a
 * single claimed instance with a provider, and every other spec in the run
 * depends on it staying that way -- so reaching these states by
 * reconfiguring it would be reaching them by breaking everything else.
 *
 * The route itself is not what is under test here and is covered where it
 * belongs (the availability route's own unit test, and slice 5's and 6's
 * integration tests); `doorModeOf` is pinned without a browser in
 * tests/unit/door-state.test.mjs. What only a browser can show is what these
 * assert: that the card appears IN THE RING with the ratified chrome off it,
 * that the gate is absent where the owner said it is absent, that the
 * fragment leaves the address bar before anything is sent, and that every
 * one of them survives the WCAG sweep. The genuinely-unclaimed and
 * genuinely-local-only journeys are slice 14's, against their own stack
 * profile (#916).
 */

const RUNNING = { configured: true, phase: "running", contactAddress: null };

/** Answers the door's own two mount-time questions with a stated instance. */
async function instance(page: Page, availability: Record<string, unknown>) {
  await page.route("**/api/auth/availability", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...RUNNING, ...availability }),
    }),
  );
}

/** The WCAG sweep every card has to pass (the pattern in signed-out.spec.ts). */
async function sweep(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
}

test.describe("the door's cards", () => {
  /* Independent of the journey above and of each other: nothing here creates
     a household, signs anyone in, or leaves a mark on the instance. */
  test.describe.configure({ mode: "default" });

  test("unclaimed shows the claim card in the ring, and no gate at all", async ({ page }) => {
    await instance(page, { claimed: false, methods: { local: true, oidc: true } });
    await page.goto("/login");

    await expect(page.locator("#claimcode")).toBeVisible();
    /* The whole of the ruling's first line: no Sign in gate. Not hidden --
       absent, so it is not reachable by keyboard or screen reader either. */
    await expect(page.locator("#gate")).toHaveCount(0);
    /* The card stands in the ring, and the login chrome is off the screen. */
    await expect(page.locator(".bigring .ringglass")).toBeAttached();
    await expect(page.locator(".loginchrome")).toBeHidden();
    /* The one sentence that says where the code is. */
    await expect(page.locator(".card .note")).toContainText("docker compose logs orbit-app");

    await sweep(page);
  });

  test("arriving by the notice's link fills the code, sends it, and clears the fragment", async ({ page }) => {
    await instance(page, { claimed: false, methods: { local: true, oidc: true } });

    /* The claim the operator's code would have earned. Recorded so the body
       can be inspected: the point of ADR-0022 §1 is that the code travels in
       the POST and never in an address a proxy or a log would see. */
    let presented: string | null = null;
    await page.route("**/api/auth/bootstrap/claim", async (route) => {
      presented = JSON.parse(route.request().postData() ?? "{}").claim ?? null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: '{"claimed":false,"methods":{"local":true,"oidc":true}}',
      });
    });

    await page.goto("/login#claim=ABCD-EFGH-2345");

    /* CREATE MODE: the identity of the first administrator, three fields. */
    await expect(page.locator("#idname")).toBeVisible();
    await expect(page.locator("#idemail")).toBeVisible();
    await expect(page.locator("#idpassword")).toBeVisible();
    expect(presented).toBe("ABCD-EFGH-2345");

    /* AND THE ADDRESS BAR IS CLEAN. `history.replaceState`, so there is no
       history entry holding it either -- a back press cannot bring it back. */
    expect(new URL(page.url()).hash).toBe("");
    await expect(page).toHaveURL(/\/login$/);

    /* With a provider configured, ONE line under the fields and no gate. */
    await expect(page.locator("#gate")).toHaveCount(0);
    await expect(page.locator(".card .quietline"))
      .toHaveText("continue with your identity provider");

    await sweep(page);
  });

  test("a claimed local-only instance shows the sign-in card in the ring", async ({ page }) => {
    await instance(page, { claimed: true, methods: { local: true, oidc: false, localAccounts: true } });
    await page.goto("/login");

    await expect(page.locator("#idemail")).toBeVisible();
    await expect(page.locator("#idpassword")).toBeVisible();
    /* Sign-in, not create: no display name is asked for, and no gate stands
       in front of a provider this instance does not have. */
    await expect(page.locator("#idname")).toHaveCount(0);
    await expect(page.locator("#gate")).toHaveCount(0);
    await expect(page.locator("#idbtn")).toHaveText("Sign in");
    await expect(page.locator(".bigring .ringglass")).toBeAttached();

    await sweep(page);
  });

  test("mixed mode is the ratified door plus one line, which opens the same card", async ({ page }) => {
    await instance(page, { claimed: true, methods: { local: true, oidc: true, localAccounts: true } });
    await page.goto("/login");

    /* THE RATIFIED DOOR, UNCHANGED: the gate, the lockup, no card. */
    await expect(page.locator("#gate")).toBeVisible();
    await expect(page.locator(".loginchrome")).toBeVisible();
    await expect(page.locator(".card")).toHaveCount(0);

    await expect(page.locator("#localopen")).toBeVisible();
    await page.locator("#localopen").click();

    /* The same card, opened rather than offered -- and the chrome goes with
       it, exactly as it does for the create-system card. */
    await expect(page.locator("#idemail")).toBeVisible();
    await expect(page.locator("#idpassword")).toBeVisible();
    await expect(page.locator("#gate")).toHaveCount(0);

    await sweep(page);
  });

  test("the local login line stays off when no local credential exists", async ({ page }) => {
    /* §2.7, verbatim: "the line appears only when a local credential
       exists". An instance with a provider and no local account is the
       ordinary state of every deployment that never used local sign-in, and
       offering it a way in that cannot work would be worse than silence. */
    await instance(page, { claimed: true, methods: { local: true, oidc: true, localAccounts: false } });
    await page.goto("/login");

    await expect(page.locator("#gate")).toBeVisible();
    await expect(page.locator("#localopen")).toHaveCount(0);
  });

  test("the setup screen asks for the password twice and refuses a spent link", async ({ page }) => {
    /* The real route, with an obviously fake token: an unknown, spent and
       expired token are one generic answer, so a token that never existed
       exercises exactly the path a spent one takes. */
    await page.goto("/setup/e2e-placeholder-token-that-never-existed");

    await expect(page.locator("#idpassword")).toBeVisible();
    await expect(page.locator("#idagain")).toBeVisible();
    await expect(page.locator(".bigring .ringglass")).toBeAttached();
    await sweep(page);

    /* The one refusal the card decides for itself, because the server cannot
       see it: two passwords that do not match. */
    await page.fill("#idpassword", "orbit-e2e-placeholder-secret");
    await page.fill("#idagain", "orbit-e2e-placeholder-secre");
    await expect(page.locator(".err.shown")).toHaveText("Those two passwords are not the same.");
    await expect(page.locator("#idbtn")).toBeDisabled();

    await page.fill("#idagain", "orbit-e2e-placeholder-secret");
    await expect(page.locator("#idbtn")).toBeEnabled();
    await page.locator("#idbtn").click();

    /* Orbit's own words, and the same ones for all three ways a token can be
       no good: nothing here tells whoever is holding it which it was. */
    await expect(page.locator(".err.shown"))
      .toHaveText("This link has been used already, or it has expired.", { timeout: 30_000 });
    await expect(page).toHaveURL(/\/setup\//);
  });
});
