import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { householdRegister } from "./support/households";
import { settleArrival } from "./support/arrival";
import { settled } from "./support/keyboard";
import { finiteMotionSettled } from "./support/motion";
import { renderedFrames } from "./support/frames";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { householdDateFromToday } from "./support/household-dates";

resetDatabaseBetweenSpecFiles();

/**
 * #1472 (north star: scrolled to the manifest, the first click scrolls to the
 * top instead of opening the drawer).
 *
 * On the desk's home, scroll down to the manifest and press the north star:
 * the quick-add drawer must open on that first press and the page must stay
 * where it was. It used to scroll back to the top and need a second press,
 * the owner saw it with a manifest row expanded (on the desk a row opens the
 * item's drawer: `/home?item=<id>`, as v19-home-drawer.spec.ts reads it).
 *
 * Covered from a scrolled page: (a) no row expanded; (b) a row expanded.
 *
 * Desk only: the pocket's north star is a link to Add, not a drawer
 * (web/tests/fidelity/pocket-create-reach.spec.js), and the pocket scrolls
 * its own sheet.
 *
 * Reaching the star while scrolled: `.drawer-top` is a `position: fixed`
 * drawer (v19-keyboard.spec.ts), so the star should stay on screen. Each test
 * asserts the star is in the viewport BEFORE the press; if it is not, that
 * fails by name rather than letting Playwright's click scroll it into view,
 * which would hide the very thing under test.
 */
test.skip(({ isMobile }) => isMobile, "the north star's drawer is the desk's; the pocket's north star is a link to Add");

const HOUSEHOLD = "Scrolled Star Proving Ground";
const ITEM_COUNT = 16;
/** How far the window may move between the press and the end, in px. */
const TOLERANCE = 4;
const households = householdRegister();

/** A household with enough items for a manifest worth scrolling to. Returns
 *  the item ids, soonest due first. */
async function seedHouseholdWithItems(page: Page): Promise<{ id: string; name: string; itemIds: string[] }> {
  const name = `${HOUSEHOLD} ${randomUUID().slice(0, 8)}`;
  const dueDates = Array.from({ length: ITEM_COUNT }, (_, index) => householdDateFromToday(10 + index * 5));
  const seeded = await page.evaluate(async ({ householdName, dates }) => {
    const session = (await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { csrfToken: string };
    const command = async (payload: unknown) => {
      const response = await fetch("/api/workspace/commands", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`command failed: ${response.status} ${await response.text()}`);
    };
    const householdId = crypto.randomUUID();
    const sectionId = crypto.randomUUID();
    await command({
      type: "household.create",
      household: {
        id: householdId,
        name: householdName,
        timezone: "Europe/London",
        currency: "GBP",
        memberCount: 1,
        canManage: true,
        onboardingComplete: true,
        sections: [{ id: sectionId, name: "Home", icon: "home", accent: "sage", visible: true }],
        items: [],
      },
    });
    const itemIds: string[] = [];
    for (const [index, dueDate] of dates.entries()) {
      const itemId = crypto.randomUUID();
      await command({
        type: "item.upsert",
        householdId,
        kind: "service",
        item: { id: itemId, sectionId, title: `Scrolled star item ${index + 1}`, currency: "GBP", dueDate, recurrenceMonths: 12 },
        activity: { id: crypto.randomUUID(), itemId, occurredAt: new Date().toISOString() },
      });
      itemIds.push(itemId);
    }
    return { id: householdId, name: householdName, itemIds };
  }, { householdName: name, dates: dueDates });
  households.track({ id: seeded.id, name });
  return seeded;
}

async function signIn(page: Page) {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
}

/** The owner's gesture, as v19-home-scroll.spec.ts makes it: the wheel over
 *  the sky until the manifest is in view. */
async function wheelToManifest(page: Page) {
  const viewport = page.viewportSize();
  await page.mouse.move((viewport?.width ?? 1280) / 2, (viewport?.height ?? 800) / 2);
  const manifest = page.locator("#manifest-top");
  await expect(async () => {
    await page.mouse.wheel(0, 600);
    await expect(manifest).toBeInViewport({ timeout: 500 });
  }).toPass({ timeout: 10_000 });
}

/** The window's scroll position once it has stopped moving (20 frames the
 *  page drew in a row at the same place), so a smooth scroll in flight is not
 *  mistaken for where the page is resting. Counted in frames, not time: a
 *  slow machine draws them slowly and is given as long as it needs. */
async function restingScrollY(page: Page): Promise<number> {
  const rest = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let last = window.scrollY;
        let still = 0;
        let drawn = 0;
        const look = () => {
          const now = window.scrollY;
          still = Math.abs(now - last) < 1 ? still + 1 : 0;
          last = now;
          drawn += 1;
          if (still >= 20) resolve(now);
          else if (drawn > 3_000) resolve(-1);
          else requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
      }),
  );
  expect(rest, "the page never stopped scrolling").toBeGreaterThanOrEqual(0);
  return rest;
}

