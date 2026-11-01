import { writeFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { APP, useFixtureScenes } from "../fidelity/pocket-states.js";
import { completeLikeTheEngine, ownWorkspace, snoozeLikeTheEngine, upsertLikeTheEngine } from "./workspace-writes.js";

/*
 * #1319 (owner-decisions section 34; design/v19/belt-purpose/round-3/
 * f-preview-beside-tracked.html): home's item drawer holds everything the belt
 * did. A document in it opens its preview beside the drawer on a wide screen
 * (the bottom sheet on a phone), Escape or a press off it removes it and leaves
 * the drawer open, and pressing the page opens the reader over home. The foot
 * row's snooze and complete act from the drawer itself.
 *
 * Stage 2 (design/v19/belt-purpose/round-8/m-colour-per-option.html): the
 * pencil puts the drawer's own rows into edit mode, a chosen value opens the
 * chooser card beside the drawer (the bottom sheet on a phone), Escape takes
 * the chooser and then the edit; snooze opens the calendar ("snooze until");
 * complete asks for its date, cost and notes in the rows and records them.
 *
 * Moved from tests/e2e (ADR-0039, #1609). The stack suite seeded a household
 * with one item and one uploaded paper per test; here the items are the
 * fixture workspace's Harlow Home (fixtures/workspace.js, today 2026-08-13):
 *
 *   MOT      i-mot     Car MOT -- Volvo V60, two papers (d-mot-cert, d-mot-history)
 *   BOILER   i-boiler  Boiler service, no papers
 *
 * The fixture app keeps nothing, so a test whose point is what the screen
 * shows after a write answers its own writes (workspace-writes.js): the command
 * that was sent is what is asserted of the engine, and the screen is judged
 * on what it makes of the answer.
 *
 * Two tests need a fixture scene (useFixtureScenes, pocket-states.js; a
 * browser asks for it before the page loads, nothing is added to the sample
 * workspace):
 *   - NOTED_ITEM, scene `noted-item`: i-mot carrying `notes: NOTE` (the two
 *     tests that read the notes row as it was: the document walk, snooze and
 *     complete);
 *   - ARCHIVED_ITEM, scene `archived-item`: an archived item `i-archived`
 *     (`status: "archived"`) in Harlow Home, with one paper named
 *     `archived-proving.pdf`.
 */

/* Reduced motion: the preview's 900ms focus beat is instant, and nothing
   breathes under Playwright's actionability wait. The assertions hold in
   either mode. */
test.use({ reducedMotion: "reduce" });

/* #1196, #1235: the tests that hold, abort or refuse a request do it with
   `page.route`, and on WebKit a request from a page Orbit's service worker
   controls skips Playwright's route. Nothing in them is about the worker, so on
   WebKit it is kept out. */
const KEEP_THE_WORKER_OFF_ON_WEBKIT = {
  serviceWorkers: async ({}, use, testInfo) => {
    await use(testInfo.project.use.defaultBrowserType === "webkit" ? "block" : "allow");
  },
};

const HARLOW = "hh-harlow-1";
const MOT = { id: "i-mot", title: "Car MOT — Volvo V60", paper: { id: "d-mot-cert", displayName: "MOT certificate 2025" } };
const BOILER = { id: "i-boiler", title: "Boiler service" };
const NOTED_ITEM = MOT;
const ARCHIVED_ITEM = { id: "i-archived", paper: "archived-proving.pdf" };
const NOTE = "Book the early slot.";
const SETTLE = 20_000;

const onPhone = () => test.info().project.name.includes("phone");

/** The desk's drawer and the phone's open row, for an item. @param {import("@playwright/test").Page} page @param {string} id */
const drawerOf = (page, id) => page.locator(`[id="${id}-view"]`);
const rowOf = (/** @type {import("@playwright/test").Page} */ page, /** @type {string} */ id) =>
  page.locator(`.pocket .pk-below [data-row-key="${id}"]`);

/** Home at an item's own address, with the screen able to answer (#1064). @param {import("@playwright/test").Page} page @param {string} id */
async function openAt(page, id) {
  await page.goto(`${APP}/home?item=${id}`, { waitUntil: "load" });
  await expect(page.locator("body[data-home-ready]")).toBeAttached();
}

/** The calendar's day 15 of next month, the fixture's today being 2026-08-13: always ahead of it. */
const NEXT_MONTH_15 = /^\w+ 15 September 2026/;

/** #1316 W1-R3: from the open preview, read the paper, remove it (the pill's two taps), make the server refuse the restore, and press the wake's undo. Returns once the undo is pressed.
 * @param {import("@playwright/test").Page} page @param {import("@playwright/test").Locator} readButton @param {string} name */
async function removeThenFailTheUndo(page, readButton, name) {
  await readButton.click();
  const reader = page.getByRole("dialog", { name: `${name}, ${MOT.title}` });
  await expect(reader).toBeVisible();
  await reader.getByRole("button", { name: `Remove ${name}` }).click();
  await reader.getByRole("button", { name: `tap again to remove ${name}` }).click();

  /* the paper goes and the wake offers it back */
  await expect(page.getByRole("status").filter({ hasText: `${name} removed` })).toHaveText(`${name} removed`);
  await expect(reader).toBeHidden();

  /* the server refuses the restore, whatever the reason */
  await page.route(`**/api/documents/${MOT.paper.id}/restore`, (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "restore failed" }) }));
  await page.getByRole("button", { name: "undo", exact: true }).click();
}

/** The removal the page asks of the fixture app, which has no such route: answered as the engine does, the paper pending deletion from then on.
 * @param {import("@playwright/test").Page} page */
async function removalsAnswered(page) {
  let removed = false;
  await page.route(`**/api/documents/${MOT.paper.id}`, (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    removed = true;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ document: { ...MOT.paper, lifecycle: "pending_deletion" } }) });
  });
  const listing = `**/api/households/${HARLOW}/items/${MOT.id}/documents`;
  await page.route(listing, async (route) => {
    if (route.request().method() !== "GET" || !removed) return route.fallback();
    const documents = (await papersOf(page, MOT.id)).map((one) => (one.id === MOT.paper.id ? { ...one, lifecycle: "pending_deletion" } : one));
    return route.fulfill({ json: { documents }, headers: { "cache-control": "no-store" } });
  });
}

/** #1316 W1-R6: hold the item's save (`type` is the command, "item.upsert" for an edit, "item.complete" for a completion) until `release()` answers it with a refusal. Dry runs (`dryRun: true`) go through untouched. `held()` counts the real saves caught.
 * @param {import("@playwright/test").Page} page @param {"item.upsert" | "item.complete"} type */
