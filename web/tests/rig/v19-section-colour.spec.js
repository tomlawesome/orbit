import { expect, test } from "@playwright/test";

import { APP, RIG_EXPECT_MS, RIG_TEST_MS, onPhone, signedIn } from "./a11y-support.js";
import { useFixtureScenes } from "../fidelity/pocket-states.js";

/*
 * #1466 (colour part, Refs not Closes): a planet wears its section's colour,
 * and members choose that colour in the sections editor. Both dialects; the
 * fixture app's Harlow Home, today pinned to 2026-08-13. Written from
 * spec-1466.md before the build; end states only, no elapsed-time assertions
 * (#1447), and a planet's fill is compared with the token's computed value,
 * never a hex (a pack may change the hex, never the pairing).
 *
 * Harlow's planets, by section: Gutter clearing (overdue) and Boiler, Chimney
 * and Roof are Home; the Car MOT (the closest approach) and the Car full
 * service are Vehicles; Smoke alarm batteries is Devices. Nothing is in
 * Services, so the key (a colour no planet wears is left out) reads Home,
 * Vehicles, Devices. The spec's line that Harlow gives M's four does not hold
 * for this fixture; see the report. The phone draws only the overdue, the
 * closest and the ones with papers, so the planets used here are the two it
 * always draws: i-gutter (Home) and i-mot (Vehicles).
 *
 * Structure this file relies on, all already in the app except the starred:
 *  - the desk's planet is the first <circle> in `g.body-vis[data-vis=<id>]`;
 *    the phone's is the first <circle> in `.pk-body[data-body=<id>]`; the
 *    Settings preview's is the first <circle> in `g.pl[data-pl=<id>]`. Its
 *    computed `fill` is the section colour: `var(--c-<colour>)`.
 *  - * the key is an element `[aria-label="Section colours"]`, its entries
 *    its direct children `span`s, each `<i style="background:var(--c-..)">`
 *    then the section's name (M's markup); the visible one is read.
 *  - * the editor's row has `role=radiogroup` named "Colour for <name>" with
 *    four `role=radio` buttons named for the colours, `data-opt="<colour>"`,
 *    `aria-checked` on the effective one, roving tabindex.
 *  - * a swatch pick saves at once: a `sections.replace` carrying `colour`.
 */
test.use({ baseURL: APP });
test.describe.configure({ timeout: RIG_TEST_MS });

const HOUSEHOLD = "/household/hh-harlow-1";
const COLOURS = ["home", "vehicles", "devices", "services"];
const NAMES = { home: "Home", vehicles: "Vehicles", devices: "Devices", services: "Services" };

/** @typedef {import("@playwright/test").Page} Page */

/** What `fill:var(--c-<colour>)` computes to on an svg shape, in this page's pack.
 * @param {Page} page @param {string} colour */
function tokenFill(page, colour) {
  return page.evaluate((name) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const probe = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    probe.setAttribute("style", `fill:var(--c-${name})`);
    svg.appendChild(probe);
    document.body.appendChild(svg);
    const value = getComputedStyle(probe).fill;
    svg.remove();
    return value;
  }, colour);
}

/** What `background:var(--c-<colour>)` computes to on an html element.
 * @param {Page} page @param {string} colour */
function tokenBackground(page, colour) {
  return page.evaluate((name) => {
    const probe = document.createElement("i");
    probe.style.background = `var(--c-${name})`;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  }, colour);
}

/** The planet's body circle on home (desk or phone): the page also holds the other dialect's sky, hidden, so only the visible one counts.
 * @param {Page} page @param {string} id */
const homePlanet = (page, id) => page.locator(`g.body-vis[data-vis="${id}"] circle, .pk-body[data-body="${id}"] circle`).locator("visible=true").first();
/** The planet's body circle in Settings' live sky (visible one; both dialects' skies are in the page). @param {Page} page @param {string} id */
const previewPlanet = (page, id) => page.locator(`g.pl[data-pl="${id}"] circle`).locator("visible=true").first();
/** @param {import("@playwright/test").Locator} circle */
const fillOf = (circle) => circle.evaluate((el) => getComputedStyle(el).fill);

/**
 * A planet's fill ends as the token's computed value.
 * @param {Page} page @param {import("@playwright/test").Locator} circle @param {string} colour
 */