/** Home, live, with the first-run tour put away and the page wheeled down to
 *  the manifest and resting there. Returns the seeded item ids. */
async function homeScrolledToManifest(page: Page): Promise<string[]> {
  await signIn(page);
  const household = await seedHouseholdWithItems(page);
  await page.goto("/home");
  await settled(page);
  await wheelToManifest(page);
  const scrolledTo = await restingScrollY(page);
  expect(scrolledTo, "the page did not scroll down to the manifest").toBeGreaterThan(200);
  return household.itemIds;
}

/** The press: the star is on screen where the page rests, one click opens
 *  the drawer, and at no frame from before the press until the drawer's
 *  animations have ended and 60 more frames have been drawn is the window
 *  anywhere but where it was. */
async function pressNorthStarOnce(page: Page, restedAt: number, how: "click" | "Space" | "Enter" = "click") {
  const star = page.locator("#nstar");
  await expect(star, "the north star is not on screen while scrolled; it cannot be pressed from here").toBeInViewport();

  /* Watch the window's place on every frame the page draws from here on, so a
     scroll away and back is seen as well as one that stays away. */
  await page.evaluate((from) => {
    const watch = window as unknown as { __farthest: number; __watching: boolean };
    watch.__farthest = 0;
    watch.__watching = true;
    const look = () => {
      watch.__farthest = Math.max(watch.__farthest, Math.abs(window.scrollY - from));
      if (watch.__watching) requestAnimationFrame(look);
    };
    look();
  }, restedAt);

  if (how === "click") {
    await star.click();
  } else {
    /* the keyboard reader: focus the star (it is on screen, so focusing it
       does not move the page) and press the key */
    await star.focus();
    await expect(star).toBeFocused();
    await page.keyboard.press(how);
  }
  await expect(page.locator("#createdrawer"), "one press on the north star did not open the drawer").toHaveClass(/\bopen\b/);
  await expect(star).toHaveAttribute("aria-expanded", "true");

  /* A smooth scroll to the top takes the better part of a second. Let the
     drawer's own motion end and then draw 60 frames, rather than race it or
     guess a time: the claim is about where the page goes. */
  await finiteMotionSettled(page, 60);
  const farthest = await page.evaluate(() => {
    const watch = window as unknown as { __farthest: number; __watching: boolean };
    watch.__watching = false;
    return watch.__farthest;
  });
  expect(
    farthest,
    `the page moved ${farthest}px from scrollY ${restedAt} when the north star was pressed`,
  ).toBeLessThanOrEqual(TOLERANCE);
  /* and the drawer is still the open one, not opened-then-closed */
  await expect(page.locator("#createdrawer")).toHaveClass(/\bopen\b/);
}

test.afterEach(async ({ page }) => {
  await households.sweep(page);
});

test("scrolled to the manifest, one press on the north star opens the drawer and the page stays put", async ({ page }) => {
  test.setTimeout(120_000);
  await homeScrolledToManifest(page);
  const restedAt = await restingScrollY(page);

  await pressNorthStarOnce(page, restedAt);
});

test("scrolled to the manifest with a row expanded, one press on the north star opens the drawer and the page stays put", async ({ page }) => {
  test.setTimeout(120_000);
  const itemIds = await homeScrolledToManifest(page);

  /* expand a row in view: on the desk the row opens the item's drawer */
  const itemId = itemIds[0];
  const row = page.locator(`a.item[id="${itemId}"]`);
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator(`[id="${itemId}-view"]`)).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(new RegExp(`/home\\?item=${itemId}$`));
  /* the page is still down at the manifest, not back at the top */
  const restedAt = await restingScrollY(page);
  expect(restedAt, "expanding the row left the manifest").toBeGreaterThan(200);

  await pressNorthStarOnce(page, restedAt);
});

