import { execFileSync } from "node:child_process";
import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * #754/#477: THE FIRST-RUN WALK, END TO END. The five journeys of slice 4,
 * through the real pipe — the real identity provider, the real front door, the
 * real `/api/settings/tour` record, the real settings control. No interception
 * anywhere, and in particular none of the tour's own API: the walk's single
 * write is the thing being proved, so faking it would prove nothing.
 *
 * WHAT THE WALK IS. On a reader's first landing on `/home`, Tour.svelte asks
 * the server whether they have ever taken it (#751's `tourSeenAt`). Null means
 * never, and the card goes up at stop 1. *Skip* and *Finish* are the same door:
 * both end the walk and both record `tourSeenAt` — once — which is why every
 * later arrival is silent. "Take the walk again" (#753) puts the record back to
 * null and returns to `/home`, where the same trigger fires again.
 *
 * WHICH IDENTITY, AND WHY IT MATTERS. The database is not reset between specs,
 * so the household a journey lands on is whatever the specs before it left
 * behind, and journey 4 needs one with NOTHING on it — the example body is
 * drawn only where the dial has no real bodies to point at (example.js,
 * `needsExampleBody`). Of the four identities in tests/oidc/server.mjs:
 *
 *  - `Orbit Administrator` is signed in by most of the suite and owns
 *    households that specs put items into (v19-create, v19-item-actions,
 *    v19-composite-entry, the document and mail journeys);
 *  - `Orbit Member` owns the households the arrival and membership journeys
 *    create, and is the collector in v19-mail-collection;
 *  - `Orbit Outsider` is approved into the member's household by
 *    v19-membership, so what it sees is the member's dial, not its own;
 *  - `Orbit Newcomer` exists for exactly one spec. v19-arrival's second test
 *    leaves it owning `Newcomer's Own <timestamp>`, created through
 *    `household.create` with the four default sections and no items, and
 *    NOTHING else in the suite signs in as it. Its dial therefore has no
 *    bodies on it, before this spec and after it.
 *
 * So the walk is taken here as the newcomer, the same one-way reasoning
 * v19-arrival states for itself. Two consequences are stated rather than
 * papered over:
 *
 *  - This spec sorts after `v19-arrival.spec.ts`, which is what gives the
 *    newcomer a household to land on. CI runs one worker in file order, so
 *    that ordering holds there; locally the suite is parallel across files and
 *    arrival's two serial tests are long finished by the time this file is
 *    reached. Journey 4 asserts the empty dial it depends on rather than
 *    assuming it, so a violated ordering fails loudly instead of quietly
 *    proving nothing.
 *  - Each journey below puts the record into the state it needs through the
 *    product's OWN route — the one "take the walk again" calls — rather than
 *    depending on the record never having been written. A first sign-in IS a
 *    null record, so nothing about the trigger is weakened by saying so
 *    explicitly, and the file stays re-runnable and safe under CI's retries.
 *
 * WHERE THE HELM IS. Bare `/settings` has not moved to v19 yet — the
 * composite container's routing table (scripts/v19-dispatch.mjs) still hands
 * it to the retiring engine, and calls that a deliberate cutover line — so
 * journey 3 does NOT navigate to it. It goes the way a reader does: home's
 * account orb, its Settings link, SvelteKit's own client router. See
 * `openTheHelm` for why that is the stronger road and not a dodge.
 *
 * DESK DIALECT ONLY, like its neighbours. The phone cut is four stops rather
 * than eight (stops.js, `stopsFor`), and it is pinned by unit test and
 * photographed by the fidelity gate; running this file on both projects would
 * also walk the same single database twice.
 */

/** The way every other spec signs in: straight at the engine's login route. */
async function signInAs(page: Page, account: string, returnTo = "/home") {
  await page.goto(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole("link", { name: account }).click();
}

/**
 * Signing in WITHOUT arriving on `/home`, which is the only screen the walk
 * ever starts on: the inbox is a real signed-in destination, so a journey can
 * put the record where it wants it before any landing can act on it.
 */
async function signInAwayFromHome(page: Page, account: string) {
  await signInAs(page, account, "/inbox");
  await expect(page).toHaveURL(/\/inbox$/, { timeout: 30_000 });
}

/**
 * THE HELM, AS A READER REACHES IT. Bare `/settings` is still the retiring
 * engine's screen — scripts/v19-dispatch.mjs keeps it there until the cutover,
 * and only `/settings/mail` is v19 — so a `goto` would load Next's settings,
 * which has no walk on it. The v19 helm is reached the way the product offers
 * it: from home's account orb, through its own link, which SvelteKit's client
 * router handles in-page.
 *
 * That is not a workaround, it is the stronger road. The relaunch's whole
 * difficulty (#753, relaunch.js) is that Tour.svelte's `started` guard has
 * ALREADY been passed on this page load, so only a same-session arrival can
 * prove the one-shot flag works; a full reload would reset the guard and prove
 * nothing.
 */
async function openTheHelm(page: Page) {
  await page.locator("button.orb").click();
  await page.locator(".account").getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/, { timeout: 30_000 });
}

/** The server's own record for the signed-in reader. */
async function tourRecordOf(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/settings/tour", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error(`tour read failed: ${response.status}`);
    const { tour } = (await response.json()) as { tour: { tourSeenAt: string | null } };
    return tour;
  });
}

