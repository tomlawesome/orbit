import { expect, test } from "@playwright/test";

import { APP, RIG_EXPECT_MS, RIG_TEST_MS, onPhone, signedIn } from "./a11y-support.js";

/** @typedef {import("@playwright/test").Page} Page */

/*
 * #866, moved to the rig (ADR-0039, #1611) from tests/e2e/v19-tour.spec.ts:
 * THE ONE-TAKE FILM, desk and pocket.
 *
 * §23 of design/owner-decisions.md retired the old eight-stop card walk in
 * favour of the one-take film assembled in web/src/lib/tour/film.js: twelve
 * chapters, one continuous take, a transport pill instead of a card. This is
 * that film's one journey: the first-run trigger (trigger.js's `beginFilm`),
 * the transport (transport.js), and the write of the tour record.
 *
 * WHY __jump AND NOT THE CLOCK. The film runs 3:41 normally and 2:07 reduced
 * (clock.js), far too long to wait out; the review hooks film.js exposes on
 * `window` (`__jump`, `__stop`, `__pause`, `__play`, `__reading`) are how a
 * headless check drives it. `player.jump` sets the chapter synchronously, so
 * `__reading()` read right after `__jump(n)` already reports chapter `n`.
 *
 * THE READER. The state `/home` / `tour-due` answers the tour record "never
 * taken" and leaves the film playing from chapter 0; the stack suite cleared
 * the record through the product's own route and made an empty household for
 * it. The fixture reader belongs to Harlow Home, which is all
 * `tourHasSomethingToShow` (offer.js) asks. The fixture does not answer the
 * record's PUT (it belongs to the engine), so this test answers it, records
 * what the skip wrote, and then answers the next GET with that date: the
 * second arrival.
 *
 * #1083: the film plays on a pocket viewport as well as a desk one
 * (owner-decisions.md §24's ending note). The pocket-specific assertions (the
 * rail is a slider, not the desk's numbered ticks; there is no `#dial-name`)
 * are gated on the phone project.
 *
 * What stays in tests/e2e: nothing; the invited reader's film (v19-invitations,
 * #871 criterion 3) needs the real redirect and a real membership and was
 * dropped with a note in v19-invitations.spec.js.
 */
test.use({ baseURL: APP, reducedMotion: "reduce" });
test.describe.configure({ timeout: RIG_TEST_MS });

/** film.js's own review hook: the clock's cursor, the film's total, the chapter playing, and its name.
 * @param {Page} page */
async function reading(page) {
  return page.evaluate(() => {
    const hooks = /** @type {any} */ (window);
    return /** @type {{ cursor: number, total: number, chapter: number, name: string }} */ (hooks.__reading());
  });
}

/** @param {Page} page @param {number} chapter */
const jump = (page, chapter) => page.evaluate((n) => /** @type {any} */ (window).__jump(n), chapter);

test("a first-time reader gets the film, works its transport, and a second arrival stays silent", async ({ page }, testInfo) => {
  const mobile = onPhone(testInfo);

  /* The record's PUT, answered here: what a skip writes is kept. */
  const recordedAt = "2026-08-13T09:00:00.000Z";
  /** @type {any[]} */
  const puts = [];
  await page.route("**/api/settings/tour", async (route) => {
    if (route.request().method() !== "PUT") return route.fallback();
    puts.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tour: { tourSeenAt: recordedAt } }) });
  });

  /* THE TRIGGER: a reader who has never taken the film lands on their own
     sky, and the transport pill is up, on desk and on the pocket alike
     (#1083). `#dial-name` is desk-only markup; the pocket's own household name
     sits in the dial with no id. */
  await signedIn("/home", "tour-due")(page);
  const transport = page.locator("#orbit-tour-transport");
  await expect(transport).toBeVisible({ timeout: RIG_EXPECT_MS });
  if (!mobile) await expect(page.locator("#dial-name")).toHaveText("Harlow Home");

  if (mobile) {
    /* #1083 §4.2: the rail is the one slider target on the pocket, not the
       desk's twelve numbered tick buttons. */
    await expect(transport.locator(".track[role=slider]")).toBeVisible();

    /* §4.4: docking to the top edge while a kit sheet is up. */
    await jump(page, 10); /* "Your sky" */
    await expect(page.locator(".p-sheet-layer.open")).toBeVisible({ timeout: 10_000 });
    await expect(transport).toHaveClass(/\btop\b/);
  }

  /* THE FILM RUNS THROUGH ITS CHAPTERS: jumped, never waited out. A jump sets
     the chapter synchronously (player.js), so the reading reported right
     after is the chapter just asked for, not a stale one. */
  await jump(page, 0);
  expect(await reading(page)).toMatchObject({ chapter: 0, name: "Arrive" });
  await jump(page, 7);
  expect(await reading(page)).toMatchObject({ chapter: 7, name: "The item" });
  await jump(page, 11);
  expect(await reading(page)).toMatchObject({ chapter: 11, name: "Yours" });

  /* THE TRANSPORT WORKS: pause and play, through the real hooks, read back off
     the real pill (transport.js's `.pp`, whose label flips with the clock it
     paints from). */
  const playPause = transport.locator(".pp");
  await page.evaluate(() => /** @type {any} */ (window).__pause());
  await expect(playPause).toHaveAttribute("aria-label", "Play");
  await page.evaluate(() => /** @type {any} */ (window).__play());
  await expect(playPause).toHaveAttribute("aria-label", "Pause");

  /* AND SKIP: through the pill's own button, the door a reader actually
     presses, not the review hook, so this is the control under test.
     (#1190: Skip replaces Stop, same slot and hit target.) */
  expect(puts, "nothing is written before the skip").toHaveLength(0);
  await transport.locator(".skp").click();

  /* SKIPPING WRITES tourSeenAt and clears the veil: the reader's screen handed
     back. player.js's `stop()` clears the veil synchronously but the write
     happens after (trigger.js's `beginFilm`), so the write is polled. On the
     pocket, stopping also folds whatever sheet the film had opened
     (vocabulary.js's `clear()`, §3.4). */
  await expect(page.locator("#orbit-tour-veil")).toBeHidden();
  if (mobile) await expect(page.locator(".p-sheet-layer.open")).toHaveCount(0);
  await expect.poll(() => puts.length, { timeout: RIG_EXPECT_MS }).toBe(1);
  expect(puts[0].tourSeenAt, "the skip records that the walk was taken").not.toBeNull();

  /* #1190: the bar then leaves on its own, removed a second after the skip,
     not left as a faint ghost. */
  await expect(transport).toHaveCount(0);

  /* A SECOND ARRIVAL AT /home DOES NOT REPLAY IT: the record now answers with
     the date the skip wrote. */
  await page.route("**/api/settings/tour", (route) => route.request().method() === "GET"
    ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tour: { tourSeenAt: recordedAt } }) })
    : route.fallback());
  await page.goto(`${APP}/home`);
  await expect(page.locator("body[data-home-ready]")).toBeAttached();
  await expect(page.locator("#orbit-tour-transport")).toHaveCount(0);
  expect(puts, "a second arrival writes nothing").toHaveLength(1);
});
