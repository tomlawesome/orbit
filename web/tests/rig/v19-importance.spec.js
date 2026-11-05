import { expect, test } from "@playwright/test";

import { APP, RIG_EXPECT_MS, RIG_TEST_MS, onPhone, signedIn } from "./a11y-support.js";
import { useFixtureScenes } from "../fidelity/pocket-states.js";
import { importanceControl, importanceGroup, pickImportance } from "./importance-support.js";

/*
 * #1463: importance, three levels and three sizes (round 6 P, L), the edit
 * drawer's importance row (round 7 S) and the one-time pass (round 7 U). Both
 * dialects; the fixture app's Harlow Home, today pinned to 2026-08-13, under
 * the `keep-saves` scene (cookies stand in for the server).
 *
 * The fixture's importance split (spec, "Fixture data"): high i-gutter, i-mot,
 * i-roof; normal i-boiler; low i-chimney, i-smoke; not set i-svc (Car full
 * service, Vehicles, due 2027-01-21, the only unset item).
 *
 * Names this spec fixes for the build, taken from the mock-ups (round 6 P and
 * L, round 7 S and U) and, where they give no accessible name, chosen here:
 *  - Add, desk: `radiogroup` named "Importance" (aria-required="true") of three
 *    `radio`s low / normal / high (aria-checked), each holding a `.disc`, the
 *    word under it; none checked to begin with. Phone: a `group` named
 *    "Importance" of three buttons low / normal / high (aria-pressed), each
 *    holding a `.disc`. The save button (desk `.btn-primary`, phone "Add to
 *    orbit") keeps aria-disabled="true" and the note beside it (desk
 *    #save-note, phone #pk-refusal) says "choose an importance" until one is
 *    picked. The command carries `item.importance`.
 *  - Settings: the third row of Planets, label "planet size shows", a `group`
 *    named "Planet size shows" of two buttons "cost" and "importance"
 *    (aria-pressed), no hint line; pressing saves at once (PUT
 *    /api/preferences, body.planetSize "cost" | "importance") and redraws the
 *    preview. Cost is pressed by default.
 *  - The sky: a planet's drawn radius is read from its group's first circle,
 *    at rest. Under importance an item with no level is drawn hollow: its
 *    first circle has fill-opacity .22 and stroke-dasharray "2 2.5".
 *  - The desk callout (`.callout.show`, summoned by mouseenter on the body)
 *    gets `.imp`: "<section name> · importance <low|normal|high>" or
 *    "<section name> · importance not set". The phone has no callout, so none
 *    is tested there (a gap, reported).
 *  - The drawer, S: a `.kv`/`.p-kv` row whose label is "importance", value
 *    the word or "not set"; in edit mode a button named "importance: <value>"
 *    opens the chooser, a dialog named "Choose importance" holding a radiogroup
 *    "Importance" of radios low / normal / high (the Add row's tiles).
 *  - The pass, U: the pill is a `status` reading "N items have no importance
 *    yet" ("1 item has" for one) with buttons "set them now" and "not now";
 *    "set them now" opens a dialog named "Set the importance" with one
 *    `.pl-row` per item (`.t` the name), each holding a radiogroup
 *    "Importance" of radios low / normal / high; a row with a pick gets the
 *    class `done`; the footer buttons are "finish later" and "Done".
 */
test.use({ baseURL: APP });
test.describe.configure({ timeout: RIG_TEST_MS });

const HARLOW = "hh-harlow-1";
const KEY_DATE = "2026-09-02";

/** @param {import("@playwright/test").Page} page */
const preview = (page) => page.getByRole("img", { name: /\d+ names? shown$/ });
/** @param {import("@playwright/test").Page} page */
const sizeGroup = (page) => page.getByRole("group", { name: "Planet size shows" });
/** @param {import("@playwright/test").Page} page */
const costButton = (page) => sizeGroup(page).getByRole("button", { name: "cost", exact: true });
/** @param {import("@playwright/test").Page} page */
const importanceButton = (page) => sizeGroup(page).getByRole("button", { name: "importance", exact: true });

