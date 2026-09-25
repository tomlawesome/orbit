import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";
/* Set to a directory to keep review screenshots of the kit's parts. */
const SHOTS = process.env.KIT_SHOTS ?? "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

/*
 * THE POCKET KIT, DRIVEN IN A REAL BROWSER (#1120). The components' logic
 * has unit tests (tests/unit/pocket-kit.test.mjs); this is the part only a
 * browser can prove: layout, hit-testing, focus, touch and history, on the
 * fixtures-only /kit page at 390x844 with touch on.
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

/** @param {import('@playwright/test').Page} page @param {string} name */
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** @param {import('@playwright/test').Page} page */
async function open(page) {
  await page.goto(`${APP}/kit`, { waitUntil: "load" });
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}

/**
 * A real touch swipe (Chromium's touch pipeline, so touch-action applies).
 * @param {import('@playwright/test').Page} page
 * @param {{ x: number, y: number }} from
 * @param {number} dx
 */
async function swipe(page, from, dx) {
  const cdp = await page.context().newCDPSession(page);
  const steps = 8;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove", touchPoints: [{ x: from.x + (dx * i) / steps, y: from.y }],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/** Visible violations of the pocket floors under a selector (see pocket-measure.spec.js). */
/** @param {import('@playwright/test').Page} page @param {string} scope */
async function floors(page, scope) {
  return page.evaluate((sel) => {
    const out = [];
    for (const root of document.querySelectorAll(sel)) {
      for (const el of root.querySelectorAll("a[href],button,input,[role=button],[tabindex]:not([tabindex='-1'])")) {
        const r = el.getBoundingClientRect();
        if (r.width <= 1 || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        if (r.width < 43.5 || r.height < 43.5) out.push(`${Math.round(r.width)}x${Math.round(r.height)} ${el.textContent?.trim()}`);
      }
    }
    return out;
  }, scope);
}

test("the kit at rest", async ({ page }) => {
  await open(page);
  await shot(page, "01-kit-rest");
  await page.locator("[data-kit=members]").scrollIntoViewIfNeeded();
  await shot(page, "02-rows-rest");
  /* No act is visible at rest: every act button is off its row (clipped,
     or off the screen, where nothing is hit at all) or covered. */
  const covered = await page.evaluate(() =>
    [...document.querySelectorAll("[data-row-acts] button")].every((b) => {
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !(hit && b.contains(hit));
    }));
  expect(covered, "a row act is visible without a swipe").toBe(true);
});

test("row acts: hidden buttons, named with their object, out of the Tab order", async ({ page }) => {
  await open(page);
  const remove = page.getByRole("button", { name: "Remove Rob Lawson" });
  await expect(remove).toHaveCount(1);
  await expect(remove).toHaveAttribute("tabindex", "-1");
  await expect(page.getByRole("button", { name: "Hand over to Ada Lawson" })).toHaveAttribute("tabindex", "-1");
});

test("row acts: keyboard reveals with an arrow, Tab walks them, Escape hides", async ({ page }) => {
  await open(page);
  const face = page.getByRole("group", { name: "Rob Lawson" });
  await face.focus();
  await page.keyboard.press("ArrowLeft");
  const row = page.locator("[data-row]", { has: face });
  await expect(row).toHaveAttribute("data-open", "");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Hand over to Rob Lawson" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Remove Rob Lawson" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(row).not.toHaveAttribute("data-open", "");
  await expect(face).toBeFocused();
});

/**
 * The swiped row's layout (Fable, #1120): the face has not moved, the tray
 * sits inside the row on its trailing side, the mark and at least 56px of
 * the title show left of it, and every pill is 44 tall with a 13px+ label.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} row
 * @param {{ x: number }} rest the face's box before the swipe
 */
async function expectSwipedLayout(page, row, rest) {
  const m = await row.evaluate((el) => {
    const box = (/** @type {Element | null} */ n) => {
      const r = /** @type {Element} */ (n).getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const face = /** @type {HTMLElement} */ (el.querySelector("[data-row-face]"));
    const title = /** @type {HTMLElement} */ (el.querySelector(".title"));
    const t = title.getBoundingClientRect();
    const hit = document.elementFromPoint(t.left + 8, t.top + t.height / 2);
    return {
      width: innerWidth,
      row: box(el),
      face: box(face),
      faceTransform: getComputedStyle(face).transform,
      mark: box(el.querySelector(".mark")),
      title: box(title),
      titleHit: Boolean(hit && title.contains(hit)),
      tray: box(el.querySelector("[data-row-acts]")),
      pills: [...el.querySelectorAll("[data-row-acts] button")].map((b) => {
        const label = [...b.querySelectorAll("span")].find((s) => getComputedStyle(s).opacity !== "0") ?? b;
        return { height: b.getBoundingClientRect().height, font: parseFloat(getComputedStyle(label).fontSize) };
      }),
    };
  });
  expect(m.faceTransform, "the face moved").toBe("none");
  expect(Math.abs(m.face.left - rest.x), "the face moved").toBeLessThan(0.5);
  expect(m.tray.right).toBeLessThanOrEqual(m.row.right + 0.5);
  expect(m.tray.right).toBeLessThanOrEqual(m.width);
  expect(m.tray.width, "the tray is over its cap").toBeLessThanOrEqual(m.row.width - 120 + 0.5);
  expect(m.mark.left).toBeGreaterThanOrEqual(0);
  expect(m.mark.right, "the tray covers the mark").toBeLessThanOrEqual(m.tray.left);
  expect(m.title.left).toBeGreaterThanOrEqual(0);
  expect(m.tray.left - m.title.left, "less than 56px of the title shows").toBeGreaterThanOrEqual(56);
  expect(m.titleHit, "the title's start is covered").toBe(true);
  expect(m.pills.length).toBe(2);
  for (const pill of m.pills) {
    expect(pill.height).toBeGreaterThanOrEqual(44);
    expect(pill.font).toBeGreaterThanOrEqual(13);
  }
}

for (const width of [390, 360]) {
  test.describe(`at ${width}`, () => {
    test.use({ viewport: { width, height: 844 } });

    test("row acts: a touch swipe slides the tray over a still face, the danger act arms then fires, the wake undoes", async ({ page }) => {
      await open(page);
      const face = page.getByRole("group", { name: "Ada Lawson" });
      await face.scrollIntoViewIfNeeded();
      const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await face.boundingBox());
      await swipe(page, { x: box.x + box.width - 30, y: box.y + box.height / 2 }, -200);
      const row = page.locator("[data-row]", { has: face });
      await expect(row).toHaveAttribute("data-open", "");
      await page.waitForTimeout(300);
      await expectSwipedLayout(page, row, box);
      await expect(row.locator(".meta")).toBeHidden();
      await shot(page, `03-row-swiped-${width}`);

      const remove = page.getByRole("button", { name: "Remove Ada Lawson" });
      await remove.tap();
      await expect(page.getByRole("button", { name: "tap again to remove Ada Lawson" })).toBeVisible();
      await page.waitForTimeout(200);
      await expectSwipedLayout(page, row, box);
      await shot(page, `04-row-armed-${width}`);
      await page.getByRole("button", { name: "tap again to remove Ada Lawson" }).tap();
      await expect(page.getByRole("group", { name: "Ada Lawson" })).toHaveCount(0);
      await expect(page.locator(".p-wake-host [role=status]")).toHaveText("Ada Lawson removed");
      await page.waitForTimeout(300);
      await shot(page, `05-wake-undo-${width}`);
      await page.getByRole("button", { name: "undo" }).tap();
      await expect(page.getByRole("group", { name: "Ada Lawson" })).toHaveCount(1);
    });
  });
}

test("arm-then-fire disarms by itself after 4s", async ({ page }) => {
  await open(page);
  const pill = page.getByRole("button", { name: "Remove the boiler service" });
  await pill.tap();
  await expect(page.getByRole("button", { name: "tap again to remove the boiler service" })).toBeVisible();
  await page.waitForTimeout(4300);
  await expect(page.getByRole("button", { name: "Remove the boiler service" })).toBeVisible();
});

test("sheets are dialogs: focus in, Tab held, Escape out, focus back, page inert", async ({ page }) => {
  await open(page);
  const opener = page.locator("[data-open=list]");
  await opener.scrollIntoViewIfNeeded();
  await opener.tap();
  const dialog = page.getByRole("dialog", { name: "Documents" });
  await expect(dialog).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest("[role=dialog]")))).toBe(true);
  const behindInert = () => page.evaluate(() => Boolean(document.querySelector("main.kit")?.closest("[inert]")));
  await expect.poll(behindInert).toBe(true);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest("[role=dialog]")))).toBe(true);
  }
  await page.waitForTimeout(350);
  expect(await floors(page, "[role=dialog]")).toEqual([]);
  await shot(page, "07-sheet-list");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await expect.poll(behindInert).toBe(false);
});

