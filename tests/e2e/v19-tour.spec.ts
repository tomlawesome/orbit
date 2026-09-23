import { expect, test, type Page } from "@playwright/test";
import { householdRegister } from "./support/households";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { dismissTourIfShown, homeIsLive } from "./support/keyboard";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   record this spec depends on (below) starts from the same place every run,
   whatever ran before it. */
resetDatabaseBetweenSpecFiles();

/**
 * #866: THE ONE-TAKE FILM, END TO END.
 *
 * §23 of design/owner-decisions.md retired the old eight-stop card walk this
 * file used to drive outright ("The only tour is the one with the play and
 * pause buttons. Anything else is old and superseded.") in favour of the
 * one-take film assembled in web/src/lib/tour/film.js: twelve chapters, one
 * continuous take, a transport pill instead of a card. This is that film's
 * one desk journey — issue #866's last checkbox — through the real pipe:
 * the real first-run trigger (trigger.js's `beginFilm`), the real transport
 * (transport.js), and the real `/api/settings/tour` write.
 *
 * WHY __jump AND NOT THE CLOCK. The film runs 3:41 normally and 2:07 reduced
 * (clock.js) — either is far too long to wait out in a spec, and the whole
 * point of the review hooks film.js exposes on `window` (`__jump`, `__stop`,
 * `__pause`, `__play`, `__reading`) is that a headless check drives the film
 * through them instead of real time. `player.jump` sets the chapter
 * synchronously before its first `await` (player.js's own comment), so
 * `__reading()` read immediately after `__jump(n)` already reports chapter
 * `n` — nothing here waits on a chapter's own beats to finish playing.
 *
 * WHY THE RECORD IS FORGOTTEN EXPLICITLY. Since #1077 claim.setup.ts's own
 * seed — what `resetDatabaseBetweenSpecFiles()` puts every file back to —
 * records the administrator as having ALREADY taken the walk (through the
 * same "take the walk again" route below), precisely so every OTHER spec's
 * /home lands quietly. So this file, like the superseded one before it,
 * clears the record through the product's own route before it can assert
 * the film shows: a first sign-in ought to mean a null record, but nothing
 * here depends on that being true independently of the one write that makes
 * it so.
 *
 * THE READER, THE SKY, AND WHY THIS FILE MAKES ITS OWN. `tourHasSomethingToShow`
 * (offer.js) only asks whether the reader belongs to a household at all —
 * the `adrift` mark, drawn only for a reader with none — so the household
 * this journey walks needs no items on it, the same "empty sky" shape the
 * superseded walk proved a chapter must survive (`anEmptySky`,
 * design/owner-decisions.md and every chapter's own "never branches on
 * data" rule). The reader is `Orbit Administrator`, and the household is
 * made through the same `household.create` command every other v19 spec
 * uses and swept the same way (`support/households.ts`) — nothing here
 * invents its own shape.
 *
 * DESK ONLY (owner-decisions.md §24): the film has no pocket cut, so a
 * mobile project run is skipped rather than left to hang on a transport
 * pill that never mounts.
 */

test.use({ reducedMotion: "reduce" });

/* #1080: this worker's own administrator, resolved lazily (worker env only). */
const READER = () => workerAccount("administrator");
const households = householdRegister();

/** The Origin and CSRF pair every mutating request in this file needs. */
async function sessionHeaders(page: Page) {
  const response = await page.request.get("/api/auth/session");
  const { csrfToken } = (await response.json()) as { csrfToken: string };
  return { Origin: new URL(page.url()).origin, "X-CSRF-Token": csrfToken };
}

/**
 * Signing in WITHOUT arriving on `/home`, the only screen the film ever
 * starts on: this leaves room to create the household and forget the walk
 * through the product's own routes before any landing can act on either.
 */
async function signInAwayFromHome(page: Page) {
  await page.goto(`/api/auth/login?returnTo=${encodeURIComponent("/inbox")}`);
  await page.getByRole("link", { name: READER() }).click();
  /* #1080: waits for the session, then holds administrator access — the
     sweep's hard delete is an instance-admin power. */
  await ensureWorkerAdministrator(page);
  /* Not always /inbox: an administrator with no household of their own may
     land on the arrival's newcomer screen instead (#840). Either is fine —
     what matters is that it is not /home, where the film's own trigger
     would otherwise run ahead of this file's own setup. */
  await expect(page).not.toHaveURL(/\/home$/, { timeout: 30_000 });
}

/** A household of the reader's own: empty, and this session's active one. */
async function anEmptySky(page: Page) {
  const name = `Film Proving Ground ${Date.now()} ${crypto.randomUUID().slice(0, 8)}`;
  const household = await page.evaluate(async (householdName) => {
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
      workspace: { households: { id: string; name: string }[] };
    };
    return workspace.households.find((one) => one.name === householdName)!;
  }, name);
  return households.track(household);
}

