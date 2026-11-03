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
 * invitation that makes a stranger a member (the real mail pipe).
 * Dropped from the moved test, with where each is held instead:
 *  - the arrival ending on /home, the household being in the invited reader's
 *    workspace and no second climb on /home: they need the real redirect and a
 *    real membership (the fixture answers /home with a blank page), so they
 *    belong to the stack test above, whose journey ends on /home as a member;
 *  - the first-run film running after the move: v19-tour.spec.js (`/home` /
 *    `tour-due`), which holds the film's chapter 0.
 */
test.use({ reducedMotion: "no-preference" });

test("an invited reader's arrival never draws the chooser: the sky moves to the household instead (#871)", async ({ page }) => {
  test.setTimeout(120_000);
  await witnessBodyClasses(page);
  await door("arrival", "invited-landing-local-only")(page);

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
});