/**
 * Waits for every running finite animation on the element, its ancestors and
 * its descendants to finish, so geometry is read at rest. An end state.
 * @param {import("@playwright/test").Locator} anyElement
 */
async function atRest(anyElement) {
  await anyElement.evaluate(async (el) => {
    const finite = () => el.ownerDocument.getAnimations().filter((a) => {
      const target = /** @type {Element | null} */ (a.effect && "target" in a.effect ? a.effect.target : null);
      return target && (target.contains(el) || el.contains(target)) && Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity) && a.playState === "running";
    });
    for (let pending = finite(); pending.length; pending = finite()) await Promise.all(pending.map((a) => a.finished.catch(() => undefined)));
  });
}

/** A planet's drawn radius: half the width of its first circle. @param {import("@playwright/test").Locator} circle */
async function drawnRadius(circle) {
  await expect(circle).toBeAttached({ timeout: RIG_EXPECT_MS });
  await atRest(circle);
  const box = await circle.boundingBox();
  if (!box) throw new Error("no box to measure");
  return box.width / 2;
}

/** @param {import("@playwright/test").Page} page @param {string} id */
const previewCircle = (page, id) => preview(page).locator(`[data-pl="${id}"] circle`).first();
/** @param {import("@playwright/test").Page} page @param {string} id @param {boolean} phone */
const homeCircle = (page, id, phone) =>
  phone ? page.locator(`.mdial .pk-body[data-body="${id}"] circle`).first() : page.locator(`g.body-vis[data-vis="${id}"] circle`).first();

/** @param {import("@playwright/test").Locator} circle */
const paintOf = (circle) => circle.evaluate((el) => ({ fillOpacity: el.getAttribute("fill-opacity"), dash: el.getAttribute("stroke-dasharray") }));

/** @param {import("@playwright/test").Page} page */
async function openHome(page) {
  await page.goto(`${APP}/home`);
  await page.locator("body[data-home-ready]").waitFor({ state: "attached" });
}

/** The household as the server holds it now (keep-saves). @param {import("@playwright/test").Page} page @param {string} id */
async function savedImportance(page, id) {
  const body = await (await page.request.get(`${APP}/api/workspace`)).json();
  const household = body.workspace.households.find((/** @type {{ id: string }} */ one) => one.id === HARLOW);
  const item = household.items.find((/** @type {{ id: string }} */ one) => one.id === id);
  return item ? (item.importance ?? null) : undefined;
}

/**
 * An item saved WITHOUT an importance, as an import would leave it, so the pass
 * has more than the fixture's one unset item to list.
 * @param {import("@playwright/test").Page} page @param {{ id: string, title: string, dueDate: string }} item
 */
async function saveUnset(page, item) {
  const session = await (await page.request.get(`${APP}/api/auth/session`)).json();
  const response = await page.request.post(`${APP}/api/workspace/commands`, {
    headers: { "x-csrf-token": session.csrfToken, origin: new URL(APP).origin },
    data: { type: "item.upsert", householdId: HARLOW, kind: "service", item: { id: item.id, sectionId: "s-home", title: item.title, currency: "GBP", dueDate: item.dueDate } },
  });
  expect(response.ok(), `saving ${item.id} without an importance`).toBe(true);
  expect(await savedImportance(page, item.id)).toBeNull();
}

/** Settings > Planets > planet size shows, pressed to importance, once saved. @param {import("@playwright/test").Page} page */
async function showImportanceSizes(page) {
  await signedIn("/settings", "rest")(page);
  await expect(sizeGroup(page)).toBeVisible({ timeout: RIG_EXPECT_MS });
  const saved = page.waitForRequest((request) => request.url().endsWith("/api/preferences") && request.method() === "PUT");
  await importanceButton(page).click();
  await expect(importanceButton(page)).toHaveAttribute("aria-pressed", "true");
  expect((await saved).postDataJSON().planetSize).toBe("importance");
}