async function holdTheSave(page, type) {
  let caught = 0;
  /** @type {() => void} */
  let answer = () => {};
  const gate = new Promise((resolveGate) => { answer = () => resolveGate(undefined); });
  await page.route("**/api/workspace/commands", async (route) => {
    const request = route.request();
    /** @type {{ type?: string, dryRun?: boolean }} */
    let body = {};
    try { body = request.postDataJSON() ?? {}; } catch { /* not ours */ }
    if (request.method() !== "POST" || body.type !== type || body.dryRun) { await route.continue(); return; }
    caught += 1;
    await gate;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "the save failed" }) });
  });
  return { held: () => caught, release: () => answer() };
}

/** The rows' own focus-free double Escape: the first arms "discard changes?" over changed rows, the second (inside the 4s hold) discards them. @param {import("@playwright/test").Page} page */
async function escapeTwice(page) {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
}

/* #1584 web-home-2 / web-home-1: the done line a landed command says when only
   the read of home (or of the item's papers) after it fails (landed.js). */
const DONE_LINE = /^done — .*reload/;

/** The item's documents route: GET lists them, POST attaches one. @param {string} id */
const documentsPathOf = (id) => `/api/households/${HARLOW}/items/${id}/documents`;

/** The papers the fixture app lists for an item (its own answer, read before a test's route is in the way). @param {import("@playwright/test").Page} page @param {string} id @returns {Promise<any[]>} */
async function papersOf(page, id) {
  const response = await page.request.get(`${APP}${documentsPathOf(id)}`);
  return (await response.json()).documents;
}

/**
 * The attach route of the fixture app, which only lists: this one keeps what
 * is posted to it for the test, answers the way the engine does (the item's
 * paper count goes up with it), and records every `x-orbit-document-id` an
 * upload carries, in order.
 * @param {import("@playwright/test").Page} page @param {string} itemId
 */
async function papersAnswered(page, itemId) {
  /* the workspace says how many papers an item carries, and the phone reads an item's papers only when it says so */
  const writes = await ownWorkspace(page);
  /** @type {string[]} */
  const uploads = [];
  /** @type {any[]} */
  const added = [];
  await page.route((url) => url.pathname === documentsPathOf(itemId), async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const id = request.headers()["x-orbit-document-id"] ?? "(none)";
      const name = decodeURIComponent(request.headers()["x-orbit-filename"] ?? "");
      uploads.push(id);
      const document = {
        id, itemId, displayName: name, mediaType: "application/pdf", sizeBytes: 4, lifecycle: "stored", scanStatus: "clean",
        availableAt: new Date().toISOString(), deleteAfter: null, ready: true, failureCode: null, recoverable: false,
        recoveryExpiresAt: null, recoveryStatus: null,
      };
      if (!added.some((one) => one.id === id)) {
        added.push(document);
        const held = await writes.itemOf(itemId);
        if (held) held.item.documentCount = (held.item.documentCount ?? 0) + 1;
      }
      return route.fulfill({ status: 201, json: { document }, headers: { "cache-control": "no-store" } });
    }
    return route.fulfill({ json: { documents: [...(await papersOf(page, itemId)), ...added] }, headers: { "cache-control": "no-store" } });
  });
  return uploads;
}

/** A file to pick BY PATH: a buffer payload gets a fresh lastModified on each pick, which would mint a new id for a reason unrelated to the fix (attach-id.js keys on name, size and lastModified).
 * @param {import("@playwright/test").TestInfo} testInfo */
function pdfOnDisk(testInfo) {
  const path = testInfo.outputPath("chromium-synthetic.pdf");
  writeFileSync(path, Buffer.from("%PDF-1.4\n%%EOF\n"));
  return path;
}

/** The wake's polite line and its failure line (Wake.svelte). @param {import("@playwright/test").Page} page */
const wakeStatus = (page) => page.locator('.p-wake-host [role="status"]');

/** #1316 W1-S1: open the item's row from the list, press the pencil and type onto its title, so the rows hold a change.
 * @param {import("@playwright/test").Page} page @param {{ id: string, title: string }} item */
async function editTheTitle(page, item) {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await expect(page.locator("body[data-home-ready]")).toBeAttached();
  await page.locator(`a.item[id="${item.id}"]`).click();
  const drawer = drawerOf(page, item.id);
  await expect(drawer).toBeVisible({ timeout: SETTLE });
  await expect(page).toHaveURL(new RegExp(`/home\\?item=${item.id}$`));
  await drawer.getByRole("button", { name: "Edit this item" }).click();
  const title = page.locator(`[id="${item.id}"]`).getByRole("textbox", { name: "title" });
  await expect(title).toBeFocused();
  await page.keyboard.press("End");
  await page.keyboard.type(" renamed");
  await expect(title).toHaveText(`${item.title} renamed`);
  return { drawer, title };
}

/** The drawer is still open on the edited item, the typed title is still in the rows and the cancel pill has armed as "discard changes?".
 * @param {import("@playwright/test").Page} page @param {{ id: string, title: string }} item @param {import("@playwright/test").Locator} drawer @param {import("@playwright/test").Locator} title */
