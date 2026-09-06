import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { cleanupHousehold, sessionHeaders } from "./support/households";

/**
 * #496 (epic #411 criterion 5): "`prefers-reduced-motion` and non-JS both
 * degrade to the plain manifest list."
 *
 * What "degrade" means was read out of the app rather than assumed:
 *
 *   - every route with a live backdrop (home's sky, due-next/documents/
 *     inbox/settings/household/item's own "*-drift" keyframes, the dial's
 *     POL-1/POL-2 flourishes, the login/logout flight) carries its own
 *     `@media (prefers-reduced-motion: reduce)` block that sets the
 *     offending `animation` to `none` or drops the element — see home.css,
 *     due-next.css, documents.css, inbox.css, settings.css, admin.css (see
 *     below), pocket.css, flight.css, arrival.css, logout.css and
 *     maintenance.css.
 *   - home's sky DRIFT specifically is not CSS at all: skies.js's
 *     `mountPlane()` reads `matchMedia("(prefers-reduced-motion: reduce)")`
 *     into a `still()` guard and never calls `requestAnimationFrame` when it
 *     matches (skies.js:235,258), so the drifting group's own `transform`
 *     attribute is the only place that would show it still running.
 *   - the "plain manifest list" is `.manifest .corridor` in
 *     web/src/routes/home/+page.svelte: a server-shaped list of `<a
 *     class="item">` rows (CorridorRow.svelte), grouped by month with a
 *     `.today` divider, every row a real link to `/home?item=<id>` rather
 *     than something the dial's pointer-driven chart hands you.
 *
 * Where a screen does not honour that promise, this file says so and leaves
 * the assertion failing rather than loosening it (see individual comments).
 */

const NAME_PREFIX = "reduced-motion-";

async function signIn(page: Page) {
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: "Orbit Administrator" }).click();
  await expect(page).toHaveURL(/\/home$/);
}

/** A household with two items, spread across "this month" and "next month"
 * so the manifest corridor exercises both its `.today`/current group and its
 * `.month` grouping (#469). Named "reduced-motion-" + a uuid: other specs
 * share this stack (#730). */
async function seedHousehold(page: Page) {
  const householdId = randomUUID();
  const sectionId = randomUUID();
  const name = `${NAME_PREFIX}${randomUUID()}`;
  const headers = { ...(await sessionHeaders(page)), "content-type": "application/json" };

  const created = await page.request.post("/api/workspace/commands", {
    headers,
    data: {
      type: "household.create",
      household: {
        id: householdId,
        name,
        timezone: "Europe/London",
        currency: "GBP",
        memberCount: 1,
        canManage: true,
        onboardingComplete: true,
        sections: [{ id: sectionId, name: "Home", icon: "home", accent: "sage", visible: true }],
        items: [],
      },
    },
  });
  if (!created.ok()) throw new Error(`Could not seed the reduced-motion household (${created.status()})`);

  const soonItem = `${NAME_PREFIX}gutter service`;
  const laterItem = `${NAME_PREFIX}boiler certificate`;
  const soonDue = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
  const laterDue = new Date(Date.now() + 70 * 86_400_000).toISOString().slice(0, 10);
  for (const [title, dueDate, scheduleKind] of [
    [soonItem, soonDue, "service"],
    [laterItem, laterDue, "renewal"],
  ] as const) {
    const upsert = await page.request.post("/api/workspace/commands", {
      headers,
      data: {
        type: "item.upsert",
        householdId,
        item: {
          id: randomUUID(),
          sectionId,
          title,
          currency: "GBP",
          costMinor: 4200,
          scheduleKind,
          dueDate,
          recurrenceMonths: 12,
          status: "active",
          version: 1,
          updatedAt: new Date().toISOString(),
        },
      },
    });
    if (!upsert.ok()) throw new Error(`Could not seed item "${title}" (${upsert.status()})`);
  }

  return { id: householdId, name, soonItem, laterItem };
}

/** Every CSS animation/transition currently RUNNING on the page (not
 * finished, not idle) -- the concrete meaning of "does not run" for a
 * feature built as a CSS animation rather than a JS loop. */
async function runningMotion(page: Page) {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => a.playState === "running")
      .map((a) => {
        const any = a as unknown as { animationName?: string; transitionProperty?: string };
        return any.animationName ?? (any.transitionProperty ? `transition:${any.transitionProperty}` : a.constructor.name);
      }),
  );
}