/** The colour a section wears, read the way the page paints it. @param {import("@playwright/test").Page} page @param {string} name */
const sectionColour = (page, name) => page.evaluate((one) => {
  const probe = document.createElement("span");
  probe.style.background = `var(--c-${one})`;
  document.body.append(probe);
  const colour = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return colour;
}, name);

/* ── Settings: planet size shows ─────────────────────────────────────────── */

test("settings: the third row 'planet size shows' starts on cost, with no hint line", async ({ page }) => {
  await signedIn("/settings", "rest")(page);
  await expect(sizeGroup(page)).toBeVisible({ timeout: RIG_EXPECT_MS });
  await expect(page.getByText("planet size shows", { exact: true })).toBeVisible();
  await expect(sizeGroup(page).getByRole("button")).toHaveCount(2);
  await expect(costButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(importanceButton(page)).toHaveAttribute("aria-pressed", "false");
  /* the third row of the Planets group, after 'names up close' and 'planets sit by' */
  const rows = page.locator(".kv", { has: page.locator("span", { hasText: /^(names up close|planets sit by|planet size shows)$/ }) });
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2)).toContainText("planet size shows");
  await expect(rows.nth(2)).toHaveClass(/stack/);
  /* L draws no hint under it: the row holds its label and its two buttons and nothing else */
  await expect(rows.nth(2).locator("p, small, .hint")).toHaveCount(0);
});

