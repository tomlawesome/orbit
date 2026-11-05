import { expect, test } from "@playwright/test";

import { APP, useFixtureScenes } from "../fidelity/pocket-states.js";
import { finiteMotionDone } from "../fidelity/finite-motion.js";
import { ownWorkspace, upsertLikeTheEngine } from "./workspace-writes.js";
import { pickImportance } from "./importance-support.js";

/*
 * #456, #1243-#1246, #1251, #1279, #1281, #1316, #1425: the create form, on the
 * desk (the dialect behind #card: #f-name, #types, #dropzone, #readcard) and on
 * the phone (the pocket's own form named "New entry", .pc-reading, .pk-problem).
 *
 * Moved from tests/e2e (ADR-0039, #1609). The stack suite signed in and made a
 * household per test; here the household is the fixture workspace's Harlow Home
 * (fixtures/workspace.js; its sections are Home, Vehicles and Devices, today
 * 2026-08-13), and the fixture app's own answers stand in for the engine:
 *
 *   - /item-document-preview answers a placeholder page (SVG), /item-document-
 *     inspection answers "nothing read, attachable", both from the app itself;
 *   - a test that is about the read's answer brings its own with `page.route`;
 *   - the app keeps nothing and has no route for staging a document, so a test
 *     whose point is what the form sends and shows after a save answers its own
 *     writes (savesAnswered below; workspace-writes.js for the workspace), and judges
 *     the commands and stage requests it sent where the stack suite read the
 *     engine back.
 *
 * What stays in tests/e2e: the real save, the real attach, the real photo and
 * the desk's first-document walk, whose front page is drawn and scanned by the
 * engine (the engine's half; see the commit message of #1609).
 *
 * The all-or-nothing create (a stage that fails sends no item, a retry re-sends
 * the same ids, removing a refused file lets Add save without it) is proved in
 * tests/unit/v19-create-partial-landing-words.test.mjs, on both forms.
 */

/* Reduced motion: nothing breathes under Playwright's actionability wait. The
   assertions hold in either mode. */
test.use({
  reducedMotion: "reduce",
  /* #1196, #1235: the tests that hold, abort or refuse a request do it with
     `page.route`, which on WebKit a request from a page Orbit's service worker
     controls skips. Nothing here is about the worker, so on WebKit it is kept out. */
  serviceWorkers: async ({}, use, testInfo) => {
    await use(testInfo.project.use.browserName === "webkit" ? "block" : "allow");
  },
});

const SETTLE = 20_000;
const DOCUMENT = "chromium-synthetic.pdf";
/* The fixture app never reads the file; a stub that is a PDF in name and magic is enough. */
const DOCUMENT_BYTES = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(2048, 32), Buffer.from("%%EOF\n")]);
const KEY_DATE = "2026-09-02"; /* twenty days after the fixture's today */
const REASON = "That file is not a PDF or image we can keep";

const onPhone = () => test.info().project.name.includes("phone");
const pdf = (/** @type {string} */ name = DOCUMENT) => ({ name, mimeType: "application/pdf", buffer: DOCUMENT_BYTES });

/** @param {import("@playwright/test").Page} page */
async function gotoCreate(page) {
  await page.goto(`${APP}/create`, { waitUntil: "load" });
  /* waits for the mount that attaches the listeners, not just for `load` (#856) */
  await page.locator("#card[data-ready]").waitFor({ state: "attached", timeout: SETTLE });
}

/** Two painted frames and no finite animation: the page has finished handling what it was just given. @param {import("@playwright/test").Page} page */
const handled = (page) => finiteMotionDone(page, { quietFrames: 2 });

/**
 * A press on a held Add is not taken for a save (the stack suite's "a document
 * the server refuses stays in the form, holds Add"): a press the page takes for
 * a save shows "Adding…" on the button in the same breath, before anything is
 * sent. Watch for that in the page itself, so the press is judged after the
 * page has handled it, not after a guess at how long handling takes; and
 * nothing more is sent.
 * @param {import("@playwright/test").Page} page
 * @param {import("@playwright/test").Locator} add
 * @param {{ stages: unknown[], upserts: () => unknown[] }} saves
 */