async function expectWearing(page, circle, colour) {
  await expect(circle).toBeAttached({ timeout: RIG_EXPECT_MS });
  const want = await tokenFill(page, colour);
  expect(want).not.toBe("");
  await expect.poll(() => fillOf(circle), { timeout: RIG_EXPECT_MS }).toBe(want);
}

/** The colour group of a section's editor row. @param {Page} page @param {string} name */
const swatchesOf = (page, name) => page.getByRole("radiogroup", { name: `Colour for ${name}`, exact: true });

/** The home reach that holds a household's saves. @param {Page} page */
async function homeWithSaves(page) {
  await signedIn("/home", "rest")(page);
  await page.locator("body[data-home-ready]").waitFor({ state: "attached" });
}

test("home: each planet wears its section's colour token, not an urgency tone", async ({ page }) => {
  await signedIn("/home", "rest")(page);
  await expectWearing(page, homePlanet(page, "i-gutter"), "home"); // overdue: its band is ruby, its fill is Home's
  await expectWearing(page, homePlanet(page, "i-mot"), "vehicles"); // closest approach
});

test("home: the key under the sky reads the sections whose colour a planet wears, in order", async ({ page }) => {
  await signedIn("/home", "rest")(page);
  const key = page.locator('[aria-label="Section colours"]:visible');
  await expect(key).toHaveCount(1, { timeout: RIG_EXPECT_MS });
  await expect(key.locator("> span")).toHaveText(["Home", "Vehicles", "Devices"]);
  const dots = key.locator("> span > i");
  await expect(dots).toHaveCount(3);
  for (const [at, colour] of ["home", "vehicles", "devices"].entries()) {
    const want = await tokenBackground(page, colour);
    await expect.poll(() => dots.nth(at).evaluate((el) => getComputedStyle(el).backgroundColor), { timeout: RIG_EXPECT_MS }).toBe(want);
  }
});

test("settings: the live preview's planets wear the same colours as home", async ({ page }) => {
  await signedIn("/settings", "rest")(page);
  await expectWearing(page, previewPlanet(page, "i-gutter"), "home");
  await expectWearing(page, previewPlanet(page, "i-mot"), "vehicles");
});

test("household editor: each section has a Colour group with its effective colour checked, one tab stop", async ({ page }, testInfo) => {
  await signedIn(HOUSEHOLD, "saves-kept")(page);
  // Shipped sections wear their own; "Dates & renewals" wears the calendar mark's (Home's).
  const effective = { Home: "home", Vehicles: "vehicles", Devices: "devices", Services: "services", "Dates & renewals": "home" };
  for (const [name, colour] of Object.entries(effective)) {
    const group = swatchesOf(page, name);
    await expect(group).toBeVisible({ timeout: RIG_EXPECT_MS });
    await expect(group.getByRole("radio")).toHaveCount(4);
    await expect(group.getByRole("radio")).toHaveText(["", "", "", ""]); // coloured dots, no words
    for (const one of COLOURS) {
      const swatch = group.getByRole("radio", { name: one, exact: true });
      await expect(swatch).toHaveAttribute("data-opt", one);
      await expect(swatch).toHaveAttribute("aria-checked", String(one === colour));
      await expect(swatch).toHaveAttribute("tabindex", one === colour ? "0" : "-1"); // one tab stop per group
    }
    await expect(group.locator('[role="radio"][aria-checked="true"]')).toHaveCount(1);
  }
  // 22 px on the desk, 30 px on the phone (N's CSS and the spec).
  const box = await swatchesOf(page, "Home").getByRole("radio").first().boundingBox();
  expect(Math.round(box?.width ?? 0)).toBe(onPhone(testInfo) ? 30 : 22);
});

