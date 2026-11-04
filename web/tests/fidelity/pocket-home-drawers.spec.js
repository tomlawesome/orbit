import { expect, test } from "@playwright/test";
import { APP, openRow, settle } from "./pocket-states.js";
import { finiteMotionDone } from "./finite-motion.js";

/*
 * HOME'S DRAWERS ON A PHONE (#1120, review round §2.1), in a real browser.
 * What a drawer asks and says (complete asking in the rows, a search result
 * or an address opening its row, a suggestion's two decisions, review &
 * amend, cancel asked twice, the replayed wake) is proved on the mounted
 * page in tests/unit/pocket-home-drawers.test.mjs (#1613, ADR-0039). What
 * stays here needs layout, scroll, computed style, real focus or the sheets'
 * inert: the outline an addressed row wears, a paper opening the preview as
 * the bottom sheet and the page behind it going inert, a chooser sheet, a
 * planet opening its row and a second tap bringing it back on screen, the
 * dial arriving on a forward arrival and never on Back, the signals' gaps,
 * the north star, and a chip flying to another household.
 * Fixture data, at the height a phone browser leaves.
 */
test.use({ viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true });

/**
 * Whether a row's outline is the theme's accent (owner-decisions §29: an
 * opened row with an outline of its own turns it accent, 1px, no rail).
 * Compared through a probe so the check holds in any theme.
 * @param {import("@playwright/test").Locator} row
 */
const wearsAccentOutline = (row) => row.evaluate((el) => {
  const probe = document.createElement("i");
  probe.style.color = "var(--accent)";
  el.append(probe);
  const accent = getComputedStyle(probe).color;
  probe.remove();
  return getComputedStyle(el).borderTopColor === accent;
});
test("the address opens the row", async ({ page }) => {
  await page.goto(`${APP}/home?item=i-boiler`, { waitUntil: "load" });
  await settle(page);
  const boiler = page.locator(".pocket .pk-below [data-row]", { hasText: "Boiler service" }).first();
  await expect(boiler).toHaveAttribute("data-open", "");
  await expect(boiler).toBeInViewport();
  /* owner-decisions §29: the opened manifest row's own outline turns the
     accent, 1px solid, and no rail is drawn on its face or drawer. */
  await expect(boiler).toHaveCSS("border-top-style", "solid");
  await expect(boiler).toHaveCSS("border-top-width", "1px");
  expect(await wearsAccentOutline(boiler)).toBe(true);
  await expect(boiler.locator(":scope > .face")).toHaveCSS("box-shadow", "none");
  await expect(boiler.locator(".p-row-open")).toHaveCSS("box-shadow", "none");
});
test("a paper opens the preview as the bottom sheet; Escape puts it away and leaves the row open", async ({ page }) => {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await settle(page);
  const mot = page.locator(".pocket .pk-below [data-row]", { hasText: "Car MOT" }).first();
  await openRow(page, mot);
  /* #1319, round 3's `narrow`: the drawer is the item; no link onward */
  await expect(mot.getByRole("link", { name: /^Open / })).toHaveCount(0);
  await mot.getByRole("button", { name: "Open Service history" }).tap();
  const sheet = page.getByRole("dialog", { name: /^Service history/ });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Read Service history" })).toBeEnabled({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(mot).toHaveAttribute("data-open", "");
  await expect(mot.getByRole("button", { name: "Open Service history" })).toBeFocused();
});
/** Whether `el` sits inside something inert. @param {import("@playwright/test").Locator} el */
const inert = (el) => el.evaluate((one) => Boolean(one.closest("[inert]")));
/* #1319: a bottom sheet is modal. While the preview or a chooser stands,
   what is behind it is inert, nothing it covers takes a tap; Escape or a
   press on the page behind puts it away and gives the page back, focus
   on what opened it. */