test("settings: importance resizes the planets in the preview and on home, saves, and cost puts them back", async ({ page }, testInfo) => {
  const phone = onPhone(testInfo);
  await useFixtureScenes(page, "keep-saves");

  await openHome(page);
  const homeCost = await drawnRadius(homeCircle(page, "i-gutter", phone));

  await signedIn("/settings", "rest")(page);
  await expect(sizeGroup(page)).toBeVisible({ timeout: RIG_EXPECT_MS });
  const previewCost = await drawnRadius(previewCircle(page, "i-gutter"));

  /* Gutter clearing is a high item, and today it is a small planet by cost */
  const saved = page.waitForRequest((request) => request.url().endsWith("/api/preferences") && request.method() === "PUT");
  await importanceButton(page).click();
  await expect(importanceButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(costButton(page)).toHaveAttribute("aria-pressed", "false");
  expect((await saved).postDataJSON().planetSize).toBe("importance");
  await expect.poll(() => drawnRadius(previewCircle(page, "i-gutter")), { timeout: RIG_EXPECT_MS, message: "the preview redraws at once" }).toBeGreaterThan(previewCost + 1);

  /* home follows, after a reload, and so does Settings */
  await openHome(page);
  expect(await drawnRadius(homeCircle(page, "i-gutter", phone)), "Gutter clearing on home").toBeGreaterThan(homeCost + 1);
  await page.goto(`${APP}/settings`);
  await expect(sizeGroup(page)).toBeVisible({ timeout: RIG_EXPECT_MS });
  await expect(importanceButton(page)).toHaveAttribute("aria-pressed", "true");

  /* cost again: back where they were */
  const savedBack = page.waitForRequest((request) => request.url().endsWith("/api/preferences") && request.method() === "PUT");
  await costButton(page).click();
  await expect(costButton(page)).toHaveAttribute("aria-pressed", "true");
  expect((await savedBack).postDataJSON().planetSize).toBe("cost");
  await expect.poll(() => drawnRadius(previewCircle(page, "i-gutter")), { timeout: RIG_EXPECT_MS }).toBeCloseTo(previewCost, 0);
  await openHome(page);
  expect(await drawnRadius(homeCircle(page, "i-gutter", phone))).toBeCloseTo(homeCost, 0);
});

test("settings: the desk draws the three levels in order and the costliest roof smaller under importance", async ({ page }, testInfo) => {
  test.skip(onPhone(testInfo), "the phone home draws only some planets; the desk draws all seven");
  await useFixtureScenes(page, "keep-saves");
  await openHome(page);
  const roofCost = await drawnRadius(homeCircle(page, "i-roof", false));

  await showImportanceSizes(page);
  await openHome(page);
  const [high, normal, low] = [
    await drawnRadius(homeCircle(page, "i-gutter", false)),
    await drawnRadius(homeCircle(page, "i-boiler", false)),
    await drawnRadius(homeCircle(page, "i-chimney", false)),
  ];
  expect(high, "high is larger than normal").toBeGreaterThan(normal + 1);
  expect(normal, "normal is larger than low").toBeGreaterThan(low + 1);
  /* Roof replacement is the costliest planet (the widest by cost) and a high item: 11 against 13 */
  expect(await drawnRadius(homeCircle(page, "i-roof", false)), "the roof by importance").toBeLessThan(roofCost - 1);
});

test("the sky draws an item with no importance hollow under importance, and solid under cost", async ({ page }, testInfo) => {
  const phone = onPhone(testInfo);
  await useFixtureScenes(page, "keep-saves");

  await openHome(page);
  const solid = await paintOf(homeCircle(page, "i-svc", phone));
  expect(solid.dash, "solid under cost").toBeNull();
  expect(solid.fillOpacity).not.toBe(".22");

  await showImportanceSizes(page);
  /* the preview (the desk preview draws all seven planets) */
  if (!phone) {
    const hollow = await paintOf(previewCircle(page, "i-svc"));
    expect(hollow.dash?.trim().split(/[\s,]+/)).toEqual(["2", "2.5"]);
    expect(Number(hollow.fillOpacity)).toBeCloseTo(0.22, 2);
    expect((await paintOf(previewCircle(page, "i-gutter"))).dash, "a set item stays solid").toBeNull();
  }
  await openHome(page);
  const hollowHome = await paintOf(homeCircle(page, "i-svc", phone));
  expect(hollowHome.dash?.trim().split(/[\s,]+/)).toEqual(["2", "2.5"]);
  expect(Number(hollowHome.fillOpacity)).toBeCloseTo(0.22, 2);
  expect((await paintOf(homeCircle(page, "i-gutter", phone))).dash, "a set item stays solid on home").toBeNull();
});

test("the desk callout's fourth line names the section and the importance, under cost and under importance", async ({ page }, testInfo) => {
  test.skip(onPhone(testInfo), "the phone's dial has no callout");
  await useFixtureScenes(page, "keep-saves");
  /** @param {string} id */
  async function calloutOf(id) {
    await openHome(page);
    const body = page.locator(`.body-link[data-body="${id}"]`);
    await expect(body).toBeAttached({ timeout: RIG_EXPECT_MS });
    await body.dispatchEvent("mouseenter");
    return page.locator(".callout.show .imp");
  }
  await expect(await calloutOf("i-gutter")).toHaveText(/Home\s*·\s*importance high$/);
  await expect(await calloutOf("i-svc")).toHaveText(/Vehicles\s*·\s*importance not set$/);
  await showImportanceSizes(page);
  await expect(await calloutOf("i-gutter")).toHaveText(/Home\s*·\s*importance high$/);
  await expect(await calloutOf("i-svc")).toHaveText(/Vehicles\s*·\s*importance not set$/);
});

/* ── Add ─────────────────────────────────────────────────────────────────── */

/** Everything but the importance filled, so only the importance can hold Add. @param {import("@playwright/test").Page} page @param {boolean} phone @param {string} name */
async function fillExceptImportance(page, phone, name) {
  await page.goto(`${APP}/create`, { waitUntil: "load" });
  await page.locator("#card[data-ready]").waitFor({ state: "attached", timeout: RIG_EXPECT_MS });
  if (phone) {
    const form = page.getByRole("form", { name: "New entry" });
    await form.getByRole("textbox", { name: "name", exact: true }).fill(name);
    await form.getByRole("button", { name: "service", exact: true }).click();
    await form.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
    await form.getByLabel("due date").fill(KEY_DATE);
  } else {
    await page.locator("#f-name").fill(name);
    await page.locator('#types button[data-type="service"]').click();
    await page.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
    await page.locator("#f-date").fill(KEY_DATE);
  }
}

/** @param {import("@playwright/test").Page} page @param {boolean} phone */
const addButton = (page, phone) => (phone ? page.getByRole("button", { name: "Add to orbit" }) : page.locator(".btn-primary"));
/** @param {import("@playwright/test").Page} page @param {boolean} phone */
const addNote = (page, phone) => (phone ? page.locator("#pk-refusal") : page.locator("#save-note"));

test("add: the importance row is required, nothing is pressed, and Add is off with its reason until one is picked", async ({ page }, testInfo) => {
  const phone = onPhone(testInfo);
  await fillExceptImportance(page, phone, "Importance proving");

  const group = importanceGroup(page);
  await expect(group).toBeVisible();
  if (!phone) await expect(group).toHaveAttribute("aria-required", "true");
  for (const level of /** @type {const} */ (["low", "normal", "high"])) {
    const control = importanceControl(page, level);
    await expect(control).toBeVisible();
    await expect(control, `${level} starts unpressed`).toHaveAttribute(phone ? "aria-pressed" : "aria-checked", "false");
  }
  await expect(addButton(page, phone)).toHaveAttribute("aria-disabled", "true");
  await expect(addNote(page, phone)).toContainText("choose an importance");

  await pickImportance(page, "high");
  await expect(importanceControl(page, "normal")).toHaveAttribute(phone ? "aria-pressed" : "aria-checked", "false");
  await expect(addButton(page, phone)).not.toHaveAttribute("aria-disabled", "true");
  /* the note may be empty or absent once a level is picked: no note that says it is still needed */
  await expect(addNote(page, phone).filter({ hasText: "choose an importance" })).toHaveCount(0);
});

test("add: each choice shows the planet it would draw, small to large, and the desk tiles wear the section's colour", async ({ page }, testInfo) => {
  const phone = onPhone(testInfo);
  await fillExceptImportance(page, phone, "Importance discs");
  const widths = [];
  for (const level of /** @type {const} */ (["low", "normal", "high"])) {
    const disc = importanceControl(page, level).locator(".disc");
    await expect(disc).toBeVisible();
    widths.push((await disc.boundingBox())?.width ?? 0);
  }
  expect(widths[0], "low is the smallest").toBeGreaterThan(0);
  expect(widths[1], "normal is larger than low").toBeGreaterThan(widths[0] + 1);
  expect(widths[2], "high is larger than normal").toBeGreaterThan(widths[1] + 1);
  if (phone) return;
  /* Home is the chosen section: its colour; choosing Vehicles changes it */
  const discColour = () => importanceControl(page, "high").locator(".disc").evaluate((el) => getComputedStyle(el).backgroundColor);
  await expect.poll(discColour).toBe(await sectionColour(page, "home"));
  await page.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Vehicles" }).click();
  await expect.poll(discColour).toBe(await sectionColour(page, "vehicles"));
});

test("add: the picked importance goes on the item the page saves", async ({ page }, testInfo) => {
  const phone = onPhone(testInfo);
  await useFixtureScenes(page, "keep-saves");
  await fillExceptImportance(page, phone, "Importance saved high");
  await pickImportance(page, "high");
  const sent = page.waitForRequest((request) => {
    if (!request.url().endsWith("/api/workspace/commands") || request.method() !== "POST") return false;
    const command = request.postDataJSON();
    return command?.type === "item.upsert" && !command.dryRun;
  });
  await expect(addButton(page, phone)).not.toHaveAttribute("aria-disabled", "true");
  await addButton(page, phone).click();
  const command = (await sent).postDataJSON();
  expect(command.item.importance).toBe("high");
  await expect.poll(() => savedImportance(page, command.item.id), { timeout: RIG_EXPECT_MS }).toBe("high");
});

/* ── Audit Lows that touch these files ───────────────────────────────────── */

test("phone remove pill (audit Low): 'not this one' hands focus to the add-a-document button, not the page", async ({ page }, testInfo) => {
  test.skip(!onPhone(testInfo), "the phone's pill; the desk's lane has its own buttons");
  await page.goto(`${APP}/create`, { waitUntil: "load" });
  await page.locator("#card[data-ready]").waitFor({ state: "attached", timeout: RIG_EXPECT_MS });
  const form = page.getByRole("form", { name: "New entry" });
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(2048, 32), Buffer.from("%%EOF\n")]);
  await form.locator('input[type="file"]').setInputFiles({ name: "focus-proving.pdf", mimeType: "application/pdf", buffer: pdf });
  const drop = form.getByRole("button", { name: "not this one" });
  await expect(drop).toBeVisible({ timeout: RIG_EXPECT_MS });
  await drop.click();
  await expect(drop).toHaveCount(0);
  await expect(form.locator(".pc-doc"), "focus lands on the control that adds a document").toBeFocused();
});

