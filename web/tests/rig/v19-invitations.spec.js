import { expect, test } from "@playwright/test";

import { bodyClassAdds, bodyClassSeen, witnessBodyClasses } from "../../../tests/e2e/support/arrival";
import { SETTLE } from "../../../tests/e2e/support/settle";
import { door } from "./a11y-support.js";

/*
 * #871, moved to the rig (ADR-0039, #1611) from tests/e2e/v19-invitations.spec.ts:
 * an invited reader's arrival never draws the chooser. The sky moves to the
 * household instead.
 *
 * The reader starts at the state `arrival` / `invited-landing-local-only`: `/`
 * for a reader who is signed in with a household set and `justJoined`, two
 * visible systems, and `/home` answered with a blank page so the landing's
 * hand-on leaves nothing to judge. Full motion: the one climb is the point
 * (#1263), and the witness records every class <body> wears in the document,
 * so the climb is a fact rather than a poll.
 *
 * What stays on the stack, in tests/e2e/v19-invitations.spec.ts: the mailed
 * invitation that makes a stranger a member (the real mail pipe), which also
 * holds the invited household being in the new member's own workspace.
 *
 * The state blanks `/home` so its own checks have nothing to judge; this test
 * lets the move land on the fixture's real home (a later route that continues
 * to the server), answers the tour record "never taken" as `/home` / `tour-due`
 * does, and so reads the rest of the stack test's journey: the arrival ending
 * on /home, no second climb there, and the first-run film running for the
 * invited reader (#871 criterion 3).
 */
test.use({ reducedMotion: "no-preference" });

test("an invited reader's arrival never draws the chooser: the sky moves to the household instead (#871)", async ({ page }) => {
  test.setTimeout(120_000);
  await witnessBodyClasses(page);
  await door("arrival", "invited-landing-local-only")(page);
  /* After the state: routes added later run first. `continue` goes to the
     fixture server, past the state's blank page, and the reader has never taken
     the tour. The climb on `/` lasts longer than this takes to set up. */
  await page.route((url) => url.pathname === "/home", (route) =>
    route.request().resourceType() === "document" ? route.continue() : route.fallback());
  await page.route("**/api/settings/tour", (route) => route.request().method() === "GET"
    ? route.fulfill({ status: 200, contentType: "application/json", body: '{"tour":{"tourSeenAt":null}}' })
    : route.fallback());

  /* THE ONE CLIMB, on `/` (#1263). */
  await expect.poll(() => bodyClassSeen(page, "showwarp"), { timeout: SETTLE }).toBe(true);
  await expect(page).toHaveURL(/\/$/);

  /* NO CHOOSER, AT ANY FRAME: not merely hidden -- absent from the DOM for the
     entire time this reader is on this surface ("not rendered then hidden",
     #871's own rule). */
  await expect(page.locator(".nf .belong")).toHaveCount(0);

  /* NOTHING NAMES THE HOUSEHOLD BEFORE THE MOVE (#871 criterion 4). The point
     of the invited landing is that the reader is carried somewhere rather than
     asked to pick it, so the destination must not be spoken aloud on the way.
     `textContent` rather than `innerText` deliberately: it reads hidden and
     off-screen nodes too, so a name parked in a not-yet-revealed element still
     fails this. The state's active household is Harlow Home. */
  const beforeMove = await page.evaluate(() => document.body.textContent ?? "");
  expect(beforeMove, "the arrival named the household before moving to it").not.toContain("Harlow Home");

  /* THE COUNT STILL SHOWS: the boxless count is a real, positive number. */
  const countText = await page.locator(".nf .disc .big").textContent();
  expect(Number(countText)).toBeGreaterThan(0);

  /* One climb, and the chooser stays gone. */
  expect(await bodyClassAdds(page, "showwarp"), "one climb on /").toBe(1);
  await expect(page.locator(".nf .belong")).toHaveCount(0);

  /* THE MOVE: the sky lands the reader on their own household, by the same road
     any arriving member already takes -- no second landing invented. The belong
     beat is 13.8s into the climb, and the climb may hold up to 8s for its world
     (Flight.svelte, #1253). */
  await expect(page).toHaveURL(/\/home$/, { timeout: 40_000 });
  await expect(page.locator(".nf .belong")).toHaveCount(0);

  /* AND THE TOUR STILL RUNS (#871 criterion 3). The invited landing skips the
     chooser, not the welcome: this reader has never seen /home before, so the
     first-run film is exactly as due to them as to any newcomer (#864 is why
     this is asserted rather than assumed). The transport pill is the film's
     own handle, and `window.__reading()` is read for the chapter index:
     chapter 0 is where a fresh film always opens. The pocket dialect takes the
     same path as the desk (#1083). */
  const transport = page.locator("#orbit-tour-transport");
  await expect(transport).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => page.evaluate(() => /** @type {any} */ (window).__reading?.().chapter))
    .toBe(0);

  /* ...and no second climb on /home (#1263): toHousehold() writes no launch
     marker. Asked once the tour is up, well past the 200ms a climb's warp would
     have started at. The witness is per document, so this reads /home's own. */
  expect(await bodyClassSeen(page, "showwarp"), "showwarp seen on /home").toBe(false);
  expect(await bodyClassSeen(page, "showdawn"), "showdawn seen on /home").toBe(false);
});