/**
 * Puts the record back to "never taken" — the exact request "take the walk
 * again" makes (workspace.js, `clearTourSeen`), on the real route, with the
 * real CSRF token. This is a precondition, never an assertion: what each
 * journey proves is what the PRODUCT does once the record says null.
 */
async function forgetTheWalk(page: Page) {
  const record = await page.evaluate(async () => {
    const session = (await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { csrfToken: string };
    const response = await fetch("/api/settings/tour", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({ tourSeenAt: null }),
    });
    if (!response.ok) throw new Error(`clearing the tour record failed: ${response.status} ${await response.text()}`);
    const { tour } = (await response.json()) as { tour: { tourSeenAt: string | null } };
    return tour;
  });
  expect(record.tourSeenAt).toBeNull();
}

/** What the signed-in reader's own workspace says they belong to. */
async function householdOf(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/workspace", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error(`workspace read failed: ${response.status}`);
    const { workspace } = (await response.json()) as {
      workspace: { households: { id: string; name: string }[] };
    };
    return workspace.households[0];
  });
}

/**
 * THE DATABASE ITSELF, not the screen (#754, journey 4). The example body is
 * drawn into the document and taken away again, and the promise that it is
 * never written down can only be checked where a write would land.
 *
 * The stack under test is a Compose stack in every harness that runs this
 * suite — CI's acceptance job and scripts/test-e2e-local.sh alike — so the
 * query goes the way scripts/test-backup-restore.sh sends its own: `compose
 * exec` into `orbit-db` and let psql read the credentials out of the
 * container's own environment, so no password is ever named here. The
 * application's compose file declares ORBIT_IMAGE as required, and `exec`
 * parses it even though it only attaches to a container that is already
 * running, so a placeholder is supplied exactly as the workflow's own
 * diagnostics step does.
 */
function ask(sql: string): string {
  return execFileSync(
    "docker",
    [
      "compose", "--env-file", ".env-orbit", "-f", "docker-compose.yml",
      "exec", "-T", "orbit-db", "sh", "-c",
      'psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --tuples-only --no-align --command="$1"',
      "sh", sql,
    ],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, ORBIT_IMAGE: process.env.ORBIT_IMAGE ?? "orbit-local:000000000000" },
    },
  ).trim();
}

/** One number out of the database under test. */
function count(sql: string): number {
  const answer = Number(ask(sql));
  if (!Number.isInteger(answer)) throw new Error(`expected a count from the database, got: ${answer}`);
  return answer;
}