/* ── S: the importance row in the edit drawer ────────────────────────────── */

/** The open drawer for an item: the desk's drawer, the phone's open row. @param {import("@playwright/test").Page} page @param {string} id @param {boolean} phone */
const drawerOf = (page, id, phone) => (phone ? page.locator(`.pocket .pk-below [data-row-key="${id}"]`) : page.locator(`[id="${id}-view"]`));
/** @param {import("@playwright/test").Locator} drawer */
const importanceRow = (drawer) => drawer.locator(".kv, .p-kv").filter({ has: drawer.page().locator("span", { hasText: /^importance$/ }) });

test("drawer: the importance row reads 'not set', the chooser offers three tiles, and a pick is saved", async ({ page }, testInfo) => {
  const phone = onPhone(testInfo);
  await useFixtureScenes(page, "keep-saves");
  await page.goto(`${APP}/home?item=i-svc`, { waitUntil: "load" });
  await expect(page.locator("body[data-home-ready]")).toBeAttached();
  const drawer = drawerOf(page, "i-svc", phone);
  await expect(drawer).toBeVisible({ timeout: RIG_EXPECT_MS });

  /* read mode: after the section, the word, or 'not set' */
  await expect(importanceRow(drawer)).toContainText("not set");
  await expect(importanceRow(drawer)).toHaveCount(1);

  /* edit mode: the value with a chevron; pressed, the chooser stands */
  await drawer.getByRole("button", { name: "Edit this item" }).click();
  const pick = drawer.getByRole("button", { name: /^importance: / });
  await expect(pick).toBeVisible();
  await pick.click();
  const chooser = page.getByRole("dialog", { name: "Choose importance" });
  await expect(chooser).toBeVisible();
  await expect(chooser.getByRole("radio")).toHaveCount(3);
  await expect(chooser.getByRole("radio", { checked: true })).toHaveCount(0);
  if (phone) {
    const height = page.viewportSize()?.height ?? 0;
    /* the sheet slides in: judge it once it has arrived (its animations finished) */
    await atRest(chooser);
    await expect.poll(async () => {
      const box = await chooser.boundingBox();
      return Math.abs((box?.y ?? 0) + (box?.height ?? 0) - height);
    }, { message: "the bottom sheet" }).toBeLessThan(2);
  }

  /* pick "high": the chooser closes, the row reads it */
  await chooser.getByRole("radio", { name: "high", exact: true }).click();
  await expect(chooser).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "importance: high" })).toBeVisible();
  /* the edit's own save commits it where the other rows are committed by it */
  const save = drawer.getByRole("group", { name: /^Editing / }).getByRole("button", { name: "save" });
  if (await save.count()) await save.click();
  await expect.poll(() => savedImportance(page, "i-svc"), { timeout: RIG_EXPECT_MS, message: "saved on the server" }).toBe("high");

  /* after a reload the row reads high */
  await page.goto(`${APP}/home?item=i-svc`, { waitUntil: "load" });
  await expect(page.locator("body[data-home-ready]")).toBeAttached();
  await expect(importanceRow(drawerOf(page, "i-svc", phone))).toContainText("high", { timeout: RIG_EXPECT_MS });
  await expect(importanceRow(drawerOf(page, "i-svc", phone))).not.toContainText("not set");
});