async function pressHeldAdd(page, add, saves) {
  const stages = saves.stages.length;
  const upserts = saves.upserts().length;
  await page.evaluate(() => {
    const watch = /** @type {any} */ (window);
    watch.__addingSeen = 0;
    new MutationObserver(() => {
      if (document.body.textContent?.includes("Adding…")) watch.__addingSeen += 1;
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await add.click({ force: true });
  await handled(page);
  expect(await page.evaluate(() => /** @type {any} */ (window).__addingSeen), "the press on a held Add was not taken for a save").toBe(0);
  expect(saves.stages, "a held Add sends no more files").toHaveLength(stages);
  expect(saves.upserts(), "a held Add sends no item").toHaveLength(upserts);
}

/**
 * The writes of a create, answered for this one test: the workspace takes the
 * item as the engine would, and the document stage (which the fixture app has
 * no route for) answers 201 unless `stageAnswer` gives another reply for that
 * try. `stages` is every stage request, in order; `upserts()` every real
 * item.upsert (the live checks carry `dryRun` and are not counted).
 * @param {import("@playwright/test").Page} page
 * @param {{ stageAnswer?: (n: number) => { status: number, contentType: string, body: string } | undefined }} [options]
 */
async function savesAnswered(page, { stageAnswer } = {}) {
  const writes = await ownWorkspace(page, { "item.upsert": upsertLikeTheEngine });
  /** @type {Array<{ name: string, documentId: string | undefined, itemId: string | undefined }>} */
  const stages = [];
  await page.route(/\/api\/households\/[^/]+\/documents$/, async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    const stage = {
      name: decodeURIComponent(request.headers()["x-orbit-filename"] ?? ""),
      documentId: request.headers()["x-orbit-document-id"],
      itemId: request.headers()["x-orbit-item-id"],
    };
    stages.push(stage);
    const refusal = stageAnswer?.(stages.length);
    if (refusal) return route.fulfill(refusal);
    return route.fulfill({
      status: 201,
      json: {
        document: {
          id: stage.documentId, itemId: stage.itemId, displayName: stage.name, mediaType: "application/pdf", sizeBytes: 15,
          lifecycle: "stored", scanStatus: "clean", availableAt: new Date().toISOString(), deleteAfter: null, ready: true,
          failureCode: null, recoverable: false, recoveryExpiresAt: null, recoveryStatus: null,
        },
      },
      headers: { "cache-control": "no-store" },
    });
  });
  return { stages, upserts: () => writes.sent("item.upsert"), writes };
}

/** The stage route refuses every file with a 415 and the server's own reason (#1316 6a). */
const REFUSED = () => ({ status: 415, contentType: "application/json", body: JSON.stringify({ error: { code: "document_type_unsupported", message: REASON } }) });

/** The pocket's form, filled and saved with a document picked (#1245, 11a). @param {import("@playwright/test").Page} page @param {string} name @param {string} [keyDate] */
async function savePocketEntryWithDocument(page, name, keyDate) {
  await gotoCreate(page);
  const form = page.getByRole("form", { name: "New entry" });
  /* "add a document" opens this hidden picker; setting it is the same change. */
  await form.locator('input[type="file"]').setInputFiles(pdf());
  await expect(form.locator(".pc-reading")).toContainText(DOCUMENT);
  await expect(form).not.toContainText("does not read or keep documents");
  await form.getByRole("textbox", { name: "name", exact: true }).fill(name);
  await form.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
  await pickImportance(page);
  /* a document's key date is "expires on" (EntryForm.svelte) */
  if (keyDate) await form.locator('input[id$="-due"]').fill(keyDate);
  await page.getByRole("button", { name: "Add to orbit" }).click();
}

/** The desk form, filled and saved with a document picked. @param {import("@playwright/test").Page} page @param {string} name @param {string} [keyDate] */
async function saveDeskEntryWithDocument(page, name, keyDate) {
  await gotoCreate(page);
  /* The drop target opens this hidden picker; setting it is the same change. */
  await page.locator('#card input[type="file"]').setInputFiles(pdf());
  await page.locator("#f-name").fill(name);
  await page.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
  await pickImportance(page);
  if (keyDate) await page.locator("#f-date").fill(keyDate);
  await page.locator(".btn-primary").click();
}

/** A DataTransfer carrying one file, for the drag events. @param {import("@playwright/test").Page} page @param {string} fileName */
const dragged = (page, fileName) => page.evaluateHandle(({ name, bytes }) => {
  const transfer = new DataTransfer();
  transfer.items.add(new File([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))], name, { type: "application/pdf" }));
  return transfer;
}, { name: fileName, bytes: DOCUMENT_BYTES.toString("base64") });

/** The inspection route's answer for this page. @param {import("@playwright/test").Page} page @param {object} body */
async function answerInspection(page, body) {
  await page.route("**/item-document-inspection", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
}

/** Hold the preview and the read, so the lane is still reading. Returns the release. @param {import("@playwright/test").Page} page */
async function holdPreviewAndRead(page) {
  /** @type {() => void} */
  let release = () => undefined;
  const held = new Promise((resolveHeld) => { release = () => resolveHeld(undefined); });
  for (const route of ["**/item-document-preview", "**/item-document-inspection"]) {
    await page.route(route, async (request) => {
      await held;
      await request.continue();
    });
  }
  return release;
}

/* ── the create form's own rules ─────────────────────────────────────────── */

/*
 * #1251: the title ships empty, so an item cannot be saved under a name
 * nobody gave it. On the desk the heading field arrives focused with a
 * "Name this entry" placeholder and the save waits for a name; the phone's
 * own form already refuses an empty name in the same words, pinned here.
 */
test("the create form will not save an entry nobody has named", async ({ page }) => {
  await gotoCreate(page);
  if (onPhone()) {
    const form = page.getByRole("form", { name: "New entry" });
    await form.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
    await pickImportance(page);
    await form.getByLabel("due date").fill(KEY_DATE);
    const save = page.getByRole("button", { name: "Add to orbit" });
    await expect(save).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator("#pk-refusal")).toHaveText("not yet — give it a name");
    await form.getByRole("textbox", { name: "name", exact: true }).fill("Gutter clearing proving");
    await expect(save).not.toHaveAttribute("aria-disabled", "true");
  } else {
    const name = page.locator("#f-name");
    await expect(name).toBeFocused();
    await expect(name).toHaveValue("");
    await expect(name).toHaveAttribute("placeholder", "Name this entry");
    await page.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
    await pickImportance(page);
    await page.locator("#f-date").fill(KEY_DATE);
    const save = page.locator(".btn-primary");
    await expect(save).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator("#save-note")).toHaveText("not yet — give it a name");
    await name.fill("Gutter clearing proving");
    await expect(save).not.toHaveAttribute("aria-disabled", "true");
  }
});

/*
 * #1246: "Add to orbit" closes the form and lands on the main screen at the
 * saved item, never a "Saved" line on a form left open. #1319: on the phone
 * too, which used to open the new item on the belt; both land on
 * /home?item=<new id> with that item's drawer open. #1316: the document is
 * staged first and the one item command names it in `documentIds`.
 */
test("add to orbit closes the form and lands on the saved item", async ({ page }) => {
  /* home's own load runs on the fixture server: it holds this browser's save (scene `keep-saves`) */
  await useFixtureScenes(page, "keep-saves");
  const saves = await savesAnswered(page);
  const name = "Home insurance proving";
  /* A dated save lands on its row in the schedule; the undated one is proven by the next test (#1281). */
  await (onPhone() ? savePocketEntryWithDocument : saveDeskEntryWithDocument)(page, name, KEY_DATE);
  await expect(page).toHaveURL(/\/home\?item=[0-9a-f-]{36}$/, { timeout: SETTLE });
  const itemId = new URL(page.url()).searchParams.get("item");

  expect(saves.stages.map((one) => one.name)).toEqual([DOCUMENT]);
  expect(saves.upserts().map((one) => [one.item.id, one.item.title, one.documentIds])).toEqual([[itemId, name, [saves.stages[0].documentId]]]);
  expect(saves.stages[0].itemId, "the stage names the draft item the command saves").toBe(itemId);

  if (onPhone()) {
    await expect(page.getByRole("form", { name: "New entry" })).toHaveCount(0);
    const opened = page.locator(`.pocket .pk-below [data-row-key="${itemId}"]`);
    await expect(opened).toHaveAttribute("data-open", "", { timeout: SETTLE });
    await expect(opened).toContainText(name);
    await expect(opened).toContainText("T−20d");
  } else {
    await expect(page.locator("#save-note")).toHaveCount(0);
    await expect(page.locator(".item", { hasText: name })).toBeVisible();
    await expect(page.locator(`[id="${itemId}-view"]`)).toBeVisible({ timeout: SETTLE });
    await expect(page.locator(".item", { hasText: name })).toContainText("T−20d");
  }
});

/*
 * #1281: the key date is optional, and an item saved without one still lands
 * on its own row -- at the corridor's foot, under the quiet "no date" rule
 * where undated suggestions sit -- open, exactly as a dated save does. The
 * dial places by days to the sun, so it draws no body for it. The phone's
 * undated save lands open in the test above's pocket half.
 */
test("add to orbit lands an undated item on its row under the no-date rule", async ({ page }) => {
  test.skip(onPhone(), "the no-date rule is the desk corridor's");
  const saves = await savesAnswered(page);
  const name = "Washing machine warranty proving";
  await saveDeskEntryWithDocument(page, name);
  await expect(page).toHaveURL(/\/home\?item=[0-9a-f-]{36}$/, { timeout: SETTLE });
  const itemId = /** @type {string} */ (new URL(page.url()).searchParams.get("item"));
  expect(saves.upserts().map((one) => one.item.id)).toEqual([itemId]);

  const row = page.locator(`.manifest a.item[id="${itemId}"]`);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await expect(row).toContainText(name);

  const rule = page.locator(".manifest .corridor .month", { hasText: "no date" });
  await expect(rule).toHaveCount(1);
  await expect(rule).toContainText("1 kept without a date");
  // The nearest rule above the row is the no-date one, not a month's or today's.
  const ruleAbove = await row.evaluate((el) => {
    for (let at = el.previousElementSibling; at; at = at.previousElementSibling) {
      if (at.matches(".month, .today")) return at.textContent?.trim() ?? "";
    }
    return null;
  });
  expect(ruleAbove).toMatch(/^no date/);

  await expect(page.locator(`[data-body="${itemId}"]`)).toHaveCount(0);
});