/** Postgres literals are built from this and nothing else. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Every body row this household has, straight out of Postgres.
 *
 * The household is looked up first, and its presence asserted, because that is
 * what makes the zero below mean something: a query that reached the WRONG
 * database — a real deployment's, say, rather than the disposable stack's —
 * would answer "no bodies" perfectly truthfully and prove nothing at all.
 */
function bodiesInTheDatabase(householdId: string): number {
  expect(householdId).toMatch(UUID);
  expect(count(`select count(*) from households where id = '${householdId}'`))
    .toBe(1);
  return count(`select count(*) from items where household_id = '${householdId}'`);
}

/** The example body's own title, anywhere in the instance, in any household. */
function examplesInTheDatabase(): number {
  return count("select count(*) from items where lower(title) like '%car insurance%'");
}

const card = (page: Page) => page.locator(".tourcard");
/** The example, on the dial and in the manifest alike: both carry the mark. */
const example = (page: Page) => page.locator(".tour-example");
/** A real body on the desk dial — what an empty household has none of. */
const bodies = (page: Page) => page.locator(".body-link");

/** Waits for the walk to be up and standing on the stop it should be. */
async function atStop(page: Page, number: number) {
  await expect(card(page)).toBeVisible({ timeout: 30_000 });
  await expect(card(page)).toHaveAttribute("data-tour-stop", String(number), { timeout: 30_000 });
}

/**
 * The walk's one write, waited for rather than sampled. `end()` in engine.js
 * takes the card down and THEN records the walk (deliberately: the reader's
 * screen is not held up by a request), so the record is fetched until it
 * settles instead of once, immediately, in the gap.
 */
async function recordedAsTaken(page: Page) {
  await expect
    .poll(async () => (await tourRecordOf(page)).tourSeenAt, { timeout: 15_000 })
    .not.toBeNull();
  return (await tourRecordOf(page)).tourSeenAt;
}

/**
 * A LANDING THE WALK STAYS AWAY FROM — absence waited out, not sampled.
 *
 * Every arrival on `/home` asks the server for the record before it decides
 * anything (Tour.svelte, `begin`), so a card that is not on screen yet is not
 * the same as a card that is never coming: asserted the instant the page
 * loads, "no walk" would pass against a product that has simply not answered
 * yet, and would go on passing if the record stopped being consulted at all.
 * So this waits for that read to come back, gives the page long enough to have
 * acted on it, and only then says the walk is not here.
 */
async function noWalkOn(page: Page, land: () => Promise<unknown>) {
  const asked = page.waitForResponse(
    (response) => response.url().includes("/api/settings/tour") && response.request().method() === "GET",
    { timeout: 30_000 },
  );
  await land();
  await asked;
  await expect(page.locator(".dialwrap")).toBeVisible({ timeout: 30_000 });
  /* The decision has been made by now; the walk would be up if it were. */
  await page.waitForTimeout(1000);
  await expect(card(page)).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveClass(/tour-running/);
}

/** The walk is over: no card, no marks, and nothing of the example left. */
async function walkIsOver(page: Page) {
  await expect(card(page)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator("body")).not.toHaveClass(/tour-running/);
  await expect(page.locator("[data-tour-dim]")).toHaveCount(0);
  await expect(example(page)).toHaveCount(0);
}

test.describe.configure({ mode: "serial" });

