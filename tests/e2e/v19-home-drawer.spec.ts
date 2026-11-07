import { expect, test, type Locator, type Page } from "@playwright/test";
import { FIXTURE_PDF, householdRegister, uploadDocument } from "./support/households";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { seedHouseholdInBrowser, signIn } from "./support/signed-in";
import { SETTLE } from "./support/settle";
import { dismissTourIfShown, homeIsLive } from "./support/keyboard";

/* #1077: back to the stack's own seed before this file's setup runs. */
resetDatabaseBetweenSpecFiles();

/**
 * #1319 (owner-decisions §34; design/v19/belt-purpose/round-3/
 * f-preview-beside-tracked.html): home's item drawer holds everything the
 * belt did. A document in it opens its preview beside the drawer on a wide
 * screen (the bottom sheet on a phone), Escape or a press off it removes it
 * and leaves the drawer open, and pressing the page opens the reader over
 * home. The foot row's snooze and complete act from the drawer itself.
 *
 * Stage 2 (design/v19/belt-purpose/round-8/m-colour-per-option.html):
 * the pencil puts the drawer's own rows into edit mode, a chosen value
 * opens the chooser card beside the drawer (the bottom sheet on a phone),
 * Escape takes the chooser and then the edit; snooze opens the calendar
 * ("snooze until"); complete asks for its date, cost and notes in the rows
 * and records them.
 *
 * A real upload through the real pipeline, as v19-document-preview.spec.ts
 * does, so the page drawn is a real render, not a placeholder.
 */
/* Reduced motion: the preview's 900ms focus beat is instant, and nothing
   breathes under Playwright's actionability wait (v19-document-preview's
   own reason). The assertions hold in either mode. */
test.use({ reducedMotion: "reduce" });

/* #1196, #1235: the tests that hold or refuse a save (`holdTheSave`) or a
   restore (`removeThenFailTheUndo`) do it with `page.route`, and on WebKit a
   request from a page Orbit's service worker controls skips Playwright's
   route, so the save went straight through. Nothing in them is about the
   worker, so on WebKit it is kept out, as v19-create.spec.ts does. */
const KEEP_THE_WORKER_OFF_ON_WEBKIT: Parameters<typeof test.use>[0] = {
  serviceWorkers: async ({}, use, testInfo) => {
    await use(testInfo.project.use.defaultBrowserType === "webkit" ? "block" : "allow");
  },
};

const HOUSEHOLD_PREFIX = "Drawer Proving Ground";
const TITLE = "Drawer proving item";
const NOTE = "Book the early slot.";
const households = householdRegister();

/** A household of its own (household.create makes it the one home shows)
 *  with one item, due in 20 days so the phone's manifest lists it too. */
async function seedHouseholdWithItem(page: Page): Promise<{ itemId: string; householdId: string; dueDate: string }> {
  const seeded = households.track(
    await seedHouseholdInBrowser(page, HOUSEHOLD_PREFIX, { withItem: true, itemTitle: TITLE, itemNotes: NOTE, dueInDays: 20 }),
  );
  return { itemId: seeded.itemId!, householdId: seeded.id, dueDate: seeded.dueDate! };
}

/** #1316 W1-R3: from the open preview, read the paper, remove it (the pill's
 *  two taps), make the server refuse the restore, and press the wake's undo.
 *  Returns once the undo is pressed. `readButton` is the preview's "Read
 *  <name>" button; the reader is the dialog that opens over home. */
async function removeThenFailTheUndo(page: Page, readButton: Locator, docId: string, name: string) {
  await readButton.click();
  const reader = page.getByRole("dialog", { name: `${name}, ${TITLE}` });
  await expect(reader).toBeVisible();
  await reader.getByRole("button", { name: `Remove ${name}` }).click();
  await reader.getByRole("button", { name: `tap again to remove ${name}` }).click();

  /* the paper goes and the wake offers it back */
  await expect(page.getByRole("status").filter({ hasText: `${name} removed` })).toHaveText(`${name} removed`);
  await expect(reader).toBeHidden();

  /* the server refuses the restore, whatever the reason */
  await page.route(`**/api/documents/${docId}/restore`, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "restore failed" }) })
      : route.continue());
  await page.getByRole("button", { name: "undo", exact: true }).click();
}

