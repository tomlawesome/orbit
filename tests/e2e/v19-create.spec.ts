import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { householdRegister } from "./support/households";
import { settleArrival } from "./support/arrival";
import { gotoCreate } from "./support/keyboard";
import { ensureWorkerAdministrator, workerAccount } from "./support/worker-identity";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { answerPushWithoutAService } from "./support/webkit-push";

/* #1077: back to the stack's own seed before this file's setup runs, so the
   lists these specs walk carry nothing an earlier spec left behind. */
resetDatabaseBetweenSpecFiles();

/**
 * #456: the create form, proven against the real engine — the wiring was
 * built before any API was reachable and has never carried a real save.
 */

/* #730: this proving ground is removed at the end of the test that makes it,
   so it is not still in the sky when a later spec measures one. */
const HOUSEHOLD = "Creation Proving Ground";
const households = householdRegister();

async function seedHousehold(page: Page): Promise<{ id: string; name: string }> {
  return await page.evaluate(async (householdName) => {
    const session = (await (await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" })).json()) as { csrfToken: string };
    const householdId = crypto.randomUUID();
    const response = await fetch("/api/workspace/commands", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({
        type: "household.create",
        household: {
          id: householdId,
          name: householdName,
          timezone: "Europe/London",
          currency: "GBP",
          memberCount: 1,
          canManage: true,
          onboardingComplete: true,
          sections: [{ id: crypto.randomUUID(), name: "Home", icon: "home", accent: "sage", visible: true }],
          items: [],
        },
      }),
    });
    if (!response.ok) throw new Error(`household.create failed: ${response.status} ${await response.text()}`);
    return { id: householdId, name: householdName };
  }, HOUSEHOLD);
}

test("the create form saves a real item into the orbit", async ({ page }) => {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  /* #1080: the sweep's hard delete is an instance-admin power. */
  await ensureWorkerAdministrator(page);
  households.track(await seedHousehold(page));

  try {
    /* #856: waits for the mount that attaches the listeners, not just for
       `load` — `fill()` and the chip click below both need them. */
    await gotoCreate(page);
    const dueDate = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    if (test.info().project.name.startsWith("mobile")) {
      /* #1120, proposal §2.5: a phone's create is the pocket's own form,
         where the section is a required choice (#1058: none is chosen for
         you), and a save approaches the new item on its belt. */
      const form = page.getByRole("form", { name: "New entry" });
      await form.getByRole("textbox", { name: "name", exact: true }).fill("Gutter clearing proving");
      await form.getByRole("button", { name: "service" }).click();
      await form.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
      await form.getByLabel("due date").fill(dueDate);
      await page.getByRole("button", { name: "Add to orbit" }).click();

      await expect(page).toHaveURL(/\/item\/[0-9a-f-]{36}$/);
      await expect(page.getByRole("heading", { name: "Gutter clearing proving" })).toBeVisible();
      await expect(page.locator(".item-card")).toContainText("T−20d");

      // And the orbit lists it where it needs attention.
      await page.goto("/home");
      const row = page.locator(".pocket .pk-below .p-row", { hasText: "Gutter clearing proving" });
      await expect(row).toBeVisible();
      await expect(row).toContainText("T−20d");
    } else {
      await page.locator("#f-name").fill("Gutter clearing proving");
      await page.locator('#types button[data-type="service"]').click();
      // #1058b/#1069: the section has no default on the desk either — the
      // save button stays disabled until one is chosen.
      await page.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
      await page.locator("#f-date").fill(dueDate);
      await page.locator(".btn-primary").click();

      // Saved and returned to the orbit at the new item (#1246), where it
      // needs attention.
      await expect(page).toHaveURL(/\/home\?item=[0-9a-f-]{36}$/);
      const row = page.locator(".item", { hasText: "Gutter clearing proving" });
      await expect(row).toBeVisible();
      await expect(row).toContainText("T−20d");
    }
  } finally {
    await households.sweep(page);
  }
});

/**
 * #1251: the title ships empty, so an item cannot be saved under a name
 * nobody gave it. On the desk the heading field arrives focused with a
 * "Name this entry" placeholder and the save waits for a name; the phone's
 * own form already refuses an empty name in the same words, pinned here.
 */
test("the create form will not save an entry nobody has named", async ({ page }) => {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
  households.track(await seedHousehold(page));

  try {
    await gotoCreate(page);
    const dueDate = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    if (test.info().project.name.startsWith("mobile")) {
      const form = page.getByRole("form", { name: "New entry" });
      await form.getByRole("button", { name: "service" }).click();
      await form.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
      await form.getByLabel("due date").fill(dueDate);
      const save = page.getByRole("button", { name: "Add to orbit" });
      await expect(save).toBeDisabled();
      await expect(page.locator("#pk-refusal")).toHaveText("not yet — give it a name");
      await form.getByRole("textbox", { name: "name", exact: true }).fill("Gutter clearing proving");
      await expect(save).toBeEnabled();
    } else {
      const name = page.locator("#f-name");
      await expect(name).toBeFocused();
      await expect(name).toHaveValue("");
      await expect(name).toHaveAttribute("placeholder", "Name this entry");
      await page.locator('#types button[data-type="service"]').click();
      await page.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
      await page.locator("#f-date").fill(dueDate);
      const save = page.locator(".btn-primary");
      await expect(save).toBeDisabled();
      await expect(page.locator("#save-note")).toHaveText("not yet — give it a name");
      await name.fill("Gutter clearing proving");
      await expect(save).toBeEnabled();
    }
  } finally {
    await households.sweep(page);
  }
});

/* A real, structurally valid PDF: the upload route refuses a stub. */
const DOCUMENT = "chromium-synthetic.pdf";
const DOCUMENT_BYTES = readFileSync(resolve(__dirname, "../support/fixtures", DOCUMENT));

/** The pocket's form, filled and saved with a document picked (#1245, 11a). */
async function savePocketEntryWithDocument(page: Page, name: string): Promise<void> {
  await gotoCreate(page);
  const form = page.getByRole("form", { name: "New entry" });
  /* "add a document" opens this hidden picker; setting it is the same change. */
  await form.locator('input[type="file"]').setInputFiles({ name: DOCUMENT, mimeType: "application/pdf", buffer: DOCUMENT_BYTES });
  // The reading card holds the paper, and no longer says it will not be kept.
  await expect(form.locator(".pc-reading")).toContainText(DOCUMENT);
  await expect(form).not.toContainText("does not read or keep documents");
  await form.getByRole("textbox", { name: "name", exact: true }).fill(name);
  await form.getByRole("button", { name: "document", exact: true }).click();
  await form.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "Add to orbit" }).click();
}