/* ── the desk's drop zone and reading lane ───────────────────────────────── */

test.describe("on the desk", () => {
  test.beforeEach(() => {
    test.skip(onPhone(), "the desk's #dropzone and lane; the phone's reading card is below (#1279)");
  });

  /*
   * #1316 W1-F3: a second document dropped on the desk's form is a new read, so
   * what the first one suggested must not outlive it. The inspection answer is
   * fixed per file name.
   */
  for (const [title, second, expected] of /** @type {const} */ ([
    ["a second document replaces the provider the first one suggested", "British Gas", "British Gas"],
    ["a second document that suggests nothing leaves the provider empty and unmarked", undefined, ""],
  ])) {
    test(`the desk's create form: ${title}`, async ({ page }) => {
      const readOf = (/** @type {string | undefined} */ provider) => ({
        extracted: true,
        attachmentDisposition: "attachable",
        suggestions: provider ? [{ field: "provider", value: provider, source: "document_text", confidence: "medium" }] : [],
      });
      /** @type {Record<string, object>} */
      const answers = { "invoice-a.pdf": readOf("Aviva"), "invoice-b.pdf": readOf(second) };
      await page.route("**/item-document-inspection", (route) => {
        const sent = decodeURIComponent(route.request().headers()["x-orbit-filename"] ?? "");
        const body = answers[sent] ?? { extracted: false, suggestions: [], attachmentDisposition: "attachable" };
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      });
      await gotoCreate(page);
      const picker = page.locator('#card input[type="file"]');
      const provider = page.locator("#f-provider");
      const field = page.locator("#field-provider");

      await picker.setInputFiles(pdf("invoice-a.pdf"));
      await expect(provider).toHaveValue("Aviva", { timeout: SETTLE });
      await expect(field).toHaveClass(/\bsugg\b/);

      await picker.setInputFiles(pdf("invoice-b.pdf"));
      await expect(page.locator("#rc-file")).toContainText("invoice-b.pdf");
      // The second read settles on its own before anything is asserted of it.
      await expect(page.locator("#readcard")).not.toHaveAttribute("data-reading", "true", { timeout: SETTLE });
      await expect(provider).toHaveValue(expected);
      await expect(provider).not.toHaveValue("Aviva");
      if (second) await expect(field).toHaveClass(/\bsugg\b/);
      else await expect(field).not.toHaveClass(/\bsugg\b/);
    });
  }

  /*
   * #1243: the quick add in the north star's drawer is a real way in for a
   * document. Its box opens the file picker when clicked and takes a file
   * dropped on it; either way the full form opens with the file already in its
   * reading lane.
   */
  test("the quick add's box takes a document by click or by drop, and opens the full form with it", async ({ page }) => {
    const openQuickAdd = async () => {
      await page.goto(`${APP}/home`, { waitUntil: "load" });
      await expect(page.locator("body[data-home-ready]")).toBeAttached();
      await page.locator("#nstar").click();
      await expect(page.locator("#createdrawer")).toHaveClass(/\bopen\b/);
    };
    const expectFormHoldsDocument = async () => {
      await expect(page).toHaveURL(/\/create$/);
      await expect(page.locator("body")).toHaveClass(/\bdoc\b/);
      await expect(page.locator("#rc-file")).toContainText(DOCUMENT);
    };

    await openQuickAdd();
    const chooser = page.waitForEvent("filechooser");
    await page.locator("#cdrop").click();
    await (await chooser).setFiles(pdf());
    await expectFormHoldsDocument();

    await openQuickAdd();
    const files = await dragged(page, DOCUMENT);
    await page.locator("#cdrop").dispatchEvent("dragover", { dataTransfer: files });
    await page.locator("#cdrop").dispatchEvent("drop", { dataTransfer: files });
    await expectFormHoldsDocument();
  });

  /*
   * #1243, the way into the quick add: the north star pressed before home goes
   * live. Home is drawn by the server long before readHome() has resolved and
   * its behaviour is bound (#1064), and a press on the star inside that window
   * used to be dropped with nothing to replay it. The workspace read is held back
   * so the window is wide enough to press into on purpose, and the press waits
   * until that read has been asked for.
   */
  test("the north star pressed before home goes live still opens the quick add", async ({ page }) => {
    /** @type {() => void} */
    let asked = () => {};
    const workspaceAsked = new Promise((resolve) => { asked = () => resolve(undefined); });
    /* The read is held until the test has clicked, not for a stretch of real
       time; the 20 s timer is only a safety so a test that fails before
       clicking cannot leave the page hanging. */
    /** @type {() => void} */
    let release = () => {};
    const clicked = new Promise((resolve) => {
      release = () => resolve(undefined);
      setTimeout(resolve, SETTLE);
    });
    const read = "**/api/workspace";
    await page.route(read, async (route) => {
      asked();
      await clicked;
      await route.continue().catch(() => {});
    });
    try {
      await page.goto(`${APP}/home`, { waitUntil: "load" });
      await workspaceAsked;
      await expect(page.locator("body[data-home-ready]")).toHaveCount(0);
      await page.locator("#nstar").click();
      release();
      await expect(page.locator("#createdrawer")).toHaveClass(/\bopen\b/, { timeout: SETTLE });
      await expect(page.locator("#nstar")).toHaveAttribute("aria-expanded", "true");
    } finally {
      release();
      await page.unroute(read).catch(() => {});
    }
  });

  /*
   * #1244: a file dragged over the desk's drop zone shows it has registered
   * (design/v19/create-dragover.html, owner's "8a yes"). Real DragEvents
   * carrying a real File, dispatched through the zone's own child the way the
   * mockup was exercised: the flicker trap (dragenter zone, dragenter child,
   * dragleave zone) must leave the zone locked, an off-target drop must be
   * refused rather than handed to the browser, and the drop itself takes the
   * file and says so in the polite live region.
   */
  test("dragging a file over the drop zone shows it has registered", async ({ page }) => {
    await gotoCreate(page);
    const body = page.locator("body");
    const zone = page.locator("#dropzone");
    const files = await dragged(page, DOCUMENT);
    const start = page.url();

    // Armed: over the page, not yet the zone.
    await page.locator("#card").dispatchEvent("dragenter", { dataTransfer: files });
    await expect(body).toHaveClass(/\bdragging\b/);
    await expect(body).not.toHaveClass(/\bover\b/);
    await expect(zone.locator('.dz-hint [data-when="arm"]')).toBeVisible();

    // Locked, and it holds while the pointer crosses the zone's own words.
    await zone.dispatchEvent("dragenter", { dataTransfer: files });
    await zone.locator(".dz-main [data-when=rest]").dispatchEvent("dragenter", { dataTransfer: files });
    await zone.dispatchEvent("dragleave", { dataTransfer: files });
    await expect(body).toHaveClass(/\bover\b/);
    await expect(zone.locator('.dz-main [data-when="lock"]')).toBeVisible();
    await expect(zone.locator('.dz-main [data-when="lock"]')).toHaveText("release to add it");
    await expect(page.locator("#dz-live")).toHaveText("Release to add the document");

    // Off the zone, a drop is refused rather than opened by the browser.
    const refused = await page.evaluate((transfer) => {
      const target = /** @type {HTMLElement} */ (document.querySelector("#f-name"));
      const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer });
      target.dispatchEvent(over);
      const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer });
      target.dispatchEvent(drop);
      return { over: over.defaultPrevented, effect: transfer.dropEffect, drop: drop.defaultPrevented };
    }, files);
    expect(refused).toEqual({ over: true, effect: "none", drop: true });
    expect(page.url()).toBe(start);
    await expect(body).not.toHaveClass(/\b(dragging|over)\b/);
    await expect(body).not.toHaveClass(/\bdoc\b/);

    // The drop on the zone takes the file, settles, and says so.
    await zone.dispatchEvent("dragenter", { dataTransfer: files });
    await zone.locator(".dz-main [data-when=rest]").dispatchEvent("drop", { dataTransfer: files });
    await expect(body).toHaveClass(/\bdoc\b/);
    await expect(body).not.toHaveClass(/\b(dragging|over)\b/);
    await expect(zone).toHaveClass(/\blanded\b/);
    await expect(page.locator("#dz-held-name")).toHaveText(DOCUMENT);
    await expect(page.locator("#dz-live")).toHaveText(`${DOCUMENT} added.`);

    // With a document held, the zone offers a swap.
    await zone.dispatchEvent("dragenter", { dataTransfer: files });
    await expect(zone.locator('.dz-main [data-when="swap"]')).toBeVisible();
    await expect(page.locator("#dz-live")).toHaveText("Release to swap the document");
  });

  /*
   * #1425: the desk keeps a way to remove a document the server refuses. The
   * reading lane's file row is its footer for the whole life of the lane, so
   * "not this one" is there while the lane is still reading, and after a
   * refusal the same button reads "remove it" beside "<size> · refused".
   */
  const SIZE_THEN_REFUSED = /\d[\d.,]*\s?(?:B|KB|MB)\s*·\s*refused/i;

  test("the desk's lane offers 'not this one' while it is still reading, and pressing it closes the lane", async ({ page }) => {
    const release = await holdPreviewAndRead(page);
    try {
      await gotoCreate(page);
      const lane = page.locator("#readcard");
      await page.locator('#card input[type="file"]').setInputFiles(pdf());
      await expect(page.locator("#read-head")).toHaveText("Reading your document");
      await expect(page.locator("#dz-held-name")).toContainText(DOCUMENT);

      const notThisOne = lane.getByRole("button", { name: "not this one" });
      await expect(notThisOne).toBeVisible();
      await notThisOne.click();

      await expect(page.locator("body")).not.toHaveClass(/\bdoc\b/);
      await expect(page.locator("#dz-held-name")).not.toContainText(DOCUMENT);
      await expect(notThisOne).toHaveCount(0);
    } finally {
      release();
    }
  });

  test("the desk's lane says 'refused' beside the size and offers 'remove it' once the server refuses the file", async ({ page }) => {
    const saves = await savesAnswered(page, { stageAnswer: REFUSED });
    await saveDeskEntryWithDocument(page, "Refused row words proving");
    await expect.poll(() => saves.stages.length, { timeout: SETTLE }).toBe(1);

    const lane = page.locator("#readcard");
    await expect(lane.getByRole("button", { name: "remove it" })).toBeVisible({ timeout: SETTLE });
    await expect(lane).toContainText(DOCUMENT);
    await expect(lane).toContainText(SIZE_THEN_REFUSED);
    await expect(lane.getByRole("button", { name: "not this one" })).toHaveCount(0);
    expect(saves.upserts()).toHaveLength(0);
  });

  test("the desk's 'remove it' clears the not-saved note, frees Add, and the next Add sends no document", async ({ page }) => {
    const saves = await savesAnswered(page, { stageAnswer: REFUSED });
    const add = page.locator(".btn-primary");
    const note = page.locator("#save-note");
    await saveDeskEntryWithDocument(page, "Remove it then save proving");
    await expect.poll(() => saves.stages.length, { timeout: SETTLE }).toBe(1);

    // The refusal is reported loudly and Add is held.
    await expect(note).toBeVisible();
    await expect(note).toContainText(REASON);
    await expect(add).toHaveAttribute("aria-disabled", "true");
    await pressHeldAdd(page, add, saves);

    const removeIt = page.locator("#readcard").getByRole("button", { name: "remove it" });
    await expect(removeIt).toBeVisible({ timeout: SETTLE });
    await removeIt.click();

    // What the note reported is gone with the file.
    await expect(note).not.toContainText(REASON);
    await expect(note).toBeHidden();
    await expect(page.locator("body")).not.toContainText(REASON);
    await expect(add).not.toHaveAttribute("aria-disabled", "true", { timeout: SETTLE });

    await add.click();
    await expect(page).toHaveURL(/\/home\?item=[0-9a-f-]{36}$/, { timeout: SETTLE });
    expect(saves.stages).toHaveLength(1);
    expect(saves.upserts()).toHaveLength(1);
    expect(saves.upserts()[0].documentIds ?? []).toEqual([]);
  });

  test("dropping a new file after a refusal relabels the button 'not this one' and hides 'refused'", async ({ page }) => {
    const saves = await savesAnswered(page, { stageAnswer: REFUSED });
    await saveDeskEntryWithDocument(page, "Replace after refusal proving");
    await expect.poll(() => saves.stages.length, { timeout: SETTLE }).toBe(1);
    const lane = page.locator("#readcard");
    await expect(lane.getByRole("button", { name: "remove it" })).toBeVisible({ timeout: SETTLE });
    await expect(lane).toContainText(SIZE_THEN_REFUSED);

    const files = await dragged(page, "replacement-after-refusal.pdf");
    const zone = page.locator("#dropzone");
    await zone.dispatchEvent("dragenter", { dataTransfer: files });
    await zone.locator(".dz-main [data-when=rest]").dispatchEvent("drop", { dataTransfer: files });

    await expect(lane).toContainText("replacement-after-refusal.pdf");
    await expect(lane.getByRole("button", { name: "not this one" })).toBeVisible({ timeout: SETTLE });
    await expect(lane.getByRole("button", { name: "remove it" })).toHaveCount(0);
    await expect(lane).not.toContainText(/refused/i);
  });

  /*
   * #1316 W1-R5: the desk's save sends the document that was picked when Add
   * was pressed. While "Adding…" shows (the document is already staged and the
   * item write is still in flight), pressing "not this one" or dropping another
   * file must not change what the save carries, nor what the zone says is
   * held: one stage POST, with the first file's name and id, and the item
   * command naming that id in `documentIds`.
   */
  const SECOND_DOCUMENT = "second-file-dropped-mid-save.pdf";

  for (const [title, interference] of /** @type {const} */ ([
    ["pressing 'not this one' while Adding… shows", "not this one"],
    ["dropping another file while Adding… shows", "drop"],
  ])) {
    test(`the desk's create form: ${title} still attaches the file that was picked`, async ({ page }) => {
      /* Every id the page mints, in order, so the document id in the POST can be
         tied to the pick that made it (the id is random, minted once per pick). */
      await page.addInitScript(() => {
        /** @type {string[]} */
        const minted = [];
        /** @type {any} */ (window).__minted = minted;
        const original = crypto.randomUUID.bind(crypto);
        crypto.randomUUID = /** @type {typeof crypto.randomUUID} */ ((() => {
          const id = original();
          minted.push(id);
          return id;
        }));
      });

      /** @type {() => void} */
      let releaseItemWrite = () => {};
      const itemWriteHeld = new Promise((resolveHeld) => { releaseItemWrite = () => resolveHeld(undefined); });
      let itemWriteSeen = false;
      /* The item write is the held reply; the live checks (`dryRun: true`) go through. */
      const writes = await ownWorkspace(page, {
        "item.upsert": async (command, workspace) => {
          itemWriteSeen = true;
          await itemWriteHeld;
          return upsertLikeTheEngine(command, workspace);
        },
      });
      /** @type {Array<{ name: string, documentId: string | undefined, itemId: string | undefined }>} */
      const documentPosts = [];
      await page.route(/\/api\/households\/[^/]+\/documents$/, async (route) => {
        const request = route.request();
        if (request.method() !== "POST") return route.fallback();
        const post = {
          name: decodeURIComponent(request.headers()["x-orbit-filename"] ?? ""),
          documentId: request.headers()["x-orbit-document-id"],
          itemId: request.headers()["x-orbit-item-id"],
        };
        documentPosts.push(post);
        return route.fulfill({
          status: 201,
          json: { document: { id: post.documentId, itemId: post.itemId, displayName: post.name, mediaType: "application/pdf", sizeBytes: 15, lifecycle: "stored", scanStatus: "clean", availableAt: new Date().toISOString(), deleteAfter: null, ready: true, failureCode: null, recoverable: false, recoveryExpiresAt: null, recoveryStatus: null } },
        });
      });

      try {
        const name = `Mid-save interference proving ${interference === "drop" ? "drop" : "release"}`;
        await gotoCreate(page);
        await page.locator('#card input[type="file"]').setInputFiles(pdf());
        await expect(page.locator("#dz-held-name")).toHaveText(DOCUMENT);
        await expect(page.locator("#rc-file")).toContainText(DOCUMENT);
        const mintedAtFirstPick = await page.evaluate(() => [.../** @type {any} */ (window).__minted]);

        await page.locator("#f-name").fill(name);
        await page.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
        await pickImportance(page);
        await page.locator(".btn-primary").click();

        // The item write is held: the form is mid-save.
        await expect.poll(() => itemWriteSeen, { timeout: SETTLE }).toBe(true);
        await expect(page.locator(".btn-primary")).toContainText("Adding…");
        // The file was staged before the item was sent: one POST, for the first file.
        expect(documentPosts).toHaveLength(1);
        expect(documentPosts[0].name).toBe(DOCUMENT);

        if (interference === "not this one") {
          await page.locator("#rc-drop").click();
        } else {
          const files = await dragged(page, SECOND_DOCUMENT);
          const zone = page.locator("#dropzone");
          await zone.dispatchEvent("dragenter", { dataTransfer: files });
          await zone.locator(".dz-main [data-when=rest]").dispatchEvent("drop", { dataTransfer: files });
        }

        // Whatever the form did with it, the zone still names the file the save is carrying.
        await expect(page.locator("#dz-held-name")).toHaveText(DOCUMENT);
        await handled(page);

        releaseItemWrite();
        await expect(page).toHaveURL(/\/home\?item=[0-9a-f-]{36}$/, { timeout: SETTLE });
        const itemId = /** @type {string} */ (new URL(page.url()).searchParams.get("item"));
        expect(writes.sent("item.upsert").map((one) => one.item.id)).toEqual([itemId]);

        // Exactly one stage POST, for the first file, under the id its pick minted,
        // and the one item command binds that same id.
        expect(documentPosts).toHaveLength(1);
        expect(documentPosts[0].name).toBe(DOCUMENT);
        const postedId = /** @type {string} */ (documentPosts[0].documentId);
        expect(postedId).toBeTruthy();
        expect(postedId).not.toBe(itemId);
        expect(mintedAtFirstPick).toContain(postedId);
        expect(writes.sent("item.upsert").map((one) => one.documentIds)).toEqual([[postedId]]);
        expect(documentPosts[0].itemId, "the stage names the draft item the command saves").toBe(itemId);
      } finally {
        releaseItemWrite();
      }
    });
  }

  /* #1425 review round 1, 7: every way a file arrives is announced through the always-present live region. */
  test("the desk announces a picked file in the live region whatever the lane is doing", async ({ page }) => {
    await gotoCreate(page);
    await page.locator('#card input[type="file"]').setInputFiles(pdf());
    await expect(page.locator("#dz-live")).toHaveText(`${DOCUMENT} added.`);
  });

  /* #1425 review round 1, 1: the lane's button leaves the page, so focus goes to the drop zone. */
  for (const [title, press] of /** @type {const} */ ([
    ["Tab to it and Enter", "keyboard"],
    ["a mouse click on it", "mouse"],
  ])) {
    test(`the desk's lane button, pressed by ${title}, closes the lane and leaves focus on the drop zone`, async ({ page }) => {
      const release = await holdPreviewAndRead(page);
      try {
        await gotoCreate(page);
        await page.locator('#card input[type="file"]').setInputFiles(pdf());
        await expect(page.locator("#read-head")).toHaveText("Reading your document");
        const button = page.locator("#readcard").getByRole("button", { name: "not this one" });
        await expect(button).toBeVisible();

        if (press === "keyboard") {
          /* Tab on from the form until the lane's own button has focus. */
          for (let presses = 0; presses < 60; presses += 1) {
            if (await page.evaluate(() => document.activeElement?.id === "rc-drop")) break;
            await page.keyboard.press("Tab");
          }
          await expect(button, "Tab reaches the lane's button").toBeFocused();
          await page.keyboard.press("Enter");
        } else {
          await button.click();
        }

        await expect(page.locator("body")).not.toHaveClass(/\bdoc\b/);
        await expect(page.locator("#dropzone")).toBeFocused();
        expect(await page.evaluate(() => document.activeElement?.id)).toBe("dropzone");
      } finally {
        release();
      }
    });
  }
});