test("the preview sheet holds the page behind it inert until a press off it puts it away", async ({ page }) => {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await settle(page);
  const mot = page.locator(".pocket .pk-below [data-row]", { hasText: "Car MOT" }).first();
  await openRow(page, mot);
  const complete = mot.getByRole("button", { name: "Complete Car MOT" });
  await mot.getByRole("button", { name: "Open Service history" }).tap();
  const sheet = page.getByRole("dialog", { name: /^Service history/ });
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute("aria-modal", "true");
  expect(await inert(complete)).toBe(true);
  expect(await inert(sheet)).toBe(false);
  await page.touchscreen.tap(195, 80);
  await expect(sheet).toBeHidden();
  /* the scrim took the tap: nothing behind it opened as well */
  await expect(page.locator(".p-sheet-layer.open")).toHaveCount(0);
  expect(await inert(complete)).toBe(false);
  await expect(mot).toHaveAttribute("data-open", "");
});
test("a chooser sheet holds the page behind it inert; Escape or a press off it puts it away", async ({ page }) => {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await settle(page);
  const mot = page.locator(".pocket .pk-below [data-row]", { hasText: "Car MOT" }).first();
  await openRow(page, mot);
  await mot.getByRole("button", { name: "Edit this item" }).tap();
  const section = mot.getByRole("button", { name: /^section: / });
  const seat = page.locator("[data-chooser-card]");
  await section.tap();
  await expect(seat.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  expect(await inert(section)).toBe(true);
  expect(await inert(seat)).toBe(false);
  await page.keyboard.press("Escape");
  await expect(seat).toHaveCount(0);
  expect(await inert(section)).toBe(false);
  await expect(section).toBeFocused();
  await section.tap();
  await expect(seat).toBeVisible();
  await page.touchscreen.tap(195, 80);
  await expect(seat).toHaveCount(0);
  await expect(page.locator(".p-sheet-layer.open")).toHaveCount(0);
  expect(await inert(section)).toBe(false);
  await expect(mot.getByRole("group", { name: "Editing Car MOT" })).toBeVisible();
});
/* #1319 (owner-decisions §34): a suggestion is reviewed in its home drawer
   -- its address opens its row in the signals, and the paper it came in
   opens the preview sheet with the staged note. */
test("a suggestion's paper opens the preview as the bottom sheet, attached on acceptance", async ({ page }) => {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await settle(page);
  const catch_ = page.locator(".pocket .pk-signals [data-row]", { hasText: "Home insurance" }).first();
  await openRow(page, catch_);
  await catch_.getByRole("button", { name: "Open policy-schedule.pdf" }).tap();
  const sheet = page.getByRole("dialog", { name: /^policy-schedule\.pdf/ });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Read policy-schedule.pdf" })).toBeEnabled({ timeout: 10_000 });
  await expect(sheet.locator(".rcnote")).toHaveText("not yet in orbit · attached on acceptance");
  await expect(sheet.getByRole("link", { name: /download/i })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(catch_).toHaveAttribute("data-open", "");
});
test("a planet opens its row; a second tap on the lit body brings the row back on screen", async ({ page }) => {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await settle(page);
  const body = page.locator(".mdial .pk-body[aria-label='Gutter clearing']");
  await body.click();
  const gutter = page.locator(".pocket .pk-below [data-row]", { hasText: "Gutter clearing" }).first();
  await expect(gutter).toHaveAttribute("data-open", "");
  await expect(page.locator(".p-sheet-layer.open")).toHaveCount(0);
  await expect(gutter).toBeInViewport();
  await expect(body).toHaveClass(/lit/);
  /* Back up to the body, the row mostly scrolled away below: the second
     tap scrolls the row back on screen, still open, and goes nowhere
     (#1319). */
  await page.evaluate(() => window.scrollTo(0, 0));
  await body.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => window.scrollY);
  await body.click();
  await expect(gutter).toHaveAttribute("data-open", "");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before);
  await expect(gutter).toBeInViewport();
  await expect(page).toHaveURL(/\/home/);
});
test("the dial arrives on a forward arrival, never on Back", async ({ page }) => {
  /* The arrival is a 1s animation, so reading "is it playing" after a
     navigation races its lifetime (#1164, #1447). The page keeps a record
     instead: from before the first load, every `pocket-arrive` start, end
     and cancel on the dial goes into a log that survives client-side
     navigation. A forward arrival is judged by the log holding its start and
     then its end; Back by the log holding nothing once the dial is on the
     page and everything has settled. */
  await page.addInitScript(() => {
    /** @type {{kind: string}[]} */
    const log = [];
    /** @type {any} */ (window).__dialLog = log;
    const isDial = (/** @type {any} */ el) => el instanceof Element && el.matches(".pocket .mdial");
    for (const kind of /** @type {const} */ (["animationstart", "animationend", "animationcancel"])) {
      document.addEventListener(kind, (e) => {
        const a = /** @type {AnimationEvent} */ (e);
        if (a.animationName === "pocket-arrive" && isDial(a.target)) log.push({ kind });
      }, true);
    }
  });
  /** The kinds logged since the last `forget`, in order, repeats collapsed. */
  const logged = async () => (await page.evaluate(() => /** @type {any} */ (window).__dialLog.map((/** @type {{kind: string}} */ e) => e.kind)))
    .filter((/** @type {string} */ kind, /** @type {number} */ i, /** @type {string[]} */ all) => kind !== all[i - 1]);
  const forget = () => page.evaluate(() => { /** @type {any} */ (window).__dialLog.length = 0; });
  /** Every finite animation finished, then two frames with nothing new to run. */
  const quiet = () => finiteMotionDone(page, { quietFrames: 2 });

  const dial = page.locator(".pocket .mdial");
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await expect(dial).toHaveClass(/arrive/);
  await settle(page);
  await quiet();
  expect(await logged(), "the first arrival did not start and finish").toEqual(["animationstart", "animationend"]);
  /* #1319: the item screen this used to leave for retired with the belt;
     the inbox, through the signals' mail row, is a forward way off home. */
  await page.locator(".pocket .pk-signals a[data-row-face][href='/inbox']").click();
  await expect(page).toHaveURL(/\/inbox$/);
  /* Back is pressed only once the other screen is on the page, as a person
     would (#1164); pressed before then, it can stay under /home (#1217). */
  await expect(dial).toHaveCount(0);
  await settle(page);
  await forget();
  await page.goBack();
  await expect(page).toHaveURL(/\/home/);
  await expect(dial).toBeAttached({ timeout: 30000 });
  await settle(page);
  await quiet();
  expect(await dial.getAttribute("class"), "Back replayed the arrival").not.toMatch(/\barrive\b/);
  expect(await logged(), "Back replayed the arrival").toEqual([]);
  await page.goForward();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(dial).toHaveCount(0);
  await settle(page);
  await forget();
  /* A forward arrival again, as a link on any screen makes it. */
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.href = "/home";
    document.body.append(a);
    a.click();
  });
  await expect(page).toHaveURL(/\/home$/);
  await expect(dial).toHaveClass(/arrive/);
  await expect.poll(logged, { message: "a second forward arrival did not start and finish", timeout: 20_000 })
    .toEqual(["animationstart", "animationend"]);
});