/** The desk form, filled and saved with a document picked. */
async function saveDeskEntryWithDocument(page: Page, name: string, keyDate?: string): Promise<void> {
  await gotoCreate(page);
  /* The drop target opens this hidden picker; setting it is the same change. */
  await page.locator('#card input[type="file"]').setInputFiles({ name: DOCUMENT, mimeType: "application/pdf", buffer: DOCUMENT_BYTES });
  await page.locator("#f-name").fill(name);
  await page.locator('#types button[data-type="document"]').click();
  await page.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
  if (keyDate) await page.locator("#f-date").fill(keyDate);
  await page.locator(".btn-primary").click();
}

/** The saved item's id, read back by its title. */
async function itemIdOf(page: Page, householdId: string, title: string): Promise<string | null> {
  const response = await page.request.get("/api/workspace");
  if (!response.ok()) return null;
  const { workspace } = (await response.json()) as { workspace: { households: Array<{ id: string; items: Array<{ id: string; title: string }> }> } };
  return workspace.households.find((one) => one.id === householdId)?.items.find((item) => item.title === title)?.id ?? null;
}

/**
 * #1245: a document picked on /create is attached to the item it saves — the
 * desk's used to be dropped with "documents are not wired up yet", and the
 * phone's with "was not kept" until the owner's 11a ruling (2026-10-07).
 */