/* ── the phone's reading card ────────────────────────────────────────────── */

/*
 * #1279: the phone's create form reads a picked document as the desk does
 * (design/v19/create-phone-reading.html, owner's "14a"). The reading card
 * lands straight under TYPE in place of the "add a document" row, page one
 * lands on its sheet -- drawn for real by the preview route -- and the read
 * fills the empty fields marked "from document", never over what was typed.
 * The inspection answer is fixed here.
 */
test.describe("the phone's create form reads a picked document", () => {
  test.beforeEach(() => {
    test.skip(!onPhone(), "the desk's lane is proven above (#1245)");
  });

  test("the phone's create form shows page one and fills the fields the read found", async ({ page }) => {
    await answerInspection(page, {
      extracted: true, attachmentDisposition: "attachable",
      suggestions: [
        { field: "provider", value: "British Gas", source: "document_text", confidence: "medium" },
        { field: "reference", value: "BG-88214-HC", source: "document_text", confidence: "medium" },
        { field: "cost", value: "144.00", source: "document_text", confidence: "medium" },
      ],
    });
    await gotoCreate(page);
    const form = page.getByRole("form", { name: "New entry" });
    const reference = form.getByRole("textbox", { name: "reference" });
    await reference.fill("MY-OWN-REF");

    await form.locator('input[type="file"]').setInputFiles(pdf());
    const card = form.locator(".pc-reading");
    await expect(card).toBeVisible();
    await expect(card).toContainText(DOCUMENT);
    await expect(form.getByRole("button", { name: /add a document/ })).toHaveCount(0);
    // Straight under TYPE, ahead of the fields it fills.
    const above = await card.evaluate((el) => el.previousElementSibling?.querySelector(".pc-kinds") !== null);
    expect(above).toBe(true);

    // Page one lands, a picture drawn from the file, and the head says so.
    const sheet = card.getByRole("img", { name: `Page one of ${DOCUMENT}` });
    await expect(sheet).toBeVisible({ timeout: SETTLE });
    await expect.poll(() => sheet.evaluate((img) => /** @type {HTMLImageElement} */ (img).naturalWidth)).toBeGreaterThan(0);
    await expect(card.getByRole("heading")).toHaveText(/page one/i);
    await expect(card).toContainText("Page one of the file you added");
    /* Nothing scanned it in the fixture app, so "scanned clean" is not said (stack: item-document-preview's real answer). */
    await expect(card).not.toContainText("scanned clean");

    // The read fills the empty fields and marks them; what was typed stays.
    await expect(card).toContainText("the fields marked ◆ from document are what orbit read across into the form");
    const provider = form.getByRole("textbox", { name: "provider" });
    const cost = form.getByRole("textbox", { name: "cost" });
    await expect(provider).toHaveValue("British Gas");
    await expect(cost).toHaveValue("144.00");
    await expect(reference).toHaveValue("MY-OWN-REF");
    await expect(form.locator(".pc-field.sugg")).toHaveCount(2);
    /* `has` is queried from inside the field, so a locator rooted at the form
       never matches there; the field is found by its label's own word. */
    await expect(form.locator(".pc-field.sugg", { hasText: "provider" })).toContainText("◆ from document");

    // Typing in a marked field accepts it: the mark clears, the value stays.
    await provider.fill("British Gas Services");
    await expect(form.locator(".pc-field.sugg")).toHaveCount(1);

    // "not this one": the file and what it still suggested leave the entry.
    await card.getByRole("button", { name: "not this one" }).click();
    await expect(card).toHaveCount(0);
    await expect(form.locator(".pc-field.sugg")).toHaveCount(0);
    await expect(cost).toHaveValue("");
    await expect(provider).toHaveValue("British Gas Services");
    await expect(reference).toHaveValue("MY-OWN-REF");
    await expect(form.getByRole("button", { name: /add a document/ })).toBeVisible();
  });

  /* G-B1-2 (#1671): a preview that reports a scan puts "scanned clean" on the reading card
     (pocket.svelte copies the outcome's `scanned` onto the pick); the test above is its converse. */
  test("the phone's reading card says scanned clean once the preview reports a scan", async ({ page }) => {
    await answerInspection(page, ATTACHABLE);
    await page.route("**/item-document-preview", (route) => route.fulfill(drawnPage));
    await gotoCreate(page);
    const form = page.getByRole("form", { name: "New entry" });
    await form.locator('input[type="file"]').setInputFiles(pdf());
    const card = form.locator(".pc-reading");
    await expect(card.getByRole("img", { name: `Page one of ${DOCUMENT}` })).toBeVisible({ timeout: SETTLE });
    await expect(card).toContainText("scanned clean");
  });

  /*
   * #1279, amended by #1316 (owner answer 6a): a file the upload would refuse
   * is marked refused in the phone's reading card, with the server's words, and
   * STAYS in the entry; Add is held until the file is replaced or removed, and
   * "add a document" is not offered while it is held.
   */
  test("the phone's create form says when a picked document is refused, and keeps it until it is replaced or removed", async ({ page }) => {
    await answerInspection(page, { extracted: false, suggestions: [], attachmentDisposition: "rejected", message: REASON });
    await gotoCreate(page);
    const form = page.getByRole("form", { name: "New entry" });
    await form.locator('input[type="file"]').setInputFiles(pdf());

    const card = form.locator(".pc-reading");
    await expect(card).toContainText("Orbit refused this file.", { timeout: SETTLE });
    await expect(card).toContainText(REASON);
    await expect(card).toContainText(DOCUMENT);
    await expect(card).toContainText(/KB · refused/);
    await expect(card.getByRole("img")).toHaveCount(0);
    // The file is still in the entry, so it can be removed or replaced, and Add is held.
    await expect(page.getByRole("button", { name: "Add to orbit" })).toHaveAttribute("aria-disabled", "true");
    await expect(card.getByRole("button", { name: /not this one|remove/i })).toHaveCount(1);
    await card.getByRole("button", { name: /not this one|remove/i }).click();
    await expect(form.getByRole("button", { name: /add a document/ })).toBeVisible();
  });

  /* #1425 review round 1, 6, the phone's half: "remove it" on a refused file. */
  test("the phone: 'remove it' on a file the server refused clears the not-saved note and releases Add", async ({ page }) => {
    const saves = await savesAnswered(page, { stageAnswer: REFUSED });
    await answerInspection(page, ATTACHABLE);
    await savePocketEntryWithDocument(page, "Phone remove clears note proving");
    await expect.poll(() => saves.stages.length, { timeout: SETTLE }).toBe(1);
    const note = page.locator(".pk-problem");
    const add = page.getByRole("button", { name: "Add to orbit" });
    await expect(note).toContainText(REASON, { timeout: SETTLE });
    await expect(add).toHaveAttribute("aria-disabled", "true");
    await pressHeldAdd(page, add, saves);

    await page.getByRole("form", { name: "New entry" }).locator(".pc-reading").getByRole("button", { name: /remove it|not this one/ }).click();

    await expect(note.filter({ hasText: REASON })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(REASON);
    await expect(add).not.toHaveAttribute("aria-disabled", "true", { timeout: SETTLE });
    expect(saves.stages).toHaveLength(1);
  });
});

/* ── #1425, review round 1 (owner, 2026-10-15) ───────────────────────────── */

/*
 * Written from the rulings alone, before the fixes. Nothing a preview or a read
 * answers after a refusal changes the lane (2 and 3); replacing a refused file
 * clears its loud note (6). The preview and the read are held with `page.route`.
 */
const COULD_NOT_DRAW = /could not turn it into a page/i;
const REJECTED = { extracted: false, suggestions: [], attachmentDisposition: "rejected", message: REASON };
const ATTACHABLE = { extracted: false, suggestions: [], attachmentDisposition: "attachable" };

/** The preview route's own 422 for a file it cannot draw. */
const previewFailed = {
  status: 422, contentType: "application/json",
  body: JSON.stringify({ error: { code: "document_preview_failed", message: "Orbit could not draw that document" } }),
};

/** The preview route's answer for a page it drew: the scan line, then the picture (the shape previewPickedDocument reads). */
const SVG_PAGE = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="85" height="120"><rect width="85" height="120" fill="#fff"/></svg>').toString("base64");
const drawnPage = {
  status: 200, contentType: "application/x-ndjson; charset=utf-8",
  body: `${JSON.stringify({ stage: "scanned", scanned: true })}\n${JSON.stringify({ stage: "preview", mediaType: "image/svg+xml", pageCount: 1, bytes: SVG_PAGE })}\n`,
};

/** Everything but the file filled in, so only a refusal can hold Add. @param {import("@playwright/test").Page} page @param {string} name */
async function fillEntry(page, name) {
  if (onPhone()) {
    const form = page.getByRole("form", { name: "New entry" });
    await form.getByRole("textbox", { name: "name", exact: true }).fill(name);
    await form.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
    await pickImportance(page);
  } else {
    await page.locator("#f-name").fill(name);
    await page.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
    await pickImportance(page);
  }
}

/** What a reader sees on the page right now (hidden words do not count). @param {import("@playwright/test").Page} page */
const seen = (page) => page.evaluate(() => document.body.innerText);

/**
 * A refusal cancels the preview request (the browser reports it aborted), so
 * an answer that arrives later has to be made to arrive: the preview's fetch
 * is given no abort signal, which is what a preview answering after the
 * refusal looks like to the page. Only the preview's fetch is touched.
 * @param {import("@playwright/test").Page} page
 */
async function previewIgnoresAbort(page) {
  await page.addInitScript(() => {
    const real = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes("item-document-preview")) return real(input, init);
      if (input instanceof Request) return real(new Request(input, { signal: null }), init ? { ...init, signal: null } : init);
      return real(input, init ? { ...init, signal: null } : init);
    };
  });
}