/**
 * Puts the record back to "never taken" — the exact request "take the walk
 * again" makes (workspace.js's `clearTourSeen`) — through the real route,
 * with the real CSRF token.
 */
async function forgetTheWalk(page: Page) {
  const headers = await sessionHeaders(page);
  const response = await page.request.put("/api/settings/tour", { headers, data: { tourSeenAt: null } });
  if (!response.ok()) throw new Error(`clearing the tour record failed: ${response.status()} ${await response.text()}`);
  const { tour } = (await response.json()) as { tour: { tourSeenAt: string | null } };
  expect(tour.tourSeenAt).toBeNull();
}

/** The server's own record for the signed-in reader. */
async function tourRecordOf(page: Page) {
  const response = await page.request.get("/api/settings/tour");
  if (!response.ok()) throw new Error(`tour read failed: ${response.status()}`);
  const { tour } = (await response.json()) as { tour: { tourSeenAt: string | null } };
  return tour;
}

/** film.js's own review hook: the clock's cursor, the film's total, the
 *  chapter playing, and its name. */
async function reading(page: Page) {
  return page.evaluate(() => {
    const hooks = window as unknown as { __reading(): { cursor: number; total: number; chapter: number; name: string } };
    return hooks.__reading();
  });
}

test("a first-time reader gets the film, works its transport, and a second arrival stays silent", async ({ page }) => {
  /* The film has no pocket cut (§24); a mobile run would wait on a
     transport pill that trigger.js never mounts. */
  test.skip(test.info().project.name.startsWith("mobile"), "the film is desk-only (owner-decisions.md §24)");
  test.setTimeout(90_000);

  await signInAwayFromHome(page);
  const household = await anEmptySky(page);

  try {
    await forgetTheWalk(page);

    /* THE TRIGGER: a reader who has never taken the film lands on their own
       sky, on desk, and the transport pill is up. */
    await page.goto("/home");
    await homeIsLive(page);
    const transport = page.locator("#orbit-tour-transport");
    await expect(transport).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#dial-name")).toHaveText(household.name);
    await page.waitForFunction(() => typeof (window as unknown as { __jump?: unknown }).__jump === "function");

    /* THE FILM RUNS THROUGH ITS CHAPTERS — jumped, never waited out. A jump
       sets the chapter synchronously (player.js), so the reading reported
       right after is the chapter just asked for, not a stale one. */
    await page.evaluate(() => (window as unknown as { __jump(n: number): void }).__jump(0));
    expect(await reading(page)).toMatchObject({ chapter: 0, name: "Arrive" });

    await page.evaluate(() => (window as unknown as { __jump(n: number): void }).__jump(7));
    expect(await reading(page)).toMatchObject({ chapter: 7, name: "The belt" });

    await page.evaluate(() => (window as unknown as { __jump(n: number): void }).__jump(11));
    expect(await reading(page)).toMatchObject({ chapter: 11, name: "Yours" });

    /* THE TRANSPORT WORKS: pause and play, through the real hooks, read back
       off the real pill (transport.js's `.pp`, whose label flips with the
       clock it paints from). */
    const playPause = transport.locator(".pp");
    await page.evaluate(() => (window as unknown as { __pause(): void }).__pause());
    await expect(playPause).toHaveAttribute("aria-label", "Play");
    await page.evaluate(() => (window as unknown as { __play(): void }).__play());
    await expect(playPause).toHaveAttribute("aria-label", "Pause");

    /* AND STOP — through the pill's own button, the door a reader actually
       presses, not the review hook, so this is the control under test. */
    await transport.locator(".stp").click();

    /* STOPPING WRITES tourSeenAt and clears the veil — the reader's screen
       handed back. player.js's `stop()` clears the veil synchronously but
       the write happens after (trigger.js's `beginFilm`), so the record is
       polled rather than sampled once. */
    await expect(page.locator("#orbit-tour-veil")).toBeHidden();
    await expect
      .poll(async () => (await tourRecordOf(page)).tourSeenAt, { timeout: 15_000 })
      .not.toBeNull();
    const recordedAt = (await tourRecordOf(page)).tourSeenAt;

    /* A SECOND ARRIVAL AT /home DOES NOT REPLAY IT. dismissTourIfShown is a
       no-op here (the record is already set) — kept so this file reuses the
       same check every other spec's settle path relies on, rather than
       writing a second copy of it. */
    await page.goto("/home");
    await dismissTourIfShown(page);
    await homeIsLive(page);
    await expect(page.locator("#orbit-tour-transport")).toHaveCount(0);
    expect((await tourRecordOf(page)).tourSeenAt).toBe(recordedAt);
  } finally {
    await households.sweep(page);
  }
});