test("a document picked on the create form is attached to the saved item", async ({ page }) => {
  test.setTimeout(90_000);
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
  const household = households.track(await seedHousehold(page));

  try {
    const name = "Boiler cover proving";
    const pocket = test.info().project.name.startsWith("mobile");
    await (pocket ? savePocketEntryWithDocument : saveDeskEntryWithDocument)(page, name);
    // The pocket approaches the new item once the document is on it (§2.5).
    if (pocket) await expect(page).toHaveURL(/\/item\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    await expect.poll(() => itemIdOf(page, household.id, name), { timeout: 15_000 }).not.toBeNull();
    const itemId = (await itemIdOf(page, household.id, name)) as string;
    /* #1281: this save has no key date, and the pocket seats it on its belt
       all the same -- the address and the apex are the item just saved. */
    if (pocket) {
      expect(new URL(page.url()).pathname).toBe(`/item/${itemId}`);
      await expect(page.getByRole("heading", { name })).toBeVisible();
    }
    await expect.poll(async () => {
      const response = await page.request.get(`/api/households/${household.id}/items/${itemId}/documents`);
      if (!response.ok()) return `http_${response.status()}`;
      const { documents } = (await response.json()) as { documents: Array<{ displayName: string }> };
      return documents.map((one) => one.displayName).join(",");
    }, { timeout: 30_000 }).toContain(DOCUMENT);
  } finally {
    await households.sweep(page);
  }
});

/**
 * #1245, the §14 walk (design/v19/create-v3.html's `doc` → `snap`): the
 * moment a document is picked the lanes split and "Reading your document"
 * breathes; page one lands on the top sheet as soon as it is drawn, while
 * the read is still running; the read settles on its own, without the page
 * ever having waited for it. The sheet used to be a sketched placeholder
 * nothing reached, and the owner saw the lane sit on "Focusing on the
 * anomaly" for good.
 */
test("picking a document shows its front page while the read runs alongside", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the pocket's reading card is proven by its own tests below (#1279)");
  test.setTimeout(90_000);
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
  households.track(await seedHousehold(page));

  try {
    await gotoCreate(page);
    const readcard = page.locator("#readcard");
    await page.locator('#card input[type="file"]').setInputFiles({ name: DOCUMENT, mimeType: "application/pdf", buffer: DOCUMENT_BYTES });

    // The lanes split and the lane says what it is doing, straight away.
    await expect(page.locator("body")).toHaveClass(/\bdoc\b/);
    await expect(readcard).toBeVisible();
    await expect(readcard).toHaveAttribute("data-reading", "true");
    await expect(page.locator("#read-head")).toHaveText("Reading your document");

    // Page one lands — a real picture, drawn from the file — within seconds,
    // and the heading says so.
    await expect(page.locator("body")).toHaveClass(/\bsnap\b/, { timeout: 20_000 });
    await expect(page.locator("#read-head")).toHaveText("Page one");
    const sheet = page.locator("#sheet-page");
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute("alt", `Page one of ${DOCUMENT}`);
    await expect.poll(() => sheet.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(page.locator("#rc-file")).toContainText(DOCUMENT);
    await expect(page.locator("#rc-scan")).toBeVisible();

    // The read settles on its own, whatever it found (the stack may have no
    // processor), and never undoes the page.
    await expect(readcard).not.toHaveAttribute("data-reading", "true", { timeout: 45_000 });
    await expect(page.locator("body")).toHaveClass(/\bsnap\b/);
    await expect(page.locator("#rc-capline")).not.toHaveText("orbit is reading the pages it was given");

    // "not this one" takes the file out again and closes the lane.
    await page.locator("#rc-drop").click();
    await expect(page.locator("body")).not.toHaveClass(/\bdoc\b/);
    await expect(page.locator("body")).not.toHaveClass(/\bsnap\b/);
  } finally {
    await households.sweep(page);
  }
});

/**
 * #1243: the quick add in the north star's drawer is a real way in for a
 * document. Its box opens the file picker when clicked and takes a file
 * dropped on it; either way the full form opens with the file already in its
 * reading lane. It used to be a dashed label that did neither.
 */
test("the quick add's box takes a document by click or by drop, and opens the full form with it", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the north star's drawer is the desk's; the pocket creates from its own sheet");
  test.setTimeout(90_000);
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
  households.track(await seedHousehold(page));

  const openQuickAdd = async () => {
    await page.goto("/home");
    await settleArrival(page);
    await page.locator("#nstar").click();
    await expect(page.locator("#createdrawer")).toHaveClass(/\bopen\b/);
  };
  const expectFormHoldsDocument = async () => {
    await expect(page).toHaveURL(/\/create$/);
    await expect(page.locator("body")).toHaveClass(/\bdoc\b/);
    await expect(page.locator("#rc-file")).toContainText(DOCUMENT);
  };

  try {
    await openQuickAdd();
    const chooser = page.waitForEvent("filechooser");
    await page.locator("#cdrop").click();
    await (await chooser).setFiles({ name: DOCUMENT, mimeType: "application/pdf", buffer: DOCUMENT_BYTES });
    await expectFormHoldsDocument();

    await openQuickAdd();
    const dataTransfer = await page.evaluateHandle(({ name, bytes }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], name, { type: "application/pdf" }));
      return transfer;
    }, { name: DOCUMENT, bytes: [...DOCUMENT_BYTES] });
    await page.locator("#cdrop").dispatchEvent("dragover", { dataTransfer });
    await page.locator("#cdrop").dispatchEvent("drop", { dataTransfer });
    await expectFormHoldsDocument();
  } finally {
    await households.sweep(page);
  }
});