/**
 * Counts, in the page, each answer the preview and inspection routes have
 * given once the page has read it to the end (or lost it), so a check that "a
 * late answer changed nothing" can wait for the page to have taken the answer
 * in, rather than for a stretch of real time. Install before the page loads.
 * @param {import("@playwright/test").Page} page
 */
async function recordAnswers(page) {
  await page.addInitScript(() => {
    /** @type {Record<string, number>} */
    const answered = {};
    /** @type {any} */ (window).__answered = answered;
    const real = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const key = ["item-document-preview", "item-document-inspection"].find((route) => url.includes(route));
      const pending = real(input, init);
      if (key) {
        pending
          .then((response) => response.clone().arrayBuffer().catch(() => undefined), () => undefined)
          .finally(() => { answered[key] = (answered[key] ?? 0) + 1; });
      }
      return pending;
    };
  });
}

/**
 * Waits until the page has taken in the route's answer (see recordAnswers) and
 * then drawn two frames, by which time everything the answer set off in the
 * page's scripts has run. A "nothing changed" check made after this is made
 * after the page handled the answer, not after a guess at how long that takes.
 * @param {import("@playwright/test").Page} page @param {"item-document-preview" | "item-document-inspection"} route
 */
async function pageHandled(page, route) {
  await page.waitForFunction(
    (key) => (/** @type {any} */ (window).__answered?.[key] ?? 0) >= 1,
    route,
    { timeout: SETTLE },
  );
  await handled(page);
}