test("drawer: a set item's row reads its level", async ({ page }, testInfo) => {
  const phone = onPhone(testInfo);
  await page.goto(`${APP}/home?item=i-boiler`, { waitUntil: "load" });
  await expect(page.locator("body[data-home-ready]")).toBeAttached();
  await expect(importanceRow(drawerOf(page, "i-boiler", phone))).toContainText("normal", { timeout: RIG_EXPECT_MS });
});

/* ── U: the one-time pass ────────────────────────────────────────────────── */

/** @param {import("@playwright/test").Page} page */
const pill = (page) => page.getByRole("status").filter({ hasText: /no importance yet/ });
/** @param {import("@playwright/test").Page} page */
const pass = (page) => page.getByRole("dialog", { name: "Set the importance" });
/** @param {import("@playwright/test").Locator} where */
const countIn = async (where) => Number(/\d+/.exec((await where.textContent()) ?? "")?.[0] ?? NaN);

test("pass: the pill counts the unset items, and the card lists one row each, nearest due first", async ({ page }) => {
  await useFixtureScenes(page, "keep-saves");
  await openHome(page);
  /* the fixture has one unset item */
  await expect(pill(page)).toBeVisible({ timeout: RIG_EXPECT_MS });
  await expect(pill(page)).toHaveText(/^\s*1 items? (has|have) no importance yet/);

  await saveUnset(page, { id: "i-late", title: "Late unset", dueDate: "2026-10-01" });
  await saveUnset(page, { id: "i-early", title: "Early unset", dueDate: "2026-09-01" });
  await openHome(page);
  await expect(pill(page)).toHaveText(/^\s*3 items have no importance yet/);
  expect(await countIn(pill(page))).toBe(3);

  await pill(page).getByRole("button", { name: "set them now" }).click();
  await expect(pass(page)).toBeVisible();
  await expect(pass(page).locator(".pl-row")).toHaveCount(3);
  await expect(pass(page).locator(".pl-row .t")).toHaveText(["Early unset", "Late unset", "Car full service"]);
  /* each row holds the three-disc segment, none chosen yet */
  const first = pass(page).locator(".pl-row").first();
  await expect(first.getByRole("radio")).toHaveCount(3);
  await expect(first.getByRole("radio", { checked: true })).toHaveCount(0);
});