async function expectHeldOpen(page, item, drawer, title) {
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/home\\?item=${item.id}$`));
  await expect(title).toHaveText(`${item.title} renamed`);
  await expect(drawer.getByRole("group", { name: /^Editing / }).getByRole("button", { name: "discard changes?" })).toBeVisible();
}

/** What the notes box holds before anything is typed onto it, and the text it holds after `typed` is. @param {import("@playwright/test").Locator} notes @param {string} typed */
async function notesThen(notes, typed) {
  const before = ((await notes.textContent()) ?? "").trim();
  return { before, after: `${before} ${typed}`.trim() };
}

/* #1319 (decision 2026-10-09): `/home?item=<id>` for an item in another of the
   reader's households switches home to that household and opens the drawer
   there, on the desk and on the phone. */
test.describe("an item in another of the reader's households", () => {
  test("its address switches home to that household and opens its drawer", async ({ page }) => {
    const SEASIDE = "hh-seaside-4551";
    const OTHER = { id: "i-seaside-0", title: "Septic tank empty" };
    /* the engine makes the activation stick: the session's active household */
    const writes = await ownWorkspace(page, { "household.activate": (command, workspace) => { workspace.activeHouseholdId = command.householdId; } });
    const activeHousehold = async () => (await writes.workspace()).activeHouseholdId;
    expect(await activeHousehold()).toBe(HARLOW);

    await openAt(page, OTHER.id);
    if (onPhone()) {
      await expect(rowOf(page, OTHER.id)).toHaveAttribute("data-open", "", { timeout: SETTLE });
      await expect(rowOf(page, MOT.id)).toHaveCount(0);
    } else {
      const drawer = drawerOf(page, OTHER.id);
      await expect(drawer).toBeVisible({ timeout: SETTLE });
      /* the manifest is that household's now: its row, not the first's */
      await expect(page.locator(`a.item[id="${OTHER.id}"]`)).toContainText(OTHER.title);
      await expect(page.locator(`[id="${MOT.id}"]`)).toHaveCount(0);
    }
    expect(await activeHousehold()).toBe(SEASIDE);
    await expect(page).toHaveURL(new RegExp(`/home\\?item=${OTHER.id}$`));
  });
});

test.describe("on the desk", () => {
  test.beforeEach(() => {
    test.skip(onPhone(), "the desk's drawer; the phone's is below");
  });

  /* #1305: the dial callout's documents chip opens the item's own drawer
     with its real documents. It used to open a dialog of the mockup's two
     made-up papers under whichever item's name. (The phone's dial has no
     callout, so no chip.) */
  test("the dial's documents chip opens the item's drawer at its real documents", async ({ page }) => {
    await page.goto(`${APP}/home`, { waitUntil: "load" });
    const body = page.locator(`.body-link[data-body="${MOT.id}"]`);
    await expect(body).toHaveAttribute("data-docs", "2", { timeout: SETTLE });
    /* The markup is drawn before home's listeners are bound (#1064): a
       synthetic mouseenter sent in that gap is heard by nobody, and there is
       no second one. Wait for the screen to be able to answer. */
    await expect(page.locator("body[data-home-ready]")).toBeAttached();
    await body.dispatchEvent("mouseenter");
    const chip = page.locator(".callout.show .chip");
    await expect(chip).toHaveText("◆ 2 documents");
    await chip.click();

    const drawer = drawerOf(page, MOT.id);
    await expect(drawer).toBeVisible({ timeout: SETTLE });
    await expect(page).toHaveURL(new RegExp(`/home\\?item=${MOT.id}$`));
    const paper = drawer.getByRole("button", { name: `Open ${MOT.paper.displayName}` });
    await expect(paper).toBeFocused();
    await expect(drawer.locator("[data-doc-row]")).toHaveCount(2);
    /* nothing made up, anywhere on the screen: the other item's paper is not shown under this one */
    await expect(page.getByText("service-invoice-2026.pdf")).toHaveCount(0);
    await expect(page.locator("#docview")).toHaveCount(0);
  });

  /* #1316 W1-S1: leaving the drawer by any road but its own pills must not
     drop an edit in progress. The first Back, search pick or documents chip
     arms the cancel pill ("discard changes?") and keeps the drawer, the
     rows and the typed title; a second one inside the hold is the answer. */
  test("Back during an edit keeps the drawer and the typed title; a second Back inside the hold closes it", async ({ page }) => {
    const { drawer, title } = await editTheTitle(page, BOILER);

    await page.goBack();
    await expectHeldOpen(page, BOILER, drawer, title);

    await page.goBack();
    await expect(drawer).toHaveCount(0);
    await expect(page).toHaveURL(/\/home$/);
  });

  test("picking a search result for another item during an edit keeps the drawer and the typed title; a second pick inside the hold closes it", async ({ page }) => {
    const { drawer, title } = await editTheTitle(page, BOILER);
    const explore = page.locator("#explore");
    await explore.fill("volvo");
    await explore.press("Enter");
    await expectHeldOpen(page, BOILER, drawer, title);

    await explore.fill("volvo");
    await explore.press("Enter");
    await expect(drawer).toHaveCount(0);
  });

  test("the dial's documents chip for another item during an edit keeps the drawer and the typed title; a second use inside the hold closes it", async ({ page }) => {
    const { drawer, title } = await editTheTitle(page, BOILER);

    const useTheChip = async () => {
      const body = page.locator(`.body-link[data-body="${MOT.id}"]`);
      await expect(body).toHaveAttribute("data-docs", "2", { timeout: SETTLE });
      // The callout is fixed beside the body; a body scrolled off-screen puts it
      // off-screen too. A member scrolls to the dial before pointing at it.
      await body.scrollIntoViewIfNeeded();
      await body.dispatchEvent("mouseenter");
      const chip = page.locator(".callout.show .chip");
      await expect(chip).toHaveText("◆ 2 documents");
      await chip.click();
    };

    await useTheChip();
    await expectHeldOpen(page, BOILER, drawer, title);

    await useTheChip();
    await expect(drawer).toHaveCount(0);
  });

  /* The card's own place (beside the drawer, its top level with the item
     card's) is proved by fidelity/document-preview.spec.js, the desk preview
     test, on these same fixture papers; it is not asserted twice here. */
  test("a document opens its preview beside the drawer; the page opens the reader; Escape walks back", async ({ page }) => {
    await useFixtureScenes(page, "noted-item");
    await openAt(page, NOTED_ITEM.id);
    const row = page.locator(`a.item[id="${MOT.id}"]`);
    const drawer = drawerOf(page, MOT.id);
    await expect(drawer).toBeVisible({ timeout: SETTLE });
    /* the drawer is the item now: no way onward to the belt */
    await expect(drawer.getByRole("link", { name: "manage this item →" })).toHaveCount(0);
    /* notes above documents (owner, 2026-10-08) */
    await expect(drawer.locator("h2")).toHaveText(["notes", "documents"]);
    await expect(drawer.getByText(NOTE)).toBeVisible();

    /* level the row a little below the page's 84px gutter, so the card's
       top has the row's top to sit level with */
    await row.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 120));
    const name = MOT.paper.displayName;
    const paper = drawer.getByRole("button", { name: `Open ${name}` });
    await paper.click();

    const card = page.getByRole("dialog", { name: new RegExp(`^${name}`) });
    await expect(card).toBeVisible();
    await expect(paper).toHaveAttribute("aria-current", "true");
    const pageButton = card.getByRole("button", { name: `Read ${name}` });
    await expect(pageButton).toBeEnabled({ timeout: SETTLE });
    await expect(card.getByRole("img", { name: `Page one of ${name}` })).toBeVisible();

    /* the page opens the reader over home */
    await pageButton.click();
    const reader = page.getByRole("dialog", { name: `${name}, ${MOT.title}` });
    await expect(reader).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/home\\?item=${MOT.id}`));

    /* Escape closes the reader onto the page that opened it… */
    await page.keyboard.press("Escape");
    await expect(reader).toBeHidden();
    await expect(pageButton).toBeFocused();
    /* …then the card, at once, onto the row that opened it; the drawer stays */
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(paper).toBeFocused();
    await expect(drawer).toBeVisible();

    /* a press off the card removes it too, and leaves the drawer open */
    await paper.click();
    await expect(card).toBeVisible();
    await page.mouse.click((page.viewportSize()?.width ?? 1280) - 8, (page.viewportSize()?.height ?? 720) - 8);
    await expect(card).toHaveCount(0);
    await expect(drawer).toBeVisible();
  });

  test("snooze and complete act from the drawer's foot row", async ({ page }) => {
    const writes = await ownWorkspace(page, { "item.snooze": snoozeLikeTheEngine, "item.complete": completeLikeTheEngine });
    const dueDate = "2026-08-29";
    await useFixtureScenes(page, "noted-item");
    await openAt(page, NOTED_ITEM.id);
    const drawer = drawerOf(page, MOT.id);
    await expect(drawer).toBeVisible({ timeout: SETTLE });
    const acts = drawer.getByRole("group", { name: `Actions for ${MOT.title}` });
    await expect(acts.getByRole("button")).toHaveText(["snooze", "complete", "attach a document", "retire"]);
    await expect(drawer.getByRole("button", { name: "Edit this item" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Copy link" })).toBeVisible();

    /* snooze opens the calendar beside the drawer; a day picked snoozes */
    await acts.getByRole("button", { name: `Snooze ${MOT.title}` }).click();
    const calendar = page.getByRole("dialog", { name: /snooze until/i });
    await expect(calendar).toBeVisible();
    await calendar.getByRole("button", { name: "Next month" }).click();
    await calendar.getByRole("button", { name: NEXT_MONTH_15 }).click();
    await expect(calendar).toHaveCount(0);
    await expect(drawer.getByText("snoozed until")).toBeVisible({ timeout: 10_000 });
    expect(writes.sent("item.snooze").map((one) => [one.itemId, one.snoozedUntil])).toEqual([[MOT.id, "2026-09-15"]]);

    /* complete asks in the rows: the date (today), the cost, the notes as
       they were; record sends it and the next orbit comes round */
    await drawer.getByRole("group", { name: `Actions for ${MOT.title}` })
      .getByRole("button", { name: `Complete ${MOT.title}` }).click();
    const completing = drawer.getByRole("group", { name: `Completing ${MOT.title}` });
    await expect(completing.getByRole("button")).toHaveText(["record", "cancel"]);
    await expect(drawer.getByRole("button", { name: /^completed on: / })).toBeFocused();
    await expect(drawer.getByRole("textbox", { name: "notes" })).toHaveText(NOTE);
    await completing.getByRole("button", { name: "record" }).click();
    await expect(page.getByText(/^Completed · next due/).first()).toBeAttached();
    expect(writes.sent("item.complete").map((one) => one.itemId)).toEqual([MOT.id]);
    expect((await writes.itemOf(MOT.id))?.item.dueDate).not.toBe(dueDate);
  });

  test("the pencil edits the drawer's own rows; Escape takes the chooser, then the edit", async ({ page }) => {
    const writes = await ownWorkspace(page, { "item.upsert": upsertLikeTheEngine });
    await openAt(page, BOILER.id);
    const drawer = drawerOf(page, BOILER.id);
    await expect(drawer).toBeVisible({ timeout: SETTLE });
    const pencil = drawer.getByRole("button", { name: "Edit this item" });
    await pencil.click();
    await expect(pencil).toHaveAttribute("aria-pressed", "true");
    /* the title edits in the row's head; save and cancel stand in the pills' place */
    await expect(page.locator(`[id="${BOILER.id}"]`).getByRole("textbox", { name: "title" })).toBeFocused();
    await expect(drawer.getByRole("group", { name: `Editing ${BOILER.title}` }).getByRole("button")).toHaveText(["save", "cancel"]);

    /* the due date opens the calendar beside the drawer; Escape takes it
       away and hands focus back to the value */
    const due = drawer.getByRole("button", { name: /^due: / });
    await due.click();
    const calendar = page.getByRole("dialog", { name: /due date/i });
    await expect(calendar).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(calendar).toHaveCount(0);
    await expect(due).toBeFocused();
    /* the second Escape cancels the edit and leaves the drawer open */
    await page.keyboard.press("Escape");
    await expect(drawer.getByRole("group", { name: `Actions for ${BOILER.title}` })).toBeVisible();
    await expect(pencil).toBeFocused();

    /* typed in place, saved through the item (the fixture's Boiler service already has a provider: it is replaced) */
    await pencil.click();
    const provider = drawer.getByRole("textbox", { name: "provider" });
    await provider.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Northgate Services");
    /* rows holding changes ask first (the coordinator's ruling, 2026-10-08):
       Escape arms the cancel pill as "discard changes?" and the edit stays */
    const editing = drawer.getByRole("group", { name: `Editing ${BOILER.title}` });
    await page.keyboard.press("Escape");
    await expect(editing.getByRole("button", { name: "discard changes?" })).toBeVisible();
    await expect(provider).toHaveText("Northgate Services");
    await editing.getByRole("button", { name: "save" }).click();
    await expect(drawer.getByText("Northgate Services")).toBeVisible({ timeout: 10_000 });
    expect((await writes.itemOf(BOILER.id))?.item.provider).toBe("Northgate Services");

    /* and edited again: the second save lands too (#1319: an upsert sends
       the version it becomes, so a second edit is not refused as "changed on
       another device"; the answer here refuses a wrong version as the engine
       does). The first edit closes only once its save and the reread both
       return, and a press on the pencil mid-edit does nothing, so wait for it
       to close before pressing again. */
    await expect(pencil).toHaveAttribute("aria-pressed", "false", { timeout: 10_000 });
    await expect(editing).toHaveCount(0);
    await pencil.click();
    await drawer.getByRole("textbox", { name: "provider" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Ltd");
    await drawer.getByRole("group", { name: `Editing ${BOILER.title}` }).getByRole("button", { name: "save" }).click();
    await expect(drawer.getByText("Northgate Services Ltd")).toBeVisible({ timeout: 10_000 });
    await expect(drawer.getByRole("alert")).toHaveCount(0);
    expect((await writes.itemOf(BOILER.id))?.item.provider).toBe("Northgate Services Ltd");
    expect(writes.sent("item.upsert").map((one) => one.item.version)).toEqual([3, 4]);
  });

  test.describe(() => {
    test.use(KEEP_THE_WORKER_OFF_ON_WEBKIT);

    /* #1316 W1-R6: Escape is not a way out of a save in flight. The second
       Escape of the discard guard used to close the rows while the save was
       still on its way, so a refusal had nowhere to read and the typing was
       gone. The rows stay open, with what was typed, until the save answers. */
    test("Escape twice during a save in flight keeps the rows; a refused save reads under them", async ({ page }) => {
      await openAt(page, BOILER.id);
      const drawer = drawerOf(page, BOILER.id);
      await expect(drawer).toBeVisible({ timeout: SETTLE });
      const typed = `${BOILER.title}, renamed`;
      await drawer.getByRole("button", { name: "Edit this item" }).click();
      const title = page.locator(`[id="${BOILER.id}"]`).getByRole("textbox", { name: "title" });
      await expect(title).toBeFocused();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type(typed);
      await expect(title).toHaveText(typed);

      const save = await holdTheSave(page, "item.upsert");
      const editing = drawer.getByRole("group", { name: `Editing ${BOILER.title}` });
      await editing.getByRole("button", { name: "save" }).click();
      await expect(editing.getByRole("button", { name: "saving…" })).toBeVisible();
      await expect.poll(save.held).toBe(1);

      await escapeTwice(page);
      /* the rows are still open and still hold the typing */
      await expect(editing).toBeVisible();
      await expect(title).toBeVisible();
      await expect(title).toHaveText(typed);
      await expect(drawer.getByRole("group", { name: `Actions for ${BOILER.title}` })).toHaveCount(0);

      /* the save answers with a refusal: it reads under the rows, which stay */
      save.release();
      await expect(drawer.getByRole("alert")).toContainText(/not saved/, { timeout: 10_000 });
      await expect(editing).toBeVisible();
      await expect(title).toHaveText(typed);
    });

    test("Escape twice during a completion being recorded keeps the rows; a refused record reads under them", async ({ page }) => {
      await openAt(page, BOILER.id);
      const drawer = drawerOf(page, BOILER.id);
      await expect(drawer).toBeVisible({ timeout: SETTLE });
      await drawer.getByRole("group", { name: `Actions for ${BOILER.title}` })
        .getByRole("button", { name: `Complete ${BOILER.title}` }).click();
      const completing = drawer.getByRole("group", { name: `Completing ${BOILER.title}` });
      await expect(completing.getByRole("button")).toHaveText(["record", "cancel"]);
      const notes = drawer.getByRole("textbox", { name: "notes" });
      const typed = await notesThen(notes, "Bring the log book.");
      await notes.click();
      await page.keyboard.press("End");
      await page.keyboard.type(" Bring the log book.");
      await expect(notes).toHaveText(typed.after);

      const save = await holdTheSave(page, "item.complete");
      await completing.getByRole("button", { name: "record" }).click();
      await expect(completing.getByRole("button", { name: "recording…" })).toBeVisible();
      await expect.poll(save.held).toBe(1);

      await escapeTwice(page);
      await expect(completing).toBeVisible();
      await expect(notes).toBeVisible();
      await expect(notes).toHaveText(typed.after);
      await expect(drawer.getByRole("group", { name: `Actions for ${BOILER.title}` })).toHaveCount(0);

      save.release();
      await expect(drawer.getByRole("alert")).toBeVisible({ timeout: 10_000 });
      await expect(drawer.getByRole("alert")).not.toHaveText("");
      await expect(completing).toBeVisible();
      await expect(notes).toHaveText(typed.after);
    });
  });

  /* #1316 W1-S2 (owner, 2026-10-11, option a): the pencil over a completion
     that holds changes goes through the discard guard. The first press keeps
     the completion rows with the typed note and cost and arms the cancel pill
     as "discard changes?"; a second press inside the hold opens the edit rows.
     It used to open the edit rows at once and the typing was gone. */
  test("the pencil over a completion holding a note and a cost asks first; a second press opens the edit rows", async ({ page }) => {
    await openAt(page, BOILER.id);
    const drawer = drawerOf(page, BOILER.id);
    await expect(drawer).toBeVisible({ timeout: SETTLE });
    await drawer.getByRole("group", { name: `Actions for ${BOILER.title}` })
      .getByRole("button", { name: `Complete ${BOILER.title}` }).click();
    const completing = drawer.getByRole("group", { name: `Completing ${BOILER.title}` });
    await expect(completing.getByRole("button")).toHaveText(["record", "cancel"]);
    const notes = drawer.getByRole("textbox", { name: "notes" });
    const cost = drawer.getByRole("textbox", { name: "cost" });
    const typed = await notesThen(notes, "Bring the log book.");
    await notes.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Bring the log book.");
    await expect(notes).toHaveText(typed.after);
    await cost.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("42.50");
    await expect(cost).toHaveText("42.50");

    const editing = drawer.getByRole("group", { name: `Editing ${BOILER.title}` });
    await drawer.getByRole("button", { name: "Edit this item" }).click();
    await expect(completing.getByRole("button", { name: "discard changes?" })).toBeVisible();
    await expect(completing).toBeVisible();
    await expect(editing).toHaveCount(0);
    await expect(notes).toHaveText(typed.after);
    await expect(cost).toHaveText("42.50");

    await drawer.getByRole("button", { name: "Edit this item" }).click();
    await expect(editing).toBeVisible();
    await expect(completing).toHaveCount(0);
    await expect(page.locator(`[id="${BOILER.id}"]`).getByRole("textbox", { name: "title" })).toBeVisible();
  });

  test.describe(() => {
    test.use(KEEP_THE_WORKER_OFF_ON_WEBKIT);

    /* #1316 W1-R3: undo is a promise; when the server refuses it the reader is
       told in the wake, not left with a silent nothing. The paper stays
       removed (the drawer may still list it, saying "removed"). */
    test("undoing a removal the server refuses says so in a wake, and the paper stays removed", async ({ page }) => {
      const name = MOT.paper.displayName;
      await removalsAnswered(page);
      await openAt(page, MOT.id);
      const drawer = drawerOf(page, MOT.id);
      await expect(drawer).toBeVisible({ timeout: SETTLE });
      await drawer.getByRole("button", { name: `Open ${name}` }).click();
      const card = page.getByRole("dialog", { name: new RegExp(`^${name}`) });
      const readButton = card.getByRole("button", { name: `Read ${name}` });
      await expect(readButton).toBeEnabled({ timeout: SETTLE });

      await removeThenFailTheUndo(page, readButton, name);

      await expect(page.getByRole("alert").filter({ hasText: new RegExp(`couldn['’]t restore ${name} — try again`) }))
        .toBeVisible();
      /* never listed as a live paper again: the item's list, read again, says it is pending deletion */
      await expect(drawer.getByRole("button", { name: `Open ${name}` }).filter({ hasNotText: /removed/ }))
        .toHaveCount(0);
    });
  });

  test.describe(() => {
    test.use(KEEP_THE_WORKER_OFF_ON_WEBKIT);

    /* #1584 web-home-2, the desk: the drawer's record read after an attach
       swallowed its own failure, so the act read as refreshed and the id was
       forgotten; a re-pick then stored a second copy. Only the item's
       documents GET fails here (home's own read goes through), the upload
       POST lands. The pick is by PATH (pdfOnDisk). That the server then holds
       one copy of a file posted twice under one id is the engine's, not the
       browser's: the browser's half is that the second pick re-sends the
       first one's id. */
    test("an attach whose record read fails says the done line and keeps its id, so a re-pick sends the same one", async ({ page }, testInfo) => {
      const uploads = await papersAnswered(page, BOILER.id);
      const file = pdfOnDisk(testInfo);
      await openAt(page, BOILER.id);
      const drawer = drawerOf(page, BOILER.id);
      await expect(drawer).toBeVisible({ timeout: SETTLE });

      const documentsRead = (/** @type {URL} */ url) => url.pathname === documentsPathOf(BOILER.id);
      await page.route(documentsRead, (route) =>
        route.request().method() === "GET" ? route.abort("connectionfailed") : route.fallback());
      try {
        await drawer.locator('input[type="file"]').setInputFiles(file);
        /* soft, so the run goes on to show what the re-pick does as well */
        await expect.soft(drawer.locator('.ivproblem[role="alert"]'), "the drawer's act line says done").toHaveText(DONE_LINE, { timeout: 8_000 });
        await expect.soft(wakeStatus(page), "the wake says the same line").toHaveText(DONE_LINE, { timeout: 8_000 });
        await expect.soft(wakeStatus(page), "and never 'attached'").not.toHaveText(/attached/, { timeout: 3_000 });
        /* the record is still shown, and says nothing but the done line */
        await expect.soft(drawer.getByRole("group", { name: `Actions for ${BOILER.title}` }), "the record is still shown").toBeVisible({ timeout: 3_000 });
        await expect.soft(drawer.locator(".ivproblem")).toHaveCount(1, { timeout: 3_000 });
      } finally {
        await page.unroute(documentsRead);
      }

      /* short: a record the failed read replaced with its error has no picker left to use */
      await drawer.locator('input[type="file"]').setInputFiles(file, { timeout: 10_000 });
      await expect(wakeStatus(page)).toHaveText(`chromium-synthetic.pdf attached to ${BOILER.title}`, { timeout: SETTLE });
      expect(uploads, "two picks, two uploads").toHaveLength(2);
      expect(uploads[1], "the re-pick re-sends the first pick's id").toBe(uploads[0]);
    });
  });
});

test.describe("on the phone", () => {
  test.beforeEach(() => {
    test.skip(!onPhone(), "the phone's drawer; the desk's is above");
  });

  test("a document in the drawer opens the preview as the bottom sheet", async ({ page }) => {
    await openAt(page, MOT.id);
    const row = rowOf(page, MOT.id);
    await expect(row).toHaveAttribute("data-open", "", { timeout: SETTLE });
    /* the foot row, as the desk's */
    await expect(row.getByRole("group", { name: `Actions for ${MOT.title}` }).getByRole("button"))
      .toHaveText(["snooze", "complete", "attach a document", "retire"]);
    await expect(row.getByRole("link", { name: /^Open / })).toHaveCount(0);

    const name = MOT.paper.displayName;
    const paper = row.getByRole("button", { name: `Open ${name}` });
    await expect(paper).toBeVisible({ timeout: SETTLE });
    await paper.tap();
    const sheet = page.getByRole("dialog", { name: new RegExp(`^${name}`) });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("button", { name: `Read ${name}` })).toBeEnabled({ timeout: SETTLE });
    /* the bottom sheet: fixed to the foot of the screen */
    const box = await sheet.boundingBox();
    const height = page.viewportSize()?.height ?? 0;
    expect(Math.abs((box?.y ?? 0) + (box?.height ?? 0) - height)).toBeLessThan(2);

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(row).toHaveAttribute("data-open", "");

    /* stage 2: the pencil edits the rows, the title in the row's head; the
       due date's calendar is the bottom sheet; Escape takes it, then the edit */
    await row.getByRole("button", { name: "Edit this item" }).tap();
    /* the title is live in the row's head; its button is put away meanwhile */
    await expect(row.getByRole("textbox", { name: "title" })).toBeFocused();
    await expect(row.locator("[data-row-face]")).toBeHidden();
    await row.getByRole("button", { name: /^due: / }).tap();
    const calendar = page.getByRole("dialog", { name: /due date/i });
    await expect(calendar).toBeVisible();
    const sheetBox = await calendar.boundingBox();
    expect(Math.abs((sheetBox?.y ?? 0) + (sheetBox?.height ?? 0) - height)).toBeLessThan(2);
    await page.keyboard.press("Escape");
    await expect(calendar).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(row.getByRole("group", { name: `Actions for ${MOT.title}` })).toBeVisible();
    await expect(row).toHaveAttribute("data-open", "");
  });

  /* #1316 W1-F7: the phone's papers are read only for active items, so an
     archived item's drawer (opened by its address) had no Documents section.
     The open row's item is read whatever its status. */
  test("an archived item's drawer shows its Documents heading and the paper by name", async ({ page }) => {
    await useFixtureScenes(page, "archived-item");
    await openAt(page, ARCHIVED_ITEM.id);
    const row = rowOf(page, ARCHIVED_ITEM.id);
    await expect(row).toHaveAttribute("data-open", "", { timeout: SETTLE });
    await expect(row.getByRole("heading", { name: /^documents$/i })).toBeVisible({ timeout: SETTLE });
    await expect(row.getByRole("button", { name: `Open ${ARCHIVED_ITEM.paper}` })).toBeVisible();
  });

  /* #1316 W1-R7: attaching to an item that had no papers left the drawer's
     list empty until the row was reopened. The open row shows the new paper
     (and its Documents heading) as soon as the wake says it is attached. */
  test("attaching a document to an item with none shows the Documents heading and the paper without reopening the row", async ({ page }) => {
    await papersAnswered(page, BOILER.id);
    await openAt(page, BOILER.id);
    const row = rowOf(page, BOILER.id);
    await expect(row).toHaveAttribute("data-open", "", { timeout: SETTLE });
    /* the item starts with no papers: nothing to list, no heading */
    await expect(row.getByRole("heading", { name: /^documents$/i })).toHaveCount(0);
    await expect(row.getByRole("button", { name: /^Open .*\.pdf$/ })).toHaveCount(0);

    await row.locator('input[type="file"]').setInputFiles({
      name: "attached-late.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n%%EOF\n"),
    });

    await expect(page.getByRole("status").filter({ hasText: "attached-late.pdf attached" }))
      .toHaveText("attached-late.pdf attached", { timeout: SETTLE });
    /* the row has stayed open throughout: no close, no reopen */
    await expect(row).toHaveAttribute("data-open", "");
    await expect(row.getByRole("heading", { name: /^documents$/i })).toBeVisible({ timeout: 10_000 });
    await expect(row.getByRole("button", { name: "Open attached-late.pdf" })).toBeVisible({ timeout: 10_000 });
    await expect(row).toHaveAttribute("data-open", "");
  });

  test.describe(() => {
    test.use(KEEP_THE_WORKER_OFF_ON_WEBKIT);

    /* #1316 W1-R6, on the phone's rows. */
    test("Escape twice during a save in flight keeps the rows; a refused save reads under them", async ({ page }) => {
      await openAt(page, BOILER.id);
      const row = rowOf(page, BOILER.id);
      await expect(row).toHaveAttribute("data-open", "", { timeout: SETTLE });
      const typed = `${BOILER.title}, renamed`;
      await row.getByRole("button", { name: "Edit this item" }).tap();
      const title = row.getByRole("textbox", { name: "title" });
      await expect(title).toBeFocused();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type(typed);
      await expect(title).toHaveText(typed);

      const save = await holdTheSave(page, "item.upsert");
      const editing = row.getByRole("group", { name: `Editing ${BOILER.title}` });
      await editing.getByRole("button", { name: "save" }).tap();
      await expect(editing.getByRole("button", { name: "saving…" })).toBeVisible();
      await expect.poll(save.held).toBe(1);

      await escapeTwice(page);
      await expect(editing).toBeVisible();
      await expect(title).toHaveText(typed);
      await expect(row).toHaveAttribute("data-open", "");

      save.release();
      await expect(row.getByRole("alert")).toContainText(/not saved/, { timeout: 10_000 });
      await expect(editing).toBeVisible();
      await expect(title).toHaveText(typed);
    });

    test("Escape twice during a completion being recorded keeps the rows; a refused record reads under them", async ({ page }) => {
      await openAt(page, BOILER.id);
      const row = rowOf(page, BOILER.id);
      await expect(row).toHaveAttribute("data-open", "", { timeout: SETTLE });
      await row.getByRole("group", { name: `Actions for ${BOILER.title}` })
        .getByRole("button", { name: `Complete ${BOILER.title}` }).tap();
      const completing = row.getByRole("group", { name: `Completing ${BOILER.title}` });
      await expect(completing.getByRole("button")).toHaveText(["record", "cancel"]);
      const notes = row.getByRole("textbox", { name: "notes" });
      const typed = await notesThen(notes, "Bring the log book.");
      await notes.tap();
      await page.keyboard.press("End");
      await page.keyboard.type(" Bring the log book.");
      await expect(notes).toHaveText(typed.after);

      const save = await holdTheSave(page, "item.complete");
      await completing.getByRole("button", { name: "record" }).tap();
      await expect(completing.getByRole("button", { name: "recording…" })).toBeVisible();
      await expect.poll(save.held).toBe(1);

      await escapeTwice(page);
      await expect(completing).toBeVisible();
      await expect(notes).toHaveText(typed.after);
      await expect(row).toHaveAttribute("data-open", "");

      save.release();
      await expect(row.getByRole("alert")).toBeVisible({ timeout: 10_000 });
      await expect(completing).toBeVisible();
      await expect(notes).toHaveText(typed.after);
    });
  });

  /* #1316 W1-S2: the same on the phone's sheet. */
  test("the pencil over a completion holding a note and a cost asks first; a second press opens the edit rows", async ({ page }) => {
    await openAt(page, BOILER.id);
    const row = rowOf(page, BOILER.id);
    await expect(row).toHaveAttribute("data-open", "", { timeout: SETTLE });
    await row.getByRole("group", { name: `Actions for ${BOILER.title}` })
      .getByRole("button", { name: `Complete ${BOILER.title}` }).tap();
    const completing = row.getByRole("group", { name: `Completing ${BOILER.title}` });
    await expect(completing.getByRole("button")).toHaveText(["record", "cancel"]);
    const notes = row.getByRole("textbox", { name: "notes" });
    const cost = row.getByRole("textbox", { name: "cost" });
    const typed = await notesThen(notes, "Bring the log book.");
    await notes.tap();
    await page.keyboard.press("End");
    await page.keyboard.type(" Bring the log book.");
    await expect(notes).toHaveText(typed.after);
    await cost.tap();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("42.50");
    await expect(cost).toHaveText("42.50");

    const editing = row.getByRole("group", { name: `Editing ${BOILER.title}` });
    await row.getByRole("button", { name: "Edit this item" }).tap();
    await expect(completing.getByRole("button", { name: "discard changes?" })).toBeVisible();
    await expect(completing).toBeVisible();
    await expect(editing).toHaveCount(0);
    await expect(notes).toHaveText(typed.after);
    await expect(cost).toHaveText("42.50");

    await row.getByRole("button", { name: "Edit this item" }).tap();
    await expect(editing).toBeVisible();
    await expect(completing).toHaveCount(0);
    await expect(row.getByRole("textbox", { name: "title" })).toBeVisible();
  });

  test.describe(() => {
    test.use(KEEP_THE_WORKER_OFF_ON_WEBKIT);

    /* #1316 W1-R3 / W1-R9: the same on the phone's sheet. */
    test("undoing a removal the server refuses says so in a wake, and the paper stays removed", async ({ page }) => {
      const name = MOT.paper.displayName;
      await removalsAnswered(page);
      await openAt(page, MOT.id);
      const row = rowOf(page, MOT.id);
      await expect(row).toHaveAttribute("data-open", "", { timeout: SETTLE });
      await row.getByRole("button", { name: `Open ${name}` }).tap();
      const sheet = page.getByRole("dialog", { name: new RegExp(`^${name}`) });
      const readButton = sheet.getByRole("button", { name: `Read ${name}` });
      await expect(readButton).toBeEnabled({ timeout: SETTLE });

      await removeThenFailTheUndo(page, readButton, name);

      await expect(page.getByRole("alert").filter({ hasText: new RegExp(`couldn['’]t restore ${name} — try again`) }))
        .toBeVisible();
      await expect(row.getByRole("button", { name: `Open ${name}` }).filter({ hasNotText: /removed/ }))
        .toHaveCount(0);
    });
  });

  test.describe(() => {
    test.use(KEEP_THE_WORKER_OFF_ON_WEBKIT);

    /* #1584 web-home-2, the phone: the desk host's `onchanged` swallowed its
       failed read of home, so the attach read as refreshed and the id was
       forgotten; a re-pick stored a second copy. Path picks, as the desk's;
       the browser's half is that the re-pick re-sends the first pick's id. */
    test("an attach whose read of home fails says the done line and keeps its id, so a re-pick sends the same one", async ({ page }, testInfo) => {
      const uploads = await papersAnswered(page, BOILER.id);
      const file = pdfOnDisk(testInfo);
      await openAt(page, BOILER.id);
      const row = rowOf(page, BOILER.id);
      await expect(row).toHaveAttribute("data-open", "", { timeout: SETTLE });

      /* the home read only: /api/workspace/commands is another path */
      const homeRead = (/** @type {URL} */ url) => url.pathname === "/api/workspace";
      await page.route(homeRead, (route) => route.abort("connectionfailed"));
      try {
        await row.locator('input[type="file"]').setInputFiles(file);
        /* soft, so the run goes on to show what the re-pick does as well */
        await expect.soft(row.locator("p.p-error"), "the row's own line says done").toHaveText(DONE_LINE, { timeout: 10_000 });
        await expect.soft(wakeStatus(page), "the wake says the same line").toHaveText(DONE_LINE, { timeout: 10_000 });
        await expect(row).toHaveAttribute("data-open", "");
      } finally {
        await page.unroute(homeRead);
      }

      await row.locator('input[type="file"]').setInputFiles(file);
      await expect(wakeStatus(page)).toHaveText("chromium-synthetic.pdf attached", { timeout: SETTLE });
      expect(uploads, "two picks, two uploads").toHaveLength(2);
      expect(uploads[1], "the re-pick re-sends the first pick's id").toBe(uploads[0]);
    });

    /* #1584 fix review r2-web-home-1, the phone: the host's read of home
       goes through, but the item's own documents GET fails. The phone's
       papers read is additive (a search over every carrying item), so it
       swallowed that failure: the attach read as refreshed, its id was
       forgotten, the drawer showed no paper, and a re-pick stored a second
       copy. Only the documents GET is aborted; the upload POST and home's
       read go through. The pick is by PATH, as above. */
    test("an attach whose papers read fails says the done line and keeps its id, so a re-pick sends the same one", async ({ page }, testInfo) => {
      const uploads = await papersAnswered(page, BOILER.id);
      const file = pdfOnDisk(testInfo);
      await openAt(page, BOILER.id);
      const row = rowOf(page, BOILER.id);
      await expect(row).toHaveAttribute("data-open", "", { timeout: SETTLE });
      const paperButton = row.getByRole("button", { name: "Open chromium-synthetic.pdf" });

      const documentsRead = (/** @type {URL} */ url) => url.pathname === documentsPathOf(BOILER.id);
      await page.route(documentsRead, (route) =>
        route.request().method() === "GET" ? route.abort("connectionfailed") : route.fallback());
      try {
        await row.locator('input[type="file"]').setInputFiles(file);
        /* soft, so the run goes on to show what the re-pick does as well */
        await expect.soft(row.locator("p.p-error"), "the row's own line says done").toHaveText(DONE_LINE, { timeout: 10_000 });
        /* the phone wakes "attached" first, so that is not asserted away */
        await expect.soft(wakeStatus(page), "the wake says the done line").toHaveText(DONE_LINE, { timeout: 10_000 });
        await expect.soft(row, "the row stays open").toHaveAttribute("data-open", "");
        await expect.soft(row, "the papers are not left 'reading'").not.toContainText(/reading/i, { timeout: 3_000 });
        await expect.soft(paperButton, "the paper is unread, so not shown").toHaveCount(0);
      } finally {
        await page.unroute(documentsRead);
      }

      await row.locator('input[type="file"]').setInputFiles(file);
      await expect(wakeStatus(page)).toHaveText("chromium-synthetic.pdf attached", { timeout: SETTLE });
      await expect.soft(paperButton, "the papers read landed, and shows one paper").toHaveCount(1, { timeout: SETTLE });
      expect.soft(uploads, "two picks, two uploads").toHaveLength(2);
      expect.soft(uploads[1], "the re-pick re-sends the first pick's id").toBe(uploads[0]);
    });

    /* #1584 web-home-2 (guards Change 1 against the W-F2 regression it could
       cause): the search sheet's own quick complete. Once the host's read
       rejects, a complete that treated that rejection as the command failing
       would say "couldn't complete it" for an item that is done. */
    test("the sheet's quick complete that lands while the read of home fails says the done line, never 'couldn't complete it'", async ({ page }) => {
      const writes = await ownWorkspace(page, { "item.complete": completeLikeTheEngine });
      await page.goto(`${APP}/home`, { waitUntil: "load" });
      await expect(page.locator("body[data-home-ready]")).toBeAttached();
      await page.locator(".msearch").click();
      await page.locator(".p-sheet-layer.open .pk-field").fill(MOT.title);
      const act = page.locator(".p-sheet-layer.open .pk-act");
      await expect(act).toContainText(`complete “${MOT.title}”`);
      await act.click();
      await expect(act).toContainText("tap again to complete");

      const homeRead = (/** @type {URL} */ url) => url.pathname === "/api/workspace";
      await page.route(homeRead, (route) => route.abort("connectionfailed"));
      try {
        await act.click();
        await expect(wakeStatus(page)).toHaveText(DONE_LINE, { timeout: 15_000 });
        await expect(page.locator('.p-wake-host [role="alert"]')).toHaveText("");
        await expect(page.getByText(/couldn.t complete it/)).toHaveCount(0);
      } finally {
        await page.unroute(homeRead);
      }

      /* the command landed; only the screen was stale */
      expect(writes.sent("item.complete").map((one) => one.itemId)).toEqual([MOT.id]);
      expect((await writes.itemOf(MOT.id))?.item.dueDate).not.toBe("2026-08-29");
    });
  });
});
