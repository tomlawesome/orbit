import { expect, test } from "@playwright/test";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * #1050: home.css's `.group`/`.group.seen` fade-in rule was unscoped, so once
 * a reader had visited /home its CSS chunk stayed loaded (SvelteKit does not
 * unload a visited route's stylesheet on client-side navigation) and kept
 * matching inbox's own `<div class="group">` lane wrappers. Nothing on
 * /inbox ever adds `.seen`, so the lane headings sat at opacity:0 forever --
 * but only when /inbox was reached from inside the app. A direct load of
 * /inbox never loads home's chunk at all, so that path always passed and
 * proved nothing.
 *
 * So the walk matters as much as the assertion: land on /home first, follow
 * a real in-app link to /inbox (client-side, not page.goto), and only then
 * read the lane's computed style. Here rather than in the e2e suite for the
 * same reason as pocket-create-reach.spec.js and belt-chrome-viewport.spec.js
 * next door -- this harness already stands up the real app with fixtures and
 * needs no live instance.
 */
test("inbox lane headings stay visible after a client-side navigation from home", async ({ page }) => {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  /* Home's own settle (screens.spec.js): the galaxy has been placed. */
  await page.waitForFunction(() => document.querySelectorAll(".minisys").length > 0);

  /* The inbox-orb top-right icon -- a plain <a href>, so SvelteKit takes this
     client-side rather than issuing a fresh navigation. */
  await page.locator("a.inbox-orb").click();
  await page.waitForURL("**/inbox");
  /* Inbox's own settle (screens.spec.js): the review card has arrived. */
  await page.waitForFunction(() => Boolean(document.querySelector(".receipt .actions")));

  /* The Filed lane always renders once the queue view has landed (it is not
     behind an {#if view.filed.length}), so it is the stable target. */
  const filedGroup = page.locator(".lane.filed .group");
  await expect(filedGroup, "#1050: the Filed lane's wrapper must not inherit home's opacity:0 fade-in").toHaveCSS(
    "opacity",
    "1",
  );
  await expect(filedGroup.locator("h2")).toBeVisible();
});