/** The paper as the server holds it now (its lifecycle), from the item's list. */
async function lifecycleOf(page: Page, householdId: string, itemId: string, docId: string) {
  const response = await page.request.get(`/api/households/${householdId}/items/${itemId}/documents`, { maxRetries: 2 });
  const body = (await response.json()) as { documents: { id: string; lifecycle: string }[] };
  return body.documents.find((one) => one.id === docId)?.lifecycle ?? null;
}

/* #1584 web-home-2 / web-home-1: the done line a landed command says when only
   the read of home (or of the item's papers) after it fails (landed.js). */
const DONE_LINE = /^done — .*reload/;

/** The item's documents route: GET lists them, POST attaches one. */
const documentsPathOf = (householdId: string, itemId: string) => `/api/households/${householdId}/items/${itemId}/documents`;

/** Every `x-orbit-document-id` an upload to the item's documents route carries, in order. */
function watchUploads(page: Page, path: string): string[] {
  const ids: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === path) {
      ids.push(request.headers()["x-orbit-document-id"] ?? "(none)");
    }
  });
  return ids;
}

/** The names of the papers the server holds for the item, one entry per stored copy. */
async function storedNames(page: Page, path: string): Promise<string[]> {
  const response = await page.request.get(path, { maxRetries: 2 });
  if (!response.ok()) throw new Error(`documents read failed: ${response.status()}`);
  const body = (await response.json()) as { documents: { displayName: string }[] };
  return body.documents.map((one) => one.displayName);
}

/** The wake's polite line and its failure line (Wake.svelte). */
const wakeStatus = (page: Page) => page.locator('.p-wake-host [role="status"]');
const wakeAlert = (page: Page) => page.locator('.p-wake-host [role="alert"]');

test.afterEach(async ({ page }) => {
  await households.sweep(page);
});

