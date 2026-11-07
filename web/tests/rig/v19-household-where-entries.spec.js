import { expect, test } from "@playwright/test";

import { APP, onPhone, RIG_TEST_MS, settle, signedIn } from "./a11y-support.js";
import { useFixtureScenes } from "../fidelity/pocket-states.js";
import { ownWorkspace, replaceSectionsLikeTheEngine } from "./workspace-writes.js";

/** @typedef {import("@playwright/test").Locator} Locator */
/** @typedef {import("@playwright/test").Page} Page */

/*
 * #1332 (design decision 2026-10-10, "where do these entries go?"), moved to
 * the rig (ADR-0039, #1610): removing a section that still holds entries opens
 * a chooser -- the destination is the second tap -- instead of arming or
 * hiding the x. Nothing is sent until save; a pick marks the row removed,
 * raises the destination's count and says so in a status line; save sends
 * `sections.replace` with `moveItemsTo`.
 *
 * Desk (>= 1200px): the chooser card beside the row, tiles two across. Phone:
 * the bottom sheet round the same tiles. The words are the issue's.
 *
 * Every test starts from the fixture app's own Harlow Home household page, with a
 * fifth section added in setup (#1769): five sections, Home (four entries), Vehicles (two), Devices (one), Services and
 * Dates & renewals (none). The save is the test's own write: `ownSections`
 * answers it the way the engine does (the list as sent, the removed section's
 * entries moved to `moveItemsTo`) and keeps it in the workspace the page reads,
 * so a reload shows what the save did, which is the proof that the entries
 * landed. That the engine itself moves them is the integration project's
 * (tests/integration/household-engine-rules.test.ts, the `moveItemsTo` field).
 *
 * A hidden section's tile says "hidden": the fixture household has none, so the
 * test hides Devices in the editor, unsaved, and looks at its tile. (The
 * source-text check at tests/unit/section-removal-asks-where.test.mjs:235 only
 * reads that the word is in the code.)
 *
 * "The last kept section has no x" no longer needs a one-section household the
 * fixture lacks: the test removes the others through the editor, as a person
 * would, and looks at the one left.
 */
/* The phone walk takes about 105 s on a loaded WebKit runner (#1694), past the rig budget alone. */
test.describe.configure({ timeout: RIG_TEST_MS * 2 });
test.use({ baseURL: APP });

const HOUSEHOLD = "/household/hh-harlow-1";

/**
 * Harlow Home as a household that added a fifth section, "Dates & renewals":
 * the fixture holds the four defaults only (#1769), so the test saves the
 * extra one the way a member would, and the fixture app keeps it for this
 * browser (the `keep-saves` scene). Call it before the page loads.
 * @param {import("@playwright/test").Page} page
 */
async function addDatesSection(page) {
  await useFixtureScenes(page, "keep-saves");
  const read = await page.request.get(`${APP}/api/workspace`);
  const { workspace } = await read.json();
  const sections = workspace.households.find((/** @type {{ id: string }} */ one) => one.id === "hh-harlow-1").sections;
  const saved = await page.request.post(`${APP}/api/workspace/commands`, {
    data: {
      type: "sections.replace",
      householdId: "hh-harlow-1",
      sections: [...sections, { id: "s-dates", name: "Dates & renewals", icon: "calendar", accent: "coral", visible: true }],
    },
  });
  expect(saved.ok()).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await addDatesSection(page);
});
/** The section the tests take apart: two entries (the MOT and the full service). */
const GOING = { id: "s-vehicles", name: "Vehicles", entries: 2 };
/** The empty section the entries are sent to. */
const DESTINATION = { id: "s-services", name: "Services" };
const WORDS = `${GOING.name} removed · ${GOING.entries} entries move to ${DESTINATION.name} when you save`;

/** The household page, settled, in its fixture state: the phone's state of
 *  pocket-states.js, and on a desk the same address, which that state's reach
 *  cannot wait on (it waits for a pocket row).
 * @param {Page} page @param {import("@playwright/test").TestInfo} testInfo */