/** @param {import("@playwright/test").Page} page */
const pickerOf = (page) =>
  onPhone() ? page.getByRole("form", { name: "New entry" }).locator('input[type="file"]') : page.locator('#card input[type="file"]');
/** @param {import("@playwright/test").Page} page */
const laneOf = (page) =>
  onPhone() ? page.getByRole("form", { name: "New entry" }).locator(".pc-reading") : page.locator("#readcard");
/** @param {import("@playwright/test").Page} page */
const addOf = (page) =>
  onPhone() ? page.getByRole("button", { name: "Add to orbit" }) : page.locator(".btn-primary");

/* 2 and 3: once a file is refused, nothing a later answer brings changes the lane. */
const NO_PAGE_AFTER_REFUSAL = [
  {
    title: "(a) a page that lands after the read refused the file is not shown",
    run: async (/** @type {import("@playwright/test").Page} */ page) => {
      /** @type {() => void} */
      let release = () => undefined;
      const held = new Promise((resolveHeld) => { release = () => resolveHeld(undefined); });
      /** @type {() => void} */
      let previewSent = () => undefined;
      const previewAnswered = new Promise((resolveSent) => { previewSent = () => resolveSent(undefined); });
      await answerInspection(page, REJECTED);
      await previewIgnoresAbort(page);
      await recordAnswers(page);
      await page.route("**/item-document-preview", async (route) => {
        await held;
        await route.fulfill(drawnPage);
        previewSent();
      });
      await gotoCreate(page);
      await fillEntry(page, "Late page proving");
      await pickerOf(page).setInputFiles(pdf());
      const lane = laneOf(page);
      await expect(lane).toContainText("Orbit refused this file.", { timeout: SETTLE });
      await expect(lane).toContainText(REASON);
      // The held preview is released with a page that can be drawn.
      release();
      await previewAnswered;
      return () => release();
    },
    after: async (/** @type {import("@playwright/test").Page} */ page) => {
      const lane = laneOf(page);
      // The page has taken the late page in (and drawn the frames its handling needs) before it is judged.
      await pageHandled(page, "item-document-preview");
      await expect(page.locator("body")).not.toHaveClass(/\bsnap\b/);
      if (onPhone()) await expect(lane.getByRole("img")).toHaveCount(0);
      else await expect(page.locator("#sheet-page")).toBeHidden();
      await expect(lane).toContainText("Orbit refused this file.");
      await expect(lane).toContainText(REASON);
      await expect(lane).toContainText(/refused/);
      await expect(lane.getByRole("button", { name: /remove it|not this one/ })).toHaveCount(1);
      await expect(addOf(page)).toHaveAttribute("aria-disabled", "true");
    },
  },
  {
    title: "(b) a preview that could not draw, answered first, does not hide the refusal that follows",
    run: async (/** @type {import("@playwright/test").Page} */ page) => {
      /** @type {() => void} */
      let release = () => undefined;
      const held = new Promise((resolveHeld) => { release = () => resolveHeld(undefined); });
      /** @type {() => void} */
      let previewSent = () => undefined;
      const previewAnswered = new Promise((resolveSent) => { previewSent = () => resolveSent(undefined); });
      await recordAnswers(page);
      await page.route("**/item-document-preview", async (route) => {
        await route.fulfill(previewFailed);
        previewSent();
      });
      await page.route("**/item-document-inspection", async (route) => {
        await held;
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(REJECTED) });
      });
      await gotoCreate(page);
      await fillEntry(page, "Undrawable then refused proving");
      await pickerOf(page).setInputFiles(pdf());
      await previewAnswered;
      // The page has taken the failed preview in before the refusal is let through behind it.
      await pageHandled(page, "item-document-preview");
      release();
      return () => release();
    },
    after: async (/** @type {import("@playwright/test").Page} */ page) => {
      const lane = laneOf(page);
      await expect(lane).toContainText("Orbit refused this file.", { timeout: SETTLE });
      // The page has taken the refusal in (and drawn the frames its handling needs) before it is judged.
      await pageHandled(page, "item-document-inspection");
      await expect(lane).toContainText("Orbit refused this file.");
      expect(await seen(page)).not.toMatch(COULD_NOT_DRAW);
      await expect(lane).toContainText(REASON);
      await expect(lane.getByRole("button", { name: /remove it|not this one/ })).toHaveCount(1);
      await expect(addOf(page)).toHaveAttribute("aria-disabled", "true");
    },
  },
  {
    title: "(c) a preview that could not draw, answered after the refusal, does not replace it",
    run: async (/** @type {import("@playwright/test").Page} */ page) => {
      /** @type {() => void} */
      let release = () => undefined;
      const held = new Promise((resolveHeld) => { release = () => resolveHeld(undefined); });
      /** @type {() => void} */
      let previewSent = () => undefined;
      const previewAnswered = new Promise((resolveSent) => { previewSent = () => resolveSent(undefined); });
      await answerInspection(page, REJECTED);
      await previewIgnoresAbort(page);
      await recordAnswers(page);
      await page.route("**/item-document-preview", async (route) => {
        await held;
        await route.fulfill(previewFailed);
        previewSent();
      });
      await gotoCreate(page);
      await fillEntry(page, "Refused then undrawable proving");
      await pickerOf(page).setInputFiles(pdf());
      await expect(laneOf(page)).toContainText("Orbit refused this file.", { timeout: SETTLE });
      release();
      await previewAnswered;
      return () => release();
    },
    after: async (/** @type {import("@playwright/test").Page} */ page) => {
      const lane = laneOf(page);
      // The page has taken the failed preview in (and drawn the frames its handling needs) before it is judged.
      await pageHandled(page, "item-document-preview");
      await expect(lane).toContainText("Orbit refused this file.");
      expect(await seen(page)).not.toMatch(COULD_NOT_DRAW);
      await expect(lane).toContainText(REASON);
      await expect(lane.getByRole("button", { name: /remove it|not this one/ })).toHaveCount(1);
      await expect(addOf(page)).toHaveAttribute("aria-disabled", "true");
    },
  },
];