test("sheets: back closes the sheet without leaving the page; the scrim closes it", async ({ page }) => {
  await open(page);
  await page.locator("[data-open=callout]").scrollIntoViewIfNeeded();
  await page.locator("[data-open=callout]").tap();
  const dialog = page.getByRole("dialog", { name: "Boiler service" });
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(350);
  await shot(page, "06-sheet-callout");
  await page.goBack();
  await expect(dialog).toBeHidden();
  expect(new URL(page.url()).pathname).toBe("/kit");

  await page.locator("[data-open=full]").tap();
  const full = page.getByRole("dialog", { name: "Edit item" });
  await expect(full).toBeVisible();
  await page.waitForTimeout(350);
  const top = await full.evaluate((el) => el.getBoundingClientRect().top);
  expect(top, "the full sheet's head is off the top of the screen").toBeGreaterThanOrEqual(0);
  await shot(page, "08-sheet-full");
  await full.getByRole("button", { name: "close" }).tap();
  await expect(full).toBeHidden();

  await page.locator("[data-open=callout]").tap();
  await expect(dialog).toBeVisible();
  await page.mouse.click(195, 60);
  await expect(dialog).toBeHidden();
});

test("sheets: dragging the handle down dismisses", async ({ page }) => {
  await open(page);
  await page.locator("[data-open=list]").scrollIntoViewIfNeeded();
  await page.locator("[data-open=list]").tap();
  const dialog = page.getByRole("dialog", { name: "Documents" });
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(350);
  const grab = /** @type {{ x: number, y: number, width: number, height: number }} */ (
    await dialog.locator(".grab").boundingBox());
  await page.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2);
  await page.mouse.down();
  await page.mouse.move(grab.x + grab.width / 2, grab.y + 300, { steps: 10 });
  await page.mouse.up();
  await expect(dialog).toBeHidden();
});