/* A chip in "other skies" flies to that household, as the desk does (#1118,
   owner 2026-09-25, 7a). */
test.describe("at 390x844", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("a chip in other skies flies to that household", async ({ page }) => {
    await page.goto(`${APP}/home`, { waitUntil: "load" });
    await settle(page);
    /* Marks this document so a real (non-SPA) browser navigation, which the
       chip's plain href would still complete on its own, is told apart from
       the fly() handler actually taking the tap: only a client-routed
       goto() carries this flag through to the destination. */
    await page.evaluate(() => { /** @type {any} */ (window).__pocket1118 = true; });
    const chip = page.locator(".skies .msys", { hasText: "Seaside Cottage" });
    await chip.click();
    await expect(page).toHaveURL(/\/household\/hh-seaside-4551$/);
    await expect(page.getByRole("heading", { name: "Seaside Cottage" })).toBeVisible();
    expect(await page.evaluate(() => /** @type {any} */ (window).__pocket1118)).toBe(true);
  });
});

/* ROUND 3 (design/v19/phone-vision/round-3.md §2, §5; #1142): the signals
   are one dashed pen below a clear gap, reading and failed mail are one
   summary row to the inbox, and the north star rests in the dial's corner
   until the dial has scrolled off, then floats at the thumb, hiding while
   a row is open. */