test.describe("on the desk", () => {
  test.skip(({ isMobile }) => isMobile, "the desk's drawer; the phone's is below");

  /* #1316 W1-S2 (owner, 2026-10-11, option a): the pencil over a completion
     that holds changes goes through the discard guard. The first press keeps
     the completion rows with the typed note and cost and arms the cancel pill
     as "discard changes?"; a second press inside the hold opens the edit rows.
     It used to open the edit rows at once and the typing was gone. */
  test("the pencil over a completion holding a note and a cost asks first; a second press opens the edit rows", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page);
    const { itemId } = await seedHouseholdWithItem(page);

    await page.goto(`/home?item=${itemId}`);
    const drawer = page.locator(`[id="${itemId}-view"]`);
    await expect(drawer).toBeVisible({ timeout: SETTLE });
    await drawer.getByRole("group", { name: `Actions for ${TITLE}` })
      .getByRole("button", { name: `Complete ${TITLE}` }).click();
    const completing = drawer.getByRole("group", { name: `Completing ${TITLE}` });
    await expect(completing.getByRole("button")).toHaveText(["record", "cancel"]);
    const notes = drawer.getByRole("textbox", { name: "notes" });
    const cost = drawer.getByRole("textbox", { name: "cost" });
    await expect(notes).toHaveText(NOTE);
    await notes.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Bring the log book.");
    const typedNote = `${NOTE} Bring the log book.`;
    await expect(notes).toHaveText(typedNote);
    await cost.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("42.50");
    await expect(cost).toHaveText("42.50");

    const editing = drawer.getByRole("group", { name: `Editing ${TITLE}` });
    await drawer.getByRole("button", { name: "Edit this item" }).click();
    await expect(completing.getByRole("button", { name: "discard changes?" })).toBeVisible();
    await expect(completing).toBeVisible();
    await expect(editing).toHaveCount(0);
    await expect(notes).toHaveText(typedNote);
    await expect(cost).toHaveText("42.50");

    await drawer.getByRole("button", { name: "Edit this item" }).click();
    await expect(editing).toBeVisible();
    await expect(completing).toHaveCount(0);
    await expect(page.locator(`[id="${itemId}"]`).getByRole("textbox", { name: "title" })).toBeVisible();
  });

  test.describe(() => {
    test.use(KEEP_THE_WORKER_OFF_ON_WEBKIT);

    /* #1316 W1-R3: undo is a promise; when the server refuses it the reader is
       told in the wake, not left with a silent nothing. The paper stays
       removed (the drawer may still list it, saying "removed"). */
    test("undoing a removal the server refuses says so in a wake, and the paper stays removed", async ({ page }) => {
      test.setTimeout(90_000);
      await signIn(page);
      const { itemId, householdId } = await seedHouseholdWithItem(page);
      const doc = await uploadDocument(page, householdId, itemId, "undo-refused.pdf");

      await page.goto(`/home?item=${itemId}`);
      const drawer = page.locator(`[id="${itemId}-view"]`);
      await expect(drawer).toBeVisible({ timeout: SETTLE });
      await drawer.getByRole("button", { name: "Open undo-refused.pdf" }).click();
      const card = page.getByRole("dialog", { name: /^undo-refused\.pdf/ });
      const readButton = card.getByRole("button", { name: "Read undo-refused.pdf" });
      await expect(readButton).toBeEnabled({ timeout: SETTLE });

      await removeThenFailTheUndo(page, readButton, doc.id, "undo-refused.pdf");

      await expect(page.getByRole("alert").filter({ hasText: /couldn['\u2019]t restore undo-refused\.pdf \u2014 try again/ }))
        .toBeVisible();
      expect(await lifecycleOf(page, householdId, itemId, doc.id)).toBe("pending_deletion");
      /* never listed as a live paper again */
      await expect(drawer.getByRole("button", { name: "Open undo-refused.pdf" }).filter({ hasNotText: /removed/ }))
        .toHaveCount(0);
    });
  });

  test.describe(() => {
    test.use(KEEP_THE_WORKER_OFF_ON_WEBKIT);

    /* #1584 web-home-2, the desk: the drawer's record read after an attach
       swallowed its own failure, so the act read as refreshed and the id was
       forgotten; a re-pick then stored a second copy. Only the item's
       documents GET fails here (home's own read goes through), the upload
       POST lands. The pick is by PATH: a buffer payload gets a fresh
       lastModified on each pick, which would mint a new id for a reason
       unrelated to the fix (attach-id.js keys on name, size and lastModified). */
    test("an attach whose record read fails says the done line and keeps its id, so a re-pick stores one copy", async ({ page }) => {
      test.setTimeout(90_000);
      await signIn(page);
      const { itemId, householdId } = await seedHouseholdWithItem(page);
      const path = documentsPathOf(householdId, itemId);
      const uploads = watchUploads(page, path);

      await page.goto(`/home?item=${itemId}`);
      const drawer = page.locator(`[id="${itemId}-view"]`);
      await expect(drawer).toBeVisible({ timeout: SETTLE });
      await expect(drawer.getByText(NOTE)).toBeVisible();

      const documentsRead = (url: URL) => url.pathname === path;
      await page.route(documentsRead, (route) =>
        route.request().method() === "GET" ? route.abort("connectionfailed") : route.continue());
      try {
        await drawer.locator('input[type="file"]').setInputFiles(FIXTURE_PDF);
        /* soft, so the run goes on to show what the re-pick does as well */
        await expect.soft(drawer.locator('.ivproblem[role="alert"]'), "the drawer's act line says done").toHaveText(DONE_LINE, { timeout: 8_000 });
        await expect.soft(wakeStatus(page), "the wake says the same line").toHaveText(DONE_LINE, { timeout: 8_000 });
        await expect.soft(wakeStatus(page), "and never 'attached'").not.toHaveText(/attached/, { timeout: 3_000 });
        /* the record is still shown, and says nothing but the done line */
        await expect.soft(drawer.getByText(NOTE), "the record is still shown").toBeVisible({ timeout: 3_000 });
        await expect.soft(drawer.locator(".ivproblem")).toHaveCount(1, { timeout: 3_000 });
      } finally {
        await page.unroute(documentsRead);
      }

      /* short: a record the failed read replaced with its error has no picker left to use */
      await drawer.locator('input[type="file"]').setInputFiles(FIXTURE_PDF, { timeout: 10_000 });
      await expect(wakeStatus(page)).toHaveText(`chromium-synthetic.pdf attached to ${TITLE}`, { timeout: SETTLE });
      expect(uploads, "two picks, two uploads").toHaveLength(2);
      expect(uploads[1], "the re-pick re-sends the first pick's id").toBe(uploads[0]);
      expect(await storedNames(page, path), "the server holds one copy").toEqual(["chromium-synthetic.pdf"]);
    });
  });
});

test.describe("on the phone", () => {
  test.skip(({ isMobile }) => !isMobile, "the phone's drawer; the desk's is above");

  /* #1316 W1-S2: the same on the phone's sheet. */
  test("the pencil over a completion holding a note and a cost asks first; a second press opens the edit rows", async ({ page }) => {
    test.setTimeout(60_000);
    await signIn(page);
    const { itemId } = await seedHouseholdWithItem(page);

    await page.goto(`/home?item=${itemId}`);
    const row = page.locator(`.pocket .pk-below [data-row-key="${itemId}"]`);
    await expect(row).toHaveAttribute("data-open", "", { timeout: SETTLE });
    await row.getByRole("group", { name: `Actions for ${TITLE}` })
      .getByRole("button", { name: `Complete ${TITLE}` }).tap();
    const completing = row.getByRole("group", { name: `Completing ${TITLE}` });
    await expect(completing.getByRole("button")).toHaveText(["record", "cancel"]);
    const notes = row.getByRole("textbox", { name: "notes" });
    const cost = row.getByRole("textbox", { name: "cost" });
    await expect(notes).toHaveText(NOTE);
    await notes.tap();
    await page.keyboard.press("End");
    await page.keyboard.type(" Bring the log book.");
    const typedNote = `${NOTE} Bring the log book.`;
    await expect(notes).toHaveText(typedNote);
    await cost.tap();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("42.50");
    await expect(cost).toHaveText("42.50");

    const editing = row.getByRole("group", { name: `Editing ${TITLE}` });
    await row.getByRole("button", { name: "Edit this item" }).tap();
    await expect(completing.getByRole("button", { name: "discard changes?" })).toBeVisible();
    await expect(completing).toBeVisible();
    await expect(editing).toHaveCount(0);
    await expect(notes).toHaveText(typedNote);
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
      test.setTimeout(90_000);
      await signIn(page);
      const { itemId, householdId } = await seedHouseholdWithItem(page);
      const doc = await uploadDocument(page, householdId, itemId, "undo-refused.pdf");

      await page.goto(`/home?item=${itemId}`);
      const row = page.locator(`.pocket .pk-below [data-row-key="${itemId}"]`);
      await expect(row).toHaveAttribute("data-open", "", { timeout: SETTLE });
      await row.getByRole("button", { name: "Open undo-refused.pdf" }).tap();
      const sheet = page.getByRole("dialog", { name: /^undo-refused\.pdf/ });
      const readButton = sheet.getByRole("button", { name: "Read undo-refused.pdf" });
      await expect(readButton).toBeEnabled({ timeout: SETTLE });

      await removeThenFailTheUndo(page, readButton, doc.id, "undo-refused.pdf");

      await expect(page.getByRole("alert").filter({ hasText: /couldn['\u2019]t restore undo-refused\.pdf \u2014 try again/ }))
        .toBeVisible();
      expect(await lifecycleOf(page, householdId, itemId, doc.id)).toBe("pending_deletion");
      await expect(row.getByRole("button", { name: "Open undo-refused.pdf" }).filter({ hasNotText: /removed/ }))
        .toHaveCount(0);
    });
  });

  test.describe(() => {
    test.use(KEEP_THE_WORKER_OFF_ON_WEBKIT);

    /* #1584 web-home-2, the phone: the desk host's `onchanged` swallowed its
       failed read of home, so the attach read as refreshed and the id was
       forgotten; a re-pick stored a second copy. Path picks, as the desk's. */
    test("an attach whose read of home fails says the done line and keeps its id, so a re-pick stores one copy", async ({ page }) => {
      test.setTimeout(90_000);
      await signIn(page);
      const { itemId, householdId } = await seedHouseholdWithItem(page);
      const path = documentsPathOf(householdId, itemId);
      const uploads = watchUploads(page, path);

      await page.goto(`/home?item=${itemId}`);
      const row = page.locator(`.pocket .pk-below [data-row-key="${itemId}"]`);
      await expect(row).toHaveAttribute("data-open", "", { timeout: SETTLE });

      /* the home read only: /api/workspace/commands is another path */
      const homeRead = (url: URL) => url.pathname === "/api/workspace";
      await page.route(homeRead, (route) => route.abort("connectionfailed"));
      try {
        await row.locator('input[type="file"]').setInputFiles(FIXTURE_PDF);
        /* soft, so the run goes on to show what the re-pick does as well */
        await expect.soft(row.locator("p.p-error"), "the row's own line says done").toHaveText(DONE_LINE, { timeout: 10_000 });
        await expect.soft(wakeStatus(page), "the wake says the same line").toHaveText(DONE_LINE, { timeout: 10_000 });
        await expect(row).toHaveAttribute("data-open", "");
      } finally {
        await page.unroute(homeRead);
      }

      await row.locator('input[type="file"]').setInputFiles(FIXTURE_PDF);
      await expect(wakeStatus(page)).toHaveText("chromium-synthetic.pdf attached", { timeout: SETTLE });
      expect(uploads, "two picks, two uploads").toHaveLength(2);
      expect(uploads[1], "the re-pick re-sends the first pick's id").toBe(uploads[0]);
      expect(await storedNames(page, path), "the server holds one copy").toEqual(["chromium-synthetic.pdf"]);
    });

    /* #1584 fix review r2-web-home-1, the phone: the host's read of home
       goes through, but the item's own documents GET fails. The phone's
       papers read is additive (a search over every carrying item), so it
       swallowed that failure: the attach read as refreshed, its id was
       forgotten, the drawer showed no paper, and a re-pick stored a second
       copy. Only the documents GET is aborted; the upload POST and home's
       read go through. The pick is by PATH, as above. */
    test("an attach whose papers read fails says the done line and keeps its id, so a re-pick stores one copy", async ({ page }) => {
      test.setTimeout(90_000);
      await signIn(page);
      const { itemId, householdId } = await seedHouseholdWithItem(page);
      const path = documentsPathOf(householdId, itemId);
      const uploads = watchUploads(page, path);

      await page.goto(`/home?item=${itemId}`);
      const row = page.locator(`.pocket .pk-below [data-row-key="${itemId}"]`);
      await expect(row).toHaveAttribute("data-open", "", { timeout: SETTLE });
      const paperButton = row.getByRole("button", { name: "Open chromium-synthetic.pdf" });

      const documentsRead = (url: URL) => url.pathname === path;
      await page.route(documentsRead, (route) =>
        route.request().method() === "GET" ? route.abort("connectionfailed") : route.continue());
      try {
        await row.locator('input[type="file"]').setInputFiles(FIXTURE_PDF);
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

      await row.locator('input[type="file"]').setInputFiles(FIXTURE_PDF);
      await expect(wakeStatus(page)).toHaveText("chromium-synthetic.pdf attached", { timeout: SETTLE });
      await expect.soft(paperButton, "the papers read landed, and shows one paper").toHaveCount(1, { timeout: SETTLE });
      expect.soft(uploads, "two picks, two uploads").toHaveLength(2);
      expect.soft(uploads[1], "the re-pick re-sends the first pick's id").toBe(uploads[0]);
      expect.soft(await storedNames(page, path), "the server holds one copy").toEqual(["chromium-synthetic.pdf"]);
    });

    /* #1584 web-home-2 (guards Change 1 against the W-F2 regression it could
       cause): the search sheet's own quick complete. Once the host's read
       rejects, a complete that treated that rejection as the command failing
       would say "couldn't complete it" for an item that is done. */
    test("the sheet's quick complete that lands while the read of home fails says the done line, never 'couldn't complete it'", async ({ page }) => {
      test.setTimeout(90_000);
      await signIn(page);
      const { itemId, dueDate } = await seedHouseholdWithItem(page);

      await page.goto("/home");
      await dismissTourIfShown(page);
      await homeIsLive(page);
      await page.locator(".msearch").click();
      await page.locator(".p-sheet-layer.open .pk-field").fill(TITLE);
      const act = page.locator(".p-sheet-layer.open .pk-act");
      await expect(act).toContainText(`complete “${TITLE}”`);
      await act.click();
      await expect(act).toContainText("tap again to complete");

      const homeRead = (url: URL) => url.pathname === "/api/workspace";
      await page.route(homeRead, (route) => route.abort("connectionfailed"));
      try {
        await act.click();
        await expect(wakeStatus(page)).toHaveText(DONE_LINE, { timeout: 15_000 });
        await expect(wakeAlert(page)).toHaveText("");
        await expect(page.getByText(/couldn.t complete it/)).toHaveCount(0);
      } finally {
        await page.unroute(homeRead);
      }

      /* the command landed; only the screen was stale */
      const dueNow = await page.evaluate(async (id) => {
        const response = await fetch("/api/workspace", { credentials: "same-origin", cache: "no-store" });
        const body = (await response.json()) as { workspace: { households: { items?: { id: string; dueDate?: string }[] }[] } };
        return body.workspace.households.flatMap((one) => one.items ?? []).find((one) => one.id === id)?.dueDate;
      }, itemId);
      expect(dueNow).toBeTruthy();
      expect(dueNow).not.toBe(dueDate);
    });
  });
});