/**
 * #1243, the way into the quick add: the north star pressed before home goes
 * live. Home is drawn by the server long before readHome() has resolved and
 * its behaviour is bound (#1064), and a press on the star inside that window
 * used to be dropped with nothing to replay it -- the drawer simply never
 * opened. The test above caught it in CI (pipeline 2236): its click landed
 * about 150 ms before /api/workspace answered.
 *
 * The workspace read is held back so the window is wide enough to press into
 * on purpose, and the press waits until that read has been asked for, which
 * is after home's own mount has started listening for a missed press.
 */
test("the north star pressed before home goes live still opens the quick add", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the north star's drawer is the desk's; the pocket creates from its own sheet");
  test.setTimeout(60_000);
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
  households.track(await seedHousehold(page));

  try {
    let asked: () => void = () => {};
    const workspaceAsked = new Promise<void>((resolve) => { asked = resolve; });
    await page.route("**/api/workspace", async (route) => {
      asked();
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      await route.continue().catch(() => {});
    });
    await page.goto("/home");
    await workspaceAsked;
    await expect(page.locator("body[data-home-ready]")).toHaveCount(0);
    await page.locator("#nstar").click();
    await expect(page.locator("#createdrawer")).toHaveClass(/\bopen\b/, { timeout: 20_000 });
    await expect(page.locator("#nstar")).toHaveAttribute("aria-expanded", "true");
  } finally {
    await page.unroute("**/api/workspace").catch(() => {});
    await households.sweep(page);
  }
});

/**
 * #1279: the phone's create form reads a picked document as the desk does
 * (design/v19/create-phone-reading.html, owner's "14a"). The reading card
 * lands straight under TYPE in place of the "add a document" row, page one
 * lands on its sheet -- drawn for real by the preview route -- and the read
 * fills the empty fields marked "◆ from document", never over what was
 * typed. The inspection answer is fixed here, so the marks do not depend on
 * whether the stack has a document processor.
 */
async function signInWithHousehold(page: Page): Promise<void> {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
  households.track(await seedHousehold(page));
}

/** @param body the inspection route's answer for this page */
async function answerInspection(page: Page, body: object): Promise<void> {
  await page.route("**/item-document-inspection", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
}

/* #1196: both phone tests stage the document read with a `page.route` mock,
   and Playwright does not route a request the service worker handles (its
   documentation says to block service workers wherever routing is relied on).
   On mobile WebKit the mock applied only until Orbit's worker took the page, so
   the reading card drew the real server's "found nothing to carry across"
   instead of the mocked read. Nothing here is about the worker, so on WebKit it
   is kept out -- the same cure as v19-feedback-recovery.spec.ts and
   v19-mail-review.spec.ts; Chromium already routes these requests. */
test.describe("the phone's create form reads a picked document", () => {
  test.use({
    serviceWorkers: async ({}, use, testInfo) => {
      await use(testInfo.project.use.defaultBrowserType === "webkit" ? "block" : "allow");
    },
  });

  test("the phone's create form shows page one and fills the fields the read found", async ({ page }) => {
    test.skip(!test.info().project.name.startsWith("mobile"), "the desk's lane is proven above (#1245)");
    test.setTimeout(90_000);
    await signInWithHousehold(page);

    try {
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

      await form.locator('input[type="file"]').setInputFiles({ name: DOCUMENT, mimeType: "application/pdf", buffer: DOCUMENT_BYTES });
      const card = form.locator(".pc-reading");
      await expect(card).toBeVisible();
      await expect(card).toContainText(DOCUMENT);
      await expect(form.getByRole("button", { name: /add a document/ })).toHaveCount(0);
      // Straight under TYPE, ahead of the fields it fills.
      const above = await card.evaluate((el) => el.previousElementSibling?.querySelector(".pc-kinds") !== null);
      expect(above).toBe(true);

      // Page one lands, a real picture drawn from the file, and the head says so.
      const sheet = card.getByRole("img", { name: `Page one of ${DOCUMENT}` });
      await expect(sheet).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => sheet.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      await expect(card.getByRole("heading")).toHaveText(/page one/i);
      await expect(card).toContainText("Page one of the file you added");
      await expect(card).toContainText("scanned clean");

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
    } finally {
      await households.sweep(page);
    }
  });

  /**
   * #1279: a file the upload would refuse leaves the phone's entry at once,
   * in the desk's words, and the "add a document" row is back to choose
   * another; there is nothing to drop, so no "not this one".
   */
  test("the phone's create form says when a picked document is refused", async ({ page }) => {
    test.skip(!test.info().project.name.startsWith("mobile"), "the desk's refusal shares the same read (#1245)");
    test.setTimeout(90_000);
    await signInWithHousehold(page);

    try {
      await answerInspection(page, { extracted: false, suggestions: [], attachmentDisposition: "rejected" });
      await gotoCreate(page);
      const form = page.getByRole("form", { name: "New entry" });
      await form.locator('input[type="file"]').setInputFiles({ name: DOCUMENT, mimeType: "application/pdf", buffer: DOCUMENT_BYTES });

      const card = form.locator(".pc-reading");
      await expect(card).toContainText("Orbit refused this file.", { timeout: 20_000 });
      await expect(card).toContainText("choose another document");
      await expect(card).toContainText(/KB · refused/);
      await expect(card.getByRole("img")).toHaveCount(0);
      await expect(card.getByRole("button", { name: "not this one" })).toHaveCount(0);
      await expect(form.getByRole("button", { name: /add a document/ })).toBeVisible();
    } finally {
      await households.sweep(page);
    }
  });
});

/**
 * #1244: a file dragged over the desk's drop zone shows it has registered
 * (design/v19/create-dragover.html, owner's "8a yes"). Real DragEvents
 * carrying a real File, dispatched through the zone's own child the way the
 * mockup was exercised: the flicker trap (dragenter zone, dragenter child,
 * dragleave zone) must leave the zone locked, an off-target drop must be
 * refused rather than handed to the browser, and the drop itself takes the
 * file and says so in the polite live region.
 */
test("dragging a file over the drop zone shows it has registered", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the pocket's document row is a tap target with no drag (#1244 build notes)");
  test.setTimeout(90_000);
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
  households.track(await seedHousehold(page));

  try {
    await gotoCreate(page);
    const body = page.locator("body");
    const zone = page.locator("#dropzone");
    const files = await page.evaluateHandle(({ name, bytes }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))], name, { type: "application/pdf" }));
      return transfer;
    }, { name: DOCUMENT, bytes: DOCUMENT_BYTES.toString("base64") });
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
      const target = document.querySelector("#f-name") as HTMLElement;
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
    await expect(page.locator("#dz-live")).toHaveText(`${DOCUMENT} added. Reading it in the lane on the right.`);

    // With a document held, the zone offers a swap.
    await zone.dispatchEvent("dragenter", { dataTransfer: files });
    await expect(zone.locator('.dz-main [data-when="swap"]')).toBeVisible();
    await expect(page.locator("#dz-live")).toHaveText("Release to swap the document");
  } finally {
    await households.sweep(page);
  }
});