/** Load has finished and every one-shot reduced-motion entrance (the
 * login/arrival crossfade and the 404 well's staged reveal, both driven by
 * `transition`, which `family.css`'s reduced-motion rule does not touch --
 * only `animation` is `!important`-cleared there) has had time to finish, so
 * a real "still animating" reading isn't just "caught mid-transition".
 * Measured empirically: 1s left genuine one-shot fades still running; 3s
 * clears every screen that has no ongoing violation. */
async function settle(page: Page) {
  await page.waitForLoadState("load");
  await page.waitForTimeout(3000);
}

test.describe("reduced motion", () => {
  // PlaywrightTestOptions in this repo's pinned @playwright/test does not
  // expose `reducedMotion` for `test.use()` (checked against
  // node_modules/.pnpm/playwright@1.62.0's own types), so it is emulated per
  // page instead -- the same mechanism (page.emulateMedia) the fidelity
  // suite (web/tests/fidelity/screens.spec.js) already uses for this exact
  // media feature.
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("signed-in screens hold still (desktop dial)", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop-chromium dial only; the pocket dialect has its own test below");
    // Nine real navigations, each needing the full 3s settle (see settle()),
    // plus sign-in and seeding: comfortably over the 30s default per-test
    // timeout on its own merits, not because anything is slow to fail.
    test.setTimeout(150_000);

    await signIn(page);
    const household = await seedHousehold(page);
    const problems: string[] = [];

    try {
      const routes = [
        "/home",
        "/due-next",
        "/documents",
        "/inbox",
        "/create",
        "/settings",
        "/settings/mail",
        "/admin",
        "/administration",
      ];
      for (const route of routes) {
        await test.step(route, async () => {
          await page.goto(route);
          await settle(page);
          const motion = await runningMotion(page);
          if (motion.length > 0) problems.push(`${route}: still animating -> ${motion.join(", ")}`);
        });
      }
      // Found while writing this spec (#496): `/home` fails here every run.
      // home.css's `.handle i{animation:breathe 3s ease-in-out infinite}`
      // (the system-status drawer's pulsing health dot, ~line 176) has no
      // `prefers-reduced-motion` override anywhere in home.css -- unlike
      // every other continuous animation on this screen (`.ping`, `.dial`,
      // the sky drift, `.itemview`), which do. Confirmed by isolating it
      // with a throwaway diagnostic reading each running Animation's target
      // element: an `<i>` inside `.handle`, animation name "breathe".

      // Home's sky drift is a requestAnimationFrame loop, not a CSS
      // animation (skies.js mountPlane), so getAnimations() above cannot see
      // it either way. mountPlane() never schedules a frame under reduced
      // motion, so the drifting group's own transform must not move.
      await test.step("/home: sky drift (requestAnimationFrame, not CSS)", async () => {
        await page.goto("/home");
        await settle(page);
        const drift = page.locator("#pdrift");
        if ((await drift.count()) > 0) {
          const before = await drift.getAttribute("transform");
          await page.waitForTimeout(700);
          const after = await drift.getAttribute("transform");
          if (before !== after) {
            problems.push(`/home: sky drift (#pdrift transform) moved under reduced motion: ${before} -> ${after}`);
          }
        }
      });

      // POL-2's perihelion ping is dropped with `display:none` under reduced
      // motion (home.css `@media (prefers-reduced-motion: reduce){.ping{display:none}}`).
      await test.step("/home: POL-2 perihelion ping", async () => {
        const ping = page.locator(".ping").first();
        if ((await ping.count()) > 0 && (await ping.isVisible())) {
          problems.push("/home: .ping (POL-2 perihelion ping) is still visible under reduced motion");
        }
      });

      expect(problems, problems.join("\n")).toEqual([]);
    } finally {
      await cleanupHousehold(page, await sessionHeaders(page), household.id, household.name);
    }
  });

  // admin.css has NO `prefers-reduced-motion` rule at all -- unlike every
  // other screen's stylesheet. `.sky .grid` runs `precess 200s linear
  // infinite` and `.pulse` runs `tele 4s ease-in-out infinite` regardless of
  // the reader's motion setting. That gap is what the step above for /admin
  // is expected to catch; it is asserted here again, isolated, so a single
  // route failing does not need digging out of the combined list above.
  test("admin's telemetry backdrop is not exempt from reduced motion", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop-chromium only");
    await signIn(page);
    const household = await seedHousehold(page);
    try {
      await page.goto("/admin");
      await settle(page);
      const motion = await runningMotion(page);
      expect(motion, motion.join(", ")).toEqual([]);
    } finally {
      await cleanupHousehold(page, await sessionHeaders(page), household.id, household.name);
    }
  });

  test("home's pocket dialect holds still (mobile)", async ({ page, isMobile }) => {
    test.skip(!isMobile, "mobile-chromium only: the pocket dialect (CON-10) has its own reduced-motion rules");

    await signIn(page);
    const household = await seedHousehold(page);
    try {
      await page.goto("/home");
      await settle(page);
      const motion = await runningMotion(page);
      expect(motion, motion.join(", ")).toEqual([]);

      // pocket.css #466: `.pocket .mitem.reading .dot` runs `pocket-breathe`
      // normally and is explicitly turned off under reduced motion.
      const dot = page.locator(".pocket .mitem.reading .dot").first();
      if ((await dot.count()) > 0) {
        const animationName = await dot.evaluate((el) => getComputedStyle(el).animationName);
        expect(animationName).toBe("none");
      }
    } finally {
      await cleanupHousehold(page, await sessionHeaders(page), household.id, household.name);
    }
  });

  test("signed-out screens hold still", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop-chromium only");

    const problems: string[] = [];
    for (const route of ["/", "/login", "/logout"]) {
      await test.step(route, async () => {
        await page.goto(route);
        await settle(page);
        const motion = await runningMotion(page);
        if (motion.length > 0) problems.push(`${route}: still animating -> ${motion.join(", ")}`);
      });
    }

    await test.step("a 404", async () => {
      await page.goto(`/orbit-does-not-exist-${randomUUID()}`);
      await settle(page);
      const motion = await runningMotion(page);
      if (motion.length > 0) problems.push(`404: still animating -> ${motion.join(", ")}`);
    });

    // Unreachable outside a real maintenance window: +page.server.js
    // redirects to "/" unless the database says maintenance is active
    // (#773). Checked, not skipped, so a change that makes it reachable
    // without motion coverage does not go unnoticed silently.
    await test.step("/maintenance (if reachable)", async () => {
      await page.goto("/maintenance");
      await settle(page);
      if (new URL(page.url()).pathname === "/maintenance") {
        const motion = await runningMotion(page);
        if (motion.length > 0) problems.push(`/maintenance: still animating -> ${motion.join(", ")}`);
      }
    });

    expect(problems, problems.join("\n")).toEqual([]);
  });
});