/** Home with a row opened part-way down and the page then scrolled well past
 *  it, resting there with the row's drawer still open. */
async function homeWithRowOpenedThenScrolledOn(page: Page): Promise<number> {
  await signIn(page);
  const household = await seedHouseholdWithItems(page);
  const itemId = household.itemIds[0];
  await page.goto("/home");
  await settled(page);

  /* wheel down until the first manifest row is in view, then open it */
  const row = page.locator(`a.item[id="${itemId}"]`);
  const viewport = page.viewportSize();
  await page.mouse.move((viewport?.width ?? 1280) / 2, (viewport?.height ?? 800) / 2);
  await expect(async () => {
    await page.mouse.wheel(0, 300);
    await expect(row).toBeInViewport({ timeout: 500 });
  }).toPass({ timeout: 15_000 });
  await restingScrollY(page);
  await row.click();
  await expect(page.locator(`[id="${itemId}-view"]`)).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(new RegExp(`/home\\?item=${itemId}$`));
  const openedAt = await restingScrollY(page);

  /* on down, well past where the row was opened */
  await page.mouse.move((viewport?.width ?? 1280) / 2, (viewport?.height ?? 800) / 2);
  await page.mouse.wheel(0, 400);
  await page.mouse.wheel(0, 400);
  /* Rest only once the page has taken BOTH wheels. A wheel's scroll can land
     late on a loaded machine (CI saw the second one arrive after a rest
     check had already returned), so resting alone can report the position
     between the two and the press then sees the page "move" on. The target is
     the two wheels' worth, or the bottom of the page if that is nearer. */
  await expect.poll(async () => {
    return page.evaluate(({ from }) => {
      const bottom = document.documentElement.scrollHeight - window.innerHeight;
      return window.scrollY >= Math.min(from + 800, bottom) - 4;
    }, { from: openedAt });
  }, { timeout: 15_000, message: "the page did not take both wheels" }).toBe(true);
  const restedAt = await restingScrollY(page);
  expect(restedAt - openedAt, "the page did not scroll on past where the row was opened (too short?)").toBeGreaterThan(200);
  await expect(page.locator(`[id="${itemId}-view"]`)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/home\\?item=${itemId}$`));

  return restedAt;
}

/* The owner's path. Opening a manifest row adds a browser history entry, and
   the star closes the row by going Back, which restores the scroll position
   the page had WHEN THE ROW WAS OPENED. So the fault shows when the reader
   scrolls further after opening the row; tests 1 and 2 press the star where
   the row was opened, so Back lands them in the same place and cannot see
   it. Here: wheel down until the first row is just in view, open it, wheel
   on down well past it, and only then press the star. */
test("a row opened part-way down, then scrolled further, one press on the north star opens the drawer and the page stays put", async ({ page }) => {
  test.setTimeout(120_000);
  const restedAt = await homeWithRowOpenedThenScrolledOn(page);
  await pressNorthStarOnce(page, restedAt);
});

/* Keyboard: Space and Enter on the focused star are presses on it, not "the
   reader scrolling" (Space scrolls a page, which must not be mistaken for the
   reader's own scroll and close the drawer just opened). Same setup as the
   test above. */
for (const key of ["Space", "Enter"] as const) {
  test(`${key} on the focused north star, with a row opened part-way down and the page scrolled further, opens the drawer and it stays open, the page where it was`, async ({ page }) => {
    test.setTimeout(120_000);
    const restedAt = await homeWithRowOpenedThenScrolledOn(page);

    await pressNorthStarOnce(page, restedAt, key);
  });
}

/* Guards: the drawer still closes when the READER scrolls. */
async function homeWithQuickAddOpenNearTheTop(page: Page, { fakeClock = false }: { fakeClock?: boolean } = {}) {
  await signIn(page);
  await seedHouseholdWithItems(page);
  /* The page's clock, from here on, is the test's to move (time still passes
     at its own pace until the test moves it on). */
  if (fakeClock) await page.clock.install();
  await page.goto("/home");
  await settled(page);
  await page.locator("#nstar").click();
  await expect(page.locator("#createdrawer")).toHaveClass(/\bopen\b/);
  /* let anything the opening does to the scroll finish */
  await restingScrollY(page);
}

test("with the quick-add drawer open, a wheel scroll of the page closes it", async ({ page }) => {
  test.setTimeout(90_000);
  await homeWithQuickAddOpenNearTheTop(page);
  const before = await page.evaluate(() => window.scrollY);

  const viewport = page.viewportSize();
  await page.mouse.move((viewport?.width ?? 1280) / 2, (viewport?.height ?? 800) - 100);
  await page.mouse.wheel(0, 300);

  await expect(page.locator("#createdrawer"), "the reader's wheel scroll did not close the drawer").not.toHaveClass(/\bopen\b/);
  expect(await page.evaluate(() => window.scrollY), "the wheel did not scroll the page").toBeGreaterThan(before);
});

test("with the quick-add drawer open, PageDown with focus on the page (not a control) closes it", async ({ page }) => {
  test.setTimeout(90_000);
  await homeWithQuickAddOpenNearTheTop(page);

  /* focus on the page itself, not on the star the click left it on */
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await page.keyboard.press("PageDown");

  await expect(page.locator("#createdrawer"), "PageDown on the page did not close the drawer").not.toHaveClass(/\bopen\b/);
});

/** A reader's wheel input that does not itself scroll: a synthetic event
 *  reaches the page's listeners as input but moves nothing, so the test
 *  decides when the scroll lands. */
async function wheelInputWithoutScroll(page: Page) {
  await page.evaluate(() => {
    document.documentElement.dispatchEvent(new WheelEvent("wheel", { deltaY: 300, bubbles: true, cancelable: true }));
  });
}

/** A scroll from script, instant: no input of the reader's behind it. */
async function scrollFromScript(page: Page) {
  await page.evaluate(() => window.scrollBy({ top: 300, behavior: "instant" }));
}

/* However late the scroll lands after the reader's input, it is the reader's:
   WebKit on a loaded CI machine applied a wheel's scroll more than a second
   after the wheel. The page's clock is moved on 1.5 s, so the lateness is
   exact and costs no real time: a rule that let the input expire on a timer
   would fire here. */
test("with the quick-add drawer open, a scroll landing 1.5 s after the reader's wheel still closes it", async ({ page }) => {
  test.setTimeout(90_000);
  await homeWithQuickAddOpenNearTheTop(page, { fakeClock: true });
  const before = await page.evaluate(() => window.scrollY);

  await wheelInputWithoutScroll(page);
  await page.clock.runFor(1_500);
  await scrollFromScript(page);

  await expect(page.locator("#createdrawer"), "a scroll 1.5 s after the reader's wheel did not close the drawer").not.toHaveClass(/\bopen\b/);
  expect(await page.evaluate(() => window.scrollY), "the late scroll did not move the page").toBeGreaterThan(before);
});

/* Input made before a drawer opened is spent: it must not turn a later scroll
   the reader did not make (history putting a position back, a glide) into a
   close. */
test("a wheel before the quick-add drawer opened does not close it on a later scroll the reader did not make", async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  await seedHouseholdWithItems(page);
  await page.goto("/home");
  await settled(page);
  await restingScrollY(page);

  await wheelInputWithoutScroll(page);
  await page.locator("#nstar").click();
  await expect(page.locator("#createdrawer"), "one press on the north star did not open the drawer").toHaveClass(/\bopen\b/);
  const before = await page.evaluate(() => window.scrollY);

  /* The page's own scroll handling is the thing under test, and it listens
     for the window's `scroll` event. This listener is added after it, so by
     the time this one has run for the script's scroll, that handling has. */
  await page.evaluate(() => {
    const seen = window as unknown as { __scrollHandled: boolean };
    seen.__scrollHandled = false;
    addEventListener("scroll", () => { seen.__scrollHandled = true; }, { passive: true });
  });
  await scrollFromScript(page);
  await expect.poll(() => page.evaluate(() => window.scrollY), { message: "the script's scroll did not move the page" }).toBeGreaterThan(before);
  await page.waitForFunction(() => (window as unknown as { __scrollHandled: boolean }).__scrollHandled, undefined, { timeout: 20_000 });
  await renderedFrames(page);

  await expect(page.locator("#createdrawer"), "a scroll the reader did not make closed the drawer, on the strength of a wheel from before it opened").toHaveClass(/\bopen\b/);
});