async function openHousehold(page, testInfo) {
  if (onPhone(testInfo)) return signedIn(HOUSEHOLD, "rest")(page);
  await page.goto(HOUSEHOLD);
  await page.locator(".sec").first().waitFor();
  await settle(page);
}

/** A save is followed by a re-read of the workspace; ending the test with it in
 *  flight makes the remembering route (`rememberWrites`) throw on a closed
 *  page, so the test lets go of its routes, ignoring what is still running.
 * @param {Page} page */
const quiet = (page) => page.unrouteAll({ behavior: "ignoreErrors" });

/** The page's own writes: a save changes the workspace its reads answer, as the
 *  engine would (the household's sections, and the entries that move), so a
 *  reload shows what the save did.
 * @param {Page} page */
const ownSections = (page) => ownWorkspace(page, { "sections.replace": replaceSectionsLikeTheEngine });

/** The `sections.replace` a save sent, once it has.
 * @param {{ commands: { type: string, [key: string]: any }[] }} writes */
const savedSections = (writes) => expect.poll(() => writes.commands.find((one) => one.type === "sections.replace")).toBeTruthy();

/* ── the desk ───────────────────────────────────────────────────────────── */
test.describe("desk", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(onPhone(testInfo), "the desk's chooser card; a phone draws the sheet");
  });

  /** @param {Page} page @param {string} name @returns {Locator} */
  const rowOf = (page, name) => page.locator(".sec").filter({ has: page.getByRole("button", { name: `Remove ${name}` }) });

  test("the × on a section with entries opens the chooser; Esc removes nothing; a pick and save move the entries (#1332)", async ({ page }, testInfo) => {
    const writes = await ownSections(page);
    await openHousehold(page, testInfo);
    const drop = page.getByRole("button", { name: `Remove ${GOING.name}` });
    await expect(drop).toBeVisible();

    // 1. Every section row offers remove, the one holding entries too; the x
    //    is named for its section, not "Remove section".
    await expect(page.getByRole("button", { name: `Remove ${DESTINATION.name}` })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove Home" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove section" })).toHaveCount(0);
    await expect(rowOf(page, GOING.name).locator(".used")).toHaveText(`${GOING.entries} entries`);

    // 2. Opening: the card stands under the row, headed and named for the
    //    entries it will move, offering every other section as a tile. Devices
    //    is hidden in the editor first (unsaved), so its tile has to say so.
    await page.getByRole("button", { name: "Devices on the chart" }).click();
    await expect(rowOf(page, "Devices").locator(".state")).toHaveText("hidden");
    await drop.click();
    const chooser = page.getByRole("dialog", { name: `Choose where ${GOING.entries} entries go` });
    await expect(chooser).toBeVisible();
    await expect(chooser.getByRole("heading", { name: `where ${GOING.entries} entries go` })).toBeVisible();
    await expect(chooser.getByRole("button", { name: /close/ })).toContainText("esc");
    const rowBox = await rowOf(page, GOING.name).boundingBox();
    const cardBox = await chooser.boundingBox();
    expect(rowBox && cardBox && cardBox.y >= rowBox.y, "the card is seated under the row").toBe(true);
    const tiles = chooser.getByRole("radiogroup", { name: "sections" });
    await expect(tiles.getByRole("radio")).toHaveCount(4);
    await expect(tiles.getByRole("radio", { name: /Home/ })).toBeVisible();
    await expect(tiles.getByRole("radio", { name: /Devices/ })).toContainText("hidden");
    await expect(tiles.getByRole("radio", { name: /Services/ })).toBeVisible();
    await expect(tiles.getByRole("radio", { name: /Home/ })).not.toContainText("hidden");
    await expect(tiles.getByRole("radio", { name: /Dates & renewals/ })).toBeVisible();
    await expect(tiles.getByRole("radio", { name: new RegExp(GOING.name) })).toHaveCount(0);

    // 3. Esc closes with nothing removed, and focus goes back to the x.
    await page.keyboard.press("Escape");
    await expect(chooser).toBeHidden();
    await expect(drop).toBeFocused();
    await expect(rowOf(page, GOING.name).locator(".used")).toHaveText(`${GOING.entries} entries`);
    await expect(page.getByRole("status").filter({ hasText: "removed" })).toHaveCount(0);

    // 4. A pick: the row goes, the destination's count rises, the status line
    //    says what will happen on save.
    await drop.click();
    await expect(chooser).toBeVisible();
    await tiles.getByRole("radio", { name: new RegExp(DESTINATION.name) }).click();
    await expect(chooser).toBeHidden();
    await expect(page.getByRole("button", { name: `Remove ${GOING.name}` })).toHaveCount(0);
    await expect(rowOf(page, DESTINATION.name).locator(".used")).toHaveText(`${GOING.entries} entries`);
    await expect(page.getByRole("status").filter({ hasText: `${GOING.name} removed` })).toHaveText(WORDS);

    // 5. Save sends the removal with moveItemsTo naming the destination.
    await page.locator(".c-sections").getByRole("button", { name: "save", exact: true }).click();
    await savedSections(writes);
    const command = writes.commands.find((one) => one.type === "sections.replace");
    expect(command?.moveItemsTo).toBe(DESTINATION.id);
    expect(command?.sections.map((/** @type {{ id: string }} */ one) => one.id)).not.toContain(GOING.id);
    await expect(page.locator(".c-sections .said")).toHaveText("saved");

    // 6. The entries landed: after a reload Vehicles is gone, Services holds
    //    them, and Devices is still hidden.
    await page.reload();
    await expect(page.getByRole("button", { name: `Remove ${DESTINATION.name}` })).toBeVisible();
    await expect(page.getByRole("button", { name: `Remove ${GOING.name}` })).toHaveCount(0);
    await expect(rowOf(page, DESTINATION.name).locator(".used")).toHaveText(`${GOING.entries} entries`);
    await expect(rowOf(page, "Devices").locator(".state")).toHaveText("hidden");
    await quiet(page);
  });

  test("an unsaved new section is offered once it has a name, marked new (#1332)", async ({ page }, testInfo) => {
    await openHousehold(page, testInfo);
    await expect(page.getByRole("button", { name: `Remove ${GOING.name}` })).toBeVisible();
    await page.getByRole("button", { name: "+ add a section" }).click();
    await page.getByRole("textbox", { name: "Section name" }).last().fill("Workshop");
    await page.getByRole("button", { name: `Remove ${GOING.name}` }).click();
    const tiles = page.getByRole("dialog", { name: `Choose where ${GOING.entries} entries go` }).getByRole("radiogroup", { name: "sections" });
    await expect(tiles.getByRole("radio", { name: /Workshop/ })).toContainText("new");
    await page.keyboard.press("Escape");
  });

  test("the last kept section has no ×: there is nowhere to send its entries (#1332)", async ({ page }, testInfo) => {
    await openHousehold(page, testInfo);
    await expect(page.locator(".sec").first()).toBeVisible();
    /* Take every other section away as a person would: the empty ones go at
       once, the ones holding entries send them to Home. Home is then the last
       kept section. */
    for (const name of ["Services", "Dates & renewals"]) {
      await page.getByRole("button", { name: `Remove ${name}` }).click();
    }
    for (const name of ["Vehicles", "Devices"]) {
      await page.getByRole("button", { name: `Remove ${name}` }).click();
      await page.getByRole("dialog", { name: /Choose where \d+ entr(y|ies) go/ }).getByRole("radio", { name: /Home/ }).click();
    }
    await expect(page.locator(".sec .drop:not(.gone)")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Remove Home" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Remove section" })).toHaveCount(0);
  });
});