test("pass: a pick on a row is kept by 'finish later', the count drops, untouched rows stay not set", async ({ page }) => {
  await useFixtureScenes(page, "keep-saves");
  await saveUnset(page, { id: "i-late", title: "Late unset", dueDate: "2026-10-01" });
  await saveUnset(page, { id: "i-early", title: "Early unset", dueDate: "2026-09-01" });
  await openHome(page);
  await expect(pill(page)).toHaveText(/^\s*3 items have no importance yet/, { timeout: RIG_EXPECT_MS });

  await pill(page).getByRole("button", { name: "set them now" }).click();
  const early = pass(page).locator(".pl-row", { hasText: "Early unset" });
  await early.getByRole("radio", { name: "high", exact: true }).click();
  await expect(early.getByRole("radio", { name: "high", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(early, "a row with a pick reads dimmer").toHaveClass(/done/);
  await pass(page).getByRole("button", { name: "finish later" }).click();
  await expect(pass(page)).toHaveCount(0);

  await expect.poll(() => savedImportance(page, "i-early"), { timeout: RIG_EXPECT_MS }).toBe("high");
  expect(await savedImportance(page, "i-late")).toBeNull();
  expect(await savedImportance(page, "i-svc")).toBeNull();
  await expect(pill(page)).toHaveText(/^\s*2 items have no importance yet/);

  /* the next pass lists only what is still unset; 'Done' keeps the pick too */
  await pill(page).getByRole("button", { name: "set them now" }).click();
  await expect(pass(page).locator(".pl-row .t")).toHaveText(["Late unset", "Car full service"]);
  await pass(page).locator(".pl-row", { hasText: "Late unset" }).getByRole("radio", { name: "low", exact: true }).click();
  await pass(page).getByRole("button", { name: "Done", exact: true }).click();
  await expect(pass(page)).toHaveCount(0);
  await expect.poll(() => savedImportance(page, "i-late"), { timeout: RIG_EXPECT_MS }).toBe("low");
  expect(await savedImportance(page, "i-svc"), "an untouched row stays not set").toBeNull();
  await expect(pill(page)).toHaveText(/^\s*1 item has no importance yet/);
});

test("pass: with the fixture's single unset item, a pick and 'finish later' make the pill go", async ({ page }) => {
  await useFixtureScenes(page, "keep-saves");
  await openHome(page);
  await pill(page).getByRole("button", { name: "set them now" }).click();
  await expect(pass(page).locator(".pl-row")).toHaveCount(1);
  await pass(page).locator(".pl-row").getByRole("radio", { name: "normal", exact: true }).click();
  await pass(page).getByRole("button", { name: "finish later" }).click();
  await expect(pass(page)).toHaveCount(0);
  await expect.poll(() => savedImportance(page, "i-svc"), { timeout: RIG_EXPECT_MS }).toBe("normal");
  await expect(pill(page)).toHaveCount(0);
  await openHome(page);
  await expect(pill(page), "and it stays gone after a reload").toHaveCount(0);
});

test("pass: 'not now' hides the pill for good: after a reload and in a new browser context, and the PUT carries the dismissal", async ({ page, browser }, testInfo) => {
  await useFixtureScenes(page, "keep-saves");
  await openHome(page);
  await expect(pill(page)).toBeVisible({ timeout: RIG_EXPECT_MS });
  const saved = page.waitForRequest((request) => request.url().endsWith("/api/preferences") && request.method() === "PUT");
  await pill(page).getByRole("button", { name: "not now" }).click();
  await expect(pill(page)).toHaveCount(0);
  expect((await saved).postDataJSON().importanceOfferDismissed).toBe(true);

  await openHome(page);
  await expect(page.locator("body[data-home-ready]")).toBeAttached();
  await expect(pill(page), "hidden after a reload").toHaveCount(0);
  expect(await savedImportance(page, "i-svc"), "dismissing sets nothing").toBeNull();

  /* a new browser context with the same sign-in: the dismissal belongs to the user, not the page */
  const { viewport, isMobile, hasTouch, deviceScaleFactor, userAgent } = testInfo.project.use;
  const other = await browser.newContext({
    storageState: await page.context().storageState(),
    ...(viewport ? { viewport } : {}),
    ...(isMobile === undefined ? {} : { isMobile }),
    ...(hasTouch === undefined ? {} : { hasTouch }),
    ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor }),
    ...(userAgent ? { userAgent } : {}),
  });
  try {
    const fresh = await other.newPage();
    await fresh.goto(`${APP}/home`);
    await fresh.locator("body[data-home-ready]").waitFor({ state: "attached" });
    await expect(pill(fresh), "hidden in a new browser context").toHaveCount(0);
  } finally {
    await other.close();
  }
});

test("pass: the pill is there for a browser that has not dismissed it", async ({ page }) => {
  /* the default: not dismissed, so a fresh browser with an unset item sees the offer */
  await openHome(page);
  await expect(pill(page)).toBeVisible({ timeout: RIG_EXPECT_MS });
  await expect(pill(page).getByRole("button", { name: "set them now" })).toBeVisible();
  await expect(pill(page).getByRole("button", { name: "not now" })).toBeVisible();
});
