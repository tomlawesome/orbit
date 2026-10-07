import { expect, test, type Page } from "@playwright/test";
import { householdRegister } from "./support/households";
import { claimInstanceAsAdministrator } from "./support/bootstrap";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { bodyClassAdds, bodyClassSeen, witnessBodyClasses } from "./support/arrival";
import { answerPushWithoutAService } from "./support/webkit-push";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   lists these specs walk carry nothing an earlier spec left behind. */
resetDatabaseBetweenSpecFiles();

/**
 * #410/§15: THE ARRIVAL. The newcomer's journey and its create drawer,
 * end to end, through the real pipe — the real identity provider, the real
 * front door, the real workspace read, the real join-request route and the real
 * `household.create` command. No interception anywhere.
 *
 * THE LAW THIS GUARDS (owner, 2026-08-16, sealed): "the first-run screen
 * doesn't get its own page — it sits ON TOP of the login screen." So the door
 * at "/" is a switchboard: a member is handed on to /home, a reader with no
 * household stays and gets the newcomer's climb, the labelled sky, the
 * boxless count and the question, whose "name your own system" drawer holds
 * the three create questions (#1263: one flight per arrival, and /home never
 * flies a second time).
 *
 * WHY A FOURTH IDENTITY. The three the harness has always had all end up
 * owning or joining something during an acceptance run — the administrator
 * creates proving grounds, the member owns a household, the outsider is
 * approved into one by v19-membership — and this journey's whole precondition
 * is a reader who belongs to NOTHING. The specs inside a file run against one
 * another's leavings, so a dedicated identity (`Orbit Newcomer`,
 * tests/oidc/server.mjs) is the only way to have one. It is signed in nowhere
 * else, and #1077's reset between spec files does not change that: it puts
 * this FILE back to the seed, not each test within it.
 *
 * THE EMPTY INSTANCE is not walked here: the journeys below run one after
 * another and the first of them makes a household. Its drawer-open landing is
 * the local-only first run in v19-first-run-door.spec.ts (#1263), and the
 * fidelity gate photographs the drawer as `newcomer-drawer`.
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
  await answerPushWithoutAService(page);
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
    /* #665 forbade the loose `/\/(home)?$/` wait that resolved mid-
       navigation; the strict wait here is now inside
       ensureWorkerAdministrator (#1080), which polls the session itself
       until it is authenticated — no URL involved. A URL assertion cannot
       stand in this hook any more: until the promotion lands, a fresh
       worker administrator belongs to nothing and is parked on the arrival
       at `/`, not /home. The sweep talks to the API, and the hard delete it
       ends with is an instance-admin power. */
    await signInAs(page, workerAccount("administrator"), "/home");
    await ensureWorkerAdministrator(page);
    await households.sweep(page);
  } finally {
    await context.close();
  }
});