/* ── the phone ──────────────────────────────────────────────────────────── */
test.describe("phone", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(!onPhone(testInfo), "the phone's sheet; the desk draws the chooser card");
  });

  /** @param {Page} page @param {string} name @returns {Locator} */
  const rowOf = (page, name) => page.locator("[data-hh=sections] [data-row]").filter({ has: page.getByText(name, { exact: true }) });

  test("the remove act on a section with entries opens the sheet; Esc, undo, a pick and save (#1332)", async ({ page }, testInfo) => {
    const writes = await ownSections(page);
    await openHousehold(page, testInfo);
    const going = rowOf(page, GOING.name);
    const face = going.locator("[data-row-face]");
    await expect(face).toBeVisible();
    await expect(going).toContainText(`${GOING.entries} entries`);

    // 1. The row's remove act is there for a section with entries, and opens
    //    the sheet rather than arming.
    await face.click();
    await page.getByRole("button", { name: `Remove ${GOING.name}` }).click();
    const sheet = page.getByRole("dialog", { name: new RegExp(`where ${GOING.entries} entries go`) });
    await expect(sheet).toBeVisible();
    const tiles = sheet.getByRole("radiogroup", { name: "sections" });
    await expect(tiles.getByRole("radio")).toHaveCount(4);
    await expect(tiles.getByRole("radio", { name: new RegExp(GOING.name) })).toHaveCount(0);

    // 2. Esc closes with nothing removed; focus returns to the row.
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(face).toBeFocused();
    await expect(rowOf(page, GOING.name)).toContainText(`${GOING.entries} entries`);

    // 3. A pick removes the row, raises the destination, says so, and counts
    //    one change; undo puts it all back.
    await face.click();
    await page.getByRole("button", { name: `Remove ${GOING.name}` }).click();
    await sheet.getByRole("radio", { name: new RegExp(DESTINATION.name) }).click();
    await expect(sheet).toBeHidden();
    await expect(rowOf(page, GOING.name)).toHaveCount(0);
    await expect(rowOf(page, DESTINATION.name)).toContainText(`${GOING.entries} entries`);
    await expect(page.getByRole("status").filter({ hasText: `${GOING.name} removed` })).toHaveText(WORDS);
    await expect(page.getByRole("status").filter({ hasText: "1 change" })).toBeVisible();
    await page.getByRole("button", { name: "undo", exact: true }).click();
    await expect(rowOf(page, GOING.name)).toContainText(`${GOING.entries} entries`);
    await expect(rowOf(page, DESTINATION.name)).toContainText("0 entries");

    // 4. A section hidden in the editor (unsaved) is offered marked hidden.
    await page.getByRole("switch", { name: "Devices shown on the chart" }).click();
    await expect(rowOf(page, "Devices")).toContainText("hidden");
    await rowOf(page, GOING.name).locator("[data-row-face]").click();
    await page.getByRole("button", { name: `Remove ${GOING.name}` }).click();
    await expect(sheet.getByRole("radio", { name: /Devices/ })).toContainText("hidden");
    await expect(sheet.getByRole("radio", { name: /Home/ })).not.toContainText("hidden");
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();

    // 5. Again, and save: moveItemsTo names the destination.
    await rowOf(page, GOING.name).locator("[data-row-face]").click();
    await page.getByRole("button", { name: `Remove ${GOING.name}` }).click();
    await sheet.getByRole("radio", { name: new RegExp(DESTINATION.name) }).click();
    await page.getByRole("button", { name: "save", exact: true }).click();
    await savedSections(writes);
    const command = writes.commands.find((one) => one.type === "sections.replace");
    expect(command?.moveItemsTo).toBe(DESTINATION.id);
    expect(command?.sections.map((/** @type {{ id: string }} */ one) => one.id)).not.toContain(GOING.id);

    // 6. The entries landed: after a reload Vehicles is gone, Services holds
    //    them, and Devices is still hidden.
    await page.reload();
    await expect(rowOf(page, DESTINATION.name)).toContainText(`${GOING.entries} entries`);
    await expect(rowOf(page, GOING.name)).toHaveCount(0);
    await expect(rowOf(page, "Devices")).toContainText("hidden");
    await quiet(page);
  });
});
