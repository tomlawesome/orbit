import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { signIn, seedHousehold, READER, cleanup } from "./support/signed-in";
import { resetDatabaseBetweenSpecFiles } from "./support/database";

resetDatabaseBetweenSpecFiles();

/* #1700: what each document paints, frame by frame, on the OIDC return and the
   OIDC sign-out. The page records into console lines (a navigation discards
   anything held in the page), one JSON line per changed frame. */

type Frame = {
  doc: string; // path of the document the browser asked for
  at: number;
  path: string;
  body: string;
  painted: boolean; // svg.dial in the DOM, visible, and every ancestor up to body visible
  dial: boolean;
  dawn: boolean;
  dusk: boolean;
};

async function recordFrames(page: Page, forMs: number): Promise<Frame[]> {
  const frames: Frame[] = [];
  page.on("console", (m) => {
    if (m.text().startsWith("FRAME ")) frames.push(JSON.parse(m.text().slice(6)));
  });
  await page.addInitScript((until) => {
    const t0 = performance.now();
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const doc = nav ? new URL(nav.name).pathname : location.pathname;
    let last = "";
    const look = () => {
      const dial = document.querySelector("svg.dial");
      let painted = !!dial;
      for (let el: Element | null = dial; el && painted; el = el.parentElement) {
        if (getComputedStyle(el).visibility !== "visible") painted = false;
        if (el === document.body) break;
      }
      const f = {
        doc,
        at: Math.round(performance.now() - t0),
        path: location.pathname,
        body: document.body?.className ?? "",
        painted,
        dial: !!dial,
        dawn: !!document.querySelector("#dawn"),
        dusk: !!document.querySelector("#dusk, .dusk"),
      };
      const key = JSON.stringify({ ...f, at: 0 });
      if (key !== last) {
        last = key;
        console.log("FRAME " + JSON.stringify(f));
      }
    };
    document.addEventListener("readystatechange", look);
    const tick = () => {
      look();
      if (performance.now() - t0 < until) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style"] });
  }, forMs);
  return frames;
}

const has = (f: Frame, c: string) => f.body.split(/\s+/).includes(c);

test("sign-in through the door: no dial before the flight, no bare door during it", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  const household = await seedHousehold(page, "Frames1700");
  await page.context().clearCookies();
  const frames = await recordFrames(page, 9000);
  try {
    await page.goto("/");
    await page.locator("#gate").click();
    await page.getByRole("link", { name: READER() }).click();
    await page.waitForURL(/\/home$/, { timeout: 30_000 });
    await expect.poll(() => frames.some((f) => has(f, "instrument")), { timeout: 30_000 }).toBe(true);

    const home = frames.filter((f) => f.doc === "/home");
    expect(home.length, "no frames recorded on the /home document").toBeGreaterThan(0);
    const warpAt = home.findIndex((f) => has(f, "showwarp"));
    expect(warpAt, "showwarp never appeared on /home").toBeGreaterThanOrEqual(0);

    const early = home.slice(0, warpAt).find((f) => f.painted);
    expect(early, `a painted dial before showwarp: ${JSON.stringify(early)}`).toBeUndefined();

    const bare = home.slice(warpAt).find((f) => f.dawn && f.body.trim() === "");
    expect(bare, `the door without the flight classes after showwarp: ${JSON.stringify(bare)}`).toBeUndefined();
  } finally {
    await cleanup(page, household);
  }
});

test("sign-out through the provider: the returning /logout document is staged from its first frame", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  const household = await seedHousehold(page, "Frames1700b");
  await page.goto("/home");
  await page.waitForTimeout(2000);
  const frames = await recordFrames(page, 6000);
  try {
    await page.reload();
    await page.waitForTimeout(1500);
    /* the menu this layout draws: the desk's account card, or the phone's
       hatch sheet (#morb), whose sign-out is the same createSignOut */
    if (test.info().project.name.startsWith("mobile")) {
      await page.locator("#morb").click();
      await page.locator('.p-sheet-layer.open:has(nav[aria-label="Go to"])').getByRole("button", { name: /sign out/ }).click();
    } else {
      await page.locator("button.orb").first().click();
      await page.locator("button.signout").first().click();
    }
    await page.waitForURL(/\/logout$/, { timeout: 60_000 });
    await page.waitForTimeout(8000);

    /* the document the provider sent back: asked for as /logout */
    const back = frames.filter((f) => f.doc === "/logout");
    expect(back.length, "no frames recorded on the returning /logout document").toBeGreaterThan(0);
    const withDusk = back.filter((f) => f.dusk);
    expect(withDusk.length, "no dusk markup seen on /logout").toBeGreaterThan(0);
    const bad = withDusk.find((f) => !has(f, "showdusk") || !has(f, "farewell"));
    expect(bad, `dusk markup drawn before showdusk farewell: ${JSON.stringify(bad)}`).toBeUndefined();
  } finally {
    await signIn(page);
    await cleanup(page, household);
  }
});

test("ordinary visit to /home paints the dial and never sets launch-owed", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const household = await seedHousehold(page, "Frames1700c");
  const frames = await recordFrames(page, 5000);
  try {
    await page.goto("/home");
    await expect.poll(() => frames.some((f) => f.doc === "/home" && f.painted), { timeout: 30_000 }).toBe(true);
    await page.waitForTimeout(4500);
    const owed = frames.find((f) => has(f, "launch-owed"));
    expect(owed, `launch-owed was set: ${JSON.stringify(owed)}`).toBeUndefined();
  } finally {
    await cleanup(page, household);
  }
});