/**
 * #1246: "Add to orbit" closes the form and lands on the main screen at the
 * saved item — never a "Saved" line on a form left open.
 */
test("add to orbit closes the form and lands on the saved item", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the pocket's save opens the new item on its belt (#1120, §2.5)");
  test.setTimeout(90_000);
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
  const household = households.track(await seedHousehold(page));

  try {
    const name = "Home insurance proving";
    /* A dated save lands on its row in the schedule; the undated one is
       proven by the next test (#1281). */
    const keyDate = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    await saveDeskEntryWithDocument(page, name, keyDate);
    await expect(page).toHaveURL(/\/home\?item=[0-9a-f-]{36}$/, { timeout: 30_000 });
    const itemId = new URL(page.url()).searchParams.get("item");
    expect(itemId).toBe(await itemIdOf(page, household.id, name));
    await expect(page.locator("#save-note")).toHaveCount(0);
    await expect(page.locator(".item", { hasText: name })).toBeVisible();
  } finally {
    await households.sweep(page);
  }
});

/**
 * #1281: the key date is optional, and an item saved without one still lands
 * on its own row -- at the corridor's foot, under the quiet "no date" rule
 * where undated suggestions sit -- open, exactly as a dated save does. The
 * dial places by days to the sun, so it draws no body for it.
 */
test("add to orbit lands an undated item on its row under the no-date rule", async ({ page }) => {
  test.skip(test.info().project.name.startsWith("mobile"), "the pocket's save opens the new item on its belt (#1120, §2.5)");
  test.setTimeout(90_000);
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: workerAccount("administrator") }).click();
  await settleArrival(page);
  await ensureWorkerAdministrator(page);
  const household = households.track(await seedHousehold(page));

  try {
    const name = "Washing machine warranty proving";
    await saveDeskEntryWithDocument(page, name);
    await expect(page).toHaveURL(/\/home\?item=[0-9a-f-]{36}$/, { timeout: 30_000 });
    const itemId = new URL(page.url()).searchParams.get("item") as string;
    expect(itemId).toBe(await itemIdOf(page, household.id, name));

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
  } finally {
    await households.sweep(page);
  }
});