test.describe("the first-run walk", () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name.startsWith("mobile"), "the journeys are asserted on the desk dialect");
    test.setTimeout(180_000);
  });

  test("journey 1: the first landing on home gets the walk, and skipping ends it", async ({ page }) => {
    /* Away from /home, so the record is set before any landing can read it. */
    await signInAwayFromHome(page, "Orbit Newcomer");
    await forgetTheWalk(page);

    /* THE TRIGGER: a reader who has never taken the walk lands on their sky
       and the card is there, at stop one, in the ratified words. */
    await page.goto("/home");
    await atStop(page, 1);
    await expect(page.locator("#tour-progress")).toHaveText("Stop 1 of 8");
    await expect(page.locator("#tour-copy-1")).toHaveText("This is your star chart.");
    await expect(page.locator("#tour-copy-2")).toHaveText("Every sun is a household you belong to.");
    await expect(page.locator("body")).toHaveClass(/tour-running/);
    /* Back is the one door that is shut at stop one; Skip never is. */
    await expect(page.locator("#tour-back")).toBeDisabled();
    await expect(page.locator("#tour-skip")).toBeEnabled();

    /* Showing the walk is not taking it: nothing is written until it ends. */
    expect((await tourRecordOf(page)).tourSeenAt).toBeNull();

    /* SKIP — the walk's one write, and the screen put back as it was found. */
    await page.locator("#tour-skip").click();
    await walkIsOver(page);
    const seen = await recordedAsTaken(page);

    /* AND THE SECOND VISIT, same session, same browser: silence. The record
       is read on every arrival, so this is the product's own answer, not a
       one-shot guard hiding a missing write. */
    await noWalkOn(page, () => page.goto("/home"));
    expect((await tourRecordOf(page)).tourSeenAt).toBe(seen);
  });

  test("journey 2: the skip holds across a new sign-in and a second browser", async ({ page, browser }) => {
    /* A FRESH SIGN-IN, straight onto /home: the record is the server's, so a
       new session cannot resurrect a walk that was skipped in another. */
    await noWalkOn(page, () => signInAs(page, "Orbit Newcomer"));
    const seen = await recordedAsTaken(page);

    /* A SECOND BROWSER: no cookies, no storage, nothing carried over — the
       only thing the two have in common is the reader the server knows. */
    const second = await browser.newContext({ ignoreHTTPSErrors: true });
    const elsewhere = await second.newPage();
    await noWalkOn(elsewhere, () => signInAs(elsewhere, "Orbit Newcomer"));
    expect((await tourRecordOf(elsewhere)).tourSeenAt).toBe(seen);
    await second.close();
  });

  test("journey 3: take the walk again starts it from stop one", async ({ page }) => {
    /* The walk has been taken — journey 1 skipped it and journey 2 proved it
       stayed taken — so the helm is the only road back to stop one. */
    /* This landing goes through the trigger and is turned away, which is
       exactly the state the relaunch has to get past. */
    await noWalkOn(page, () => signInAs(page, "Orbit Newcomer"));
    await recordedAsTaken(page);

    await openTheHelm(page);
    const relaunch = page.getByRole("button", { name: "take the walk again" });
    await expect(relaunch).toBeVisible();
    await relaunch.click();

    /* The control clears the record and goes home, and the walk begins there —
       in the same page load that had already passed the trigger once. */
    await expect(page).toHaveURL(/\/home$/, { timeout: 30_000 });
    await atStop(page, 1);
    await expect(page.locator("#tour-progress")).toHaveText("Stop 1 of 8");
    await expect(page.locator("#tour-copy-1")).toHaveText("This is your star chart.");
    await expect(page.locator("#tour-back")).toBeDisabled();
    /* Stop one, not stop eight resumed: the record really was put back. */
    expect((await tourRecordOf(page)).tourSeenAt).toBeNull();

    await page.locator("#tour-skip").click();
    await walkIsOver(page);
    await recordedAsTaken(page);
  });

  test("journey 4: the example body is drawn, and never written down", async ({ page }) => {
    await signInAwayFromHome(page, "Orbit Newcomer");
    const household = await householdOf(page);
    expect(household, "the newcomer must own the household v19-arrival left them").toBeTruthy();

    /* The precondition, asserted rather than assumed — on a household that
       already had bodies the tour would point at a real one and draw nothing,
       and everything below would pass without testing anything. */
    await page.goto("/home");
    await expect(page.locator(".dialwrap")).toBeVisible({ timeout: 30_000 });
    await expect(bodies(page)).toHaveCount(0);
    expect(bodiesInTheDatabase(household.id)).toBe(0);

    /* ---- drawn, then SKIPPED ------------------------------------------- */
    await forgetTheWalk(page);
    await page.goto("/home");
    await atStop(page, 1);

    /* Stop 3 is the dial, the first stop that asks for the example. */
    await page.locator("#tour-next").click();
    await atStop(page, 2);
    await page.locator("#tour-next").click();
    await atStop(page, 3);

    /* THE TEACHING PROP, on both surfaces: the dashed body on the dial and
       its matching row in the manifest, each saying what it is. */
    await expect(example(page).first()).toBeVisible();
    await expect(page.locator("svg.dial .tour-example")).toHaveCount(1);
    await expect(page.locator("#manifest-top .tour-example")).toContainText("Car insurance");
    await expect(page.locator("#manifest-top .tour-example")).toContainText("example · due in 12 days");
    /* and stop 4 says so in words, because it is drawn (stops.js) */
    await page.locator("#tour-next").click();
    await atStop(page, 4);
    await expect(page.locator("#tour-copy-2"))
      .toHaveText("This one's an example — car insurance, due in 12 days.");

    await page.locator("#tour-skip").click();
    await walkIsOver(page);
    /* Waited for here as well as asserted: the write lands after the card
       goes, and the second half of this journey clears the record again. */
    await recordedAsTaken(page);
    await expect(bodies(page)).toHaveCount(0);

    /* THE PROMISE, where a write would have landed. */
    expect(bodiesInTheDatabase(household.id)).toBe(0);
    expect(examplesInTheDatabase()).toBe(0);

    /* and a reload agrees: the dial is empty because there is nothing there */
    await page.goto("/home");
    await expect(page.locator(".dialwrap")).toBeVisible({ timeout: 30_000 });
    await expect(example(page)).toHaveCount(0);
    await expect(bodies(page)).toHaveCount(0);

    /* ---- drawn, then FINISHED ------------------------------------------ */
    await forgetTheWalk(page);
    await page.goto("/home");
    await atStop(page, 1);

    /* All eight stops, by the door the reader who likes it uses: Next through
       the inbox and the relay screen and back onto their own sky, where the
       last press reads Finish. */
    for (let stop = 1; stop < 8; stop += 1) {
      await page.locator("#tour-next").click();
      await atStop(page, stop + 1);
    }
    await expect(page.locator("#tour-next")).toHaveText("Finish");
    await expect(page).toHaveURL(/\/home$/);
    await page.locator("#tour-next").click();
    await walkIsOver(page);
    await recordedAsTaken(page);

    /* The same promise, by the other door. */
    await expect(bodies(page)).toHaveCount(0);
    expect(bodiesInTheDatabase(household.id)).toBe(0);
    expect(examplesInTheDatabase()).toBe(0);
  });

  test("journey 5: the walk can be taken from the keyboard, and Escape skips", async ({ page }) => {
    await signInAwayFromHome(page, "Orbit Newcomer");
    await forgetTheWalk(page);
    await page.goto("/home");
    await atStop(page, 1);

    /* The card takes focus at every stop, so the keys land on the walk
       without the reader having to find it first. */
    await expect(card(page)).toBeFocused();

    /* Forward, both ways round. */
    await page.keyboard.press("ArrowRight");
    await atStop(page, 2);
    await page.keyboard.press("ArrowDown");
    await atStop(page, 3);

    /* and back, both ways round */
    await page.keyboard.press("ArrowLeft");
    await atStop(page, 2);
    await page.keyboard.press("ArrowUp");
    await atStop(page, 1);

    /* Stop one is the floor: Back is shut, and so is the key for it. */
    await page.keyboard.press("ArrowLeft");
    await atStop(page, 1);

    /* ESCAPE IS SKIP — the same door, so it ends the walk and records it. */
    await page.keyboard.press("Escape");
    await walkIsOver(page);
    await recordedAsTaken(page);

    /* and the record holds: the next landing is silent */
    await noWalkOn(page, () => page.goto("/home"));
  });
});