test("the signals sit under a clear gap, each its own row-card, with mail as one summary row to the inbox", async ({ page }) => {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await settle(page);
  const pen = page.locator(".pocket .pk-signals");
  await expect(pen).toHaveCount(1);
  /* owner-decisions §29: the section is not a card; the suggestion is its
     own dashed one, solid accent once open, with no rail. */
  await expect(pen).not.toHaveClass(/p-card/);
  await expect(pen.locator(".p-caps")).toHaveText(/^Signals\s*1$/);
  await expect(pen.locator("[data-row]")).toHaveCount(2);
  const catch_ = pen.locator("[data-row]").first();
  await expect(catch_).toHaveCSS("border-top-style", "dashed");
  expect(await wearsAccentOutline(catch_)).toBe(false);
  await openRow(page, catch_);
  await expect(catch_).toHaveCSS("border-top-style", "solid");
  await expect(catch_).toHaveCSS("border-top-width", "1px");
  expect(await wearsAccentOutline(catch_)).toBe(true);
  await expect(catch_.locator(":scope > .face")).toHaveCSS("box-shadow", "none");
  await expect(catch_.locator(".p-row-open")).toHaveCSS("box-shadow", "none");
  await expect(catch_.locator(".p-row-open")).toHaveCSS("border-top-style", "none");
  await catch_.locator("[data-row-face]").first().tap();
  await expect(catch_).not.toHaveAttribute("data-open", "");
  const summary = pen.locator("[data-row]").last();
  await expect(summary.locator(".title")).toHaveText("reading 1 · 2 couldn't be read");
  await expect(summary.locator("a[data-row-face]")).toHaveAttribute("href", "/inbox");
  await expect(page.locator(".pocket [data-row]", { hasText: "A message from" })).toHaveCount(0);
  await expect(page.locator(".pocket", { hasText: "nothing is added without you" })).toHaveCount(0);
  const gap = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".pocket .pk-list [data-row]")];
    const last = rows[rows.length - 1].getBoundingClientRect();
    return /** @type {Element} */ (document.querySelector(".pocket .pk-signals")).getBoundingClientRect().top - last.bottom;
  });
  expect(Math.round(gap)).toBe(32);
});
test("the north star rests in the dial's corner, floats once the dial has scrolled off, and comes back", async ({ page }) => {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await settle(page);
  const star = page.getByRole("link", { name: "Add an item" }).last();
  const flag = () => page.evaluate(() => "northstar" in document.body.dataset);
  await expect(star).toHaveAttribute("data-station", "rest");
  const corner = await page.evaluate(() => {
    const dial = /** @type {Element} */ (document.querySelector(".pocket .mdial")).getBoundingClientRect();
    const box = [...document.querySelectorAll(".p-northstar")].pop()?.getBoundingClientRect();
    return box && { right: dial.right - box.right, bottom: dial.bottom - box.bottom, width: box.width };
  });
  expect(corner).toEqual({ right: 0, bottom: 0, width: 56 });
  expect(await flag(), "the wake makes room for a star that is in the sky").toBe(false);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect(star).toHaveAttribute("data-station", "afloat");
  const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await star.boundingBox());
  expect(Math.round(box.x + box.width)).toBe(390 - 16);
  expect(Math.round(box.y + box.height)).toBe(664 - 20);
  expect(await flag()).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(star).toHaveAttribute("data-station", "rest");
  expect(await flag()).toBe(false);
});
test("the north star hides while a row is open", async ({ page }) => {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await settle(page);
  const star = page.getByRole("link", { name: "Add an item" }).last();
  await expect(star).toBeVisible();
  const catch_ = page.locator(".pocket [data-row]", { hasText: "Home insurance" }).first();
  await openRow(page, catch_);
  await expect(star).toBeHidden();
  await catch_.locator("[data-row-face]").first().tap();
  await expect(catch_).not.toHaveAttribute("data-open", "");
  await expect(star).toBeVisible();
});

/* THE RELAY'S CATCH, DECIDED AND AMENDED IN ITS ROW (#1319 stage 3b;
   owner, 2026-10-08, on the phone amending as the desk does: "Yeah,
   ideally"). What the belt's phone card did (`/item/<receiptId>`, retired)
   and the review sheet home used to raise (round 3 §4, #1140): the two
   decisions on the row, and `review & amend →` -- or a second tap on its
   hollow body on the dial -- putting the row's own lines into editing,
   `add to orbit` approving what they hold. The two decisions, the amend
   lines and the replayed wake are proved on the mounted page
   (tests/unit/pocket-home-drawers.test.mjs); what stays here is the dial's
   hollow body, which needs layout and scroll. */

test("a second tap on the relay's catch puts its row into editing, on home", async ({ page }) => {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await settle(page);
  const body = page.locator(".mdial .pk-body[data-body-sugg]").first();
  await body.click();
  const catch_ = page.locator(".pocket .pk-signals [data-row]", { hasText: "Home insurance" }).first();
  await expect(catch_).toHaveAttribute("data-open", "");
  await body.scrollIntoViewIfNeeded();
  await body.click();
  await expect(catch_.locator('[data-ed="title"]')).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Review & amend" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/home/);
});