test("the hatch: the orb opens the account sheet; sign-out arms", async ({ page }) => {
  await open(page);
  const orb = page.getByRole("button", { name: "Account and menu" });
  await orb.tap();
  const hatch = page.getByRole("dialog", { name: "Emma Lawson" });
  await expect(hatch).toBeVisible();
  for (const name of ["Add an item", "Items", "Inbox", "Settings"])
    await expect(hatch.getByRole("link", { name, exact: true })).toBeVisible();
  /* The fixtures instance has no session, so no admin. */
  await expect(hatch.getByRole("link", { name: "Administration" })).toHaveCount(0);
  await page.waitForTimeout(350);
  expect(await floors(page, "[role=dialog]")).toEqual([]);
  await shot(page, "09-hatch");
  await hatch.getByRole("button", { name: "sign out →" }).tap();
  await expect(hatch.getByRole("button", { name: "tap again to sign out" })).toBeVisible();
  await page.waitForTimeout(200);
  await shot(page, "10-hatch-signout-armed");
  await page.keyboard.press("Escape");
  await expect(hatch).toBeHidden();
  await expect(orb).toBeFocused();
});

test("the top chrome retracts on scroll down and returns on scroll up", async ({ page }) => {
  await open(page);
  const chrome = page.locator(".p-chrome");
  await expect(chrome).not.toHaveClass(/hidden/);
  await page.mouse.wheel(0, 600);
  await expect(chrome).toHaveClass(/hidden/);
  await page.waitForTimeout(300);
  await shot(page, "11-chrome-retracted");
  await page.mouse.wheel(0, -120);
  await expect(chrome).not.toHaveClass(/hidden/);
  await page.waitForTimeout(300);
  await shot(page, "12-chrome-returned");
});

test("reorder: Alt-arrow moves a row; long-press lifts and drops it", async ({ page }) => {
  await open(page);
  const order = () => page.locator("[data-kit=sections] [data-row] .title").allTextContents();
  const home = page.getByRole("group", { name: "Home" });
  await home.focus();
  await page.keyboard.press("Alt+ArrowDown");
  expect(await order()).toEqual(["Car", "Home", "Health", "Money"]);

  const car = page.getByRole("group", { name: "Car" });
  await car.scrollIntoViewIfNeeded();
  const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await car.boundingBox());
  await page.mouse.move(box.x + 60, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await expect(page.locator("[data-kit=sections] [data-row][data-lifted]")).toHaveCount(1);
  await page.mouse.move(box.x + 60, box.y + box.height / 2 + box.height * 2 + 4, { steps: 8 });
  await shot(page, "13-reorder-lifted");
  await page.mouse.up();
  expect(await order()).toEqual(["Home", "Health", "Car", "Money"]);
});

test("the north star sits bottom right, 56px, inside the viewport", async ({ page }) => {
  await open(page);
  const star = page.getByRole("link", { name: "Add an item" }).last();
  const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await star.boundingBox());
  expect(box.width).toBe(56);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
});
