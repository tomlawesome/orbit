import { expect, test, type Browser, type Page } from "@playwright/test";
import { householdRegister } from "./support/households";

/**
 * #410/§15: THE ARRIVAL. The newcomer's journey and the create-system card,
 * end to end, through the real pipe — the real identity provider, the real
 * front door, the real workspace read, the real join-request route and the real
 * `household.create` command. No interception anywhere.
 *
 * THE LAW THIS GUARDS (owner, 2026-08-16, sealed): "the first-run screen
 * doesn't get its own page — it sits ON TOP of the login screen." So the door
 * at "/" is a switchboard: a member is handed on to /home, a reader with no
 * household stays and gets either the create card (an empty instance) or the
 * newcomer's climb, the labelled sky, the boxless count and the question (an
 * instance that already has systems).
 *
 * WHY A FOURTH IDENTITY. The three the harness has always had all end up
 * owning or joining something during an acceptance run — the administrator
 * creates proving grounds, the member owns a household, the outsider is
 * approved into one by v19-membership — and this journey's whole precondition
 * is a reader who belongs to NOTHING. The database is not reset between specs,
 * so a dedicated identity (`Orbit Newcomer`, tests/oidc/server.mjs) is the only
 * way to have one. It is signed in nowhere else.
 *
 * THE GAP, stated rather than papered over. The FIRST ADMIN's automatic route
 * to the create card needs an instance with ZERO households, and this harness
 * cannot offer one: the database survives every spec in the run and several of
 * them create households before this file is reached. What is proved here is
 * the create card's own journey by the road a reader can always reach it on —
 * the newcomer's "or name your own system" — which is the SAME card, the same
 * command, the same hand-over and the same landing; the only unproved step is
 * the branch that chooses it automatically, and that is covered by unit test
 * (tests/unit/v19-arrival.test.mjs, `arrivalStageOf`) and photographed by the
 * fidelity gate's `first-run` entry. Proving it here would need a
 * freshly-volumed stack, which is a harness change and not a product one.
 *
 * ONE-WAY, like the membership journey it stands beside: the second test leaves
 * the reader owning a system, so a retry of it on the same stack finds a member
 * and is handed on to /home. Journeys that change the world are re-run by
 * bringing the stack down with its volumes, not by retrying the test.
 */

const HOUSEHOLD = `Harbour Approach ${Date.now()}`;
const OWN_SYSTEM = `Newcomer's Own ${Date.now()}`;

/* #730: both systems this journey makes are removed once the file is done —
   not sooner, because the second test needs the first one's name to still be
   taken. The sweep runs from the administrator's own session: a hard delete is
   an instance-admin power, and neither the member nor the newcomer has it. */
const households = householdRegister();
let seeded = false;

/** The way every other spec signs in: straight at the engine's login route. */
async function signInAs(page: Page, account: string, returnTo = "/") {
  await page.goto(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole("link", { name: account }).click();
}

/**
 * The way a READER signs in: the ratified door, its own button, and the
 * one-shot marker that button writes. It is the marker that tells the landing a
 * launch is owed, so this is the only road that flies the climb — pressing the
 * gate is the departure the flight is cut at.
 */
async function signInThroughTheDoor(page: Page, account: string) {
  await page.goto("/");
  await page.locator("#gate").click();
  await page.getByRole("link", { name: account }).click();
}

/* A fresh instance promotes its first sign-in to instance admin — and an admin
 * never sees the labelled sky, because the server hands them every household as
 * a member would see it (§11). Claim the promotion for the administrator so
 * everyone below is ordinary. */
async function establishInstanceAdmin(browser: Browser) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await signInAs(page, "Orbit Administrator", "/home");
  await expect(page).toHaveURL(/\/home$/);
  await context.close();
}

/**
 * A system, created through the arrival's own contract: a name, a time zone and
 * a currency, and nothing else. What comes back proves the server's half of the
 * sealed ruling — the caller is its owner and the four default sections are
 * applied by the command rather than composed by the browser.
 */
async function createSystem(page: Page, name: string) {
  return page.evaluate(async (householdName) => {
    const session = (await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { csrfToken: string };
    const response = await fetch("/api/workspace/commands", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({
        type: "household.create",
        household: {
          id: crypto.randomUUID(),
          name: householdName,
          timezone: "Europe/London",
          currency: "GBP",
          onboardingComplete: true,
        },
      }),
    });
    if (!response.ok) throw new Error(`household.create failed: ${response.status} ${await response.text()}`);
    const { workspace } = (await response.json()) as {
      workspace: { households: { id: string; name: string; canManage: boolean; onboardingComplete: boolean; sections: { name: string }[] }[] };
    };
    return workspace.households.find((one) => one.name === householdName)!;
  }, name);
}