test("the newcomer's arrival: the climb, the labelled sky, the question with the instrument", async ({ page, browser }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the journey is asserted on the desk dialect");
  test.setTimeout(180_000);

  /* An admin never sees the labelled sky, because the server hands them every
     household as a member would see it (§11), so the administrator takes the
     instance first and everyone below is ordinary. Since ADR-0022 that is the
     claim code from the stack's own log rather than a first-sign-in race. */
  await claimInstanceAsAdministrator(browser);

  /* Somebody's system for the newcomer to find, created through the arrival's
     own three-answer contract — so this step is also the proof that the server
     owns the default sections and the owner membership. */
  const ownerContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const ownerPage = await ownerContext.newPage();
  await signInAs(ownerPage, workerAccount("member"), "/home");
  /* Not a fixed destination: this is "Orbit Member"'s own first sign-in with
     no household yet, exactly the reader #840 sends to the arrival instead
     -- createSystem below talks to the API from whatever page that landed
     on, same origin either way. */
  const created = await createSystem(ownerPage, HOUSEHOLD);
  households.track(created);
  seeded = true;
  expect(created.canManage).toBe(true);
  expect(created.onboardingComplete).toBe(true);
  expect(created.sections.map((section) => section.name))
    .toEqual(["Home", "Vehicles", "Devices", "Services"]);

  /* Captured before the door is even pressed: Arrival.svelte's decide() makes
     exactly one GET /api/workspace on mount (web/src/lib/arrival/Arrival.svelte),
     and that single response is what THE COUNT below reads its number from
     instead of a second, later fetch (#1085/#1080). Workers run in parallel
     and the household list is instance-wide, budget-bounded rather than
     isolated per worker (tests/e2e/support/reset-gate.ts's own account of
     what a reset "still cannot do"), so a fresh fetch made minutes later in
     the test would legitimately race another worker's fixtures. This is the
     exact response the sky was drawn from, so it cannot disagree with what is
     on screen. */
  const ownWorkspaceRead = page.waitForResponse(
    (response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/workspace",
  );

  /* THE READER. Through the door, by its own button, so the launch is owed and
     the climb plays. The witness goes in first: it is what proves the climb
     below (see witnessBodyClasses). */
  await witnessBodyClasses(page);
  await signInThroughTheDoor(page, workerAccount("newcomer"));

  /* The door KEEPS them: first-run sits on top of the login screen, and a
     reader with no household is not handed on to a home they do not have. */
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });

  /* THE CLIMB — the ratified launch, whole, on the authenticated return.
     Asked of the witness, not of <body> at the moment of asking: the warp is
     a 4.6 s window a stalled poll can miss entirely (#1233). */
  await expect.poll(() => bodyClassSeen(page, "showwarp"), { timeout: 20_000 }).toBe(true);
  /* #1263: once. */
  expect(await bodyClassAdds(page, "showwarp")).toBe(1);
  /* and while it flies, the question has not arrived: the staging is
     class-driven, so the beat that has not happened is a class that is absent */
  await expect(page.locator("body")).not.toHaveClass(/belong/);

  /* THE LANDING: the labelled sky, every system a bearing and a name. */
  await expect(page.locator(".minisys").first()).toBeVisible({ timeout: 30_000 });
  const target = page.locator(".minisys", { hasText: HOUSEHOLD.toUpperCase() });
  await expect(target).toBeVisible();
  /* no dial, because they belong to nothing yet */
  await expect(page.locator(".dialwrap")).toHaveCount(0);

  /* THE LIST IS REAL: the households are read off the ones that exist, never
     written. The sky draws at most twelve (#670), and on a shared instance
     (#730) more exist than it can draw, so the sky is a lower bound and
     `visibleHouseholds` is the list the card shows.
     Read from `ownWorkspaceRead` above, not a fresh fetch: a second,
     independent read taken this many beats after the page's own would race
     every other worker's fixtures under #1080 rather than only this file's. */
  const ownResponse = await ownWorkspaceRead;
  if (!ownResponse.ok()) throw new Error(`workspace read failed: ${ownResponse.status()}`);
  const { workspace } = (await ownResponse.json()) as {
    workspace: {
      households: unknown[];
      visibleHouseholds: { id: string; name: string; requested: boolean }[];
    };
  };
  expect(workspace.households).toEqual([]);
  const discovered = workspace.visibleHouseholds.length;
  expect(discovered).toBeGreaterThan(0);
  const drawn = await page.locator(".minisys").count();
  expect(drawn).toBeGreaterThan(0);
  expect(drawn).toBeLessThanOrEqual(discovered);

  /* THE QUESTION arrives with the instrument (#1222, owner 2026-10-07): no
     count beat stands between the landing and the card. */
  await expect(page.getByRole("heading", { name: "where do you belong?" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".nf .disc")).toHaveCount(0);

  /* The card lists the same systems as the sky, and one road out of it. */
  const row = page.locator(".nf .belong li", { hasText: HOUSEHOLD });
  await expect(row).toBeVisible();
  await expect(row.locator(".act")).toHaveText("ask to join");

  /* ASKING IS REAL: the row and the constellation both take the waiting state,
     and the owner's own listing has the request in it. */
  await row.getByRole("button").click();
  await expect(row.locator(".act")).toHaveText("waiting", { timeout: 15_000 });
  /* #1263: the reader stays on the card — no navigation and no polling;
     approval lands on their next sign-in, which is that arrival's flight. */
  await expect(row).toHaveClass(/waiting/);
  await expect(page).toHaveURL(/\/$/);
  expect(await bodyClassAdds(page, "showwarp")).toBe(1);
  await expect(target).toContainText("ASKED TO JOIN · WAITING");

  /* #866 (owner-decisions §23): the "waiting" word is a marker, not an
     explanation. The row now carries a real sentence saying both that the
     request is waiting and who has to approve it -- not aria-hidden, not
     colour-only, reachable the same way any other text in the row is. */
  const note = row.locator(".note");
  await expect(note).toBeVisible();
  await expect(note).toHaveAttribute("role", "status");
  await expect(note).toContainText("waiting");
  await expect(note).toContainText("owner");
  await expect(note).toContainText("administrator");
  await expect(note).toContainText("approve");

  const requests = await pendingRequests(ownerPage);
  expect(requests.map((one) => `${one.householdName}/${one.displayName}`))
    .toContain(`${HOUSEHOLD}/${workerAccount("newcomer")}`);

  /* Asking twice cannot file twice: the row has nothing left to press. */
  await expect(row.getByRole("button")).toBeDisabled();

  await ownerContext.close();
});