test("household editor: arrow keys move and select within a group, and the pick is saved", async ({ page }) => {
  await signedIn(HOUSEHOLD, "saves-kept")(page);
  const group = swatchesOf(page, "Home");
  await expect(group).toBeVisible({ timeout: RIG_EXPECT_MS });
  const saved = page.waitForRequest((request) => request.url().endsWith("/api/workspace/commands") && request.method() === "POST"
    && request.postDataJSON()?.type === "sections.replace" && !request.postDataJSON()?.dryRun
    && request.postDataJSON().sections.some((/** @type {{ id: string, colour?: string }} */ one) => one.id === "s-home" && one.colour === "vehicles"));
  await group.getByRole("radio", { name: "home", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(group.getByRole("radio", { name: "vehicles", exact: true })).toBeFocused();
  await expect(group.getByRole("radio", { name: "vehicles", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(group.getByRole("radio", { name: "home", exact: true })).toHaveAttribute("aria-checked", "false");
  await saved;
});

test("household editor: the why line sits under the list, after + add a section", async ({ page }, testInfo) => {
  test.skip(onPhone(testInfo), "the phone editor is not drawn (spec section 4); the why line is N's desk row");
  await signedIn(HOUSEHOLD, "saves-kept")(page);
  const why = page.getByText("Pick the colour each section wears on the sky. Four colours, so two sections may share one.", { exact: true });
  await expect(why).toBeVisible({ timeout: RIG_EXPECT_MS });
  const after = await why.evaluate((el) => {
    const add = document.querySelector(".addsec");
    return Boolean(add && add.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(after).toBe(true);
});

test("household editor: a reader who cannot edit sections is offered no colour choice", async ({ page }) => {
  await signedIn("/household/hh-seaside-4551", "any-dialect")(page);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: RIG_EXPECT_MS });
  await expect(page.getByRole("radiogroup", { name: /^Colour for / })).toHaveCount(0);
});

test("a pick on Home's row survives a reload and recolours the planets, the Add chooser and the preview", async ({ page }, testInfo) => {
  await useFixtureScenes(page, "keep-saves");

  await test.step("pick vehicles on Home's row; it saves at once and stays checked after a reload", async () => {
    await signedIn(HOUSEHOLD, "saves-kept")(page);
    const home = () => swatchesOf(page, "Home").getByRole("radio", { name: "vehicles", exact: true });
    await expect(home()).toBeVisible({ timeout: RIG_EXPECT_MS });
    const saved = page.waitForRequest((request) => request.url().endsWith("/api/workspace/commands") && request.method() === "POST"
      && request.postDataJSON()?.type === "sections.replace" && !request.postDataJSON()?.dryRun);
    await home().click();
    const sent = (await saved).postDataJSON();
    expect(sent.sections.find((/** @type {{ id: string }} */ one) => one.id === "s-home")?.colour).toBe("vehicles");
    await expect(home()).toHaveAttribute("aria-checked", "true");
    await page.reload();
    await expect(home()).toHaveAttribute("aria-checked", "true", { timeout: RIG_EXPECT_MS });
    await expect(swatchesOf(page, "Home").locator('[role="radio"][aria-checked="true"]')).toHaveCount(1);
    // the other rows are untouched
    await expect(swatchesOf(page, "Vehicles").getByRole("radio", { name: "vehicles", exact: true })).toHaveAttribute("aria-checked", "true");
  });

  await test.step("a Home item's planet on home wears the vehicles colour", async () => {
    await homeWithSaves(page);
    await expectWearing(page, homePlanet(page, "i-gutter"), "vehicles");
    await expectWearing(page, homePlanet(page, "i-mot"), "vehicles");
    // and the key has followed: Home now wears vehicles, and as the first section (by position) wearing it names that dot; Vehicles shares it and adds no entry
    const key = page.locator('[aria-label="Section colours"]:visible');
    await expect(key.locator("> span")).toHaveText(["Home", "Devices"]);
  });

  await test.step("the Add chooser's Home tile wears it too", async () => {
    if (onPhone(testInfo)) {
      await signedIn("/home", "row-edit-section")(page);
    } else {
      await page.goto(`${APP}/home?item=i-mot`, { waitUntil: "load" });
      await page.locator("body[data-home-ready]").waitFor({ state: "attached" });
      const drawer = page.locator('[id="i-mot-view"]');
      await expect(drawer).toBeVisible({ timeout: RIG_EXPECT_MS });
      await drawer.getByRole("button", { name: "Edit this item" }).click();
      await drawer.getByRole("button", { name: /^section: / }).click();
    }
    const chooser = page.locator("[data-chooser-card]");
    await expect(chooser).toBeVisible({ timeout: RIG_EXPECT_MS });
    await expect(chooser.getByRole("radio", { name: "Home", exact: true })).toHaveAttribute("data-opt", "vehicles");
    await expect(chooser.getByRole("radio", { name: "Devices", exact: true })).toHaveAttribute("data-opt", "devices");
  });

  await test.step("the Settings preview wears the same colour as home", async () => {
    await signedIn("/settings", "rest")(page);
    await expectWearing(page, previewPlanet(page, "i-gutter"), "vehicles");
    await expectWearing(page, previewPlanet(page, "i-mot"), "vehicles");
  });
});