/** What the signed-in reader's own workspace says they belong to. */
async function workspaceOf(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/workspace", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error(`workspace read failed: ${response.status}`);
    const { workspace } = (await response.json()) as {
      workspace: {
        households: { id: string; name: string; canManage: boolean; onboardingComplete: boolean; timezone: string; currency: string; sections: { name: string }[] }[];
        visibleHouseholds: { id: string; name: string; requested: boolean }[];
      };
    };
    return workspace;
  });
}

/** The owner's own listing, the way household management will read it (§15-2g). */
async function pendingRequests(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/join-requests", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error(`join-requests listing failed: ${response.status}`);
    const { requests } = (await response.json()) as {
      requests: { id: string; householdName: string; displayName: string }[];
    };
    return requests;
  });
}

test.describe.configure({ mode: "serial" });

test.afterAll(async ({ browser }) => {
  if (!seeded) return;
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    await signInAs(page, "Orbit Administrator");
    await page.waitForURL(/\/(home)?$/);
    await households.sweep(page);
  } finally {
    await context.close();
  }
});

test("the newcomer's arrival: the climb, the labelled sky, the real count, the question", async ({ page, browser }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the journey is asserted on the desk dialect");
  test.setTimeout(180_000);

  await establishInstanceAdmin(browser);

  /* Somebody's system for the newcomer to find, created through the arrival's
     own three-answer contract — so this step is also the proof that the server
     owns the default sections and the owner membership. */
  const ownerContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const ownerPage = await ownerContext.newPage();
  await signInAs(ownerPage, "Orbit Member", "/home");
  await expect(ownerPage).toHaveURL(/\/home$/);
  const created = await createSystem(ownerPage, HOUSEHOLD);
  households.track(created);
  seeded = true;
  expect(created.canManage).toBe(true);
  expect(created.onboardingComplete).toBe(true);
  expect(created.sections.map((section) => section.name))
    .toEqual(["Home", "Vehicles", "Devices", "Services"]);

  /* THE READER. Through the door, by its own button, so the launch is owed and
     the climb plays. */
  await signInThroughTheDoor(page, "Orbit Newcomer");

  /* The door KEEPS them: first-run sits on top of the login screen, and a
     reader with no household is not handed on to a home they do not have. */
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });

  /* THE CLIMB — the ratified launch, whole, on the authenticated return. */
  await expect(page.locator("body")).toHaveClass(/showwarp/, { timeout: 20_000 });
  /* and while it flies, the question has not arrived: the staging is
     class-driven, so the beat that has not happened is a class that is absent */
  await expect(page.locator("body")).not.toHaveClass(/belong/);

  /* THE LANDING: the labelled sky, every system a bearing and a name. */
  await expect(page.locator(".minisys").first()).toBeVisible({ timeout: 30_000 });
  const target = page.locator(".minisys", { hasText: HOUSEHOLD.toUpperCase() });
  await expect(target).toBeVisible();
  /* no dial, because they belong to nothing yet */
  await expect(page.locator(".dialwrap")).toHaveCount(0);

  /* THE COUNT — a moment on the settled sky, boxless, and REAL: the number is
     read off the households that exist, never written.
     It is the real list that is counted, not the sky: the sky draws at most
     twelve (#670), and on a shared instance (#730) more exist than it can
     draw, so the sky is a lower bound and `visibleHouseholds` is the number.
     Specs run in parallel locally, and a system created by another one between
     this read and the page's own would make a true count look wrong; CI runs
     one worker, so there the two reads cannot disagree. */
  const workspace = await workspaceOf(page);
  expect(workspace.households).toEqual([]);
  const discovered = workspace.visibleHouseholds.length;
  expect(discovered).toBeGreaterThan(0);
  const drawn = await page.locator(".minisys").count();
  expect(drawn).toBeGreaterThan(0);
  expect(drawn).toBeLessThanOrEqual(discovered);
  await expect(page.locator("body")).toHaveClass(/counting/, { timeout: 30_000 });
  await expect(page.locator(".nf .disc .big")).toHaveText(String(discovered));
  await expect(page.locator(".nf .disc p")).toContainText("discovered in this universe");

  /* AND THEN THE QUESTION, in the space the count left. */
  await expect(page.getByRole("heading", { name: "where do you belong?" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("body")).not.toHaveClass(/counting/);

  /* The card lists the same systems as the sky, and one road out of it. */
  const row = page.locator(".nf .belong li", { hasText: HOUSEHOLD });
  await expect(row).toBeVisible();
  await expect(row.locator(".act")).toHaveText("ask to join");

  /* ASKING IS REAL: the row and the constellation both take the waiting state,
     and the owner's own listing has the request in it. */
  await row.getByRole("button").click();
  await expect(row.locator(".act")).toHaveText("waiting", { timeout: 15_000 });
  await expect(target).toContainText("ASKED TO JOIN · WAITING");

  const requests = await pendingRequests(ownerPage);
  expect(requests.map((one) => `${one.householdName}/${one.displayName}`))
    .toContain(`${HOUSEHOLD}/Orbit Newcomer`);

  /* Asking twice cannot file twice: the row has nothing left to press. */
  await expect(row.getByRole("button")).toBeDisabled();

  await ownerContext.close();
});