test("naming your own system: one climb, the drawer, the refusal, then home without a second flight", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the journey is asserted on the desk dialect");
  test.setTimeout(180_000);

  /* #1263: ONE FLIGHT PER ARRIVAL. The same reader, still belonging to
     nothing (a pending request is not a membership), through the door by its
     own button, so a launch is owed and the climb plays here on `/`. The
     witness records every class <body> wears in each document. */
  await witnessBodyClasses(page);
  await signInThroughTheDoor(page, workerAccount("newcomer"));
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  await expect.poll(() => bodyClassSeen(page, "showwarp"), { timeout: 20_000 }).toBe(true);
  /* the card is in the document, transparent, for the whole climb; the
     question has arrived when `belong` does (13.8s in, after the count) */
  await expect(page.locator("body")).toHaveClass(/\bbelong\b/, { timeout: 40_000 });
  await expect(page.getByRole("heading", { name: "where do you belong?" })).toBeVisible();
  expect((await workspaceOf(page)).households).toEqual([]);

  /* THE OTHER ROAD is a drawer in the card, not a second stage. On an
     instance with systems it starts closed. */
  const handle = page.getByRole("button", { name: "name your own system" });
  await expect(handle).toHaveAttribute("aria-expanded", "false");
  await expect(handle).toHaveAttribute("aria-controls", "own-drawer");
  await expect(page.locator("#hhname")).toHaveCount(0);
  /* it opens by grid rows over .3s, and with no transition under reduced
     motion (arrival.css's reduced-motion block) */
  const drawer = page.locator("#own-drawer");
  expect(await drawer.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0.3s");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await drawer.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
  await handle.click();
  await expect(handle).toHaveAttribute("aria-expanded", "true");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  /* the fields stand IN the belong card: no ring, no card of their own */
  await expect(page.locator(".nf .belong #hhname")).toBeVisible();
  await expect(page.locator(".nf .belong #tz")).toBeVisible();
  await expect(page.locator(".nf .belong #cur")).toBeVisible();
  await expect(page.locator(".ringcard")).toHaveCount(0);
  await expect(page.locator(".nf .belong .create .note")).toHaveText("4 sections to start · change them later");

  /* THE SEALED REFUSAL, in one warm line: a name that is already out there is
     not created, and the line offers the road it names. */
  await page.fill("#hhname", HOUSEHOLD);
  /* #862 round 3: the act reads `Create`, one word, and no longer grows with
     the typed name — the owner's ratified rule, so what is asserted is that
     the button is armed by a name, not that it repeats one. */
  await expect(page.locator("#gobtn")).toHaveText("Create");
  await expect(page.locator("#gobtn")).toBeEnabled();
  await page.locator("#gobtn").click();
  /* #1120: the root layout mounts the wake's assertive live region on every
     screen, present and empty at rest so that a later failure is announced.
     An empty region says nothing, so the alerts that count are the ones with
     words in them; that holds across the whole page, not just the card. */
  const spoken = page.getByRole("alert").filter({ hasText: /\S/ });
  await expect(spoken).toContainText("already exists here");
  /* nothing was created and nothing flew */
  await expect(page).toHaveURL(/\/$/);
  expect((await workspaceOf(page)).households).toEqual([]);
  /* "ask to join it →" closes the drawer and puts focus on the row */
  await spoken.getByRole("link", { name: "ask to join it" }).click();
  await expect(handle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#hhname")).toHaveCount(0);
  /* the row that holds the name: its button, or (as here, where the reader
     already asked to join it) the row itself */
  expect(await page.evaluate(() => document.activeElement?.closest(".nf .belong li")?.textContent ?? ""))
    .toContain(HOUSEHOLD);

  /* A second press opens it again with the answers kept. */
  await handle.click();
  await expect(page.locator("#hhname")).toHaveValue(HOUSEHOLD);

  /* Typing disarms the rejection, because the rejection was about the NAME. */
  await page.fill("#hhname", OWN_SYSTEM);
  await expect(spoken).toHaveCount(0);

  /* AND THE CREATE: the server makes the system and the reader goes home. The
     two answers the drawer reads off the browser are read back off it,
     because the machine running the suite is what decides them. */
  const zone = await page.locator("#tz").inputValue();
  const money = await page.locator("#cur").inputValue();
  expect(await bodyClassAdds(page, "showwarp"), "one climb on /").toBe(1);
  expect(await bodyClassSeen(page, "reclaimed"), "no reclaim of the door").toBe(false);
  await page.locator("#gobtn").click();
  await expect(page).toHaveURL(/\/home$/, { timeout: 30_000 });
  /* the ordinary arrival: POL-1 brings the dial in with the new name */
  await expect(page.locator("#dial-name")).toHaveText(OWN_SYSTEM, { timeout: 30_000 });
  /* #1263: the arrival already flew once on `/`, so /home must not fly a
     second time: no climb and no dawn. */
  expect(await bodyClassSeen(page, "showwarp"), "showwarp seen on /home").toBe(false);
  expect(await bodyClassSeen(page, "showdawn"), "showdawn seen on /home").toBe(false);

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
