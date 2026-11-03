import { expect, test } from "@playwright/test";

import { renderedFrames } from "../../../tests/e2e/support/frames";
import { finiteMotionSettled } from "../fidelity/finite-motion.js";
import { APP, door, onPhone, signedIn } from "./a11y-support.js";

/** @typedef {import("@playwright/test").Page} Page */

/*
 * #496 (epic #411 criterion 5): "`prefers-reduced-motion` and non-JS both
 * degrade to the plain manifest list", moved to the rig (ADR-0039, #1610).
 *
 * What "degrade" means was read out of the app rather than assumed:
 *
 *   - every route with a live backdrop (home's sky,
 *     inbox/settings/household's own "*-drift" keyframes, the dial's
 *     POL-1/POL-2 flourishes, the login/logout flight) carries its own
 *     `@media (prefers-reduced-motion: reduce)` block that sets the
 *     offending `animation` to `none` or drops the element -- see home.css,
 *     inbox.css, settings.css, pocket.css, flight.css, arrival.css,
 *     logout.css and maintenance.css.
 *   - home's sky DRIFT specifically is not CSS at all: skies.js's
 *     `mountPlane()` reads `matchMedia("(prefers-reduced-motion: reduce)")`
 *     into a `still()` guard and never calls `requestAnimationFrame` when it
 *     matches, so the drifting group's own `transform` attribute is the only
 *     place that would show it still running.
 *   - the "plain manifest list" is `.manifest .corridor` in
 *     web/src/routes/home/+page.svelte: a server-shaped list of `<a
 *     class="item">` rows, grouped by month with a `.today` divider, every
 *     row a real link to `/home?item=<id>`.
 *
 * Where a screen does not honour that promise, this file says so and leaves
 * the assertion failing rather than loosening it (see individual comments).
 *
 * Every test starts from a fixture state (../fidelity/pocket-states.js) or a
 * fixture route's own address; nothing is signed into or seeded. The fixture
 * workspace's Boiler service (`i-boiler`) is the item whose drawer is judged.
 * Reduced motion is emulated before the state is reached, so the screen
 * draws, and settles, as a reader who asked for it would see it.
 */
test.use({ baseURL: APP });

/* The fixture workspace's Boiler service, in Harlow Home's Home section. */
const ITEM_ID = "i-boiler";
const ITEM_TITLE = "Boiler service";

/**
 * Every CSS animation/transition currently RUNNING on the page (not finished,
 * not idle) -- the concrete meaning of "does not run" for a feature built as a
 * CSS animation rather than a JS loop.
 * @param {Page} page
 * @returns {Promise<string[]>}
 */
async function runningMotion(page) {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => a.playState === "running")
      .map((a) => {
        const any = /** @type {{ animationName?: string, transitionProperty?: string }} */ (/** @type {unknown} */ (a));
        return any.animationName ?? (any.transitionProperty ? `transition:${any.transitionProperty}` : a.constructor.name);
      }),
  );
}

/**
 * The signed-out screens' one-shot entrances cannot begin until their sky has
 * rasterised (#1219): every one of them -- the door, the logout, the error
 * page, maintenance -- mounts a `.world` and the grain, which mark themselves
 * `data-rasterised="ready"` when their filtered layers are drawn. So the wait
 * for the finite animations to end begins once the sky is ready, and ends when
 * they have, however long the thread held them; anything still running after
 * it is still reported.
 * @param {Page} page
 */
async function settleSignedOut(page) {
  await page.waitForFunction(() => {
    const surfaces = [...document.querySelectorAll(".world[data-rasterised], .grain[data-rasterised]")];
    return surfaces.some((surface) => surface.classList.contains("world"))
      && surfaces.every((surface) => /** @type {HTMLElement} */ (surface).dataset.rasterised === "ready");
  }, undefined, { timeout: 30_000 });
  await finiteMotionSettled(page);
}

/**
 * #1319 (owner-decisions §34): the item's own screen is home's drawer now,
 * so the drawer is held to the same rule: open on its address, then with its
 * rows in edit and the chooser up (the card slides in beside the drawer, or
 * rises as the phone's sheet, and drops that under reduced motion:
 * ChooserCard.svelte).
 * @param {Page} page
 * @param {boolean} phone
 * @returns {Promise<string[]>}
 */