test("naming your own system: the sealed refusal, then the create, then the launch home", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the journey is asserted on the desk dialect");
  test.setTimeout(180_000);

  /* The same reader, still belonging to nothing: a pending request is not a
     membership. Straight at the login route this time — no marker, so no climb;
     the question is served already arrived at, the way /logout serves the
     goodbye already arrived at. */
  await signInAs(page, "Orbit Newcomer");
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "where do you belong?" })).toBeVisible({ timeout: 30_000 });
  expect((await workspaceOf(page)).households).toEqual([]);

  /* THE OTHER ROAD: the same three questions the first admin is asked. */
  await page.getByRole("button", { name: "or name your own system" }).click();
  await expect(page.locator(".card")).toBeVisible();
  /* the login chrome is gone while the card shows (§15, fourth pass) */
  await expect(page.locator("#gate")).toHaveCount(0);
  await expect(page.locator("#formlayer .note")).toHaveText("4 sections to start · change them later");

  /* THE SEALED REFUSAL, in one warm line: a name that is already out there is
     not created, and the line offers the road it names. */
  await page.fill("#hhname", HOUSEHOLD);
  await expect(page.locator("#gobtn")).toHaveText(`create ${HOUSEHOLD} →`);
  await page.locator("#gobtn").click();
  await expect(page.getByRole("alert")).toContainText("already exists here");
  await expect(page.getByRole("alert").getByRole("link", { name: "ask to join it" })).toBeVisible();
  /* nothing was created and nothing flew */
  await expect(page).toHaveURL(/\/$/);
  expect((await workspaceOf(page)).households).toEqual([]);

  /* Typing disarms the rejection, because the rejection was about the NAME. */
  await page.fill("#hhname", OWN_SYSTEM);
  await expect(page.getByRole("alert")).toHaveCount(0);

  /* AND THE CREATE: the server makes the system, the lockup is reclaimed, and
     the ratified climb plays over the populated home. The two answers the card
     reads off the browser are read back off the card, because the machine
     running the suite is what decides them. */
  const zone = await page.locator("#tz").inputValue();
  const money = await page.locator("#cur").inputValue();
  await page.locator("#gobtn").click();
  await expect(page).toHaveURL(/\/home$/, { timeout: 30_000 });
  await expect(page.locator("body")).toHaveClass(/instrument/, { timeout: 60_000 });
  await expect(page.locator("#dial-name")).toHaveText(OWN_SYSTEM);

  /* The server's own account of it: one system, theirs, with the four default
     sections the command applied and the answers the card asked for. */
  const workspace = await workspaceOf(page);
  expect(workspace.households).toHaveLength(1);
  expect(workspace.households[0]).toMatchObject({
    name: OWN_SYSTEM,
    canManage: true,
    onboardingComplete: true,
    timezone: zone,
    currency: money,
  });
  expect(workspace.households[0].sections.map((section) => section.name))
    .toEqual(["Home", "Vehicles", "Devices", "Services"]);
  /* the reader's own system, made by the card rather than by this file, joins
     the sweep now that the server has named it (#730) */
  households.track(workspace.households[0]);
  seeded = true;

  /* And from now on the door hands them on, because home is theirs. */
  await page.goto("/");
  await expect(page).toHaveURL(/\/home$/, { timeout: 30_000 });
});
