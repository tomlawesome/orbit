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

/** A member row's face, the button that opens it. @param {import('@playwright/test').Page} page @param {string} name */
const memberFace = (page, name) => page.locator("[data-kit=members] [data-row-face]", { hasText: name });

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
  /* No act shows at rest: every row's panel is shut (review round §1.1). */
  const shut = await page.evaluate(() =>
    [...document.querySelectorAll("[data-row-panel]")].every((panel) => panel instanceof HTMLElement && panel.hidden));
  expect(shut, "a row's panel is open without a tap").toBe(true);
});

test("row acts: shut rows keep their acts out of the page; the face says so", async ({ page }) => {
  await open(page);
  const face = memberFace(page, "Rob Lawson");
  await expect(face).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Remove Rob Lawson" })).toHaveCount(0);
  const panel = await face.getAttribute("aria-controls");
  await expect(page.locator(`#${panel}`)).toBeHidden();
});

test("row acts: Enter opens, Tab walks the pills, Escape closes and returns to the face", async ({ page }) => {
  await open(page);
  const face = memberFace(page, "Rob Lawson");
  await face.focus();
  await page.keyboard.press("Enter");
  const row = face.locator("xpath=ancestor::*[@data-row][1]");
  await expect(row).toHaveAttribute("data-open", "");
  await expect(face).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Hand over to Rob Lawson" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Remove Rob Lawson" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(row).not.toHaveAttribute("data-open", "");
  await expect(face).toBeFocused();
});

/* A tap elsewhere leaves it open, as the desk does (owner, 2026-09-27,
   #1159); only its own face closes it. */
test("row acts: one open per list, and it stays open until its own face is tapped", async ({ page }) => {
  await open(page);
  const rob = page.locator("[data-kit=members] [data-row]", { hasText: "Rob Lawson" });
  const ada = page.locator("[data-kit=members] [data-row]", { hasText: "Ada Lawson" });
  await rob.locator("[data-row-face]").tap();
  await expect(rob).toHaveAttribute("data-open", "");
  await ada.locator("[data-row-face]").tap();
  await expect(ada).toHaveAttribute("data-open", "");
  await expect(rob).not.toHaveAttribute("data-open", "");
  await page.mouse.click(195, 120);
  await expect(ada).toHaveAttribute("data-open", "");
  await ada.locator("[data-row-face]").tap();
  await expect(ada).not.toHaveAttribute("data-open", "");
});

/**
 * The opened row's layout (review round §1.1): the panel sits directly
 * under the face, as wide as it, its text edge the row's text edge; the
 * trail and meta still show; every pill is 44 tall with a 13px+ label.
 * @param {import('@playwright/test').Locator} row
 */
async function expectOpenLayout(row) {
  const m = await row.evaluate((el) => {
    const box = (/** @type {Element | null} */ n) => {
      const r = /** @type {Element} */ (n).getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const inner = /** @type {Element} */ (el.querySelector(".p-row-in"));
    return {
      width: innerWidth,
      face: box(el.querySelector(".face")),
      panel: box(el.querySelector("[data-row-panel]")),
      title: box(el.querySelector(".title")),
      text: inner.getBoundingClientRect().left + parseFloat(getComputedStyle(inner).paddingLeft),
      meta: /** @type {HTMLElement} */ (el.querySelector(".meta"))?.checkVisibility() ?? true,
      pills: [...el.querySelectorAll("[data-row-acts] > *")].map((b) => {
        const label = [...b.querySelectorAll("span")].find((s) => getComputedStyle(s).opacity !== "0") ?? b;
        return { height: b.getBoundingClientRect().height, font: parseFloat(getComputedStyle(label).fontSize) };
      }),
    };
  });
  expect(Math.abs(m.panel.top - m.face.bottom), "the panel is not under the face").toBeLessThan(0.5);
  expect(Math.abs(m.panel.left - m.face.left)).toBeLessThan(0.5);
  expect(Math.abs(m.panel.width - m.face.width)).toBeLessThan(0.5);
  expect(m.panel.right).toBeLessThanOrEqual(m.width);
  expect(Math.abs(m.text - m.title.left), "the panel's text edge is not the row's").toBeLessThan(0.5);
  expect(m.meta, "the meta went while open").toBe(true);
  expect(m.pills.length).toBe(2);
  for (const pill of m.pills) {
    expect(pill.height).toBeGreaterThanOrEqual(44);
    expect(pill.font).toBeGreaterThanOrEqual(13);
  }
}

for (const width of [390, 360]) {
  test.describe(`at ${width}`, () => {
    test.use({ viewport: { width, height: 844 } });

    test("row acts: a tap opens the row in place, the danger act arms then fires, the wake undoes", async ({ page }) => {
      await open(page);
      const face = memberFace(page, "Ada Lawson");
      await face.scrollIntoViewIfNeeded();
      await face.tap();
      const row = face.locator("xpath=ancestor::*[@data-row][1]");
      await expect(row).toHaveAttribute("data-open", "");
      await page.waitForTimeout(350);
      await expectOpenLayout(row);
      await shot(page, `03-row-open-${width}`);

      const remove = page.getByRole("button", { name: "Remove Ada Lawson" });
      await remove.tap();
      await expect(page.getByRole("button", { name: "tap again to remove Ada Lawson" })).toBeVisible();
      await expect(row.getByText("tap again to remove", { exact: true })).toBeVisible();
      await expect(row, "arming closed the row").toHaveAttribute("data-open", "");
      await page.waitForTimeout(200);
      await expectOpenLayout(row);
      await shot(page, `04-row-armed-${width}`);
      await page.getByRole("button", { name: "tap again to remove Ada Lawson" }).tap();
      await expect(memberFace(page, "Ada Lawson")).toHaveCount(0);
      await expect(page.locator(".p-wake-host [role=status]")).toHaveText("Ada Lawson removed");
      await page.waitForTimeout(300);
      await shot(page, `05-wake-undo-${width}`);
      await page.getByRole("button", { name: "undo" }).tap();
      await expect(memberFace(page, "Ada Lawson")).toHaveCount(1);
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

test("the hatch: the orb opens the account sheet; sign-out is one tap", async ({ page }) => {
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
  /* one tap, not arm-then-fire (owner, 2026-10-06): it is a plain pill,
     never an arming one, and it is not tapped here (it would sign out) */
  const signOut = hatch.getByRole("button", { name: "sign out →" });
  await expect(signOut).toBeVisible();
  await expect(signOut).not.toHaveClass(/\barm\b/);
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

test("reorder: Alt-arrow and the move pills move a row; long-press lifts and drops it", async ({ page }) => {
  await open(page);
  const order = () => page.locator("[data-kit=sections] [data-row] .title").allTextContents();
  const face = (/** @type {string} */ name) => page.locator("[data-kit=sections] [data-row-face]", { hasText: name });
  await face("Home").focus();
  await page.keyboard.press("Alt+ArrowDown");
  expect(await order()).toEqual(["Car", "Home", "Health", "Money"]);
  await face("Home").click();
  await page.getByRole("button", { name: "Move Home down" }).click();
  expect(await order()).toEqual(["Car", "Health", "Home", "Money"]);
  await face("Home").click();
  await page.getByRole("button", { name: "Move Home up" }).click();
  expect(await order()).toEqual(["Car", "Home", "Health", "Money"]);
  await expect(face("Car")).toHaveAttribute("aria-expanded", "false");
  await face("Car").click();
  await expect(page.getByRole("button", { name: "Move Car up" }), "the first row offers a move up").toHaveCount(0);
  await face("Car").click();

  const car = face("Car");
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