async function drawerMotion(page, phone) {
  /** @type {string[]} */
  const problems = [];
  await page.goto(`/home?item=${ITEM_ID}`);
  const drawer = phone
    ? page.locator(`.pocket .pk-below [data-row-key="${ITEM_ID}"]`)
    : page.locator(`[id="${ITEM_ID}-view"]`);
  await expect(drawer.getByRole("group", { name: `Actions for ${ITEM_TITLE}` })).toBeVisible({ timeout: 30_000 });
  await finiteMotionSettled(page);
  const open = await runningMotion(page);
  if (open.length > 0) problems.push(`/home?item=: the drawer open, still animating -> ${open.join(", ")}`);

  await drawer.getByRole("button", { name: "Edit this item" }).click();
  await drawer.getByRole("button", { name: /^due: / }).click();
  await expect(page.getByRole("dialog", { name: /due date/i })).toBeVisible();
  await finiteMotionSettled(page);
  const choosing = await runningMotion(page);
  if (choosing.length > 0) problems.push(`/home?item=: the chooser up, still animating -> ${choosing.join(", ")}`);
  return problems;
}

test.describe("reduced motion", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("signed-in screens hold still (desktop dial)", async ({ page }, testInfo) => {
    test.skip(onPhone(testInfo), "the desk dial only; the pocket dialect has its own test below");
    /* Six real navigations, each waiting for its finite motion to end, then
       the drift, the ping and the drawer. */
    test.setTimeout(120_000);

    /** @type {string[]} */
    const problems = [];
    /* The fixture states for /create and /administration wait for pocket-only
       elements (`#pocket-entry`, `.ad-pocket`), so a desk takes their address. */
    const routes = [
      { path: "/home", state: "rest" },
      { path: "/inbox", state: "rest" },
      { path: "/create", state: null },
      { path: "/settings", state: "rest" },
      { path: "/settings/mail", state: "rest" },
      { path: "/administration", state: null },
    ];
    for (const route of routes) {
      await test.step(route.path, async () => {
        if (route.state) await signedIn(route.path, route.state)(page);
        else await page.goto(`${APP}${route.path}`, { waitUntil: "load" });
        await finiteMotionSettled(page);
        const motion = await runningMotion(page);
        if (motion.length > 0) problems.push(`${route.path}: still animating -> ${motion.join(", ")}`);
      });
    }
    // Found while writing the stack version (#496): `/home` failed there every
    // run. home.css's `.handle i{animation:breathe 3s ease-in-out infinite}`
    // (the system-status drawer's pulsing health dot) had no
    // `prefers-reduced-motion` override anywhere in home.css -- unlike every
    // other continuous animation on this screen (`.ping`, `.dial`, the sky
    // drift, `.itemview`), which do.

    // Home's sky drift is a requestAnimationFrame loop, not a CSS animation
    // (skies.js mountPlane), so getAnimations() above cannot see it either
    // way. mountPlane() never schedules a frame under reduced motion, so the
    // drifting group's own transform must not move.
    await test.step("/home: sky drift (requestAnimationFrame, not CSS)", async () => {
      await signedIn("/home", "rest")(page);
      await finiteMotionSettled(page);
      const drift = page.locator("#pdrift");
      if ((await drift.count()) > 0) {
        const before = await drift.getAttribute("transform");
        /* 30 frames the page drew, not 700 ms: a drift that ran on any frame
           would have moved its transform by the end of them. */
        await renderedFrames(page, 30);
        const after = await drift.getAttribute("transform");
        if (before !== after) {
          problems.push(`/home: sky drift (#pdrift transform) moved under reduced motion: ${before} -> ${after}`);
        }
      }
    });

    // POL-2's perihelion ping is dropped with `display:none` under reduced
    // motion (home.css `@media (prefers-reduced-motion: reduce){.ping{display:none}}`).
    // T-Q3 (#1151): `.ping` only renders at all when the household has an
    // overdue item (+page.svelte's `firstOverdue`), so this requires the
    // element to actually be there rather than silently passing when it is not.
    await test.step("/home: POL-2 perihelion ping", async () => {
      const ping = page.locator(".ping").first();
      if ((await ping.count()) === 0) {
        problems.push("/home: .ping (POL-2 perihelion ping) did not render for an overdue item");
      } else if (await ping.isVisible()) {
        problems.push("/home: .ping (POL-2 perihelion ping) is still visible under reduced motion");
      }
    });

    await test.step("/home?item=<id>: the item's drawer and its chooser", async () => {
      problems.push(...await drawerMotion(page, false));
    });

    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("home's pocket dialect holds still (mobile)", async ({ page }, testInfo) => {
    test.skip(!onPhone(testInfo), "the phone only: the pocket dialect (CON-10) has its own reduced-motion rules");
    /* home, then the drawer (#1319), each waiting for its finite motion to end */
    test.setTimeout(90_000);

    await signedIn("/home", "rest")(page);
    await finiteMotionSettled(page);
    const motion = await runningMotion(page);
    expect(motion, motion.join(", ")).toEqual([]);

    // pocket.css #466: `.pocket .mitem.reading .dot` runs `pocket-breathe`
    // normally and is explicitly turned off under reduced motion.
    const dot = page.locator(".pocket .mitem.reading .dot").first();
    if ((await dot.count()) > 0) {
      const animationName = await dot.evaluate((el) => getComputedStyle(el).animationName);
      expect(animationName).toBe("none");
    }

    const problems = await drawerMotion(page, true);
    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("signed-out screens hold still", async ({ page }) => {
    /* The door's states, each the sky's rasterising plus the wait for its
       finite motion to end. */
    test.setTimeout(90_000);

    /** @type {string[]} */
    const problems = [];
    /** @type {[string, () => Promise<void>][]} */
    const screens = [
      ["/", () => door("door", "rest")(page)],
      ["/login", () => door("login", "mixed")(page)],
      ["/logout", () => door("logout", "rest")(page)],
      ["a 404", () => door("404", "rest")(page)],
      /* `/maintenance` answers a known window under the fixtures, which is what
         makes it reachable here at all (the stack's only did inside a real
         window, #773). */
      ["/maintenance", () => door("maintenance", "rest")(page)],
    ];
    for (const [name, reach] of screens) {
      await test.step(name, async () => {
        await reach();
        await settleSignedOut(page);
        const motion = await runningMotion(page);
        if (motion.length > 0) problems.push(`${name}: still animating -> ${motion.join(", ")}`);
      });
    }

    expect(problems, problems.join("\n")).toEqual([]);
  });
});

test.describe("no JavaScript", () => {
  test("home degrades to the plain manifest list", async ({ browser }, testInfo) => {
    test.skip(onPhone(testInfo), "the no-JS fallback is checked once, on the desk");

    /* No sign-in to hand over: the fixture app answers as a signed-in reader
       to a context that runs no script at all. */
    const noJs = await browser.newContext({ javaScriptEnabled: false });
    try {
      const noJsPage = await noJs.newPage();
      await noJsPage.goto(`${APP}/home`);

      // The plain manifest list (`.manifest .corridor`, +page.svelte) is
      // built from `corridor`, a $derived off `view`, and `view` starts from
      // the server's own read of the workspace (+page.server.js, #842), so
      // the first render already has the manifest and a reader with no
      // JavaScript gets the list rather than an empty page.
      await expect(noJsPage.locator(".manifest .corridor .item", { hasText: "Chimney sweep" })).toHaveCount(1);
      await expect(noJsPage.locator(".manifest .corridor .item", { hasText: "Roof replacement" })).toHaveCount(1);
      await expect(noJsPage.locator(".manifest .corridor .today")).toContainText("TODAY");

      // Grouped, with dates printed: at least one month header, and the
      // due dates readable in each row (CorridorRow.svelte's `short()`).
      await expect(noJsPage.locator(".manifest .corridor .month").first()).toBeVisible();

      // Reachable without the interactive dial: every row is a real link.
      const soonHref = await noJsPage
        .locator(".manifest .corridor .item", { hasText: "Chimney sweep" })
        .getAttribute("href");
      expect(soonHref).toMatch(/\/home\?item=/);
    } finally {
      await noJs.close();
    }
  });
});