test.describe("no JavaScript", () => {
  // Signing in requires JS (it is a real OIDC round trip through a button
  // click), so a JS-disabled context can never sign in for itself. Sign in
  // normally, then hand the session cookie to a second, JS-disabled context
  // -- the same household, read exactly as a non-JS visitor with a valid
  // session would see it.
  test("home degrades to the plain manifest list", async ({ page, context, browser, isMobile }) => {
    test.skip(isMobile, "the no-JS fallback is checked once, on desktop");

    await signIn(page);
    const household = await seedHousehold(page);
    try {
      const cookies = await context.cookies();
      const noJs = await browser.newContext({ javaScriptEnabled: false });
      try {
        await noJs.addCookies(cookies);
        const noJsPage = await noJs.newPage();
        await noJsPage.goto("/home");

        // The plain manifest list (`.manifest .corridor`, +page.svelte) is
        // built from `corridor`, a $derived off `view`. `view` starts as
        // `$state(null)` and is only ever assigned inside `onMount()`
        // (+page.svelte ~line 558) or event handlers -- both JS-only, and
        // there is no `+page.js`/universal load for /home that would fetch
        // it any other way (+page.server.js returns only the fixture flag).
        // So without JS, `view` stays null forever, `corridor` stays null,
        // and `{#if corridor && !view?.emptySky}` never renders the
        // `.corridor` div at all: the manifest is empty, not plain. Left
        // failing rather than weakened -- see the report for #496.
        await expect(noJsPage.locator(".manifest .corridor .item", { hasText: household.soonItem })).toHaveCount(1);
        await expect(noJsPage.locator(".manifest .corridor .item", { hasText: household.laterItem })).toHaveCount(1);
        await expect(noJsPage.locator(".manifest .corridor .today")).toContainText("TODAY");

        // Grouped, with dates printed: at least one month header, and the
        // due dates readable in each row (CorridorRow.svelte's `short()`).
        await expect(noJsPage.locator(".manifest .corridor .month").first()).toBeVisible();

        // Reachable without the interactive dial: every row is a real link.
        const soonHref = await noJsPage
          .locator(".manifest .corridor .item", { hasText: household.soonItem })
          .getAttribute("href");
        expect(soonHref).toMatch(/\/home\?item=/);
      } finally {
        await noJs.close();
      }
    } finally {
      await cleanupHousehold(page, await sessionHeaders(page), household.id, household.name);
    }
  });
});