for (const layout of /** @type {const} */ (["desk", "phone"])) {
  for (const one of NO_PAGE_AFTER_REFUSAL) {
    test(`the ${layout}'s lane: ${one.title}`, async ({ page }) => {
      test.skip(layout === "desk" ? onPhone() : !onPhone(), layout === "desk" ? "the desk's lane; the phone's reading card has its own test" : "the phone's reading card; the desk's lane has its own test");
      /** @type {() => void} */
      let release = () => undefined;
      try {
        release = await one.run(page);
        await one.after(page);
      } finally {
        release();
      }
    });
  }
}

/* 2 and 3, the other way a file is refused: the save-time stage says no while the preview is still out. */
for (const layout of /** @type {const} */ (["desk", "phone"])) {
  test(`the ${layout}'s lane: a page that lands after the save refused the file is not shown`, async ({ page }) => {
    test.skip(layout === "desk" ? onPhone() : !onPhone(), layout === "desk" ? "the desk's lane; the phone's reading card has its own test" : "the phone's reading card; the desk's lane has its own test");
    const saves = await savesAnswered(page, { stageAnswer: REFUSED });
    await answerInspection(page, ATTACHABLE);
    await previewIgnoresAbort(page);
    await recordAnswers(page);
    /** @type {() => void} */
    let release = () => undefined;
    const held = new Promise((resolveHeld) => { release = () => resolveHeld(undefined); });
    /** @type {() => void} */
    let previewSent = () => undefined;
    const previewAnswered = new Promise((resolveSent) => { previewSent = () => resolveSent(undefined); });
    await page.route("**/item-document-preview", async (route) => {
      await held;
      await route.fulfill(drawnPage);
      previewSent();
    });

    try {
      if (layout === "desk") await saveDeskEntryWithDocument(page, "Late page after save proving");
      else await savePocketEntryWithDocument(page, "Late page after save proving");
      await expect.poll(() => saves.stages.length, { timeout: SETTLE }).toBe(1);
      const lane = laneOf(page);
      await expect(lane).toContainText(/refused/);
      release();
      await previewAnswered;
      // The page has taken the late page in (and drawn the frames its handling needs) before it is judged.
      await pageHandled(page, "item-document-preview");

      await expect(page.locator("body")).not.toHaveClass(/\bsnap\b/);
      if (onPhone()) await expect(lane.getByRole("img")).toHaveCount(0);
      else await expect(page.locator("#sheet-page")).toBeHidden();
      await expect(lane).toContainText(/refused/);
      await expect(lane.getByRole("button", { name: /remove it|not this one/ })).toHaveCount(1);
      await expect(addOf(page)).toHaveAttribute("aria-disabled", "true");
    } finally {
      release();
    }
  });
}

