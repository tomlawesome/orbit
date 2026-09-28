import { expect, test } from "@playwright/test";
import { APP, openRow, settle } from "./pocket-states.js";

/*
 * HOME'S DRAWERS ON A PHONE (#1120, review round §2.1): a manifest row
 * opens in place, its `complete` goes to the belt's record sheet for an
 * item with a cost to confirm, `open →` goes to the belt, a search result
 * closes the search and opens its row (or, with no row, goes to the item:
 * round 2, e), and the item's own address opens it on arrival. A planet on
 * the dial opens its row and a second tap on the lit body goes to the item
 * (owner's answer 6a); the dial arrives on every forward arrival, never on
 * Back (round 2, g). Fixture data, at the height a phone browser leaves.
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
test("complete goes to the record sheet", async ({ page }) => {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await settle(page);
  const gutter = page.locator(".pocket .pk-below [data-row]", { hasText: "Gutter clearing" }).first();
  await openRow(page, gutter);
  await gutter.getByRole("button", { name: "Complete Gutter clearing" }).tap();
  await expect(page).toHaveURL(/\/item\/i-gutter/);
  await expect(page.getByRole("dialog", { name: "Record a completion" })).toBeVisible();
});
test("search result opens the row", async ({ page }) => {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await settle(page);
  await page.locator(".msearch").click();
  await page.locator(".pk-field").fill("MOT");
  await page.locator(".pk-results [data-row-face]", { hasText: "Car MOT" }).first().click();
  const mot = page.locator(".pocket .pk-below [data-row]", { hasText: "Car MOT" }).first();
  await expect(mot).toHaveAttribute("data-open", "");
  await expect(page.locator(".p-sheet-layer.open")).toHaveCount(0);
  await expect(mot.locator("[data-row-face]")).toBeFocused();
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
test("open → morphs to the belt", async ({ page }) => {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await settle(page);
  const mot = page.locator(".pocket .pk-below [data-row]", { hasText: "Car MOT" }).first();
  await openRow(page, mot);
  await mot.getByRole("link", { name: "Open Car MOT — Volvo V60" }).tap();
  await expect(page).toHaveURL(/\/item\/i-mot/);
});
test("a search result with no row goes straight to the item", async ({ page }) => {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await settle(page);
  await expect(page.locator(".pocket .pk-below [data-row]", { hasText: "Chimney sweep" })).toHaveCount(0);
  await page.locator(".msearch").click();
  await page.locator(".pk-field").fill("Chimney");
  await page.locator(".pk-results [data-row-face]", { hasText: "Chimney sweep" }).first().click();
  await expect(page).toHaveURL(/\/item\/i-chimney/);
});
test("a planet opens its row; a second tap on the lit body goes to the item", async ({ page }) => {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await settle(page);
  const body = page.locator(".mdial .pk-body[aria-label='Gutter clearing']");
  await body.click();
  const gutter = page.locator(".pocket .pk-below [data-row]", { hasText: "Gutter clearing" }).first();
  await expect(gutter).toHaveAttribute("data-open", "");
  await expect(page.locator(".p-sheet-layer.open")).toHaveCount(0);
  await expect(gutter).toBeInViewport();
  await expect(body).toHaveClass(/lit/);
  await body.scrollIntoViewIfNeeded();
  await body.click();
  await expect(page).toHaveURL(/\/item\/i-gutter/);
});
test("the dial arrives on a forward arrival, never on Back", async ({ page }) => {
  const dial = page.locator(".pocket .mdial");
  /** Whether the arrival is playing, or has played, on the dial now. */
  const arriving = () => dial.evaluate((el) => el.getAnimations().some((a) => /** @type {CSSAnimation} */ (a).animationName === "pocket-arrive"));
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await expect(dial).toHaveClass(/arrive/);
  await settle(page);
  const mot = page.locator(".pocket .pk-below [data-row]", { hasText: "Car MOT" }).first();
  await openRow(page, mot);
  await mot.getByRole("link", { name: "Open Car MOT — Volvo V60" }).tap();
  await expect(page).toHaveURL(/\/item\/i-mot/);
  await page.goBack();
  await expect(page).toHaveURL(/\/home/);
  await expect(dial).not.toHaveClass(/arrive/);
  expect(await arriving(), "Back replayed the arrival").toBe(false);
  await page.goForward();
  await expect(page).toHaveURL(/\/item\/i-mot/);
  /* A forward arrival again, as a link on any screen makes it. */
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.href = "/home";
    document.body.append(a);
    a.click();
  });
  await expect(page).toHaveURL(/\/home$/);
  await expect(dial).toHaveClass(/arrive/);
  expect(await arriving(), "a second forward arrival did not arrive").toBe(true);
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

/* ROUND 3 §4 (#1140): home raises the review sheet in place, from a
   suggestion's `review & amend →` and from a second tap on its hollow body
   on the dial, rather than going to the receipt page. */
test("review & amend raises the review sheet on home", async ({ page }) => {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await settle(page);
  const catch_ = page.locator(".pocket .pk-signals [data-row]", { hasText: "Home insurance" }).first();
  await openRow(page, catch_);
  await catch_.getByRole("button", { name: "review & amend →" }).click();
  const sheet = page.getByRole("dialog", { name: "Review & amend" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("textbox", { name: "name", exact: true })).toHaveValue("Home insurance renewal");
  await expect(page).toHaveURL(/\/home$/);
});
test("a second tap on the relay's catch raises the review sheet on home", async ({ page }) => {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await settle(page);
  const body = page.locator(".mdial .pk-body[data-body-sugg]").first();
  await body.click();
  const catch_ = page.locator(".pocket .pk-signals [data-row]", { hasText: "Home insurance" }).first();
  await expect(catch_).toHaveAttribute("data-open", "");
  await body.scrollIntoViewIfNeeded();
  await body.click();
  await expect(page.getByRole("dialog", { name: "Review & amend" })).toBeVisible();
  await expect(page).toHaveURL(/\/home$/);
});