/* 6: the loud "not saved" note raised by a refusal goes when the file leaves. */
for (const layout of /** @type {const} */ (["desk", "phone"])) {
  test(`the ${layout}: replacing a file the server refused clears the not-saved note and releases Add once the read settles`, async ({ page }) => {
    test.skip(layout === "desk" ? onPhone() : !onPhone(), layout === "desk" ? "the desk's lane; the phone has its own test" : "the phone's reading card; the desk has its own test");
    const saves = await savesAnswered(page, { stageAnswer: REFUSED });
    await answerInspection(page, ATTACHABLE);

    const note = layout === "desk" ? page.locator("#save-note") : page.locator(".pk-problem");
    const add = addOf(page);
    if (layout === "desk") await saveDeskEntryWithDocument(page, "Replace clears note proving");
    else await savePocketEntryWithDocument(page, "Replace clears note proving");
    await expect.poll(() => saves.stages.length, { timeout: SETTLE }).toBe(1);
    await expect(note).toContainText(REASON, { timeout: SETTLE });
    await expect(add).toHaveAttribute("aria-disabled", "true");

    await pickerOf(page).setInputFiles(pdf("replacement-after-refusal.pdf"));
    await expect(laneOf(page)).toContainText("replacement-after-refusal.pdf");

    // The loud note goes with the file it was about, and Add is released.
    await expect(note.filter({ hasText: REASON })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(REASON);
    await expect(add).not.toHaveAttribute("aria-disabled", "true", { timeout: SETTLE });
    expect(saves.stages).toHaveLength(1);
  });
}
